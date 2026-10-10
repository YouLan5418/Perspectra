import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { createChatProvider, prototypeTurnCall, type ChatCall } from '@harness-world/provider-chat'
import { runPrototypeActivations } from '../../packages/application/src/prototype-activation-cycle.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { crossSceneRuntime } from './cross-scene-runtime.ts'
import { CrossScenePhone, phoneCalls } from './cross-scene-phone.ts'
import { decideActivityFormat } from './pack-activity.ts'

const directory = process.argv[2], medium = process.argv[3]
if (!directory || !['sms', 'phone'].includes(medium ?? '')) throw new TypeError('用法：指定新目录与 sms 或 phone')
const root = resolve(directory); mkdirSync(root, { recursive: true })
const provider = createChatProvider({ endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8046/v1/chat/completions'),
  model: process.env.HCW_LOCAL_MODEL ?? 'gemini-3.8-flash', style: 'tool', timeoutMs: 60000,
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
let phase = 'contact'
const runtime = await crossSceneRuntime(root, async (request, signal) => {
  const actor = String((request.context.character as WorldJsonObject).characterId)
  const task = actor === 'character:friend' ? phase === 'contact'
    ? `你独自在后室，现在想${medium === 'phone' ? '打电话给' : '发短信给'}前室同行者，询问是否方便稍后聊。你的秘密暗号是纸船，不必向玩家透露。你不是猜数游戏参与者，不要猜测内部答案或操作游戏；已经联系过就不必重复发起。`
    : '你现在决定结束这次通话，请通过可用的挂断操作结束，然后停止。'
    : phase === 'game' ? '通信之后游戏仍在进行。如果轮到你，请自主选择游戏操作；通信没有替代猜数回合。' : undefined
  const projected = { ...request, context: { ...request.context, ...(task ? { experimentIntent: task } : {}) } }
  const decide = async (call: ChatCall) => {
    const raw = await provider.decide(call, signal)
    appendFileSync(join(root, 'decisions.jsonl'), JSON.stringify({ actor, phase, continuation: request.continuation, output: JSON.stringify(raw).slice(0, 16000) }) + '\n')
    return raw
  }
  const prepared = localPrototypeTurnCall(projected)
  // Match the ordinary activity host's existing one-shot schema correction, without coercing values.
  return request.context.activity === undefined ? decide(prepared)
    : decideActivityFormat(prepared, decide, signal, prototypeTurnCall(projected).schema)
}, { phone: medium === 'phone', activities: true, packPath: 'examples/world-packs/cross-scene-activity' })
const results: unknown[] = []
const run = async (actor: string) => {
  const result = await runtime.turn.run(brandId(actor, 'CharacterId'), { signal: new AbortController().signal, maxCalls: 3 })
  results.push({ phase, actor, result }); assert(!['failed', 'interrupted'].includes(result.status), JSON.stringify(result.failure))
  return result
}
try {
  await runtime.activities!.apply({ activityKey: 'guess', activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  const initial = structuredClone(runtime.activities!.current())!
  const before = runtime.store.head(runtime.address).headSeq
  await run('character:friend')
  const cycle = await runPrototypeActivations({ store: runtime.store, address: runtime.address, turn: runtime.turn,
    afterSeq: before, characterIds: [brandId('character:companion', 'CharacterId'), brandId('character:friend', 'CharacterId')],
    signal: new AbortController().signal, limits: { maximumWaves: 3, maximumNpcCalls: 12, maximumCallsPerCharacter: 2, reactionDeadlineSeconds: 120 } })
  results.push({ phase, cycle }); assert(!['failed', 'interrupted'].includes(cycle.terminalReason), JSON.stringify(cycle))
  assert.deepEqual(runtime.activities!.current(), initial, '通信期间活动发生变化，需检查是否角色主动执行了正式游戏操作')
  if (medium === 'phone') {
    assert(phoneCalls(runtime.store.readEvents(runtime.address)).some(call => call.callerId === 'character:friend' && call.calleeId === 'character:companion'), '没有实际呼叫，不计入电话验收')
    phase = 'hangup'
    if ((runtime.communication as CrossScenePhone).callFor(runtime.store.readEvents(runtime.address), 'character:friend')) await run('character:friend')
    assert.equal((runtime.communication as CrossScenePhone).callFor(runtime.store.readEvents(runtime.address), 'character:friend'), undefined)
  } else {
    assert(JSON.stringify(runtime.view('character:companion').observations).includes('character:friend'), '没有实际来信')
    const sent = await runtime.send('我和同行者在前室玩游戏，稍后聊。', 'character:friend'); results.push({ phase: 'outgoing', sent })
    assert(!['failed', 'interrupted'].includes(sent.cycle.terminalReason))
    assert.deepEqual(runtime.activities!.current(), initial)
  }
  phase = 'game'
  await runtime.activities!.apply({ activityKey: 'guess', activityId: initial.id, revision: initial.revision,
    operation: 'guess', parameters: { value: 20 }, requestId: 'guess' })
  await run('character:companion')
  assert(runtime.store.readEvents(runtime.address).some(event => event.eventType === 'activity.updated'
    && (event.data as WorldJsonObject).actorId === 'character:companion'), '通信后没有实际 NPC 游戏操作')
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: 'passed', medium, initial, final: runtime.activities!.current(), results,
    calls: phoneCalls(runtime.store.readEvents(runtime.address)), playerObservations: runtime.view('character:player').observations,
    remoteObservations: runtime.view('character:friend').observations }, null, 2) + '\n')
  console.log(`passed: ${join(root, 'report.json')}`)
} catch (error) {
  writeFileSync(join(root, 'report.json'), JSON.stringify({ status: 'failed', medium, phase, reason: String(error), results,
    activity: runtime.activities!.current(), calls: phoneCalls(runtime.store.readEvents(runtime.address)) }, null, 2) + '\n')
  throw error
} finally { await runtime.close() }
