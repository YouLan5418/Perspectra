import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../../tests/experiments/playtest-frozen-runtime.ts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'

type Ref = { sourceId: string; sourceHash: string; epistemicKind: string;
  worldSeq: number; characterId: string; worldAddress: WorldAddress }
type Unit = { id: string; text: string; kind: string; sourceRefs: Ref[];
  entities?: string[]; sourceFactIds?: string[]; score?: number }
type Source = Ref & { text: string }
type Shadow = { scope: WorldJsonObject; sources: Source[]; representations: Unit[];
  facts: Unit[]; observations: Unit[]; checkpoints: Array<Record<string, unknown>> }
type Recall = { scope: WorldJsonObject; query: string; results: Unit[];
  arms: Record<string, number> }
const rootArg = process.argv[2]
if (!rootArg) throw new Error('provide the completed long-play output directory')
const root = resolve(rootArg)
const base = resolve(root, 'base')
const progress = JSON.parse(readFileSync(resolve(root, 'progress.json'), 'utf8')) as {
  turns: Array<{ turn: number; error: boolean; headSeq: number }>; address: WorldAddress; model: string }
if (progress.turns.length !== 52 || progress.turns.some(t => t.error)) throw new Error('52 successful prior turns required')
const shadow = JSON.parse(readFileSync(resolve(root, 'shadow.json'), 'utf8')) as Shadow
if (shadow.checkpoints.at(-1)?.turn !== 52) throw new Error('Hindsight shadow did not reach turn 52')
const companion = brandId('character:companion', 'CharacterId')
const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
const endpoint = process.env.HCW_LOCAL_ENDPOINT?.trim()
const model = process.env.HCW_LOCAL_MODEL?.trim() || progress.model
const modes = ['existing','core-recall','core-recall-observation'] as const
const onlyModeIndex = process.argv.indexOf('--only-mode')
const onlyMode = onlyModeIndex < 0 ? undefined : process.argv[onlyModeIndex+1]
if (onlyMode !== undefined && !modes.some(mode => mode === onlyMode)) throw new Error('invalid only-mode')
const selectedModes = modes.filter(mode => onlyMode === undefined || mode === onlyMode)
const exploratory = process.argv.includes('--exploratory')
const probes = exploratory ? [
  { id: 'paraphrase', question: '同行者，我们私下定过一句让我别着急的暗号，后来又换了说法。现用的那句是什么？旧的那句又是什么？' },
  { id: 'unfulfilled', question: '我们改过暗号以后，你真的曾在我犹豫做重要决定时用它提醒过我吗？请区分约定和实际做过的事。' },
] : [
  { id: 'history', question: '同行者，关于我私下约定的重要决定提醒，最初的提醒词是什么？后来我改成了什么？请说清楚旧词和新词。' },
  { id: 'current', question: '同行者，如果我现在犹豫要不要去后室，你应该用哪个提醒词提醒我？最初那个词现在还是当前约定吗？' },
]
writeFileSync(resolve(root, exploratory ? 'protocol-exploratory.json' : 'protocol-planned.json'), JSON.stringify({ priorTurns: 52, probes, modes:selectedModes, model,
  exploratory, assessment: ['old reminder remembered', 'latest reminder remembered', 'old/current distinction',
    'private-source isolation', 'source traceability'] }, null, 2))
