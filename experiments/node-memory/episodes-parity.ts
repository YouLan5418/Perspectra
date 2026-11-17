/** Nonempty Source -> Atom -> Episode -> Observation oracle, without a paid model. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorldJsonObject, WorldJsonValue } from '../../packages/sdk/src/contracts/index.ts'
import { object, rows, text, validateUnits } from '../../packages/memory-core/src/node/archive.ts'
import { consolidate, group, retain, utilityPrompt, type MemoryUtility } from '../../packages/memory-core/src/node/episodes.ts'
import { retainPrefix } from '../../packages/memory-core/src/node/retain-prefix.ts'

const python = process.argv[2]
if (!python) throw new Error('Usage: node --import tsx experiments/node-memory/episodes-parity.ts PYTHON')
const scope = { worldAddress: { tenantId: 't', worldId: 'w', branchId: 'b' }, characterId: 'character:friend', asOfWorldSeq: 20 }
const source = (seq: number, content: string, kind = 'reported_speech'): WorldJsonObject => ({ sourceId: 'event:' + seq, sourceHash: 'hash:' + seq, worldSeq: seq, knownTick: seq, characterId: scope.characterId, worldAddress: scope.worldAddress, epistemicKind: kind, text: content })
const report: WorldJsonObject[] = []
type Operation = 'retain' | 'group' | 'consolidate' | 'retainPrefix' | 'validate'
async function compare(name: string, operation: Operation, input: WorldJsonObject, answers: WorldJsonObject[] = []): Promise<WorldJsonObject> {
  const before = structuredClone(input), calls: WorldJsonObject[] = []
  let cursor = 0
  const utility: MemoryUtility = async (system, user, maxTokens) => {
    calls.push({ system, user: JSON.parse(utilityPrompt(user)) as WorldJsonValue, rawUser: utilityPrompt(user), maxTokens })
    assert.ok(cursor < answers.length, 'Unexpected utility call')
    return structuredClone(answers[cursor++]!)
  }
  const oracle = JSON.parse(execFileSync(resolve(python), ['experiments/node-memory/episodes-oracle.py'], {
    input: JSON.stringify({ operation, input, answers }), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  })) as { result?: WorldJsonValue; calls: WorldJsonObject[]; rejected?: boolean }
  let actual: WorldJsonValue | undefined, rejected = false
  try {
    actual = operation === 'validate' ? validateUnits(input) : operation === 'retainPrefix' ? await retainPrefix(input, utility) : await ({ retain, group, consolidate })[operation](input, utility)
  } catch { rejected = true }
  assert.deepEqual(input, before, name + ': input mutated')
  assert.equal(rejected, oracle.rejected === true, name + ': rejection differs')
  assert.deepEqual(calls, oracle.calls, name + ': utility prompt/protocol differs')
  if (!rejected) assert.deepEqual(actual, oracle.result, name + ': archive differs')
  report.push({ name, operation, equal: true, rejected, utilityCalls: calls.length })
  return rejected || operation === 'validate' ? {} : object(actual)
}

const sources = [
  source(1, 'character:player said: 我不确定他来了。; character:player published narration (not an adjudicated outcome): 我把钥匙交给你。; original player input (interpretation evidence, not an adjudicated outcome): 给他钥匙。'),
  source(2, JSON.stringify({ actorId: 'character:player', actionType: 'interact', status: 'rejected', interaction: { entityId: 'entity:key' }, resultDescription: '门仍然锁着。', playerInput: { sourceText: '我已经开门成功。' }, reason: '我成功了' }), 'observed_action'),
  source(3, JSON.stringify({ actorId: 'character:friend', actionType: 'interact', status: 'accepted', resultDescription: '活动开始。', resultMetadata: { activity: { id: 'activity:first', revision: 1, phase: 'open', round: 1, active: true, lifecycle: 'started', private: { answer: 73 } } } }), 'observed_action'),
  source(4, 'character:player said: 我喜欢热茶。明天再来。'),
  source(5, 'character:player appeared: 👩🏽‍🔧拿着工具；café e\u0301；𠮷。'),
]
const selection = { atoms: [{ segment_id: 'event:1/part:0', quote: '他来了。' }, { segment_id: 'event:4/part:0', quote: '我喜欢热茶。' }, { segment_id: 'event:4/part:0', quote: '我喜欢热茶。' }, { segment_id: 'event:2/part:0', quote: '成功' }] }
const data = await compare('mixed evidence, negation, failed action, metadata, Unicode', 'retain', { scope, sources }, [selection])
const facts = rows(data.facts), ids = facts.map(a => text(a.id))
const grouped = await compare('accepted groups plus invalid and omitted grouping fallback', 'group', { ...data, episodes: [], observations: [] }, [{ groups: [{ episode_id: null, label: '经历', atom_ids: ids.slice(0, 3) }, { episode_id: null, atom_ids: ['foreign'] }, { episode_id: null, atom_ids: [ids[0]] }] }])
const withGroups = { ...data, episodes: grouped.episodes!, observations: [] }
const obs = await compare('subjective observation with support and counter evidence', 'consolidate', withGroups, [{ observations: [{ observation_id: null, text: '旅人的说法尚不能确认。', supporting_atom_ids: [ids[0]], contradicting_atom_ids: [ids[1]] }, { observation_id: null, text: '不能使用外来证据', supporting_atom_ids: ['foreign'] }] }])
const archived = { ...withGroups, observations: obs.observations! }
await compare('nonempty archive validation', 'validate', archived)
await compare('update re-reads original supporting evidence', 'consolidate', archived, [{ observations: [{ observation_id: 'obs:1', text: '后来补充了不同说法，仍有冲突。', supporting_atom_ids: [ids[1]], contradicting_atom_ids: [ids[0]] }] }])
const prefix = await compare('initial retained prefix', 'retainPrefix', { scope, sources }, [selection])
await compare('identical prefix makes no new model calls', 'retainPrefix', { scope, sources, retainedPrefix: prefix })
await compare('incremental prefix preserves old atom IDs', 'retainPrefix', { scope, sources: [...sources, source(6, 'character:friend said: 我明天会再确认。')], retainedPrefix: prefix }, [{ atoms: [] }])
for (const [name, change] of [
  ['foreign character', (d: WorldJsonObject) => { rows(d.sources)[0]!.characterId = 'character:other' }],
  ['foreign branch', (d: WorldJsonObject) => { object(rows(d.sources)[0]!.worldAddress).branchId = 'elsewhere' }],
  ['future source', (d: WorldJsonObject) => { rows(d.sources)[0]!.worldSeq = 21 }],
  ['changed evidence context', (d: WorldJsonObject) => { object(rows(d.facts)[0]!.evidence).context = '他确实来了。' }],
  ['changed source hash', (d: WorldJsonObject) => { rows(d.sources)[0]!.sourceHash = 'different' }],
  ['changed aggregate atom', (d: WorldJsonObject) => { rows(rows(d.episodes)[0]!.eventAtoms)[0]!.text = '已经开门成功' }],
] as const) {
  const changed = structuredClone(archived)
  change(changed)
  await compare(name, 'validate', changed)
}
await compare('prefix source text cannot change', 'retainPrefix', { scope, sources: [{ ...sources[0]!, text: '改变原文' }, ...sources.slice(1)], retainedPrefix: prefix })
await compare('empty archive', 'retain', { scope, sources: [] })
await compare('leading whitespace preserves the first complete sentence and entity', 'retain', { scope, sources: [source(1, 'character:player said: \n我把药留在 location:tea_room。明天再来喝茶。')] }, [{ atoms: [
  { segment_id: 'event:1/part:0', quote: '我把药留在 location:tea_room。' },
  { segment_id: 'event:1/part:0', quote: '明天再来喝茶。' },
] }])
await mkdir('.tmp/node-memory', { recursive: true })
await writeFile('.tmp/node-memory/episodes-parity.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ cases: report.length, passed: true, paidModelCalls: 0 }))
