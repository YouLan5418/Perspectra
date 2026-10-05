/** Stage 6.0: frozen-prefix complex retrieval versus direct authorized history. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openActionWorld, actionContext, actionResult, askId, terminalId } from './notice-board-action-fixture.ts'
import { npc } from './notice-board-fixture.ts'
import { privateText } from './notice-board-capability.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { hindsightPython } from './hindsight-python.ts'
import { rawHistorySnapshot, deliverRawHistory, historyBytes } from './raw-history-delivery.ts'
const object = (v: unknown): WorldJsonObject => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as WorldJsonObject : {}
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as WorldJsonObject
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2))
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const root = resolve(process.argv[2] ?? ''), mode = process.argv[3] ?? '--prepare'
const old = resolve(process.argv[4] ?? '.tmp/notice-board-action-loop-20261005-v1')
if (!process.argv[2] || !['--prepare', '--run'].includes(mode)) throw new Error('fresh root + --prepare, then --run')
const paths = ['complex', 'raw-8000-bytes', 'raw-24000-bytes'], seeds = ['raw-evidence', 'paired-evidence', 'updated-cognition']
const samples = Number(process.env.HCW_SIMPLIFY_SAMPLES ?? 2)
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 3) throw new Error('samples must be 1..3')
const clone = (from: string, to: string) => { mkdirSync(to, { recursive: true }); for (const p of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(from, p), join(to, p)) }
const plain = (r: PrototypeTurnRequest) => JSON.stringify({ ...r, context: { ...r.context, memories: [] } })
async function complexRecall(doc: WorldJsonObject): Promise<WorldJsonObject> {
  return new Promise((yes, no) => {
    const child = execFile(hindsightPython(), [resolve('experiments/activity-memory/notice_board_action_loop.py')], {
      timeout: 180000, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0', HCW_JEV_APPLICABILITY_TRACE: join(root, 'jev-calls.jsonl'),
        HCW_HINDSIGHT_UTILITY_TRACE: join(root, 'utility-calls.jsonl') },
    }, (error, out, err) => { if (error) no(new Error('complex recall failed: ' + err.slice(-1200))); else { try { yes(JSON.parse(out)) } catch (cause) { no(cause) } } })
    child.stdin!.on('error', () => {}); child.stdin!.end(JSON.stringify(doc))
  })
}
if (mode === '--prepare') {
  if (existsSync(root)) throw new Error('fresh output required')
  const selected = load(join(old, 'selected.json')), frozen: Record<string, string> = {}
  // Hash every reused source input before any cloned world is opened.
  for (const seed of seeds) for (const p of [join(old, 'later-' + seed, 'future-prefix', 'world.sqlite'),
    join(old, 'later-' + seed, 'future-prefix', 'memory.sqlite'), join(String(selected[seed]), 'revision.json'),
    join(old, 'later-' + seed, 'current-cognition', 'retrieval-request.json')]) frozen[p] = hash(p)
  mkdirSync(root, { recursive: true })
  save(join(root, 'protocol.json'), { phase: '6.0', model: 'gemini-3.7-flash', paths, seeds, samples, frozen,
    historyBudgets: [8000, 24000], budgetMetric: 'utf8-json-bytes', materialTokens: null, maxCharacterCallsPerActivation: 2,
    capacity: 'gateway metadata does not declare capacity; only actual request acceptance is measured',
    laterStages: 'simple narrow candidate / JEV ablation / delayed cognition remain separate experiments',
    controls: ['same committed prefix, stimulus, model, affordances, recent window and call budget',
      'raw selection uses current persons, places, visible target association and activity metadata; no target answer injection',
      'recent content remains in Character context, overlapping Sources are not delivered again',
      'no cognition update, no Source rewrite, no automatic family discovery', 'repeated same-provider calls, no selective retries'],
    limits: ['byte budgets are not 8k/24k token budgets', 'short histories may not fill either budget',
      'explicit current target-location association does not assert a historical location', 'unstructured names are not resolved'] })
  for (const seed of seeds) {
    const from = join(old, 'later-' + seed, 'future-prefix'), dir = join(root, seed, 'prefix')
    clone(from, dir)
    const f = openActionWorld(dir, true)
    f.memory.prepareStimulus = () => { throw new Error('implicit native retrieval is forbidden in this experiment') }
    try {
      const template = load(join(old, 'later-' + seed, 'current-cognition', 'retrieval-request.json')) as unknown as PrototypeTurnRequest
      let request: PrototypeTurnRequest | undefined
      const preview = new PrototypeCharacterTurn({ address: f.address, store: f.store, leases: f.leases, availability: f.availability, rulebooks: f.rules, projectContext: context => actionContext({ character: context.character!, stimulus: context.stimulus!, memories: [], ...context }), executionResult: actionResult,
        recentObservations: 4, recentSelfObservations: 4, decide: async r => { request = { ...r, canRecall: false }; return { decision: 'abstain' } } })
      const before = f.store.head(f.address)
      await preview.run(npc, { stimulus: template.context.stimulus as WorldJsonObject[], maxCalls: 1 })
      if (!request || plain(request) !== plain(template) || JSON.stringify(before) !== JSON.stringify(f.store.head(f.address)))
        throw new Error('frozen nonmemory context or head changed')
      save(join(root, seed, 'request.json'), request)
      const snapshot = rawHistorySnapshot(f)
      save(join(root, seed, 'snapshot.json'), snapshot)
      for (const budget of [8000, 24000]) save(join(root, seed, 'raw-' + budget + '.json'), deliverRawHistory(snapshot, request, budget))
      // Compare against the unchanged complex algorithm, including its existing empty candidate behavior.
      const revision = load(join(String(selected[seed]), 'revision.json'))
      const complex = await complexRecall({ operation: 'recall', variant: 'current-cognition', revision,
        request: request as unknown as WorldJsonObject, tick: before.tick, scope: snapshot.scope })
      save(join(root, seed, 'complex.json'), complex)
    } finally { f.close() }
  }
  if (Object.entries(frozen).some(([p, h]) => hash(p) !== h)) throw new Error('frozen inputs changed')
  save(join(root, 'prepared.json'), { ready: true, characterCalls: 0 })
  console.log(JSON.stringify({ prepared: true, root, paths, samples }))
} else {
  if (!existsSync(join(root, 'prepared.json')) || existsSync(join(root, 'trials.json'))) throw new Error('prepare once, run once')
  const protocol = load(join(root, 'protocol.json')), frozen = object(protocol.frozen)
  if (Object.entries(frozen).some(([p, h]) => hash(p) !== h)) throw new Error('frozen inputs changed')
  let transport: string | undefined, calls = 0
  const provider = createChatProvider({ endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions'),
    model: String(protocol.model), timeoutMs: 90000, maxOutputTokens: 1600,
    ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}),
    fetch: async (input, init) => { const response = await fetch(input, init)
      if (transport) save(transport, { status: response.status, body: await response.clone().text() }); return response } })
  const trials: WorldJsonObject[] = []
  save(join(root, 'trials.json'), trials)
  for (const [seedIndex, seed] of seeds.entries()) for (let sample = 0; sample < Number(protocol.samples); sample++) {
    const offset = (seedIndex + sample) % paths.length, order = [...paths.slice(offset), ...paths.slice(0, offset)]
    for (const path of order) {
      const dir = join(root, seed, 'sample-' + sample + '-' + path)
      clone(join(root, seed, 'prefix'), dir)
      const expected = load(join(root, seed, 'request.json')) as unknown as PrototypeTurnRequest
      const delivery = load(join(root, seed, path === 'complex' ? 'complex.json' : path === 'raw-8000-bytes' ? 'raw-8000.json' : 'raw-24000.json'))
      const memories = (path === 'complex' ? object(delivery.delivery).memories : delivery.memories) as WorldJsonObject[]
      const f = openActionWorld(dir, true), before = f.store.head(f.address), started = performance.now()
      f.memory.prepareStimulus = () => { throw new Error('implicit native retrieval is forbidden in this experiment') }
      let callIndex = 0, firstRequest = ''
      try {
        const turn = new PrototypeCharacterTurn({ address: f.address, store: f.store, leases: f.leases, availability: f.availability, rulebooks: f.rules, projectContext: context => actionContext({ character: context.character!, stimulus: context.stimulus!, memories: [], ...context }), executionResult: actionResult,
          recentObservations: 4, recentSelfObservations: 4,
          validateDecision: d => { if (d.decision === 'recall') throw new Error('active recall disabled consistently') },
          decide: async (r, signal) => {
            const visible: PrototypeTurnRequest = { ...r, canRecall: false, context: { ...r.context, memories } }
            if (JSON.stringify(visible).includes(privateText)) throw new Error('private evidence leaked')
            if (!r.continuation) {
              if (plain(visible) !== plain(expected)) throw new Error('nonmemory context differs')
              firstRequest = JSON.stringify(visible)
            }
            const index = callIndex++, file = join(dir, 'call-' + index + '.json'), call = localPrototypeTurnCall(visible)
            transport = join(dir, 'transport-' + index + '.json'); calls++
            save(file, { status: 'pending', request: visible, prepared: call, requestBytes: historyBytes(call), head: f.store.head(f.address) })
            const start = performance.now(), response = await provider.decide(call, signal)
            save(file, { status: 'returned', request: visible, prepared: call, requestBytes: historyBytes(call), response,
              durationMs: Math.round(performance.now() - start), head: f.store.head(f.address) })
            return response
          } })
        const result = await turn.run(npc, { stimulus: expected.context.stimulus as WorldJsonObject[], maxCalls: 2, signal: AbortSignal.timeout(115000) })
        const events = f.store.readEvents(f.address).filter(e => e.seq > before.headSeq)
        const action = object(result.performResult?.action), params = object(action.parameters)
        const resolved = events.find(e => e.eventType === 'action.resolved' && object(e.data).accepted === true
          && object(e.data).actionId === result.performResult?.operationId)
        const committed = result.performResult?.status === 'accepted' && resolved !== undefined
        const newSnapshot = rawHistorySnapshot(f)
        const row: WorldJsonObject = { seed, sample, path, before: before as unknown as WorldJsonObject,
          calls: callIndex, durationMs: Math.round(performance.now() - started), materialBytes: historyBytes(memories),
          materialCount: memories.length, firstRequestHash: createHash('sha256').update(firstRequest).digest('hex'),
          result: result as unknown as WorldJsonObject, acceptedAndCommitted: committed,
          actionKind: committed ? action.actionType === 'move' ? 'move:' + params.locationId : object(params.definitionRef).id ?? action.actionType! : 'none',
          newSourceIds: newSnapshot.sources.filter(s => Number(s.worldSeq) > before.headSeq).map(s => s.sourceId!),
          acquiredEvidence: committed && [askId, terminalId, 'experiment:inspect-notice-board'].includes(String(object(params.definitionRef).id)),
          failure: result.failure ?? null }
        save(join(dir, 'result.json'), row); save(join(dir, 'events.json'), f.store.readEvents(f.address)); save(join(dir, 'sources.json'), newSnapshot)
        trials.push(row); save(join(root, 'trials.json'), trials)
        console.log(JSON.stringify({ seed, sample, path, calls: callIndex, action: row.actionKind, materials: memories.length }))
        if (result.failure === 'provider_failed' || result.status === 'interrupted') throw new Error('provider failure; no selective retry')
      } finally { f.close() }
    }
  }
  if (Object.entries(frozen).some(([p, h]) => hash(p) !== h)) throw new Error('frozen inputs changed')
  save(join(root, 'summary.json'), { completed: true, phase: '6.0', calls, trials: trials.length, frozenInputsUnchanged: true,
    noCognitionUpdate: true, cost: null, capacity: 'only actual requests verified',
    byPath: Object.fromEntries(paths.map(path => [path, { trials: trials.filter(t => t.path === path).length,
      acquisitions: trials.filter(t => t.path === path && t.acquiredEvidence).length,
      committedActions: trials.filter(t => t.path === path && t.acceptedAndCommitted).length,
      calls: trials.filter(t => t.path === path).reduce((n, t) => n + Number(t.calls), 0) }])) })
}
