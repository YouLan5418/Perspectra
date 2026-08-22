import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, worldAddressKey } from '@harness-world/contracts'
import { RoundInbox } from './round-inbox.ts'
import { WriterLeaseService } from './writer-lease.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []
const address = {
  tenantId: brandId('tenant:round-status', 'TenantId'), worldId: brandId('world:round-status', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-round-status-'))
  directories.push(directory)
  return join(directory, 'world.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable Round status and queued cancellation', () => {
  it('maps every durable state, supports both selectors, and cancels only pending work', async () => {
    const path = database()
    const world = new WorldStore(path)
    world.createBranch(address)
    const inbox = new RoundInbox(path)
    const first = inbox.enqueue({ address, idempotencyKey: 'round:cancel', principalId: 'principal:player', input: { actionType: 'speak', parameters: {} }, correlationId: 'enqueue:cancel' }, 8)
    expect(inbox.readStatus(address, { idempotencyKey: 'round:cancel' })).toMatchObject({ status: 'queued', roundId: first.roundId, result: null })
    expect(inbox.readStatus(address, { roundId: first.roundId })).toMatchObject({ inboxSeq: first.inboxSeq })
    expect(inbox.readStatus(address, { idempotencyKey: 'missing' })).toBeUndefined()
    expect(() => inbox.readStatus(address, {})).toThrow('exactly one')
    expect(() => inbox.readStatus(address, { idempotencyKey: 'x', roundId: first.roundId })).toThrow('exactly one')
    expect(inbox.cancelQueued(address, { roundId: first.roundId }, 'cancel:first')).toMatchObject({ status: 'cancelled', result: { status: 'cancelled' } })
    expect(inbox.cancelQueued(address, { idempotencyKey: 'round:cancel' }, 'cancel:retry').status).toBe('cancelled')
    expect(() => inbox.cancelQueued(address, { idempotencyKey: 'missing' }, 'cancel:missing')).toThrow('unknown Round')

    const second = inbox.enqueue({ address, idempotencyKey: 'round:processing', principalId: 'principal:player', input: { actionType: 'speak', parameters: {} }, correlationId: 'enqueue:processing' }, 8)
    const leases = new WriterLeaseService(path)
    const lease = leases.acquire(address, 'round-status-owner')
    expect(inbox.claimNext(address, lease.ownerId, lease.fencingToken)).toMatchObject({ inboxSeq: second.inboxSeq })
    expect(inbox.readStatus(address, { roundId: second.roundId })?.status).toBe('processing')
    expect(() => inbox.cancelQueued(address, { roundId: second.roundId }, 'cancel:processing')).toThrow('only a queued Round')
    const head = world.head(address)
    const transactionId = brandId('transaction:round-status', 'TransactionId')
    const commit = await world.commitRound({
      address, transactionId, roundId: second.roundId,
      expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
      events: [{ eventType: 'round.status.fixture', eventVersion: 1, data: null }], outbox: [],
      correlationId: 'round-status:commit', admissionProof: { inboxSeq: second.inboxSeq, inputHash: second.inputHash },
      writerFencingToken: lease.fencingToken,
    })
    const result = { status: 'accepted', bundleHash: commit.bundleHash }
    inbox.complete(address, second.inboxSeq, lease.ownerId, lease.fencingToken, { transactionId, bundleHash: commit.bundleHash }, result)
    expect(inbox.readStatus(address, { idempotencyKey: 'round:processing' })).toMatchObject({ status: 'committed', result })
    expect(() => inbox.cancelQueued(address, { idempotencyKey: 'round:processing' }, 'cancel:committed')).toThrow('only a queued Round')

    const third = inbox.enqueue({ address, idempotencyKey: 'round:failed', principalId: 'principal:player', input: { actionType: 'speak', parameters: {} }, correlationId: 'enqueue:failed' }, 8)
    const failedResult = { status: 'failed', reason: 'fixture' }
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE round_inbox SET status = 'failed', result_hash = ?, result_json = ? WHERE address_key = ? AND inbox_seq = ?`)
      .run(hashWorldJson('player-round-result', failedResult), JSON.stringify(failedResult), worldAddressKey(address), third.inboxSeq)
    expect(inbox.readStatus(address, { roundId: third.roundId })).toMatchObject({ status: 'failed', result: failedResult })
    raw.prepare(`UPDATE round_inbox SET result_hash = 'sha256:corrupt' WHERE address_key = ? AND inbox_seq = ?`)
      .run(worldAddressKey(address), third.inboxSeq)
    expect(() => inbox.readStatus(address, { roundId: third.roundId })).toThrow('status result is corrupt')
    raw.close()
    leases.release(address, lease.ownerId, lease.fencingToken)
    leases.close()
    inbox.close()
    world.close()
  })
})
