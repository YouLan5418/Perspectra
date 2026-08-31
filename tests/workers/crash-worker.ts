import { RoundInbox, SessionDeliveryAdapter, WorldOutbox, WorldStore } from '@harness-world/store-sqlite'
import {
  IpcPauseFaultInjector,
  fixtureAddress,
  fixtureCommitRequest,
  fixtureDeliveryRequest,
} from '@harness-world/testkit'
import type { FaultPoint } from '@harness-world/contracts'
import { brandId, hashWorldJson } from '@harness-world/contracts'

const [mode, databasePath, faultPoint] = process.argv.slice(2)
if ((mode !== 'world' && mode !== 'session' && mode !== 'outbox' && mode !== 'reaction-preempt' && mode !== 'reaction-settle')
  || databasePath === undefined || faultPoint === undefined) {
  throw new Error('usage: crash-worker <world|session|outbox|reaction-preempt|reaction-settle> <database-path> <fault-point>')
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
} else if (mode === 'outbox') {
  const outbox = new WorldOutbox(databasePath, faultInjector)
  const delivery = outbox.claimNext(fixtureAddress())
  if (delivery === undefined) throw new Error('outbox crash fixture is missing')
  await outbox.recordDelivered(delivery)
  outbox.close()
} else if (mode === 'reaction-preempt') {
  const inbox = new RoundInbox(databasePath, Date.now, faultInjector)
  inbox.enqueue({
    address: fixtureAddress(),
    idempotencyKey: 'reaction:player-preempt',
    principalId: 'principal:player',
    input: { type: 'speak', text: 'interrupt' },
    correlationId: 'reaction:player-preempt',
  }, 1)
  inbox.close()
} else {
  const store = new WorldStore(databasePath, faultInjector)
  const address = fixtureAddress()
  const bundle = store.activeReactionCycle(address)
  const job = bundle?.jobs.find(value => value.status === 'claimed')
  if (bundle === undefined || job?.status !== 'claimed') throw new Error('reaction settlement crash fixture is missing')
  if (job.claimOwnerId === null || job.claimFencingToken === null) {
    throw new Error('reaction settlement crash fixture has no live claim')
  }
  const head = store.head(address)
  await store.commitRound({
    address,
    transactionId: brandId('transaction:reaction-crash-settle', 'TransactionId'),
    roundId: brandId('round:reaction-crash-settle', 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: { text: 'settle after crash' } }],
    outbox: [],
    authority: { schemaVersion: 1, origin: 'reaction', cycleId: bundle.cycle.cycleId, wave: 1 },
    reactionSettlement: {
      cycleId: bundle.cycle.cycleId,
      wave: 1,
      terminalReason: 'quiescent',
      jobs: [{
        jobId: job.jobId,
        claimOwnerId: job.claimOwnerId,
        claimFencingToken: job.claimFencingToken,
        expectedStateHash: job.stateHash,
        outcome: 'proposed',
        proposalHash: hashWorldJson('reaction-proposal:test', 'crash-settle'),
      }],
    },
    writerFencingToken: 1,
    correlationId: 'reaction-crash-settle',
  })
  store.close()
}
