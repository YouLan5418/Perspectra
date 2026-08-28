import { CognitiveMemoryService } from '@harness-world/memory'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { fixtureAddress, IpcPauseFaultInjector } from '@harness-world/testkit'

const [worldPath, memoryPath] = process.argv.slice(2)
if (worldPath === undefined || memoryPath === undefined) {
  throw new Error('usage: memory-v2-crash-worker <world-path> <memory-path>')
}

const address = fixtureAddress()
const world = new WorldStore(worldPath)
const leaseService = new WriterLeaseService(worldPath)
const lease = leaseService.acquire(address, 'memory:v2-crash-worker', 10_000)
const memory = new CognitiveMemoryService(
  memoryPath,
  world,
  new IpcPauseFaultInjector('memory.after-catchup-commit'),
  2,
)

memory.processPending(
  address,
  'memory:v2-crash-worker',
  lease.fencingToken,
  () => { leaseService.renew(address, 'memory:v2-crash-worker', lease.fencingToken, 10_000) },
)
