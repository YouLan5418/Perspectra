/** Real one-call Character Turns over a predeclared Delivery intervention. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { brandId, hashWorldJson, worldAddressKey, RECALL_KEYWORD_TOKENIZER_ID,
  type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { hindsightPython } from './hindsight-python.ts'

const root = resolve(process.argv[2] ?? '')
const mode = process.argv[3] ?? '--prepare'
if (!process.argv[2] || !['--prepare', '--run'].includes(mode)) throw new Error('provide directory and --prepare or --run')
const npc = brandId('character:npc', 'CharacterId'), tick = 55, repeats = 3
const conditions = ['full', 'counter-ablated', 'without-cognition']
const probes = [
  { id: 'winner-recall', text: '上次那局猜数字，最后是谁猜中赢了？' },
  { id: 'rematch-choice', text: '下次我们再玩猜数字吧，这回让我先猜，怎么样？' },
  { id: 'unrelated-control', text: '窗边的光线刚好，想一起过去坐坐吗？' },
]
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2))
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as WorldJsonObject
const checksum = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const canary = '仅陆舟可见的私密校验信息'
const cold = (context: WorldJsonObject) => ({ ...context, observations: [], selfObservations: [], memories: [] })

if (mode === '--prepare') {
  if (existsSync(root)) throw new Error('fresh output directory required')
  mkdirSync(root, { recursive: true })
  const history = join(root, 'history'); mkdirSync(history)
  const base = frozenInteractionWorld()
  const address: WorldAddress = { ...base.manifest.address, worldId: brandId('world:delivery-counter-live', 'WorldId') }
  const characters = base.manifest.characters.map(c => ({ ...c, name: c.characterId === npc ? '小芷' : c.characterId === 'character:player' ? '旅人' : '陆舟',
    portrayal: c.characterId === npc ? { summary: '同行的游戏参与者，自行决定如何回应以及尝试什么行动。', speakingStyle: '自然具体，不必长篇分析。' } : null }))
  const manifest = { ...base.manifest, address, characters, metadata: { title: 'Delivery 反证真实角色对照', description: 'authored history; real Character Turns' } }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesis = base.genesisEvents.map(e => e.eventType === 'world.manifest-locked'
    ? { ...e, data: { ...e.data as WorldJsonObject, manifestHash } } : e.eventType === 'character.created'
    ? { ...e, data: { ...e.data as WorldJsonObject, name: characters.find(c => c.characterId === (e.data as WorldJsonObject).characterId)?.name ?? '' } } : e)
  const store = new WorldStore(join(history, 'world.sqlite'))
  const memory = new CognitiveMemoryService(join(history, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
  let authorized: WorldJsonObject
  try {
    store.activateBranch({ address, manifest, manifestHash, genesisEvents: genesis, genesisHash: hashWorldJson('world-genesis-plan', genesis),
      transactionId: brandId('transaction:counter-genesis', 'TransactionId'), roundId: brandId('round:counter-genesis', 'InteractionRoundId'), correlationId: 'counter-genesis' })
    const game = (revision: number, lifecycle: string, active: boolean, description: string): WorldJsonObject => ({
      actorId: 'character:bob', actionType: 'interact', status: 'accepted', resultDescription: description,
      resultMetadata: { activity: { id: 'activity:counter-third', revision, phase: active ? 'playing' : 'ended', round: revision, active, lifecycle } },
    })
    const authored = new Map<number, WorldJsonObject | string>([
      [2, '小芷亲眼见到第一局猜数字结束：小芷先猜中了答案获胜，旅人没有猜中。'],
      [6, '第二次独立的猜数字比赛中，小芷亲眼见到自己先猜中获胜，旅人没有猜中。'],
      [10, game(1, 'started', true, '第三局猜数字开始，参与者是旅人和小芷，陆舟主持。')],
      [12, game(2, 'updated', true, '第三局旅人先猜中答案，主持人正式确认旅人获胜，小芷本局没有获胜。')],
      [13, game(3, 'ended', false, '第三局猜数字正常结算结束，本局交互限制已解除。')],
    ])
    for (let t = 1; t <= tick; t++) {
      const head = store.head(address), content = authored.get(t) ?? '窗边的光线慢慢移向墙面。'
      const events: WorldEventDraft[] = [{ eventType: 'observation.upsert', eventVersion: 1,
        data: { id: 'observation:counter-history:' + t, value: { observerId: npc, content, epistemicKind: typeof content === 'string' ? 'direct_observation' : 'observed_action' } } }]
      if (t === 4) events.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:counter-private',
        value: { observerId: 'character:bob', content: canary, epistemicKind: 'direct_observation' } } })
      await store.commitRound({ address, expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: t,
        transactionId: brandId('transaction:counter-history:' + t, 'TransactionId'),
        roundId: brandId('round:counter-history:' + t, 'InteractionRoundId'), events, outbox: [], correlationId: 'counter-history' })
    }
    const head = store.head(address)
    memory.catchUp(address, npc, head.headSeq, 'counter-live')
    const ticks = new Map(store.readEvents(address).map(e => [e.seq, e.tick]))
    const db = new DatabaseSync(join(history, 'memory.sqlite'), { readOnly: true })
    try {
      type Row = { source_id: string; source_hash: string; epistemic_kind: string; source_seq: number; text_value: string }
      const rows = db.prepare('SELECT source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id')
        .all(worldAddressKey(address) + '\u001f' + npc, head.headSeq) as Row[]
      authorized = { scope: { worldAddress: { ...address }, characterId: npc, asOfWorldSeq: head.headSeq }, sources: rows.map(r => ({
        sourceId: r.source_id, sourceHash: r.source_hash, epistemicKind: r.epistemic_kind, worldSeq: r.source_seq,
        characterId: npc, worldAddress: { ...address }, knownTick: ticks.get(r.source_seq)!, text: r.text_value,
      })) }
    } finally { db.close() }
  } finally { memory.close(); store.close() }
  if (JSON.stringify(authorized).includes(canary)) throw new Error('private source leaked')
  save(join(root, 'authorized.json'), authorized)
  const frozen = Object.fromEntries(['world.sqlite', 'memory.sqlite'].map(f => [f, checksum(join(history, f))]))
  save(join(root, 'protocol.json'), { model: 'gemini-3.7-flash', address, tick, repeats, probes, conditions, frozen,
    maxModelCalls: probes.length * repeats * conditions.length, canary,
    historyMode: '55 authored committed ticks; not a live 55-turn game', naturalRetrieval: false,
    cognitionOrigin: 'researcher authored stale subjective understanding; canonical host-authorized evidence',
    candidateMode: 'explicit intervention; unrelated control predeclares empty candidates',
    objective: ['third-game winner reported correctly', 'rematch choice and certainty', 'no invented causes/motives', 'empty-control variability'],
    controls: ['same nonmemory context per probe', 'one call per trial', 'further recall disabled', 'condition order rotated',
      'no labels/rubric sent to character', 'actions validated and committed only in fresh trial copies'],
    limitations: ['small exploratory sample', 'nonblind qualitative reading', 'not natural consolidation or retrieval acceptance'] })
  for (const probe of probes) {
    const dir = join(root, probe.id + '-preview'); mkdirSync(dir)
    for (const f of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(history, f), join(dir, f))
    const s = new WorldStore(join(dir, 'world.sqlite')), m = new CognitiveMemoryService(join(dir, 'memory.sqlite'), s, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    const leases = new WriterLeaseService(join(dir, 'world.sqlite')), availability = new CharacterRuntimeAvailabilityService(join(dir, 'world.sqlite'))
    try {
      const turn = new PrototypeCharacterTurn({ address, store: s, memory: m, leases, availability,
        rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }), projectContext: cold,
        decide: async request => {
          save(join(root, probe.id + '-request.json'), request)
          const input = { authorized, request, tick, stimulus: probe.text, probe: probe.id }
          const child = spawnSync(hindsightPython(), [resolve('experiments/activity-memory/prepare_counter_live.py')], {
            input: JSON.stringify(input), encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024,
            windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          })
          if (child.error || child.status !== 0) throw new Error('preparation failed: ' + child.stderr.slice(-2000))
          const prepared = JSON.parse(child.stdout) as WorldJsonObject
          if (JSON.stringify(prepared).includes(canary)) throw new Error('private source leaked into projection')
          save(join(root, probe.id + '-prepared.json'), prepared)
          return { decision: 'abstain' }
        } })
      const result = await turn.run(npc, { stimulus: [{ observerId: npc, content: { actorId: 'character:player', actionType: 'speak',
        speech: { characterId: 'character:player', text: probe.text } } }], maxCalls: 1 })
      if (result.status !== 'abstained' || !existsSync(join(root, probe.id + '-prepared.json'))) throw new Error('preview failed')
    } finally { m.close(); availability.close(); leases.close(); s.close() }
  }
  for (const f of Object.keys(frozen)) if (checksum(join(history, f)) !== frozen[f]) throw new Error('history mutated')
  save(join(root, 'prepared.json'), { ready: true, newModelCalls: 0, sourceIsolationChecked: true })
  console.log(JSON.stringify({ prepared: true, root, plannedCharacterCalls: 27, newModelCalls: 0 }))
} else {
  if (!existsSync(join(root, 'prepared.json')) || existsSync(join(root, 'trials.jsonl'))) throw new Error('prepare once, then run once')
  const protocol = load(join(root, 'protocol.json')), address = protocol.address as unknown as WorldAddress
  const history = join(root, 'history'), frozen = protocol.frozen as WorldJsonObject
  let transportPath: string | undefined
  const provider = createChatProvider({ fetch: async (input, init) => {
    const response = await fetch(input, init)
    if (transportPath !== undefined) {
      const body = await response.clone().text()
      save(transportPath, { status: response.status, body })
    }
    return response
  }, endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions'),
    model: String(protocol.model), timeoutMs: 90000, maxOutputTokens: 1600,
    ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
  const canonical = new Map<string, string>(), trials: WorldJsonObject[] = []
  for (const probe of probes) {
    const prepared = load(join(root, probe.id + '-prepared.json')), variants = prepared.conditions as WorldJsonObject
    for (let repeat = 0; repeat < repeats; repeat++) {
      const ordered = [...conditions.slice(repeat), ...conditions.slice(0, repeat)]
      for (const condition of ordered) {
        const dir = join(root, probe.id + '-' + repeat + '-' + condition); mkdirSync(dir)
        for (const f of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(history, f), join(dir, f))
        const store = new WorldStore(join(dir, 'world.sqlite')), memory = new CognitiveMemoryService(join(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
        const leases = new WriterLeaseService(join(dir, 'world.sqlite')), availability = new CharacterRuntimeAvailabilityService(join(dir, 'world.sqlite'))
        const before = store.head(address).headSeq
        let calls = 0, returned = false
        try {
          const turn = new PrototypeCharacterTurn({ address, store, memory, leases, availability,
            rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }), projectContext: cold,
            validateDecision: decision => { if (decision.decision === 'recall') throw new Error('one-choice experiment disables recall') },
            decide: async (request, signal) => {
              const memories = variants[condition] as WorldJsonObject[]
              const visible: PrototypeTurnRequest = { ...request, canRecall: false, context: { ...request.context, memories } }
              const comparison = JSON.stringify({ ...visible, context: { ...visible.context, memories: [] } })
              if (canonical.has(probe.id) && canonical.get(probe.id) !== comparison) throw new Error('nonmemory context changed')
              canonical.set(probe.id, comparison)
              if (JSON.stringify(visible).includes(canary)) throw new Error('private context leaked')
              const record: WorldJsonObject = { probe: probe.id, repeat, condition, request: visible as unknown as WorldJsonObject, status: 'pending' }
              save(join(dir, 'call.json'), record); calls++
              const start = performance.now()
              transportPath = join(dir, 'transport.json')
              const response = await provider.decide(localPrototypeTurnCall(visible), signal)
              returned = true
              save(join(dir, 'call.json'), { ...record, status: 'returned', durationMs: Math.round(performance.now() - start), response })
              return response
            } })
          const result = await turn.run(npc, { stimulus: [{ observerId: npc, content: { actorId: 'character:player', actionType: 'speak',
            speech: { characterId: 'character:player', text: probe.text } } }], maxCalls: 1, signal: AbortSignal.timeout(120000) })
          const events = store.readEvents(address).filter(e => e.seq > before)
          const row: WorldJsonObject = { probe: probe.id, repeat, condition, calls, returned,
            result: result as unknown as WorldJsonObject, events: events as unknown as WorldJsonObject[],
            privateContextAbsent: true, originalHistoryUnchanged: Object.keys(frozen).every(f => checksum(join(history, f)) === frozen[f]) }
          if (!row.originalHistoryUnchanged) throw new Error('frozen history changed')
          save(join(dir, 'result.json'), row); appendFileSync(join(root, 'trials.jsonl'), JSON.stringify(row) + '\n'); trials.push(row)
          console.log(JSON.stringify({ probe: probe.id, repeat, condition, returned, status: result.status }))
          if (result.failure === 'provider_failed') throw new Error('provider failed; recorded trial, stopping further calls')
        } finally { memory.close(); availability.close(); leases.close(); store.close() }
      }
    }
  }
  save(join(root, 'summary.json'), { trials: trials.length, calls: trials.reduce((n, r) => n + Number(r.calls), 0),
    returned: trials.filter(r => r.returned).length, originalHistoryUnchanged: true, nonmemoryContextIdentical: true,
    limits: 'delivery intervention; no natural retrieval claim; qualitative behavior assessment still required' })
}
