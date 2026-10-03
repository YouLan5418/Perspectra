import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, worldAddressKey, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { FrozenWorldPlaytestRuntime } from '../../tests/experiments/playtest-frozen-runtime.ts'

export type Ref = { sourceId: string; sourceHash: string; epistemicKind: string;
  worldSeq: number; characterId: string; worldAddress: WorldAddress }
export type Unit = { id: string; text: string; kind: string; sourceRefs: Ref[];
  entities?: string[]; sourceFactIds?: string[] }
type Source = Ref & { text: string }
type Shadow = { scope: WorldJsonObject; sources: Source[]; representations: Unit[];
  facts: Unit[]; observations: Unit[]; checkpoints: Array<Record<string, unknown>> }
type SourceRow = { source_id: string; source_seq: number; source_hash: string;
  epistemic_kind: string; text_value: string }

const rootArg = process.argv[2]
if (!rootArg) throw new Error('provide a long-play output directory')
const root = resolve(rootArg)
const base = resolve(root, 'base')
mkdirSync(base, { recursive: true })
const progressPath = resolve(root, 'progress.json')
const shadowPath = resolve(root, 'shadow.json')
const model = process.env.HCW_LOCAL_MODEL?.trim() || 'gemini-3.7-flash'
const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex < 0 ? 'existing' : process.argv[modeIndex+1]
if (mode !== 'existing' && mode !== 'core-recall' && mode !== 'core-recall-observation') {
  throw new Error('invalid memory mode')
}
const endpoint = process.env.HCW_LOCAL_ENDPOINT?.trim()
const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
const companion = brandId('character:companion', 'CharacterId')
const texts = [
  '同行者，我只告诉你：重要决定前的提醒词是山茶灯。如果我犹豫，请先提醒我慢一点。先不要告诉留守者。',
  '我们先看看前室的桌子，别急着做决定。',
  '黄铜钥匙还在桌面上，我想先观察它。',
  '那只保温瓶看起来有些旧，你注意到了吗？',
  '我想听听你们各自对这间屋子的第一印象。',
  '先不要移动钥匙，我还没有想好是否带走。',
  '门缝透进来的光似乎比刚才弱了。',
  '我在桌边坐一会儿，把刚才的事理一理。',
  '留守者，你怎么看前室和后室之间的门？',
  '我还是想让大家自己决定要不要说话。',
  '我摸了摸桌沿，又把手收回来。',
  '钥匙的形状挺特别，但我暂时不拿它。',
  '保温瓶先留在原地，等需要时再处理。',
  '我听了一会儿门外的声音，没有急着出去。',
  '我们可以先讨论一下进入后室的风险。',
  '我现在更关心你们各自真正看到了什么。',
  '谁也不用替别人决定接下来应该怎么做。',
  '我往门口走了两步，又停住了。',
  '桌上的东西仍留在那里，我想先保持现状。',
  '留守者，如果你想休息，可以先休息。',
  '同行者，你可以直接告诉我你不同意的地方。',
  '我想把门的状况和钥匙的状况分开考虑。',
  '这里的光线变了，但我不能因此断定外面发生了什么。',
  '我们已经谈了很久，先让屋里安静一会儿。',
  '我把注意力重新放到前室的门上。',
  '等真正做决定时，我会先说清楚自己打算做什么。',
  '现在我还没决定是否要去后室。',
  '同行者，我只对你修订先前的提醒约定：从现在起用云杉铃提醒我慢一点。山茶灯是旧提醒词，不要把换词说成已经完成了什么行动。',
  '我想再核对一下桌上的保温瓶有没有被人动过。',
  '门后有没有人，我目前没有证据。',
  '我只是站在原地听，并没有打开门。',
  '留守者，你自己想接下来做什么？',
  '同行者，如果有不同意见请你直接说。',
  '我们可以暂时不碰任何物品。',
  '我注意到刚才的讨论让我们都谨慎起来。',
  '我把椅子往桌边挪了一点，又坐下。',
  '我想知道前室是否还有遗漏的细节。',
  '今天我们说过不少事情，还是以亲眼所见为准。',
  '我望向后室的方向，但还没有过去。',
  '黄铜钥匙也许有用，不过现在仍在原处。',
  '先把谁说了什么和真正做了什么分开记。',
  '保温瓶的归属我没有改变。',
  '如果有谁想离开，可以先说出自己的意愿。',
  '我仍然站在前室里，没有把门推开。',
  '我们可以把关于后室的猜想留到以后验证。',
  '我想休息一下，再决定下一步。',
  '我重新打量桌面和门把手。',
  '我没有拿起钥匙，也没有把它交给别人。',
  '留守者，你刚才的想法有没有变化？',
  '同行者，我会自己决定行动，你可以提出提醒。',
  '这段对话很长了，我先把手头的事停下来。',
  '等会儿我想核对我们早先的提醒约定；此刻先不用回答。',
] as const
if (texts.length !== 52) throw new Error('long-play corpus must contain exactly 52 turns')
const turns = texts.map((text, index) => '/act speak ' + JSON.stringify(index === 0 || index === 27
  ? { text, scope: 'private', addresseeIds: [companion] } : { text }))
