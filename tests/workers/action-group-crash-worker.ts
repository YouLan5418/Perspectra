import { interactionWorld, interactionOutput } from '../fixtures/interaction-world.ts'
import { WorldApplication } from '@harness-world/application'
import { brandId, type FaultInjector, type FaultPoint } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'
import { actionGroupWorld, groupOutput } from '../fixtures/action-group-world.ts'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

const [worldPath, sessionPath, memoryPath, point, mode] = process.argv.slice(2)
if (!worldPath || !sessionPath || !memoryPath || !point) throw new Error('missing worker arguments')
const compiled = mode === 'frozen' ? frozenInteractionWorld()
  : mode === 'frozen-reaction' ? frozenInteractionWorld('responsive/v2')
  : mode === 'interactions' ? interactionWorld() : actionGroupWorld()
const pause = new IpcPauseFaultInjector(point as FaultPoint)
// The frozen-reaction mode pauses inside the Reaction Wave's commit, and its Root Round passes the same
// fault point on the way there. The world's first round is allowed through; the pause is armed only once
// it has committed, so what stops here is the Wave and not the Round that opened its Cycle.
let armed = mode !== 'frozen-reaction'
const faultInjector: FaultInjector = { hit: hitPoint => { if (armed) pause.hit(hitPoint) } }
// The frozen modes drive the explicit player only. A Root Round participant would count as already
// reacting in that Round, so the Cycle would open without the character meant to answer it; and with no
// participant at all there is no reaction stimulus, which is what makes the frozen mode's Round the
// interaction commit itself and nothing else.
const application = new WorldApplication({ worldPath, sessionPath, memoryPath,
  runtimeOwnerId: 'group:crash', leaseTtlMs: 500, modelBudgetTokens: 10,
  ...(mode === 'frozen' || mode === 'frozen-reaction' ? {} : { participants: () => [{ participantId: 'agent:group', role: 'agent',
    actorId: brandId('character:npc', 'CharacterId'),
    allowedActionTypes: mode === 'interactions' ? ['speak', 'interact'] : ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
    provider: { propose: async () => mode === 'interactions' ? interactionOutput() : groupOutput } }] }),
  ...(mode === 'frozen-reaction' ? { reactionParticipants: () => [
    { participantId: 'agent:npc', role: 'agent' as const,
      actorId: brandId('character:npc', 'CharacterId'), allowedActionTypes: ['speak', 'move', 'interact'],
      priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: { propose: async () => ({ schemaVersion: 6 as const, decision: 'act' as const, actions: [{
        actionId: 'action:npc-cup', actorId: brandId('character:npc', 'CharacterId'),
        actionType: 'interact', actionVersion: 2, parameters: {
          targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 }, arguments: {},
        } }] }) } },
    { participantId: 'agent:bob', role: 'agent' as const,
      actorId: brandId('character:bob', 'CharacterId'), allowedActionTypes: ['speak', 'move', 'interact'],
      priority: 1, estimatedTokens: 1, timeoutMs: 100,
      provider: { propose: async () => ({ schemaVersion: 6 as const, decision: 'abstain' as const, actions: [] }) } },
  ] } : {}),
  faultInjector,
})
application.activate(compiled)
// A v10 world resolves its interactions for the explicit player; the frozen shape names the binding and
// the definition lock the world's own selection declared.
const holdHand = { actionType: 'interact', parameters: { targetRef: { kind: 'character', id: 'character:npc' },
  bindingId: 'binding:character:npc:base:hold-hand', definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {} } }
const action = mode === 'frozen' || mode === 'frozen-reaction'
  ? holdHand
  : { actionType: 'speak', parameters: { text: 'go' } }
await application.submit(compiled.manifest.address, {
  idempotencyKey: 'group:crash', principalId: 'principal:player', action, correlationId: 'group:crash',
})
if (mode === 'frozen-reaction') {
  // The Root Round is durable now, so the Reaction Wave that answers it is what the pause catches.
  armed = true
  await application.processReactionCycles(compiled.manifest.address)
}
