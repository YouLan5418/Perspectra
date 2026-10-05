/** Post-hoc removal diagnostic; never elects a true conflict branch in runtime. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brandId, RECALL_KEYWORD_TOKENIZER_ID, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const root = resolve(process.argv[2] ?? ''), input = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3] || existsSync(root)) throw new Error('provide fresh output and completed natural-choice directory')
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as WorldJsonObject
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2))
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const protocol = load(join(input, 'protocol.json')), address = protocol.address as unknown as WorldAddress
const probe = (protocol.probes as WorldJsonObject[]).find(p => p.id === 'new-building')!
if (!existsSync(join(input, 'audit.json'))) throw new Error('complete the main experiment audit first')
const files = [join(input, 'protocol.json'), join(input, 'bank.json'), ...[0, 1, 2].map(r => join(input, 'new-building-retrieval-' + r + '.json')),
  ...['world.sqlite', 'memory.sqlite'].map(f => join(input, 'history', f))]
const frozen = Object.fromEntries(files.map(p => [p, hash(p)]))
const unchanged = () => Object.entries(frozen).every(([p, h]) => hash(p) === h)
const conditions = ['natural-full-repeat', 'without-opposed', 'without-opposed-and-target'], npc = brandId('character:npc', 'CharacterId')
mkdirSync(root, { recursive: true })
save(join(root, 'protocol.json'), { inputRoot: input, model: protocol.model, address: protocol.address, probe,
  target: protocol.target, opposed: 'bank:10', repeats: 3, conditions, maxCharacterCalls: 9, newJevCalls: 0, frozen,
  hypothesis: 'an already read opposed understanding may mask the target contribution',
  limits: ['post-hoc exploratory diagnosis selected after primary results', 'removal intervention, not a default conflict resolution',
    'no new facts/bodies/queries/JEV decisions', 'no truth adjudication or forced target', 'one initial choice only'] })
let transportPath: string | undefined
const provider = createChatProvider({ fetch: async (req, init) => {
  const response = await fetch(req, init)
  if (transportPath) save(transportPath, { status: response.status, body: await response.clone().text() })
  return response
}, endpoint: new URL(process.env.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions'),
  model: String(protocol.model), timeoutMs: 90000, maxOutputTokens: 1600,
  ...(process.env.HCW_LOCAL_API_KEY ? { apiKey: process.env.HCW_LOCAL_API_KEY } : {}) })
let canonical: string | undefined
const trials: WorldJsonObject[] = []
for (let repeat = 0; repeat < 3; repeat++) {
  const retrieval = load(join(input, 'new-building-retrieval-' + repeat + '.json'))
  const full = (retrieval.delivery as WorldJsonObject).memories as WorldJsonObject[]
  if (!full.some(m => m.memoryId === protocol.target) || !full.some(m => m.memoryId === 'bank:10')) throw new Error('required diagnostic branches were not naturally read')
  const variants: Record<string, WorldJsonObject[]> = { 'natural-full-repeat': full,
    'without-opposed': full.filter(m => m.memoryId !== 'bank:10'),
    'without-opposed-and-target': full.filter(m => m.memoryId !== 'bank:10' && m.memoryId !== protocol.target) }
  const ordered = [...conditions.slice(repeat), ...conditions.slice(0, repeat)]
  for (const condition of ordered) {
    const dir = join(root, repeat + '-' + condition); mkdirSync(dir)
    for (const f of ['world.sqlite', 'memory.sqlite']) copyFileSync(join(input, 'history', f), join(dir, f))
    const store = new WorldStore(join(dir, 'world.sqlite')), memory = new CognitiveMemoryService(join(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    const leases = new WriterLeaseService(join(dir, 'world.sqlite')), availability = new CharacterRuntimeAvailabilityService(join(dir, 'world.sqlite'))
    const before = store.head(address).headSeq
    try {
      const turn = new PrototypeCharacterTurn({ address, store, memory, leases, availability,
        rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
        projectContext: context => ({ ...context, observations: [], selfObservations: [], memories: [] }),
        validateDecision: d => { if (d.decision === 'recall') throw new Error('initial choice disables further recall') },
        decide: async (request, signal) => {
          const visible: PrototypeTurnRequest = { ...request, canRecall: false, context: { ...request.context, memories: variants[condition]! } }
          const plain = JSON.stringify({ ...visible, context: { ...visible.context, memories: [] } })
          if (canonical !== undefined && canonical !== plain) throw new Error('nonmemory context changed')
          canonical = plain
          if (JSON.stringify(visible).includes('雪青密码')) throw new Error('private source leaked')
          save(join(dir, 'call.json'), { repeat, condition, request: visible, status: 'pending' }); transportPath = join(dir, 'transport.json')
          const start = performance.now(), response = await provider.decide(localPrototypeTurnCall(visible), signal)
          save(join(dir, 'call.json'), { repeat, condition, request: visible, status: 'returned', response, durationMs: Math.round(performance.now() - start) })
          return response
        } })
      const result = await turn.run(npc, { stimulus: [{ observerId: npc, content: { actorId: probe.actorId!,
        actionType: 'speak', speech: { characterId: probe.actorId!, text: probe.text! } } }], maxCalls: 1 })
      const row: WorldJsonObject = { repeat, condition, result: result as unknown as WorldJsonObject,
        events: store.readEvents(address).filter(e => e.seq > before) as unknown as WorldJsonObject[], frozenInputsUnchanged: unchanged() }
      if (!row.frozenInputsUnchanged) throw new Error('diagnostic mutated original evidence')
      save(join(dir, 'result.json'), row); appendFileSync(join(root, 'trials.jsonl'), JSON.stringify(row) + '\n'); trials.push(row)
      console.log(JSON.stringify({ repeat, condition, status: result.status }))
      if (result.failure === 'provider_failed') throw new Error('provider failed; stopping')
    } finally { memory.close(); availability.close(); leases.close(); store.close() }
  }
}
save(join(root, 'summary.json'), { trials: trials.length, newJevCalls: 0, frozenInputsUnchanged: unchanged(), nonmemoryContextIdentical: true })