const stopIndex = process.argv.indexOf('--stop-after')
const stopAfter = stopIndex < 0 ? turns.length : Math.min(turns.length, Number(process.argv[stopIndex+1]))
const started: { turns: Array<Record<string, unknown>>; address?: WorldAddress } = existsSync(progressPath)
  ? JSON.parse(readFileSync(progressPath, 'utf8')) as { turns: Array<Record<string, unknown>>; address: WorldAddress }
  : { turns: [] }
let shadow: Shadow | undefined = existsSync(shadowPath) ? JSON.parse(readFileSync(shadowPath, 'utf8')) as Shadow : undefined
function core(input: WorldJsonObject): Record<string, unknown> {
  const run = spawnSync(process.env.HCW_HINDSIGHT_PYTHON || 'python', [resolve('experiments/hindsight-core/core.py')], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (run.error || run.status !== 0) throw new Error('Hindsight core: '+(run.error?.message ?? run.stderr.slice(0, 2000)))
  return JSON.parse(run.stdout) as Record<string, unknown>
}
function verify(units: Unit[], sources: Source[]): void {
  const map = new Map(sources.map(source => [source.sourceId, source]))
  for (const unit of units) for (const ref of unit.sourceRefs) {
    const found = map.get(ref.sourceId)
    if (found === undefined || found.sourceHash !== ref.sourceHash || found.epistemicKind !== ref.epistemicKind
      || found.worldSeq !== ref.worldSeq || found.characterId !== ref.characterId
      || JSON.stringify(found.worldAddress) !== JSON.stringify(ref.worldAddress)) {
      throw new Error('derived unit lost authorized source mapping: '+unit.id)
    }
  }
}
async function checkpoint(address: WorldAddress, turn: number): Promise<void> {
  const store = new WorldStore(resolve(base, 'world.sqlite'))
  let memory: CognitiveMemoryService | undefined
  try {
    const head = store.head(address)
    memory = new CognitiveMemoryService(resolve(base, 'memory.sqlite'), store, undefined, 2)
    memory.catchUp(address, companion, head.headSeq, `hindsight-long:${turn}`)
    const db = new DatabaseSync(resolve(base, 'memory.sqlite'), { readOnly: true })
    let rows: SourceRow[]
    try {
      rows = db.prepare('SELECT source_id, source_seq, source_hash, epistemic_kind, text_value '
        + 'FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND source_seq <= ? ORDER BY source_seq, source_id')
        .all(worldAddressKey(address) + '\u001f' + companion, head.headSeq) as SourceRow[]
    } finally { db.close() }
    const scope: WorldJsonObject = { worldAddress: address, characterId: companion, asOfWorldSeq: head.headSeq }
    shadow ??= { scope, sources: [], representations: [], facts: [], observations: [], checkpoints: [] }
    const known = new Set(shadow.sources.map(source => source.sourceId))
    const incoming: Source[] = rows.filter(row => !known.has(row.source_id)).map(row => ({
      sourceId: row.source_id, sourceHash: row.source_hash, epistemicKind: row.epistemic_kind,
      worldSeq: row.source_seq, characterId: companion, worldAddress: address, text: row.text_value,
    }))
    const retained = incoming.length ? core({ operation: 'retain', scope, sources: incoming }) : {
      representations: [], facts: [] }
    const representations = retained.representations as Unit[]
    const facts = retained.facts as Unit[]
    verify([...representations, ...facts], incoming)
    const nextSources = [...shadow.sources, ...incoming]
    const consolidated = facts.length ? core({ operation: 'consolidate', scope, representations: [],
      facts, observations: shadow.observations }) : { observations: shadow.observations,
      actions: { creates: [], updates: [], deletes: [] } }
    const observations = consolidated.observations as Unit[]
    verify(observations, nextSources)
    shadow = { scope, sources: nextSources, representations: [...shadow.representations, ...representations],
      facts: [...shadow.facts, ...facts], observations,
      checkpoints: [...shadow.checkpoints, { turn, worldSeq: head.headSeq, incoming: incoming.length,
        facts: facts.length, observations: observations.length, actions: consolidated.actions }] }
    writeFileSync(shadowPath, JSON.stringify(shadow, null, 2))
    process.stdout.write(JSON.stringify({ checkpoint: turn, incoming: incoming.length,
      facts: facts.length, observations: observations.length })+'\n')
  } finally { memory?.close(); store.close() }
}
let activeTurnText = ''
let activeTurnNumber = 0
function adaptRequest(request: import('../../packages/application/src/prototype-character-turn.ts').PrototypeTurnRequest) {
  if (mode === 'existing' || shadow === undefined
    || (request.context.character as WorldJsonObject).characterId !== companion) return request
  const query = typeof request.recallEvidence?.query === 'string'
    ? request.recallEvidence.query : activeTurnText
  const selected = core({ operation: 'recall', scope: shadow.scope, query,
    representations: shadow.representations, facts: shadow.facts,
    observations: mode === 'core-recall-observation' ? shadow.observations : [], limit: 8 }) as {
    results: Array<Unit & { score: number }> }
  verify(selected.results, shadow.sources)
  const readable = new WorldStore(resolve(base, 'world.sqlite'))
  let currentTick: number, sourceTicks: Map<number, number>
  try {
    currentTick = readable.head(shadow.scope.worldAddress as WorldAddress).tick
    sourceTicks = new Map(readable.readEvents(shadow.scope.worldAddress as WorldAddress)
      .map(event => [event.seq, event.tick]))
  } finally { readable.close() }
  const memories = selected.results.map(unit => {
    const sourceAges = unit.sourceRefs.map(ref => ({ sourceId: ref.sourceId,
      sourceAgeTicks: currentTick - (sourceTicks.get(ref.worldSeq) ?? currentTick) }))
    return { memoryId: unit.id, text: unit.text, kind: unit.kind, sourceRefs: unit.sourceRefs,
      sourceMaxSeq: Math.max(...unit.sourceRefs.map(ref => ref.worldSeq)),
      sourceAgeTicks: Math.min(...sourceAges.map(age => age.sourceAgeTicks)), sourceAges,
      epistemicKinds: [...new Set(unit.sourceRefs.map(ref => ref.epistemicKind))],
      note: 'Derived character memory; reported speech and intentions are not completed world facts.' }
  })
  const visible = { ...request, context: { ...request.context, memories },
    ...(request.recallEvidence === undefined ? {} : { recallEvidence: { query, memories,
      note: 'Only this character authorized non-authoritative sources.' } }) }
  const path = resolve(root, 'adapted.jsonl')
  writeFileSync(path, JSON.stringify({ turn: activeTurnNumber, mode, query,
    asOfWorldSeq: shadow.scope.asOfWorldSeq,
    selected: selected.results.map(unit => ({ id: unit.id, sourceRefs: unit.sourceRefs })) })+'\n', { flag: 'a' })
  return visible
}
const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: base,
  packPath: resolve('examples/world-packs/hand-in-hand'), provider: 'local', model,
  ...(endpoint === undefined ? {} : { utilityEndpoint: endpoint }),
  ...(apiKey === undefined ? {} : { apiKey }), timeoutMs: 90_000,
  ...(mode === 'existing' ? {} : { experimentalCharacterRequest: adaptRequest }) })
