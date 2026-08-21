import { SessionDeliveryAdapter, WorldStore } from '@harness-world/store-sqlite'
import {
  IpcPauseFaultInjector,
  fixtureCommitRequest,
  fixtureDeliveryRequest,
} from '@harness-world/testkit'
import type { FaultPoint } from '@harness-world/contracts'

const [mode, databasePath, faultPoint] = process.argv.slice(2)
if ((mode !== 'world' && mode !== 'session') || databasePath === undefined || faultPoint === undefined) {
  throw new Error('usage: crash-worker <world|session> <database-path> <fault-point>')
}
const faultInjector = new IpcPauseFaultInjector(faultPoint as FaultPoint)
if (mode === 'world') {
  const store = new WorldStore(databasePath, faultInjector)
  await store.commitRound(fixtureCommitRequest())
  store.close()
} else {
  const adapter = new SessionDeliveryAdapter(databasePath, faultInjector)
  await adapter.appendIfAbsent(fixtureDeliveryRequest())
  adapter.close()
}