function core(input: WorldJsonObject): Recall {
  const run = spawnSync(process.env.HCW_HINDSIGHT_PYTHON || 'python', [resolve('experiments/hindsight-core/core.py')], {
    input: JSON.stringify(input), encoding:'utf8', maxBuffer:32*1024*1024, timeout:180_000,
    env:{...process.env, PYTHONIOENCODING:'utf-8'},
  })
  if (run.error || run.status !== 0) throw new Error('Hindsight core: '+(run.error?.message ?? run.stderr.slice(0,2500)))
  return JSON.parse(run.stdout) as Recall
}
function verify(units: Unit[]): void {
  const map = new Map(shadow.sources.map(source => [source.sourceId, source]))
  for (const unit of units) for (const ref of unit.sourceRefs) {
    const source = map.get(ref.sourceId)
    if (source === undefined || source.sourceHash !== ref.sourceHash || source.epistemicKind !== ref.epistemicKind
      || source.worldSeq !== ref.worldSeq || source.characterId !== ref.characterId
      || JSON.stringify(source.worldAddress) !== JSON.stringify(ref.worldAddress)) {
      throw new Error('invalid core evidence: '+unit.id)
    }
  }
}
const world = new WorldStore(resolve(base,'world.sqlite'))
const head = world.head(progress.address)
const ticks = new Map(world.readEvents(progress.address).map(event => [event.seq,event.tick]))
world.close()
if (shadow.scope.asOfWorldSeq !== head.headSeq) throw new Error('shadow and world prefixes diverged')
verify([...shadow.facts,...shadow.observations])
if (shadow.sources.some(source => source.characterId !== companion
  || JSON.stringify(source.worldAddress) !== JSON.stringify(progress.address)
  || source.worldSeq > head.headSeq)) {
  throw new Error('foreign or future source crossed the character boundary')
}
const comparison: Array<Record<string, unknown>> = []
for (const probe of probes) {
  const plain = core({ operation:'recall', scope:shadow.scope, query:probe.question,
    representations:shadow.representations, facts:shadow.facts, observations:[], limit:8 })
  const observed = core({ operation:'recall', scope:shadow.scope, query:probe.question,
    representations:shadow.representations, facts:shadow.facts, observations:shadow.observations, limit:8 })
  verify([...plain.results,...observed.results])
  const recallDir = resolve(root,'recall')
  mkdirSync(recallDir,{recursive:true})
  writeFileSync(resolve(recallDir,probe.id+'.json'),JSON.stringify({plain,observed},null,2))
  for (const mode of selectedModes) {
    const dir = resolve(root,'forks',probe.id,mode)
    if (existsSync(dir)) throw new Error('fork already exists: '+dir)
    mkdirSync(dir,{recursive:true})
    for (const file of readdirSync(base)) if (file.endsWith('.sqlite')) {
      copyFileSync(resolve(base,file),resolve(dir,file))
    }
    const selected = mode === 'core-recall' ? plain : observed
    const memories = selected.results.map(unit => {
      const seq = Math.max(...unit.sourceRefs.map(ref => ref.worldSeq))
      const tick = ticks.get(seq)
      if (tick === undefined) throw new Error('source tick missing: '+seq)
      return { memoryId:unit.id, text:unit.text, kind:unit.kind, sourceRefs:unit.sourceRefs,
        sourceMaxSeq:seq, sourceAgeTicks:head.tick+1-tick,
        sourceAges:unit.sourceRefs.map(ref => ({ sourceId:ref.sourceId,
          sourceAgeTicks:head.tick+1-(ticks.get(ref.worldSeq) ?? head.tick+1) })),
        epistemicKinds:[...new Set(unit.sourceRefs.map(ref => ref.epistemicKind))],
        note:'角色来源的非权威派生记忆；转述和约定不证明相应行动已经发生。' }
    })
    const requests: PrototypeTurnRequest[] = []
    const runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory:dir,
      packPath:resolve('examples/world-packs/hand-in-hand'), provider:'local', model,
      ...(endpoint === undefined ? {} : { utilityEndpoint:endpoint }),
      ...(apiKey === undefined ? {} : { apiKey }), timeoutMs:90_000,
      experimentalCharacterRequest: request => {
        const id = (request.context.character as WorldJsonObject).characterId
        if (id !== companion || mode === 'existing') { requests.push(request); return request }
        const visible: PrototypeTurnRequest = { ...request,
          context:{...request.context,memories},
          ...(request.recallEvidence === undefined ? {} : { recallEvidence:{
            query:request.recallEvidence.query ?? '',memories,
            note:'仅限该角色已授权的非权威来源。' } }),
        }
        requests.push(visible)
        return visible
      },
    })
    try {
      const before = new Set((await runtime.state()).transcript.map(line => line.seq))
      const command = '/act speak '+JSON.stringify({ text:probe.question,
        scope:'private',addresseeIds:[companion] })
      const state = await runtime.submit(command,`hindsight-long-probe:${probe.id}:${mode}`)
      const lines = state.transcript.filter(line => !before.has(line.seq))
        .map(line => ({ speaker:line.speaker, player:line.player, text:line.text }))
      const characterText = lines.filter(line => !line.player).map(line => line.text).join('\n')
      const report = { probe:probe.id, mode, question:probe.question,
        headSeqBefore:head.headSeq, headSeqAfter:(state.debug as {headSeq:number}).headSeq,
        error:state.error, notice:state.notice, lines,
        oldMentioned:characterText.includes('山茶灯'), currentMentioned:characterText.includes('云杉铃'),
        usedCoreSources:mode==='existing' ? [] : selected.results.flatMap(unit => unit.sourceRefs.map(ref => ref.sourceId)),
        sourceKinds:mode==='existing' ? [] : selected.results.map(unit => unit.kind),
        friendSawPrivateReminder:requests.some(request =>
          (request.context.character as WorldJsonObject).characterId === 'character:friend'
          && (JSON.stringify(request).includes('山茶灯') || JSON.stringify(request).includes('云杉铃'))),
        requestMemoryCount:requests.map(request => Array.isArray(request.context.memories)
          ? request.context.memories.length : 0) }
      writeFileSync(resolve(dir,'probe.json'),JSON.stringify({report,requests},null,2))
      comparison.push(report)
      process.stdout.write(JSON.stringify({probe:probe.id,mode,error:state.error,
        oldMentioned:report.oldMentioned,currentMentioned:report.currentMentioned,
        memoryCount:report.requestMemoryCount,lines})+'\n')
    } finally { await runtime.close() }
  }
}
writeFileSync(resolve(root,exploratory ? 'comparison-exploratory.json' : 'comparison-planned.json'),JSON.stringify(comparison,null,2))