const address = runtime.address
if (started.address !== undefined && JSON.stringify(started.address) !== JSON.stringify(address)) {
  throw new Error('resumed world address changed')
}
try {
  for (let index = started.turns.length; index < stopAfter; index += 1) {
    activeTurnText = texts[index]!
    activeTurnNumber = index + 1
    const before = new Set((await runtime.state()).transcript.map(line => line.seq))
    const state = await runtime.submit(turns[index]!, `hindsight-long:turn:${index+1}`)
    const newLines = state.transcript.filter(line => !before.has(line.seq))
      .map(line => ({ speaker: line.speaker, player: line.player, text: line.text }))
    const record = { turn: index+1, input: turns[index], headSeq: (state.debug as {headSeq:number}).headSeq,
      notice: state.notice, error: state.error, lines: newLines }
    started.turns.push(record)
    writeFileSync(progressPath, JSON.stringify({ model, mode, address, turns: started.turns }, null, 2))
    process.stdout.write(JSON.stringify({ turn: index+1, headSeq: record.headSeq, error: state.error,
      lineCount: newLines.length, notice: state.notice })+'\n')
    if (state.error) throw new Error('turn '+(index+1)+' reported error; inspect progress before continuing')
    if ((index+1)%10===0 || index+1===stopAfter) await checkpoint(address,index+1)
  }
} finally { await runtime.close() }
process.stdout.write(JSON.stringify({ mode, completedTurns: started.turns.length, sourceCount: shadow?.sources.length,
  factCount: shadow?.facts.length, observationCount: shadow?.observations.length, root })+'\n')
