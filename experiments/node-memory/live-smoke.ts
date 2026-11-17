/** Explicit paid-model smoke on synthetic authorized sources; never reads player saves. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCoreRuntime } from '../../packages/memory-core/src/node/runtime.ts'
import { object, rows } from '../../packages/memory-core/src/node/archive.ts'

const endpoint = process.env.PERSPECTRA_MODEL_ENDPOINT ?? 'http://127.0.0.1:8025/v1/chat/completions'
const model = process.env.PERSPECTRA_MODEL ?? 'opencode-go/deepseek-v4.1-flash'
const apiKey = process.env.PERSPECTRA_MODEL_API_KEY
const output = resolve('.tmp/node-memory/live-' + Date.now())
await mkdir(output, { recursive: true })
const runtime = createCoreRuntime({
  model: { protocol: 'openai', endpoint, model, ...(apiKey ? { apiKey } : {}) },
  assetDirectory: resolve(process.env.HCW_HINDSIGHT_ONNX_DIR ?? '.tmp/hindsight-e5-small'),
  utilityAttemptsFile: resolve(output, 'attempts.jsonl'),
})
const scope = { worldAddress: { tenantId: 'node-smoke', worldId: 'tea', branchId: 'main' }, characterId: 'character:friend', asOfWorldSeq: 4 }
const contents = [
  'character:player said: 我不喜欢苦咖啡，我最喜欢桂花热茶。',
  'character:player said: 我明天一定来茶室见你。',
  'character:player said: 我刚接到急事，明天来不了了，见面的约定取消。',
  JSON.stringify({ actorId: 'character:player', actionType: 'interact', status: 'rejected', interaction: { entityId: 'entity:door', interactionId: 'open' }, resultDescription: '门锁着，开门失败，门仍关闭。' }),
]
const sources = contents.map((text, i) => ({ ...scope, sourceId: 'event:' + (i + 1), sourceHash: 'smoke:' + (i + 1), worldSeq: i + 1, knownTick: i + 1, epistemicKind: i === 3 ? 'observed_action' : 'reported_speech', text }))
const signal = AbortSignal.timeout(300_000)
try {
  const built = process.argv[2] ? object(JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))) : await runtime.run({ operation: 'build', scope, sources }, signal)
  const archive = object(built.archive), index = object(built.index)
  assert(rows(archive.facts).length >= 4)
  assert(rows(archive.observations).length > 0)
  await writeFile(resolve(output, 'built.json'), JSON.stringify(built, null, 2))
  const questions = ['我最喜欢喝什么？', '明天还会来见面吗？', '刚才门打开了吗？']
  const results = []
  for (const question of questions) {
    const request = { context: { character: { characterId: scope.characterId }, scene: { locationId: 'location:tea', people: [] }, items: { current: [] }, stimulus: [{ value: { content: { actorId: 'character:player', speech: { characterId: 'character:player', text: question, addresseeIds: [scope.characterId] } } } }], observations: [], selfObservations: [] } }
    const recalled = await runtime.run({ operation: 'recall', archive, index, request, tick: 4, observations: true, deliveryMode: 'minimal', deliveryBudget: { maxItems: 6, maxJsonChars: 12000 } }, signal)
    await writeFile(resolve(output, 'recall-' + results.length + '.json'), JSON.stringify(recalled, null, 2))
    assert(rows(recalled.delivery).length > 0, 'Empty recall: ' + question + '; evidence: ' + output)
    const response = await fetch(endpoint, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) }, body: JSON.stringify({ model, messages: [
      { role: 'system', content: '你是茶室里的朋友。只根据给你的本人记忆自然回答玩家，用简短中文。记忆中的对白是当事人的说法，不是独立核实的真值。' },
      { role: 'user', content: JSON.stringify({ memories: recalled.delivery, question }) },
    ], max_tokens: 600, thinking: { type: 'disabled' } }) })
    assert(response.ok, 'Character model HTTP status ' + response.status)
    const wire = await response.json() as { choices?: { message?: { content?: string } }[] }
    const answer = wire.choices?.[0]?.message?.content
    assert(answer?.trim(), 'Missing character reply')
    results.push({ question, answer, delivery: recalled.delivery, trace: recalled.deliveryTrace })
  }
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ model, archive, results }, null, 2))
  console.log(JSON.stringify({ output, model, atoms: rows(archive.facts).length, observations: rows(archive.observations).length, replies: results.map(({ question, answer }) => ({ question, answer })) }, null, 2))
} finally { await runtime.close() }
