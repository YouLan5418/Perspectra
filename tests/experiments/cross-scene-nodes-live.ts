import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createChatProvider, prototypeTurnCall, type ChatCall } from '@harness-world/provider-chat'
import { type WorldJsonObject } from '@harness-world/contracts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
import { crossSceneRuntime } from './cross-scene-runtime.ts'
import { CrossScenePhone } from './cross-scene-phone.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { decideActivityFormat } from './pack-activity.ts'
import { createCoreWorker, coreRunner } from './hindsight-python.ts'

const directory = process.argv[2], medium = process.argv[3]
const core = process.argv[4] === 'core'
if (!directory || !['sms', 'phone'].includes(medium ?? '')) throw new TypeError('用法：指定新目录与 sms 或 phone')
const root = resolve(directory); mkdirSync(root, { recursive: true })
const packPath = resolve('examples/world-packs/cross-scene-activity'), friend = 'character:friend', player = 'character:player'
const provider = createChatProvider({ endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8046/v1/chat/completions'),
  model: process.env.HCW_LOCAL_MODEL ?? 'gemini-3.8-flash', style: 'tool', timeoutMs: 60000,
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
const live = new Set<Awaited<ReturnType<typeof crossSceneRuntime>>>(), results: unknown[] = []
const workers: ReturnType<typeof createCoreWorker>[] = []
async function open(path: string, label: string) {
  const environment = { HCW_LOCAL_ENDPOINT: process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8046/v1/chat/completions',
    HCW_LOCAL_MODEL: process.env.HCW_LOCAL_MODEL ?? 'gemini-3.8-flash', HCW_MODEL_PROTOCOL: 'openai',
    HCW_HINDSIGHT_UTILITY_ATTEMPTS: join(path, 'memory-core', 'utility-attempts.jsonl') }
  const worker = core ? createCoreWorker(environment) : undefined
  if (worker) workers.push(worker)
  const r = await crossSceneRuntime(path, async (request, signal) => {
    const decide = async (call: ChatCall) => {
      const raw = await provider.decide(call, signal)
      appendFileSync(join(root, 'decisions.jsonl'), JSON.stringify({ label, actor: (request.context.character as WorldJsonObject).characterId,
        continuation: request.continuation, output: JSON.stringify(raw).slice(0, 16000) }) + '\n')
      return raw
    }
    const prepared = localPrototypeTurnCall(request)
    return request.context.activity === undefined ? decide(prepared) : decideActivityFormat(prepared, decide, signal, prototypeTurnCall(request).schema)
  }, { phone: medium === 'phone', packPath, activities: true, storyNodes: true,
    ...(worker ? { memoryCoreRun: worker.run, memoryCoreBuildRun: coreRunner(environment),
      memoryContextBudget: { triggerTokens: 170000, compactTokens: 120000, minimumRecentTokens: 0 } } : {}) })
  live.add(r); return r
}
async function close(r: Awaited<ReturnType<typeof open>>) { await r.close(); live.delete(r) }
async function message(r: Awaited<ReturnType<typeof open>>, text: string, label: string) {
  const result = medium === 'phone' ? await r.phone('say', text, friend) : await r.send(text, friend)
  results.push({ label, result }); assert.equal(result.sent.status, 'accepted')
  assert(!['failed', 'interrupted'].includes(result.cycle.terminalReason), JSON.stringify(result))
  return result
}
try {
  const sourceDirectory = join(root, 'source'), source = await open(sourceDirectory, 'source')
  await source.activities!.apply({ activityKey: 'guess', activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  if (medium === 'phone') {
    const call = await source.phone('call', undefined, friend); results.push({ label: 'call', result: call })
    assert.equal((source.communication as CrossScenePhone).callFor(source.store.readEvents(source.address), player)?.state, 'connected', '角色未接听，本轮不计入接通节点验收')
  }
  await message(source, '节点前暗号是青灯。我在玩游戏，请通过当前通信回复收到即可，不要向同行者复述。', 'before-node')
  if (core) await source.refreshMemory()
  const activity = structuredClone(source.activities!.current()), node = await source.saveNode('活动与通信节点')
  const saved = source.store.readEvents(source.address)
  await message(source, '节点后的新暗号是鸢尾。', 'future')
  if (core) await source.refreshMemory()
  if (medium === 'phone') await source.phone('hangup', undefined, friend)
  await source.activities!.apply({ activityKey: 'guess', activityId: activity!.id, revision: activity!.revision,
    operation: 'guess', parameters: { value: 20 }, requestId: 'future-guess' })
  const future = source.store.readEvents(source.address)
  await close(source)
  const childDirectory = join(root, 'rollback')
  restoreStoryNode(sourceDirectory, node.id, childDirectory, node.packHash)
  const child = await open(childDirectory, 'rollback')
  assert.deepEqual(child.store.readEvents(child.address), saved); assert.deepEqual(child.activities!.current(), activity)
  if (medium === 'phone') assert.equal((child.communication as CrossScenePhone).callFor(child.store.readEvents(child.address), player)?.state, 'connected')
  assert(!JSON.stringify(child.view(friend).observations).includes('鸢尾'))
  if (core) {
    assert(child.memoryCore!.archivePrefix(friend) > 0)
    assert(!JSON.stringify(child.memoryCore!.snapshotArchives([friend])).includes('鸢尾'))
  }
  await message(child, '节点前我告诉你的暗号是什么？请通过当前通信回复，不要猜没收到的内容。', 'rollback-recall')
  if (core) verifyRecall(childDirectory)
  await close(child)
  const archive = join(root, 'node.perspectra-story'); await exportStoryNode(sourceDirectory, node.id, archive, packPath)
  const imported = await importStoryNode(archive, join(root, 'receiver'), packPath, node.packHash), receiverDirectory = join(root, 'receiver', imported.id)
  const receiver = await open(receiverDirectory, 'shared')
  assert.deepEqual(receiver.store.readEvents(receiver.address), saved); assert.deepEqual(receiver.activities!.current(), activity)
  assert(!JSON.stringify(receiver.view(friend).observations).includes('鸢尾'))
  if (core) {
    assert.equal(receiver.memoryCore!.archivePrefix(friend), 0, '分享不包含 Core 缓存')
    await receiver.refreshMemory()
  }
  await message(receiver, '节点前我告诉你的暗号是什么？请通过当前通信回复，不要猜没收到的内容。', 'shared-recall')
  if (core) verifyRecall(receiverDirectory)
  assert.deepEqual(receiver.activities!.current(), activity)
  const original = await open(sourceDirectory, 'source-readback')
  assert.deepEqual(original.store.readEvents(original.address), future)
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: 'passed', medium, memoryMode: core ? 'core' : 'native', node, imported,
    originalHead: original.store.head(original.address), sharedHead: receiver.store.head(receiver.address), results,
    sharedObservations: receiver.view(friend).observations }, null, 2) + '\n')
  console.log(`passed: ${join(root, 'report.json')}`)
} catch (error) {
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: 'failed', medium, reason: String(error), results }, null, 2) + '\n')
  throw error
} finally { for (const r of live) await close(r); for (const worker of workers) await worker.close() }

function verifyRecall(path: string) {
  const traces = readFileSync(join(path, 'memory-core', 'recall-trace.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { actor: string; request: { context: WorldJsonObject }; result: WorldJsonObject; status: string })
  const recall = traces.find(row => row.actor === friend && JSON.stringify(row.request.context.stimulus).includes('节点前我告诉你的暗号'))
  assert(recall && recall.status === 'core', '必须实际调用 Core recall')
  assert(JSON.stringify(recall.result.delivery).includes('青灯'), 'Core 未交付暗号')
  for (const key of ['observations', 'selfObservations']) assert(!JSON.stringify(recall.request.context[key] ?? []).includes('青灯'), '旧暗号不能依赖短期原文')
  assert(!JSON.stringify(recall.request.context).includes('鸢尾'), '回退或分享不得带入未来记忆')
}
