import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, hashWorldJson, RECALL_KEYWORD_TOKENIZER_ID, worldAddressKey,
  type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { localPrototypeTurnCall } from '../../tests/experiments/local-prototype-turn-call.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../../tests/fixtures/frozen-interaction-world.ts'

type SourceRow = { source_id: string; source_seq: number; source_hash: string;
  epistemic_kind: string; text_value: string }
type Ref = { sourceId: string; sourceHash: string; epistemicKind: string;
  worldSeq: number; characterId: string; worldAddress: WorldJsonObject }
type Unit = { id: string; text: string; kind: string; sourceRefs: Ref[];
  entities?: string[]; evidenceQuote?: string; sourceFactIds?: string[] }
type CoreResult = { scope: WorldJsonObject; representations?: Unit[]; facts?: Unit[];
  observations?: Unit[]; results?: (Unit & { score: number })[]; actions?: WorldJsonObject; stats?: WorldJsonObject }

const rootArg = process.argv[2]
if (!rootArg) throw new Error('provide a new output directory')
const root = resolve(rootArg)
if (existsSync(root)) throw new Error('output directory already exists')
mkdirSync(root, { recursive: true })
const model = process.env.HCW_LOCAL_MODEL?.trim() || 'gemini-3.7-flash'
const endpoint = process.env.HCW_LOCAL_ENDPOINT?.trim() || 'http://127.0.0.1:8045/v1/chat/completions'
const apiKey = process.env.HCW_LOCAL_API_KEY?.trim()
const provider = createChatProvider({ endpoint: new URL(endpoint), model,
  ...(apiKey === undefined ? {} : { apiKey }), toolName: 'character_decision', timeoutMs: 90_000 })
