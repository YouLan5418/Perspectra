import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { brandId } from '@perspectra/sdk/contracts'
import { FrozenInteractionRulebook, WorldBootstrap } from '@perspectra/core/kernel'
import { WorldStore } from './world-store.ts'
import { RoundInbox } from './round-inbox.ts'
import { WriterLeaseService } from './writer-lease.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../../../../tests/fixtures/frozen-interaction-world.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'inbox-fault-')),
    path = join(root, 'world.sqlite')
  const store = new WorldStore(path),
    leases = new WriterLeaseService(path),
    inbox = new RoundInbox(path)
  const world = frozenInteractionWorld(),
    address = world.manifest.address
  new WorldBootstrap(store, false, new FrozenInteractionRulebook([basicInteractionPackage])).activate(world)
  const lease = leases.acquire(address, 'writer')
  const queued = inbox.enqueue(
    {
      address,
      idempotencyKey: 'fault',
      principalId: world.manifest.playerBindings[0]!.principalId,
      input: { actionType: 'speak', parameters: { text: 'hello' } },
      correlationId: 'test',
    },
    8,
  )
  inbox.claimNext(address, lease.ownerId, lease.fencingToken)
  return {
    store,
    inbox,
    leases,
    lease,
    address,
    queued,
    close() {
      inbox.close()
      leases.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
const fault = { status: 'failed', pluginId: 'test', operation: 'resolve' }
it('ends an adjudication fault under the current writer without changing authoritative facts', () => {
  const f = fixture()
  try {
    const before = f.store.head(f.address)
    expect(() => f.inbox.failClaimed(f.address, f.queued.inboxSeq, 'other', f.lease.fencingToken, fault)).toThrow()
    expect(f.inbox.readStatus(f.address, { idempotencyKey: 'fault' })?.status).toBe('processing')
    f.inbox.failClaimed(f.address, f.queued.inboxSeq, f.lease.ownerId, f.lease.fencingToken, fault)
    expect(f.inbox.readStatus(f.address, { idempotencyKey: 'fault' })).toMatchObject({
      status: 'failed',
      result: fault,
    })
    expect(f.store.head(f.address)).toEqual(before)
    expect(f.inbox.unfinishedAddresses()).toEqual([])
  } finally {
    f.close()
  }
})
it('cannot relabel a committed round as a failed adjudication', async () => {
  const f = fixture()
  try {
    const head = f.store.head(f.address)
    const status = f.inbox.readStatus(f.address, { idempotencyKey: 'fault' })!
    await f.store.commitRound({
      address: f.address,
      transactionId: brandId('committed', 'TransactionId'),
      roundId: status.roundId,
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events: [{ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1 } }],
      outbox: [],
      writerFencingToken: f.lease.fencingToken,
      correlationId: 'test',
    })
    expect(() =>
      f.inbox.failClaimed(f.address, f.queued.inboxSeq, f.lease.ownerId, f.lease.fencingToken, fault),
    ).toThrow('committed round')
    expect(f.inbox.readStatus(f.address, { idempotencyKey: 'fault' })?.status).toBe('processing')
    expect(f.store.head(f.address).tick).toBe(head.tick + 1)
  } finally {
    f.close()
  }
})
