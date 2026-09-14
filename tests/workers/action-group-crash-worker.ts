import { interactionWorld, interactionOutput } from '../fixtures/interaction-world.ts'
import { WorldApplication } from '@harness-world/application'
import { brandId, type FaultPoint } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'
import { actionGroupWorld, groupOutput } from '../fixtures/action-group-world.ts'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

const [worldPath, sessionPath, memoryPath, point, mode] = process.argv.slice(2)
if (!worldPath || !sessionPath || !memoryPath || !point) throw new Error('missing worker arguments')
const compiled = mode === 'frozen' ? frozenInteractionWorld()
  : mode === 'interactions' ? interactionWorld() : actionGroupWorld()
// The frozen mode drives the explicit player only: no participant means no reaction stimulus, so the
// round is the interaction commit itself and nothing else.
const application = new WorldApplication({ worldPath, sessionPath, memoryPath,
  runtimeOwnerId: 'group:crash', leaseTtlMs: 500, modelBudgetTokens: 10,
  ...(mode === 'frozen' ? {} : { participants: () => [{ participantId: 'agent:group', role: 'agent',
    actorId: brandId('character:npc', 'CharacterId'),
    allowedActionTypes: mode === 'interactions' ? ['speak', 'interact'] : ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
    provider: { propose: async () => mode === 'interactions' ? interactionOutput() : groupOutput } }] }),
  faultInjector: new IpcPauseFaultInjector(point as FaultPoint),
})
application.activate(compiled)
// A v10 world resolves its interactions for the explicit player; the frozen shape names the binding and
// the definition lock the world's own selection declared.
const action = mode === 'frozen'
  ? { actionType: 'interact', parameters: { targetRef: { kind: 'character', id: 'character:npc' },
      bindingId: 'binding:character:npc:base:hold-hand', definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {} } }
  : { actionType: 'speak', parameters: { text: 'go' } }
await application.submit(compiled.manifest.address, {
  idempotencyKey: 'group:crash', principalId: 'principal:player', action, correlationId: 'group:crash',
})
