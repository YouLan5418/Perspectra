import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, hashWorldJson, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { createChatProvider, prototypeTurnCall } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

// Small isolated experiment. Does not open the frozen group-playtest databases or drive their scheduler.
const directory = resolve(process.argv[2] ?? `.tmp/perform-playtest-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const apiKey = process.env.DEEPSEEK_API_KEY
if (apiKey === undefined) throw new Error('DEEPSEEK_API_KEY is required')
const evidence: unknown[] = []
const save = () => writeFileSync(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
const provider = createChatProvider({ endpoint: new URL('https://api.deepseek.com/chat/completions'),
  model: 'deepseek-flash', apiKey, toolName: 'character_decision', timeoutMs: 45_000 })

for (const scenario of ['success', 'rejected'] as const) {
  const path = resolve(directory, `${scenario}.sqlite`)
  const store = new WorldStore(path)
  const leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  try {
    const base = frozenInteractionWorld()
    const address = base.manifest.address
    if (store.readManifest(address) !== undefined) throw new Error('use a fresh experiment directory')
    const actorId = brandId('character:npc', 'CharacterId')
    const manifest = { ...base.manifest, characters: base.manifest.characters.map(character =>
      character.characterId === actorId ? { ...character, name: 'GPT', portrayal: {
        description: '温和、自然，喜欢和玩家轻松相处；无需分析实验或向玩家解释程序协议。' } } : character) }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesis: WorldEventDraft[] = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
      ? { ...event, data: { ...event.data as WorldJsonObject, manifestHash } } : event)
    if (scenario === 'rejected') genesis.push({ eventType: 'entity.transferred', eventVersion: 1, data: {
      entityId: 'entity:cup', characterId: 'character:player', interactionId: 'base:take',
      fromHolderId: null, fromLocationId: 'location:room',
      toHolderId: 'character:player', toLocationId: null,
    } })
    if (scenario === 'rejected') genesis.push({ eventType: 'observation.upsert', eventVersion: 1, data: {
      id: 'observation:player-holds-cup', value: { observerId: actorId, content: {
        actorId: 'character:player', actionType: 'interact', status: 'accepted',
        interaction: genesis.at(-1)!.data,
      } },
    } })
    genesis.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:request', value: {
      observerId: actorId, content: { actorId: 'character:player', actionType: 'speak', status: 'accepted',
        speech: { characterId: 'character:player', text: 'GPT，帮我拿一下杯子（entity:cup）吧。' } },
    } } })
    store.activateBranch({ address, manifest, manifestHash, genesisEvents: genesis,
      genesisHash: hashWorldJson('world-genesis-plan', genesis),
      transactionId: brandId('transaction:genesis', 'TransactionId'), roundId: brandId('round:genesis', 'InteractionRoundId'),
      correlationId: 'perform-playtest' })
    let calls = 0
    const turn = new PrototypeCharacterTurn({ address, store, leases, availability,
      rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
      decide: async (request, signal) => {
        calls += 1
        const prepared = prototypeTurnCall(request)
        // The refusal case deliberately submits an unavailable take. This is a scripted proposal,
        // followed by the real Rulebook rejection and a real model continuation, not a fabricated result.
        const scripted = scenario === 'rejected' && !request.continuation
        const requestRecord = { scenario, call: calls, scripted, request, prepared,
          headBefore: store.head(address).headSeq }
        evidence.push(requestRecord)
        save()
        console.log(JSON.stringify({ scenario, call: calls, scripted, continuation: request.continuation }))
        const answer = scripted ? { decision: 'perform', actionType: 'interact', parameters: {
          targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 }, arguments: {},
        } } : await provider.decide(prepared, signal).catch(error => {
          evidence.push({ scenario, call: calls, transportError: error instanceof Error ? error.message : 'unknown error' })
          save()
          throw error
        })
        evidence.push({ scenario, call: calls, answer })
        save()
        return answer
      } })
    const result = await turn.run(actorId)
    const events = store.readEvents(address)
    const summary = { scenario, result, cup: currentEntityState(events, 'entity:cup'),
      expressions: events.filter(event => event.eventType === 'character.speak').map(event => ({ seq: event.seq, data: event.data })) }
    evidence.push(summary)
    save()
    console.log(JSON.stringify(summary))
  } finally { availability.close(); leases.close(); store.close() }
}
console.log(JSON.stringify({ directory }))
