/** Stage 6.3 prepares same-prefix immediate evidence/current cognition for the shared native runner. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openActionWorld, actionContext, actionResult } from './notice-board-action-fixture.ts'
import { npc } from './notice-board-fixture.ts'
import { inscriptionReadings } from './notice-board-evidence-delivery.ts'
import { rawHistorySnapshot, historyBytes } from './raw-history-delivery.ts'
import { hindsightPython } from './hindsight-python.ts'
const root = resolve(process.argv[2] ?? '')
const previous = resolve('.tmp/notice-board-action-loop-20261005-v1')
if (!process.argv[2] || existsSync(root)) throw new Error('fresh output root required')
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as WorldJsonObject
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2))
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
function current(doc: WorldJsonObject): Promise<WorldJsonObject> {
  return new Promise((yes, no) => {
    const child = execFile(hindsightPython(), [resolve('experiments/activity-memory/immediate_delivery.py')], {
      timeout: 60000, maxBuffer: 16*1024*1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0' },
    }, (error, out, err) => { if (error) no(new Error(err.slice(-1200))); else { try { yes(JSON.parse(out)) } catch (cause) { no(cause) } } })
    child.stdin!.on('error', () => {}); child.stdin!.end(JSON.stringify(doc))
  })
}
const seeds = [0,1,2].map(i => 'immediate-' + i), paths = ['raw-direct', 'existing-cognition']
const frozen = Object.fromEntries([join(previous, 'protocol.json'), ...[0,1,2].flatMap(i =>
  ['initial.json','world.sqlite','memory.sqlite'].map(p => join(previous, 'seed-' + i, p)))].map(p => [p, hash(p)]))
mkdirSync(root, { recursive: true })
save(join(root, 'protocol.json'), { phase: '6.3', contrast: 'immediate', model: 'gemini-3.7-flash',
  seeds, paths, samples: 2, samplesBySeed: Object.fromEntries(seeds.map(s => [s,2])), frozen, previousRoot: previous,
  stimulus: '那我们接下来怎么办？', maxCharacterCallsPerActivation: 2, maxDeliveryItems: 3, maxDeliveryJsonChars: 4500,
  controls: ['same two native accepted inscription reads, world prefix and neutral player question',
    'both arms receive both authorized sign Sources; only memories differ',
    'raw direct evidence is rendered with existing host-owned descriptions',
    'current cognition bodies are reused verbatim and delivered by minimal Delivery',
    'no cognition update, retrieval, JEV, implicit native memory or active recall before responding',
    'ask staff, inspect terminal and physical movement remain native optional choices; no verification hint',
    'two samples per frozen seed, alternating order, no selective retries'],
  limits: ['the seed prefix uses scripted setup reads; setup is not counted as Character choice',
    'recent context also contains the immediate sign read results in both arms',
    'current cognition was generated in an earlier offline experiment; online formation latency is not measured',
    'three frozen cognition bodies and two repeats per body do not establish generality'] })
for (const [i,seed] of seeds.entries()) {
  const dir = join(root, seed, 'prefix'); mkdirSync(dir, { recursive: true })
  for (const p of ['world.sqlite','memory.sqlite']) copyFileSync(join(previous, 'seed-' + i, p), join(dir, p))
  const f = openActionWorld(dir, true)
  f.memory.prepareStimulus = () => { throw new Error('implicit retrieval forbidden') }
  try {
    const stimulus = await f.submitPlayer('那我们接下来怎么办？', 'immediate-choice')
    const before = f.store.head(f.address)
    let request: PrototypeTurnRequest | undefined
    const preview = new PrototypeCharacterTurn({ address: f.address, store: f.store, leases: f.leases,
      availability: f.availability, rulebooks: f.rules,
      projectContext: context => actionContext({ character: context.character!, stimulus: context.stimulus!, memories: [], ...context }),
      executionResult: actionResult, recentObservations: 4, recentSelfObservations: 4,
      decide: async r => { request = { ...r, canRecall: false }; return { decision: 'abstain' } } })
    await preview.run(npc, { stimulus, maxCalls: 1 })
    if (!request || JSON.stringify(f.store.head(f.address)) !== JSON.stringify(before)) throw new Error('preview changed frozen world')
    const snapshot = rawHistorySnapshot(f), initial = load(join(previous, 'seed-' + i, 'initial.json'))
    const doc: WorldJsonObject = { initial, snapshot, request: request as unknown as WorldJsonObject }
    const start = performance.now(), updated = await current(doc)
    const raw = inscriptionReadings(initial.archive as WorldJsonObject, snapshot.tick, 'separate')
    if (raw.length > 3 || JSON.stringify(raw).length > 4500) throw new Error('raw exceeds shared budget')
    save(join(root, seed, 'request.json'), request); save(join(root, seed, 'snapshot.json'), snapshot)
    save(join(root, seed, 'preparation-input.json'), doc)
    save(join(root, seed, 'raw-direct.json'), { delivery: { memories: raw }, newModelCalls: 0,
      trace: { semanticCalls: 0, sourceIds: raw.flatMap(m => m.sourceIds as string[]), materialBytes: historyBytes(raw) } })
    save(join(root, seed, 'existing-cognition.json'), updated)
    save(join(root, seed, 'preparation-timing.json'), { localPreparationMs: Math.round(performance.now()-start),
      newModelCalls: 0, includesPythonStartup: true, reusedForSamples: 2 })
  } finally { f.close() }
}
if (Object.entries(frozen).some(([p,h]) => hash(p) !== h)) throw new Error('frozen inputs changed')
save(join(root, 'prepared.json'), { ready: true, newModelCalls: 0 })
console.log(JSON.stringify({ prepared: true, phase: '6.3', root, firstChoices: 12, maxCharacterCalls: 24 }))
