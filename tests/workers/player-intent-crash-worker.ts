import { WorldApplication } from '@harness-world/application'
import { brandId, type FaultPoint, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'
import { frozenIntentWorld, intentWorld, intentFixtureProfile, intentFixtureRequest, intentFixtureResponse } from '../fixtures/player-intent-world.ts'

const [worldPath, sessionPath, memoryPath, point, mode] = process.argv.slice(2)
if (!worldPath || !sessionPath || !memoryPath || !point) throw new Error('missing worker arguments')
/** The frozen mode interprets free text into an interaction the world adjudicates at version 2. */
const frozen = mode === 'frozen'
const compiled = frozen ? frozenIntentWorld('responsive/v2') : intentWorld()
const frozenRequest = { text: '拿起杯子', principalId: 'principal:player', idempotencyKey: 'intent:frozen', correlationId: 'intent:frozen' }
const dispatch = async (raw: WorldJsonValue): Promise<WorldJsonValue> => {
  if (!frozen) return intentFixtureResponse
  const offered = (raw as { body: { affordances: readonly { affordanceId: string; parameters: WorldJsonObject }[] } })
    .body.affordances
  const take = offered.find(entry => entry.parameters.bindingId === 'binding:entity:cup:base:take')!
  return { version: 'player-intent-candidate/v2', decision: 'act', reason: 'none',
    actions: [{ key: 't', affordanceId: take.affordanceId }],
    sourceSpans: [{ actionKey: 't', startUtf16: 0, endUtf16: 4, text: '拿起杯子', kind: 'action' }] }
}
// A responsive world refuses to mount without a binding for every active non-manual character, and both
// of them abstain: what this worker is here to interrupt is the interpreted input, not the reaction.
const app = new WorldApplication({ worldPath, sessionPath, memoryPath, runtimeOwnerId: 'intent:crash', leaseTtlMs: 500, modelBudgetTokens: 20,
  ...(frozen ? { reactionParticipants: () => ['character:npc', 'character:bob'].map(actorId => ({
    participantId: `agent:${actorId}`, role: 'agent' as const, actorId: brandId(actorId, 'CharacterId'),
    allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
    provider: { propose: async () => ({ schemaVersion: 7 as const, decision: 'abstain' as const, actions: [] }) },
  })) } : {}),
  playerIntent: { profile: intentFixtureProfile, dispatch }, faultInjector: new IpcPauseFaultInjector(point as FaultPoint) })
app.activate(compiled)
await app.submitText(compiled.manifest.address, frozen ? frozenRequest : intentFixtureRequest)