const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const player = brandId('character:player', 'CharacterId')
const question = '那件喝水用的器皿最初是谁收走的？鲍勃后来怎么说？请区分你看到的事和他声称的事。'
const corePath = resolve('experiments/hindsight-core/core.py')
function core(input: WorldJsonObject): CoreResult {
  const run = spawnSync(process.env.HCW_HINDSIGHT_PYTHON || 'python', [corePath], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (run.error || run.status !== 0) throw new Error(`core failed: ${run.error?.message ?? run.stderr.slice(0, 6000)}`)
  return JSON.parse(run.stdout) as CoreResult
}
const observation = (id: string, observerId: string, content: WorldJsonObject): WorldEventDraft => ({
  eventType: 'observation.upsert', eventVersion: 1, data: { id, value: { observerId, content } },
})
const eventsFor = (world: ReturnType<typeof frozenInteractionWorld>): WorldEventDraft[] => {
  const transfer: WorldEventDraft = { eventType: 'entity.transferred', eventVersion: 1, data: {
    entityId: 'entity:cup', characterId: bob, interactionId: 'base:take',
    fromHolderId: null, fromLocationId: 'location:room', toHolderId: bob, toLocationId: null,
  } }
  return [...world.genesisEvents, transfer,
    observation('observation:actual-transfer', npc, { actorId: bob, actionType: 'interact', status: 'accepted',
      interaction: transfer.data, resultDescription: '鲍勃取得了杯子的保管。' }),
    observation('observation:false-report', npc, { actorId: bob, actionType: 'speak', status: 'accepted',
      speech: { characterId: bob, text: '我早把杯子交给玩家了。' } }),
    observation('observation:private-other', bob, { actorId: player, actionType: 'speak', status: 'accepted',
      speech: { characterId: player, text: '只对鲍勃说：密码是深海灯。' } }),
    ...Array.from({ length: 18 }, (_, n) => observation(`observation:filler-${n}`, npc,
      { actorId: player, actionType: 'speak', status: 'accepted',
        speech: { characterId: player, text: `今天雨还没停，我们已经等了${n + 1}分钟。` } })),
    observation('observation:question', npc, { actorId: player, actionType: 'speak', status: 'accepted',
      speech: { characterId: player, text: question } }),
  ]
}
let prepared: { scope: WorldJsonObject; representations: Unit[]; facts: Unit[]; observations: Unit[];
  recall: CoreResult; recallObservation: CoreResult } | undefined
const summary: Array<Record<string, unknown>> = []
for (const mode of ['existing', 'core-recall', 'core-recall-observation'] as const) {
  const dir = resolve(root, mode)
  mkdirSync(dir)
  const worldPath = resolve(dir, 'world.sqlite')
  const store = new WorldStore(worldPath)
  const leases = new WriterLeaseService(worldPath)
  const availability = new CharacterRuntimeAvailabilityService(worldPath)
  let memory: CognitiveMemoryService | undefined
  try {
    const world = frozenInteractionWorld()
    const events = eventsFor(world)
    store.activateBranch({ ...world, genesisEvents: events, genesisHash: hashWorldJson('world-genesis-plan', events),
      address: world.manifest.address, transactionId: brandId('transaction:hindsight-core', 'TransactionId'),
      roundId: brandId('round:hindsight-core', 'InteractionRoundId'), correlationId: 'hindsight-core-experiment' })
    const head = store.head(world.manifest.address)
    memory = new CognitiveMemoryService(resolve(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    memory.catchUp(world.manifest.address, npc, head.headSeq, 'hindsight-core:'+mode)
    const db = new DatabaseSync(resolve(dir, 'memory.sqlite'), { readOnly: true })
    let rows: SourceRow[]
    try {
      rows = db.prepare('SELECT source_id, source_seq, source_hash, epistemic_kind, text_value '
        + 'FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND source_seq <= ? ORDER BY source_seq, source_id')
        .all(worldAddressKey(world.manifest.address) + '\u001f' + npc, head.headSeq) as SourceRow[]
    } finally { db.close() }
    const history = store.readEvents(world.manifest.address)
    const privateSeq = history.find(e => (e.data as WorldJsonObject).id === 'observation:private-other')?.seq
    const questionSeq = history.find(e => (e.data as WorldJsonObject).id === 'observation:question')?.seq
    if (questionSeq === undefined) throw new Error('question event missing')
    rows = rows.filter(row => row.source_seq < questionSeq)
    if (privateSeq === undefined || rows.some(row => row.source_seq === privateSeq || row.text_value.includes('深海灯'))) {
      throw new Error('character-scoped source export leaked private information')
    }
    const scope: WorldJsonObject = { worldAddress: world.manifest.address, characterId: npc, asOfWorldSeq: head.headSeq }
    const sources = rows.map(row => ({ sourceId: row.source_id, sourceHash: row.source_hash,
      epistemicKind: row.epistemic_kind, worldSeq: row.source_seq, characterId: npc,
      worldAddress: world.manifest.address, text: row.text_value }))
    if (prepared === undefined) {
      const retained = core({ operation: 'retain', scope, sources })
      const recall = core({ operation: 'recall', scope, query: question,
        representations: retained.representations!, facts: retained.facts!, observations: [] })
      const consolidated = core({ operation: 'consolidate', scope,
        representations: retained.representations!, facts: retained.facts!, observations: [] })
      const recallObservation = core({ operation: 'recall', scope, query: question,
        representations: retained.representations!, facts: retained.facts!, observations: consolidated.observations! })
      prepared = { scope, representations: retained.representations!, facts: retained.facts!,
        observations: consolidated.observations!, recall, recallObservation }
      writeFileSync(resolve(root, 'core-artifacts.json'), JSON.stringify({ scope, sources, retained, consolidated,
        recall, recallObservation }, null, 2))
    } else if (JSON.stringify(sources) !== JSON.stringify(JSON.parse(
      readFileSync(resolve(root, 'core-artifacts.json'), 'utf8')).sources)) {
      throw new Error('mode inputs diverged')
    }
    const selected = mode === 'core-recall' ? prepared.recall : prepared.recallObservation
    const sourceById = new Map(sources.map(source => [source.sourceId, source]))
    for (const item of [...prepared.facts, ...prepared.observations, ...(selected.results ?? [])]) {
      for (const ref of item.sourceRefs) {
        const source = sourceById.get(ref.sourceId)
        if (source === undefined || source.sourceHash !== ref.sourceHash
          || source.epistemicKind !== ref.epistemicKind || source.worldSeq !== ref.worldSeq
          || source.characterId !== ref.characterId
          || JSON.stringify(source.worldAddress) !== JSON.stringify(ref.worldAddress)) {
          throw new Error('derived evidence lost its authorized source mapping')
        }
      }
    }
    const requests: PrototypeTurnRequest[] = [], decisions: unknown[] = []
    const sourceTicks = new Map(history.map(e => [e.seq, e.tick]))
    const asMemories = (result: CoreResult) => (result.results ?? []).map(item => ({
      memoryId: item.id, text: item.text, sourceRefs: item.sourceRefs, kind: item.kind,
      sourceMaxSeq: Math.max(...item.sourceRefs.map(ref => ref.worldSeq)),
      sourceAgeTicks: head.tick - (sourceTicks.get(Math.max(...item.sourceRefs.map(ref => ref.worldSeq))) ?? head.tick),
      score: item.score, epistemicKinds: [...new Set(item.sourceRefs.map(ref => ref.epistemicKind))],
      note: '角色来源的非权威派生记忆；转述不证明所述事情已经发生。',
    }))
    const before = store.head(world.manifest.address).headSeq
    const turn = new PrototypeCharacterTurn({ address: world.manifest.address, store, memory, leases, availability,
      rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
      decide: async (request, signal) => {
        const visible: PrototypeTurnRequest = mode === 'existing' ? request : {
          ...request,
          context: { ...request.context, memories: asMemories(selected) },
          ...(request.recallEvidence === undefined ? {} : { recallEvidence: {
            query: request.recallEvidence.query ?? '', memories: asMemories(selected),
            note: '角色授权来源的非权威证据；不要把转述当成已发生的事实。',
          } }),
        }
        if (JSON.stringify(visible).includes('深海灯')) throw new Error('private phrase reached Character Turn')
        requests.push(visible)
        const answer = await provider.decide(localPrototypeTurnCall(visible), signal)
        decisions.push(answer)
        return answer
      } })
    const result = await turn.run(npc, { maxCalls: 1, stimulus: [{ sourceText: question, actorId: player }] })
    const afterEvents = store.readEvents(world.manifest.address)
    const report = { mode, question, result, decisions,
      initialMemoryCount: Array.isArray(requests[0]?.context.memories) ? requests[0].context.memories.length : 0,
      coreSourceIds: mode === 'existing' ? [] : (selected.results ?? []).flatMap(r => r.sourceRefs.map(ref => ref.sourceId)),
      privateLeak: JSON.stringify(requests).includes('深海灯'),
      worldStateChangeFromMemory: afterEvents.slice(before).some(e => e.eventType === 'entity.transferred'),
      publishedSpeech: afterEvents.slice(before).filter(e => e.eventType === 'observation.upsert')
        .map(e => e.data).slice(0, 4) }
    writeFileSync(resolve(dir, 'turn.json'), JSON.stringify({ report, requests }, null, 2))
    summary.push(report)
    process.stdout.write(JSON.stringify({ mode, result, decisions, initialMemoryCount: report.initialMemoryCount,
      privateLeak: report.privateLeak }) + '\n')
  } finally { memory?.close(); availability.close(); leases.close(); store.close() }
}
writeFileSync(resolve(root, 'comparison.json'), JSON.stringify(summary, null, 2))
