import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, hashWorldJson, RECALL_KEYWORD_TOKENIZER_ID, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider, prototypeTurnCall } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

const root = resolve(process.argv[2] ?? '')
if (!process.argv[2] || existsSync(root)) throw new Error('provide a new output directory')
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY missing')
mkdirSync(root, { recursive: true })
const provider = createChatProvider({ endpoint: new URL('https://api.deepseek.com/chat/completions'),
  model: 'deepseek-flash', apiKey: process.env.DEEPSEEK_API_KEY,
  toolName: 'character_decision', timeoutMs: 60_000 })
const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const player = brandId('character:player', 'CharacterId')
const observation = (id: string, observerId: string, content: WorldJsonObject): WorldEventDraft => ({
  eventType: 'observation.upsert', eventVersion: 1, data: { id, value: { observerId, content } },
})
const prompts = process.argv.includes('--opaque') ? [
  '上次从桌上被拿走的那件东西究竟到了谁手里？我听到不同说法。你可以先核对自己的旧经历。',
] : [
  '你还记得那只杯子最初是谁保管的吗？我听到不同说法，你怎么想？',
  '关于那只杯子，我听到相反说法。你能先核对自己的旧经历，再说你记得谁说过什么吗？',
]
writeFileSync(resolve(root, 'protocol.json'), JSON.stringify({ prompts, model: 'deepseek-flash',
  realModel: true, noForcedRecall: true, cases: 'same contradictory authorized evidence, only question changes' }, null, 2))
const summaries = []
for (const [index, prompt] of prompts.entries()) {
  const dir = resolve(root, `case-${index + 1}`)
  mkdirSync(dir)
  const path = resolve(dir, 'world.sqlite')
  const store = new WorldStore(path), leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  let memory: CognitiveMemoryService | undefined
  try {
    const world = frozenInteractionWorld()
    const transfer: WorldEventDraft = { eventType: 'entity.transferred', eventVersion: 1, data: {
      entityId: 'entity:cup', characterId: bob, interactionId: 'base:take',
      fromHolderId: null, fromLocationId: 'location:room', toHolderId: bob, toLocationId: null } }
    const away: WorldEventDraft[] = process.argv.includes('--away') ? [{ eventType: 'character.moved', eventVersion: 1,
      data: { characterId: bob, fromLocationId: 'location:room', toLocationId: 'location:next' } }] : []
    const events = [...world.genesisEvents, transfer,
      observation('observation:actual-transfer', npc, { actorId: bob, actionType: 'interact', status: 'accepted',
        interaction: transfer.data, resultDescription: '鲍勃取得了杯子的保管。' }),
      observation('observation:false-report', npc, { actorId: bob, actionType: 'speak', status: 'accepted',
        speech: { characterId: bob, text: '我早把杯子交给玩家了。' } }),
      observation('observation:private-other', bob, { actorId: player, actionType: 'speak', status: 'accepted',
        speech: { characterId: player, text: '只对鲍勃说：密码是深海灯。' } }),
      ...away,
      ...Array.from({ length: 18 }, (_, n) => observation(`observation:filler-${n}`, npc,
        { actorId: player, actionType: 'speak', status: 'accepted',
          speech: { characterId: player, text: `今天雨还没停，我们已经等了${n + 1}分钟。` } })),
      observation('observation:current-question', npc, { actorId: player, actionType: 'speak', status: 'accepted',
        speech: { characterId: player, text: prompt } }),
    ]
    store.activateBranch({ ...world, genesisEvents: events, genesisHash: hashWorldJson('world-genesis-plan', events),
      address: world.manifest.address, transactionId: brandId(`transaction:active-recall:${index}`, 'TransactionId'),
      roundId: brandId(`round:active-recall:${index}`, 'InteractionRoundId'), correlationId: 'active-recall-playtest' })
    memory = new CognitiveMemoryService(resolve(dir, 'memory.sqlite'), store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
    const requests: unknown[] = [], decisions: unknown[] = []
    const before = store.head(world.manifest.address).headSeq
    const turn = new PrototypeCharacterTurn({ address: world.manifest.address, store, memory, leases, availability,
      rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
      decide: async (request, signal) => {
        requests.push(request)
        const answer = await provider.decide(prototypeTurnCall(request), signal)
        decisions.push(answer)
        return answer
      } })
    const result = await turn.run(npc, { maxCalls: 1, stimulus: [{ sourceText: prompt, actorId: player }] })
    const all = store.readEvents(world.manifest.address)
    const summary = { prompt, result, decisions, initialEvidenceInRequest: JSON.stringify(requests[0]).includes('我早把杯子交给玩家了'),
      voluntaryRecall: decisions.some(d => (d as WorldJsonObject).decision === 'recall'),
      evidenceReturned: requests.some(r => (r as WorldJsonObject).recallEvidence !== undefined),
      leakedOtherPrivate: JSON.stringify(requests).includes('深海灯'),
      worldUnchangedByRecall: all.filter(e => e.seq > before && e.eventType === 'entity.transferred').length === 0,
      finalHolder: currentEntityState(all, 'entity:cup')?.holderId }
    writeFileSync(resolve(dir, 'requests.json'), JSON.stringify(requests, null, 2))
    writeFileSync(resolve(dir, 'events.json'), JSON.stringify(all, null, 2))
    writeFileSync(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2))
    summaries.push(summary)
    process.stdout.write(JSON.stringify({ case: index + 1, ...summary }) + '\n')
  } finally { memory?.close(); availability.close(); leases.close(); store.close() }
}
writeFileSync(resolve(root, 'summary.json'), JSON.stringify(summaries, null, 2))
