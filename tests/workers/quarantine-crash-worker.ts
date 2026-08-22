import { createErrorEnvelope, type FaultPoint } from '@harness-world/contracts'
import { BranchQuarantineService } from '@harness-world/store-sqlite'
import { fixtureAddress, IpcPauseFaultInjector } from '@harness-world/testkit'

const [mode, databasePath, faultPoint] = process.argv.slice(2)
if ((mode !== 'quarantine' && mode !== 'recover') || databasePath === undefined || faultPoint === undefined) {
  throw new Error('usage: quarantine-crash-worker <quarantine|recover> <database-path> <fault-point>')
}
const address = fixtureAddress()
const quarantine = new BranchQuarantineService(
  databasePath,
  Date.now,
  new IpcPauseFaultInjector(faultPoint as FaultPoint),
)
if (mode === 'quarantine') {
  quarantine.quarantine({
    address,
    error: createErrorEnvelope({
      errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'hard-crash quarantine fixture',
      retryable: false, correlationId: 'crash:quarantine', address,
    }),
    source: 'crash-worker',
  })
} else {
  quarantine.recover(address, 'crash:recover', () => ({ eventChain: 'verified', projection: 'verified', session: 'verified' }))
}
quarantine.close()
