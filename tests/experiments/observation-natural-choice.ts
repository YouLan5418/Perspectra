/** Frozen owned bank, natural retrieval, real validated initial choices. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { brandId, RECALL_KEYWORD_TOKENIZER_ID, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { hindsightPython } from './hindsight-python.ts'

const root = resolve(process.argv[2] ?? ''), mode = process.argv[3] ?? '--prepare'
if (!process.argv[2] || !['--prepare', '--run'].includes(mode)) throw new Error('provide fresh directory and --prepare or --run')
const bankRoot = resolve('.tmp/observation-bank-20261004-v1')
const retrievalRoot = resolve('.tmp/observation-lineage-retrieval-20261004-v1')
const lineageRoot = resolve('.tmp/observation-lineage-20261004-v1')
const npc = brandId('character:npc', 'CharacterId'), repeats = 3
const conditions = ['natural-full', 'target-removed', 'no-observations']
const probes = [
  { id: 'new-building', actorId: 'character:player', text: '这栋办事楼我们都是头一回来。登记材料在隔壁小屋，我之前查过位置，先一起过去吧。' },
  { id: 'fresh-map-control', actorId: 'character:player', text: '我们第一次来这栋办事楼，不过我刚核对了今天更新的地图，登记材料就在隔壁小屋。一起过去吧。' },
  { id: 'familiar-control', actorId: 'character:player', text: '这是我们经常来的地方，隔壁小屋的老位置没有变。我来带路，我们过去吧。' },
  { id: 'other-person-control', actorId: 'character:bob', text: '这栋办事楼我们都是头一回来。登记材料在隔壁小屋，我之前查过位置，先一起过去吧。' },
]
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2))
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as WorldJsonObject
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const cold = (context: WorldJsonObject) => ({ ...context, observations: [], selfObservations: [], memories: [] })
const stimulus = (probe: typeof probes[number]) => [{ observerId: npc, content: { actorId: probe.actorId,
  actionType: 'speak', speech: { characterId: probe.actorId, text: probe.text } } }]
const unchanged = (frozen: WorldJsonObject) => Object.entries(frozen).every(([path, digest]) => hash(path) === digest)

if (mode === '--prepare') {
  if (existsSync(root)) throw new Error('fresh output directory required')
  mkdirSync(root, { recursive: true }); mkdirSync(join(root, 'history'))
  const inputFiles = [join(retrievalRoot, 'prepared.json'), join(bankRoot, 'authorized-at-probe.json'),
    join(lineageRoot, 'bank-update.json'), ...['world.sqlite', 'memory.sqlite'].map(f => join(bankRoot, 'history', f))]
  const frozen = Object.fromEntries(inputFiles.map(p => [p, hash(p)]))
  const prepared = load(join(retrievalRoot, 'prepared.json'))['B-continuity'] as WorldJsonObject
  const archive = prepared.archive as WorldJsonObject, scope = archive.scope as WorldJsonObject
  const address = scope.worldAddress as unknown as WorldAddress
  const authorized = load(join(bankRoot, 'authorized-at-probe.json'))
  if (JSON.stringify(archive.sources) !== JSON.stringify(authorized.sources)) throw new Error('bank is not the authorized prefix')
  const revision = load(join(lineageRoot, 'bank-update.json'))
  const target = String((revision.current as WorldJsonObject[])[0]!.id)
  if (JSON.stringify(prepared).includes('雪青密码')) throw new Error('private source leaked')
  save(join(root, 'bank.json'), prepared); save(join(root, 'authorized.json'), authorized)
  for (const f of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(bankRoot, 'history', f), join(root, 'history', f))
  save(join(root, 'protocol.json'), { model: 'gemini-3.7-flash', address: { ...address }, repeats, probes, conditions,
    frozen, target, stage: 'B-continuity', candidateBudget: 7, deliveryBudget: 3, maxJsonChars: 4500,
    maxCharacterCalls: 36, maxJevCalls: 12, tick: 55, naturalRetrievalWithinBank: true,
    controls: ['no forced target', 'actual query per stimulus', 'one JEV draw per repeat shared by three conditions',
      'same nonmemory context', 'one initial Character Turn call', 'recall disabled after automatic selection', 'rotated condition order'],
    objective: ['target shortlist/RELATED/read status', 'accepted move vs ask before moving',
      'fresh map and familiar exceptions', 'subject mismatch', 'failures separate from abstain'],
    limits: ['frozen synthetic bank except original formed understanding', 'authored history not continuous live play',
      'new-building/fresh-map/object probes new; familiar stimulus reused', 'nonblind exploratory reading', 'no runtime schema changes'] })
  for (const probe of probes) {
    const dir = join(root, probe.id + '-preview'); mkdirSync(dir)
    for (const f of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(root, 'history', f), join(dir, f))
    const store = new WorldStore(join(dir, 'world.sqlite')), memory = new CognitiveMemoryService(join(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    const leases = new WriterLeaseService(join(dir, 'world.sqlite')), availability = new CharacterRuntimeAvailabilityService(join(dir, 'world.sqlite'))
    try {
      if (store.head(address).headSeq !== scope.asOfWorldSeq || store.head(address).tick !== 55) throw new Error('history snapshot differs')
      const turn = new PrototypeCharacterTurn({ address, store, memory, leases, availability, projectContext: cold,
        rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
        decide: async request => { save(join(root, probe.id + '-request.json'), request); return { decision: 'abstain' } } })
      const result = await turn.run(npc, { stimulus: stimulus(probe), maxCalls: 1 })
      if (result.status !== 'abstained') throw new Error('preview failed')
    } finally { memory.close(); availability.close(); leases.close(); store.close() }
  }
  if (!unchanged(frozen)) throw new Error('frozen inputs changed')
  save(join(root, 'prepared.json'), { ready: true, newModelCalls: 0 })
  console.log(JSON.stringify({ prepared: true, plannedCharacterCalls: 36, plannedJevCalls: 12 }))
} else {
  if (!existsSync(join(root, 'prepared.json')) || existsSync(join(root, 'trials.jsonl'))) throw new Error('prepare once, then run once')
  const protocol = load(join(root, 'protocol.json')), address = protocol.address as unknown as WorldAddress
  const frozen = protocol.frozen as WorldJsonObject
  if (!unchanged(frozen)) throw new Error('frozen inputs changed before run')
  const bank = load(join(root, 'bank.json')), authorized = load(join(root, 'authorized.json'))
  let transportPath: string | undefined
  const provider = createChatProvider({ fetch: async (input, init) => {
    const response = await fetch(input, init)
    if (transportPath) save(transportPath, { status: response.status, body: await response.clone().text() })
    return response
  }, endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions'),
    model: String(protocol.model), timeoutMs: 90000, maxOutputTokens: 1600,
    ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
  const canonical = new Map<string, string>(), trials: WorldJsonObject[] = []
  for (const probe of probes) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const queryRequest = load(join(root, probe.id + '-request.json'))
      const child = spawnSync(hindsightPython(), [resolve('experiments/activity-memory/natural_choice_recall.py')], {
        input: JSON.stringify({ prepared: bank, authorized, request: queryRequest, target: protocol.target }),
        encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0',
          HCW_JEV_APPLICABILITY_TRACE: join(root, 'jev-calls.jsonl') },
      })
      if (child.error || child.status !== 0) {
        save(join(root, 'retrieval-failure.json'), { probe: probe.id, repeat, status: child.status, stderr: child.stderr })
        throw new Error('natural retrieval failed before Character Turn')
      }
      const retrieval = JSON.parse(child.stdout) as WorldJsonObject
      save(join(root, probe.id + '-retrieval-' + repeat + '.json'), retrieval)
      console.log(JSON.stringify({ probe: probe.id, repeat, targetShortlisted: retrieval.targetShortlisted,
        targetRelated: retrieval.targetRelated, targetDelivered: retrieval.targetDelivered }))
      const variants = retrieval.conditions as WorldJsonObject
      const ordered = [...conditions.slice(repeat), ...conditions.slice(0, repeat)]
      for (const condition of ordered) {
        const dir = join(root, probe.id + '-' + repeat + '-' + condition); mkdirSync(dir)
        for (const f of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(root, 'history', f), join(dir, f))
        const store = new WorldStore(join(dir, 'world.sqlite')), memory = new CognitiveMemoryService(join(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
        const leases = new WriterLeaseService(join(dir, 'world.sqlite')), availability = new CharacterRuntimeAvailabilityService(join(dir, 'world.sqlite'))
        const before = store.head(address).headSeq
        let calls = 0, returned = false
        try {
          const turn = new PrototypeCharacterTurn({ address, store, memory, leases, availability, projectContext: cold,
            rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
            validateDecision: decision => { if (decision.decision === 'recall') throw new Error('initial-choice experiment disables further recall') },
            decide: async (request, signal) => {
              const visible: PrototypeTurnRequest = { ...request, canRecall: false,
                context: { ...request.context, memories: variants[condition]! } }
              const plain = JSON.stringify({ ...visible, context: { ...visible.context, memories: [] } })
              if (canonical.has(probe.id) && canonical.get(probe.id) !== plain) throw new Error('nonmemory context changed')
              canonical.set(probe.id, plain)
              if (JSON.stringify(visible).includes('雪青密码')) throw new Error('private context leaked')
              const record = { probe: probe.id, repeat, condition, request: visible, status: 'pending' }
              save(join(dir, 'call.json'), record); calls++; transportPath = join(dir, 'transport.json')
              const start = performance.now()
              const response = await provider.decide(localPrototypeTurnCall(visible), signal)
              returned = true
              save(join(dir, 'call.json'), { ...record, status: 'returned', durationMs: Math.round(performance.now() - start), response })
              return response
            } })
          const result = await turn.run(npc, { stimulus: stimulus(probe), maxCalls: 1, signal: AbortSignal.timeout(120000) })
          const events = store.readEvents(address).filter(e => e.seq > before)
          const row: WorldJsonObject = { probe: probe.id, repeat, condition, calls, returned,
            result: result as unknown as WorldJsonObject, events: events as unknown as WorldJsonObject[],
            targetDelivered: retrieval.targetDelivered!, frozenInputsUnchanged: unchanged(frozen) }
          if (!row.frozenInputsUnchanged) throw new Error('frozen evidence changed')
          save(join(dir, 'result.json'), row); appendFileSync(join(root, 'trials.jsonl'), JSON.stringify(row) + '\n'); trials.push(row)
          console.log(JSON.stringify({ probe: probe.id, repeat, condition, returned, status: result.status }))
          if (result.failure === 'provider_failed') throw new Error('provider failed; stopping additional calls')
        } finally { memory.close(); availability.close(); leases.close(); store.close() }
      }
    }
  }
  save(join(root, 'summary.json'), { characterCalls: trials.reduce((n, r) => n + Number(r.calls), 0),
    returned: trials.filter(r => r.returned).length, retrievalDraws: 12, frozenInputsUnchanged: unchanged(frozen),
    nonmemoryContextIdentical: true, conclusion: 'qualitative autonomous-choice assessment required' })
}
