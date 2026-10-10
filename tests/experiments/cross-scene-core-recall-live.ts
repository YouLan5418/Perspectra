import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createChatProvider, prototypeTurnCall, type ChatCall } from '@harness-world/provider-chat'
import type { WorldJsonObject } from '@harness-world/contracts'
import { crossSceneRuntime } from './cross-scene-runtime.ts'
import { coreRunner, createCoreWorker } from './hindsight-python.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { decideActivityFormat } from './pack-activity.ts'

// Use only after the source experiment has stopped. Copy into a new directory, retaining its evidence.
const source = process.argv[2], target = process.argv[3], medium = process.argv[4]
if (!source || !target || !['sms', 'phone'].includes(medium ?? '')) throw new Error('指定已停止的来源目录、新目录、sms 或 phone')
const root = resolve(target), data = join(root, 'data'), friend = 'character:friend'
if (existsSync(root)) throw new Error('验证需要新目录')
mkdirSync(root, { recursive: true }); cpSync(resolve(source), data, { recursive: true, errorOnExist: true })
const environment = { HCW_LOCAL_ENDPOINT: process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8046/v1/chat/completions',
  HCW_LOCAL_MODEL: process.env.HCW_LOCAL_MODEL ?? 'gemini-3.8-flash', HCW_MODEL_PROTOCOL: 'openai' }
const worker = createCoreWorker(environment)
const provider = createChatProvider({ endpoint: new URL(environment.HCW_LOCAL_ENDPOINT), model: environment.HCW_LOCAL_MODEL,
  style: 'tool', timeoutMs: 60000, ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
const requests: WorldJsonObject[] = [], decisions: unknown[] = []
const runtime = await crossSceneRuntime(data, async (request, signal) => {
  requests.push(request.context)
  const decide = async (call: ChatCall) => { const decision = await provider.decide(call, signal); decisions.push(decision); return decision }
  const call = localPrototypeTurnCall(request)
  return request.context.activity === undefined ? decide(call) : decideActivityFormat(call, decide, signal, prototypeTurnCall(request).schema)
}, { phone: medium === 'phone', packPath: resolve('examples/world-packs/cross-scene-activity'), activities: true, storyNodes: true,
  memoryCoreRun: worker.run, memoryCoreBuildRun: coreRunner(environment),
  memoryContextBudget: { triggerTokens: 170000, compactTokens: 120000, minimumRecentTokens: 0 } })
try {
  assert(runtime.memoryCore!.archivePrefix(friend) > 0, '需要实际安装的 Core 档案')
  const activity = structuredClone(runtime.activities!.current())
  const question = '我之前告诉你的暗号是什么？请通过当前通信回复，不要猜没收到的内容。'
  const result = medium === 'phone' ? await runtime.phone('say', question, friend) : await runtime.send(question, friend)
  assert.equal(result.sent.status, 'accepted')
  assert(!['failed', 'interrupted'].includes(result.cycle.terminalReason), JSON.stringify(result.cycle))
  const context = requests.find(c => (c.character as WorldJsonObject).characterId === friend)!
  assert(context, '没有实际角色调用')
  assert(JSON.stringify(context.memories).includes('青灯'), 'Core 没有交付暗号')
  for (const key of ['observations', 'selfObservations', 'stimulus']) assert(!JSON.stringify(context[key] ?? []).includes('青灯'), '不能依赖短期原文')
  assert(JSON.stringify(decisions).includes('青灯'), '真实角色没有回答暗号')
  assert.deepEqual(runtime.activities!.current(), activity)
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: 'passed', medium, source, activity, result, requests, decisions }, null, 2))
  console.log(`passed: ${join(root, 'report.json')}`)
} catch (error) {
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: 'failed', medium, reason: String(error), requests, decisions }, null, 2))
  throw error
} finally { await runtime.close(); await worker.close() }
