import { SessionDeliveryAdapter, WorldOutbox, WorldStore } from '@harness-world/store-sqlite'
import {
  IpcPauseFaultInjector,
  fixtureAddress,
  fixtureCommitRequest,
  fixtureDeliveryRequest,
} from '@harness-world/testkit'
import type { FaultPoint } from '@harness-world/contracts'

const [mode, databasePath, faultPoint] = process.argv.slice(2)
if ((mode !== 'world' && mode !== 'session' && mode !== 'outbox') || databasePath === undefined || faultPoint === undefined) {
  throw new Error('usage: crash-worker <world|session|outbox> <database-path> <fault-point>')
}
const faultInjector = new IpcPauseFaultInjector(faultPoint as FaultPoint)
if (mode === 'world') {
  const store = new WorldStore(databasePath, faultInjector)
  await store.commitRound(fixtureCommitRequest())
  store.close()
} else if (mode === 'session') {
  const adapter = new SessionDeliveryAdapter(databasePath, faultInjector)
  await adapter.appendIfAbsent(fixtureDeliveryRequest())
  adapter.close()
} else {
  const outbox = new WorldOutbox(databasePath, faultInjector)
  const delivery = outbox.claimNext(fixtureAddress())
  if (delivery === undefined) throw new Error('outbox crash fixture is missing')
  await outbox.recordDelivered(delivery)
  outbox.close()
}
