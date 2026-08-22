import { WorldApplication } from '@harness-world/application'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { RoundInbox, WriterLeaseService } from '@harness-world/store-sqlite'

const [worldPath, sessionPath] = process.argv.slice(2)
if (worldPath === undefined || sessionPath === undefined) {
  throw new Error('usage: accepted-round-crash-worker <world-path> <session-path>')
}
const address: WorldAddress = {
  tenantId: brandId('tenant:accepted-crash', 'TenantId'),
  worldId: brandId('world:accepted-crash', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const application = new WorldApplication({ worldPath, sessionPath })
await application.acceptRound(address, {
  idempotencyKey: 'accepted-crash-round',
  principalId: 'principal:player',
  action: { actionType: 'speak', parameters: { text: 'durable before worker crash' } },
  correlationId: 'accepted-crash-round',
})
const leases = new WriterLeaseService(worldPath, () => 0)
const lease = leases.acquire(address, 'worker:about-to-crash', 1)
const inbox = new RoundInbox(worldPath, () => 0)
if (inbox.claimNext(address, lease.ownerId, lease.fencingToken) === undefined) {
  throw new Error('accepted Round was not claimable')
}
process.send?.({ type: 'fault-reached', point: 'round.claimed-before-execution' })
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
