/** Minimal Delivery contrast, then stage 6.2 on the exact frozen 6.1 candidate pool. */
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
import { rawHistorySnapshot, historyBytes } from './raw-history-delivery.ts'
const object = (v: unknown): WorldJsonObject => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as WorldJsonObject : {}
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as WorldJsonObject
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2))
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const root = resolve(process.argv[2] ?? ''), mode = process.argv[3] ?? '--prepare'
const old = resolve(process.argv[4] ?? '.tmp/memory-candidate-admission-20261005-v2')
if (!process.argv[2] || !['--prepare-delivery', '--prepare-jev', '--run'].includes(mode)) throw new Error('fresh root + --prepare-delivery or --prepare-jev, then --run')
const prior = load(join(mode === '--run' ? root : old, 'protocol.json'))
const contrast = mode === '--run' ? String(load(join(root, 'protocol.json')).contrast) : mode === '--prepare-jev' ? 'jev' : 'delivery'
const paths = mode === '--run' ? prior.paths as string[] : contrast === 'delivery' ? ['legacy', 'minimal'] : ['with-jev', 'without-jev']
const seeds = prior.seeds as string[]
const samples = Number(process.env.HCW_DELIVERY_SAMPLES ?? 2)
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 3) throw new Error('samples must be 1..3')
const clone = (from: string, to: string) => { mkdirSync(to, { recursive: true }); for (const p of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(from, p), join(to, p)) }
const plain = (r: PrototypeTurnRequest) => JSON.stringify({ ...r, context: { ...r.context, memories: [] } })
async function complexRecall(doc: WorldJsonObject, traceTag: string): Promise<WorldJsonObject> {
  return new Promise((yes, no) => {
    const child = execFile(hindsightPython(), [resolve('experiments/activity-memory/minimal_delivery_contrast.py')], {
      timeout: 180000, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0', HCW_JEV_APPLICABILITY_TRACE: join(root, traceTag + '-jev.jsonl'),
        HCW_HINDSIGHT_UTILITY_TRACE: join(root, 'utility-calls.jsonl') },
    }, (error, out, err) => { if (error) no(new Error('Delivery preparation failed: ' + err.slice(-1200))); else { try { yes(JSON.parse(out)) } catch (cause) { no(cause) } } })
    child.stdin!.on('error', () => {}); child.stdin!.end(JSON.stringify(doc))
  })
}
if (mode !== '--run') {
  if (existsSync(root)) throw new Error('fresh output required')
  const frozen: Record<string, string> = { [join(old, 'protocol.json')]: hash(join(old, 'protocol.json')) }
  for (const seed of seeds) for (const file of ['prefix/world.sqlite','prefix/memory.sqlite','request.json','snapshot.json','simple-id-input.json','simple-id.json'])
    frozen[join(old, seed, file)] = hash(join(old, seed, file))
  mkdirSync(root, { recursive: true })
  const samplesBySeed = Object.fromEntries(seeds.map(seed => [seed, seed.endsWith('--registration') ? samples : 1]))
  save(join(root, 'protocol.json'), { phase: contrast === 'delivery' ? '6.1-delivery' : '6.2', contrast,
    model: prior.model!, paths, seeds, samples, samplesBySeed, frozen, previousRoot: old,
    originalProtocolPath: prior.originalProtocolPath!, maxCharacterCallsPerActivation: 2,
    maxDeliveryItems: 3, maxDeliveryJsonChars: 4500,
    controls: ['exact frozen 6.1 authorized archive, candidate pool, score diagnostics, query and stimulus',
      'same world prefix, nonmemory context, Character model, capabilities, recent window and activation budget',
      contrast === 'delivery' ? 'same recorded JEV selection; only Observation delivery changes'
        : 'same minimal Delivery; one live JEV preparation per case versus no JEV selection',
      'body first; source types, unresolved counters and excerpt coverage survive missing evidence',
      'no source rewriting, cognition update, native keyword retrieval, active recall or selective retries'],
    limits: ['negative controls retain previous registration question in recent context',
      'Character repeats reuse frozen prepared material; JEV repeated stability and full online pipeline latency not measured',
      'partial evidence is explicit; all referenced evidence need not fit in the reading budget'] })
  for (const seed of seeds) {
    clone(join(old, seed, 'prefix'), join(root, seed, 'prefix'))
    const request = load(join(old, seed, 'request.json')), snapshot = load(join(old, seed, 'snapshot.json'))
    save(join(root, seed, 'request.json'), request); save(join(root, seed, 'snapshot.json'), snapshot)
    const input: WorldJsonObject = { phase: contrast, input: load(join(old, seed, 'simple-id-input.json')),
      recall: load(join(old, seed, 'simple-id.json')) }
    save(join(root, seed, 'contrast-input.json'), input)
    const start = performance.now(), pair = await complexRecall(input, seed)
    for (const path of paths) {
      save(join(root, seed, path + '.json'), pair[path])
      save(join(root, seed, path + '-timing.json'), { pairedPreparationMs: Math.round(performance.now() - start), reusedForSamples: samplesBySeed[seed] })
    }
    if (seed.endsWith('--registration')) {
      const minimal = object(pair[contrast === 'delivery' ? 'minimal' : 'with-jev'])
      const items = object(minimal.delivery).memories as WorldJsonObject[]
      if (!items.some(m => m.memoryLevel === 'observation')) throw new Error('positive Observation body still blocked')
    }
  }
  if (Object.entries(frozen).some(([p, h]) => hash(p) !== h)) throw new Error('frozen inputs changed')
  save(join(root, 'prepared.json'), { ready: true, characterCalls: 0 })
  console.log(JSON.stringify({ prepared: true, root, contrast, paths, samplesBySeed }))
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
  for (const [seedIndex, seed] of seeds.entries()) for (let sample = 0; sample < Number(object(protocol.samplesBySeed)[seed]); sample++) {
    const offset = (seedIndex + sample) % paths.length, order = [...paths.slice(offset), ...paths.slice(0, offset)]
    for (const path of order) {
      const dir = join(root, seed, 'sample-' + sample + '-' + path)
      clone(join(root, seed, 'prefix'), dir)
      const expected = load(join(root, seed, 'request.json')) as unknown as PrototypeTurnRequest
      const delivery = load(join(root, seed, path + '.json'))
      const memories = object(delivery.delivery).memories as WorldJsonObject[]
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
  save(join(root, 'summary.json'), { completed: true, phase: protocol.phase!, calls, trials: trials.length, frozenInputsUnchanged: true,
    noCognitionUpdate: true, cost: null, capacity: 'only actual requests verified',
    byPath: Object.fromEntries(paths.map(path => [path, { trials: trials.filter(t => t.path === path).length,
      acquisitions: trials.filter(t => t.path === path && t.acquiredEvidence).length,
      committedActions: trials.filter(t => t.path === path && t.acceptedAndCommitted).length,
      calls: trials.filter(t => t.path === path).reduce((n, t) => n + Number(t.calls), 0) }])) })
}
