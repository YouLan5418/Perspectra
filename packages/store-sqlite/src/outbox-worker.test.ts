import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type FaultPoint, type WorldAddress } from '@harness-world/contracts'
import { SessionDeliveryAdapter } from './session-delivery.ts'
import { SessionOutboxWorker, WorldOutbox, type ClaimedOutboxDelivery, type SessionDeliveryPort } from './outbox-worker.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function paths(name: string): { world: string; session: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-outbox-'))
  directories.push(directory)
  return { world: join(directory, `${name}-world.sqlite`), session: join(directory, `${name}-session.sqlite`) }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(): WorldAddress {
  return {
    tenantId: brandId('tenant:outbox', 'TenantId'),
    worldId: brandId('world:outbox', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
}

async function seed(path: string, deliveries: readonly { id: string; session: string; critical: boolean }[]): Promise<void> {
  const store = new WorldStore(path)
  store.createBranch(address())
  await store.commitRound({
    address: address(),
    transactionId: brandId(`transaction:${deliveries.map(value => value.id).join(':')}`, 'TransactionId'),
    roundId: brandId('round:outbox', 'InteractionRoundId'),
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events: [{ eventType: 'fixture.event', eventVersion: 1, data: {} }],
    outbox: deliveries.map(value => ({
      deliveryId: brandId(value.id, 'DeliveryId'),
      sessionId: brandId(value.session, 'SessionId'),
      payload: { delivery: value.id },
      critical: value.critical,
    })),
    correlationId: 'seed-outbox',
  })
  store.close()
}

describe('SessionOutboxWorker', () => {
  it('delivers FIFO per Session, records receipts, and runs Sessions independently', async () => {
    const path = paths('fifo')
    await seed(path.world, [
      { id: 'delivery:01', session: 'session:a', critical: true },
      { id: 'delivery:02', session: 'session:a', critical: true },
      { id: 'delivery:03', session: 'session:b', critical: false },
    ])
    const outbox = new WorldOutbox(path.world)
    const session = new SessionDeliveryAdapter(path.session)
    const worker = new SessionOutboxWorker(outbox, session)
    await expect(worker.runOnce()).resolves.toEqual({ status: 'delivered', deliveryId: 'delivery:01' })
    await expect(worker.runOnce('second')).resolves.toEqual({ status: 'delivered', deliveryId: 'delivery:02' })
    await expect(worker.runOnce()).resolves.toEqual({ status: 'delivered', deliveryId: 'delivery:03' })
    await expect(worker.runOnce()).resolves.toEqual({ status: 'idle' })
    expect(session.cursor(brandId('session:a', 'SessionId'))).toBe(2)
    expect(session.cursor(brandId('session:b', 'SessionId'))).toBe(1)
    expect(outbox.hasReceipt(brandId('delivery:01', 'DeliveryId'))).toBe(true)
    expect(outbox.hasReceipt(brandId('missing', 'DeliveryId'))).toBe(false)
    session.close()
    outbox.close()
  })

  it('blocks a Session behind a critical dead letter and resumes after explicit retry', async () => {
    const path = paths('dead-letter')
    await seed(path.world, [
      { id: 'delivery:critical', session: 'session:blocked', critical: true },
      { id: 'delivery:later', session: 'session:blocked', critical: true },
    ])
    const outbox = new WorldOutbox(path.world)
    const failing: SessionDeliveryPort = { appendIfAbsent: async () => { throw new Error('session offline') } }
    const worker = new SessionOutboxWorker(outbox, failing, 1)
    await expect(worker.runOnce()).resolves.toEqual({ status: 'dead_letter', deliveryId: 'delivery:critical' })
    await expect(worker.runOnce()).resolves.toEqual({ status: 'idle' })
    expect(outbox.deadLetters()).toMatchObject([{
      deliveryId: 'delivery:critical', critical: true, attemptCount: 1, lastError: 'session offline', sessionDeliverySeq: 1,
    }])
    expect(() => outbox.retryDeadLetter(brandId('delivery:later', 'DeliveryId'))).toThrow('not a dead letter')
    outbox.retryDeadLetter(brandId('delivery:critical', 'DeliveryId'))
    const session = new SessionDeliveryAdapter(path.session)
    const recovered = new SessionOutboxWorker(outbox, session, 2)
    await expect(recovered.runOnce()).resolves.toMatchObject({ status: 'delivered', deliveryId: 'delivery:critical' })
    await expect(recovered.runOnce()).resolves.toMatchObject({ status: 'delivered', deliveryId: 'delivery:later' })
    expect(session.cursor(brandId('session:blocked', 'SessionId'))).toBe(2)
    session.close()
    outbox.close()
  })

  it('retries consumer commit ambiguity without duplicating a Session Observation', async () => {
    const path = paths('consumer-ambiguity')
    await seed(path.world, [{ id: 'delivery:ambiguous', session: 'session:ambiguous', critical: true }])
    const outbox = new WorldOutbox(path.world)
    const afterCommit = new SessionDeliveryAdapter(path.session, {
      hit(point: FaultPoint) { if (point === 'session-delivery.after-commit') throw new Error('caller lost COMMIT result') },
    })
    const first = new SessionOutboxWorker(outbox, afterCommit, 2)
    await expect(first.runOnce()).resolves.toEqual({ status: 'retry_scheduled', deliveryId: 'delivery:ambiguous' })
    afterCommit.close()
    const recoveredSession = new SessionDeliveryAdapter(path.session)
    const recovered = new SessionOutboxWorker(outbox, recoveredSession, 2)
    await expect(recovered.runOnce()).resolves.toEqual({ status: 'delivered', deliveryId: 'delivery:ambiguous' })
    expect(recoveredSession.cursor(brandId('session:ambiguous', 'SessionId'))).toBe(1)
    expect(recoveredSession.readEvent(brandId('session:ambiguous', 'SessionId'), 2)).toBeUndefined()
    recoveredSession.close()
    outbox.close()
  })

  it('rolls back or preserves sender receipts at the exact COMMIT boundary', async () => {
    for (const [suffix, point, receiptAfter] of [
      ['before', 'outbox.before-receipt-commit', false],
      ['after', 'outbox.after-receipt-commit', true],
    ] as const) {
      const path = paths(`receipt-${suffix}`)
      const deliveryId = brandId(`delivery:${suffix}`, 'DeliveryId')
      await seed(path.world, [{ id: deliveryId, session: `session:${suffix}`, critical: true }])
      let now = 1_000
      const faulting = new WorldOutbox(
        path.world,
        { hit(hitPoint) { if (hitPoint === point) throw new Error(`fault ${suffix}`) } },
        { workerId: `worker:${suffix}`, claimTtlMs: 100, now: () => now },
      )
      const delivery = faulting.claimNext() as ClaimedOutboxDelivery
      await expect(faulting.recordDelivered(delivery)).rejects.toThrow(`fault ${suffix}`)
      expect(faulting.hasReceipt(deliveryId)).toBe(receiptAfter)
      faulting.close()
      now = delivery.claimExpiresAtMs
      const recovered = new WorldOutbox(path.world, undefined, { workerId: `worker:${suffix}:recovered`, now: () => now })
      expect(recovered.claimNext() === undefined).toBe(receiptAfter)
      recovered.close()
    }
  })

  it('validates sender state and records retryable unknown failures', async () => {
    const path = paths('validation')
    await seed(path.world, [{ id: 'delivery:validation', session: 'session:validation', critical: false }])
    const outbox = new WorldOutbox(path.world)
    const delivery = outbox.claimNext() as ClaimedOutboxDelivery
    expect(() => outbox.recordFailed(delivery, 'bad', 0)).toThrow(RangeError)
    await expect(outbox.recordDelivered({ ...delivery, payloadHash: 'sha256:mismatch' })).rejects.toThrow('does not match')
    expect(outbox.recordFailed(delivery, 'retry after mismatch', 2)).toBe('retry_scheduled')
    const unknownFailure: SessionDeliveryPort = { appendIfAbsent: async () => Promise.reject('not-an-error') }
    const worker = new SessionOutboxWorker(outbox, unknownFailure, 1)
    await expect(worker.runOnce()).resolves.toEqual({ status: 'dead_letter', deliveryId: 'delivery:validation' })
    expect(outbox.deadLetters()).toMatchObject([{ critical: false, lastError: 'unknown Session delivery failure' }])
    outbox.close()

    const corruptPath = paths('corrupt-payload')
    await seed(corruptPath.world, [{ id: 'delivery:corrupt', session: 'session:corrupt', critical: true }])
    const raw = new DatabaseSync(corruptPath.world)
    raw.prepare(`UPDATE outbox SET payload_json = 'not-json' WHERE delivery_id = 'delivery:corrupt'`).run()
    raw.close()
    const corrupted = new WorldOutbox(corruptPath.world)
    expect(() => corrupted.claimNext()).toThrow(SyntaxError)
    corrupted.close()
  })

  it('leases claims and rejects stale worker completion or failure writes', async () => {
    const path = paths('claim-lease')
    await seed(path.world, [{ id: 'delivery:leased', session: 'session:leased', critical: true }])
    let now = 1_000
    let token = 0
    const options = (workerId: string) => ({
      workerId,
      claimTtlMs: 100,
      now: () => now,
      createClaimToken: () => `${workerId}:${token += 1}`,
    })
    const firstWorker = new WorldOutbox(path.world, undefined, options('worker:first'))
    const secondWorker = new WorldOutbox(path.world, undefined, options('worker:second'))
    const firstClaim = firstWorker.claimNext() as ClaimedOutboxDelivery
    expect(firstClaim).toMatchObject({ claimOwnerId: 'worker:first', claimExpiresAtMs: 1_100, attemptCount: 1 })
    expect(secondWorker.claimNext()).toBeUndefined()

    now = firstClaim.claimExpiresAtMs
    const replacement = secondWorker.claimNext() as ClaimedOutboxDelivery
    expect(replacement).toMatchObject({ claimOwnerId: 'worker:second', attemptCount: 2 })
    expect(replacement.claimToken).not.toBe(firstClaim.claimToken)
    await secondWorker.recordDelivered(replacement)
    expect(() => firstWorker.recordFailed(firstClaim, 'late failure', 1)).toThrow('stale')
    await expect(firstWorker.recordDelivered(firstClaim)).rejects.toThrow('stale')
    expect(secondWorker.hasReceipt(replacement.deliveryId)).toBe(true)
    firstWorker.close()
    secondWorker.close()

    expect(() => new WorldOutbox(path.world, undefined, { workerId: '' })).toThrow(TypeError)
    expect(() => new WorldOutbox(path.world, undefined, { claimTtlMs: 0 })).toThrow(RangeError)
  })
})
