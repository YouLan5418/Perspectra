import { WorldApplication } from '@harness-world/application'
import { brandId, type FaultPoint, type SubmitActionsV2 } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'
import { phase8ProviderCrashWorld } from '../fixtures/phase8-provider-world.ts'

const [worldPath, sessionPath, memoryPath, faultPoint] = process.argv.slice(2)
if (worldPath === undefined || sessionPath === undefined || memoryPath === undefined || faultPoint === undefined) {
  throw new Error('usage: provider-call-crash-worker <world-path> <session-path> <memory-path> <fault-point>')
}
const compiled = phase8ProviderCrashWorld()
const application = new WorldApplication({
  worldPath, sessionPath, memoryPath,
  runtimeOwnerId: 'application:p8-crash', leaseTtlMs: 500, modelBudgetTokens: 10,
  participants: () => [{
    participantId: 'agent:p8-crash', role: 'agent',
    actorId: brandId('character:npc', 'CharacterId'),
    allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
    provider: {
      async propose(): Promise<SubmitActionsV2> {
        return {
          schemaVersion: 2, decision: 'act',
          actions: [{
            actionId: 'action:p8-crash:npc', actorId: brandId('character:npc', 'CharacterId'),
            actionType: 'speak', actionVersion: 1, parameters: { text: 'durable provider response' },
          }],
        }
      },
    },
  }],
  faultInjector: new IpcPauseFaultInjector(faultPoint as FaultPoint),
})
application.activate(compiled)
await application.submit(compiled.manifest.address, {
  idempotencyKey: 'p8-provider-crash-round', principalId: 'principal:player',
  action: { actionType: 'speak', parameters: { text: 'exercise provider crash boundary' } },
  correlationId: 'p8-provider-crash-round',
})
