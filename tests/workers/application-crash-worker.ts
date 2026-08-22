import { WorldApplication } from '@harness-world/application'
import { brandId, type FaultPoint, type WorldAddress } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'

const [worldPath, sessionPath, faultPoint] = process.argv.slice(2)
if (worldPath === undefined || sessionPath === undefined || faultPoint === undefined) {
  throw new Error('usage: application-crash-worker <world-path> <session-path> <fault-point>')
}
const address: WorldAddress = {
  tenantId: brandId('tenant:p6-crash', 'TenantId'),
  worldId: brandId('world:p6-crash', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const application = new WorldApplication({
  worldPath,
  sessionPath,
  runtimeOwnerId: 'application:p6-crash',
  faultInjector: new IpcPauseFaultInjector(faultPoint as FaultPoint),
})
await application.submit(address, {
  idempotencyKey: 'p6-crash-round',
  principalId: 'principal:player',
  action: { actionType: 'speak', parameters: { text: 'durable across hard kill' } },
  correlationId: 'p6-crash-round',
})
