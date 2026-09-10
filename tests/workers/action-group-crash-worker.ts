import { interactionWorld, interactionOutput } from '../fixtures/interaction-world.ts'
import { WorldApplication } from '@harness-world/application'
import { brandId, type FaultPoint } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'
import { actionGroupWorld, groupOutput } from '../fixtures/action-group-world.ts'

const [worldPath, sessionPath, memoryPath, point, mode] = process.argv.slice(2)
if (!worldPath || !sessionPath || !memoryPath || !point) throw new Error('missing worker arguments')
const compiled = mode === 'interactions' ? interactionWorld() : actionGroupWorld()
const application = new WorldApplication({ worldPath, sessionPath, memoryPath,
  runtimeOwnerId: 'group:crash', leaseTtlMs: 500, modelBudgetTokens: 10,
  participants: () => [{ participantId: 'agent:group', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
    allowedActionTypes: mode === 'interactions' ? ['speak', 'interact'] : ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
    provider: { propose: async () => mode === 'interactions' ? interactionOutput() : groupOutput } }],
  faultInjector: new IpcPauseFaultInjector(point as FaultPoint),
})
application.activate(compiled)
await application.submit(compiled.manifest.address, {
  idempotencyKey: 'group:crash', principalId: 'principal:player',
  action: { actionType: 'speak', parameters: { text: 'go' } }, correlationId: 'group:crash',
})
