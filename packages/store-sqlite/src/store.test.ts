import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type CommitRoundRequest,
  type FaultInjector,
  type FaultPoint,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import {
  BranchAdministration,
  OperationalAuditLog,
  ProjectionRebuilder,
  ProjectionStore,
  RoundInbox,
  SessionDeliveryAdapter,
  WriterLeaseService,
  WorldStore,
  openMigratedDatabase,
  openOwnedDatabase,
  parseWorldJson,
  readPragmaInteger,
  rollbackAndThrow,
  WORLD_APPLICATION_ID,
  WORLD_SCHEMA_VERSION,
  worldJsonText,
} from './index.ts'

const directories: string[] = []

class ThrowingFaultInjector implements FaultInjector {
  constructor(private readonly target: FaultPoint) {}

  hit(point: FaultPoint): void {
    if (point === this.target) throw new Error(`simulated fault at ${point}`)
  }
}

function fixtureAddress(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:test', 'TenantId'),
    worldId: brandId('world:test', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function fixtureCommitRequest(address = fixtureAddress()): CommitRoundRequest {
  return {
    address,
    transactionId: brandId('transaction:store-fixture', 'TransactionId'),
    roundId: brandId('round:store-fixture', 'InteractionRoundId'),
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events: [{ eventType: 'fixture.event', eventVersion: 1, data: { value: 'committed' } }],
    outbox: [{
      deliveryId: brandId('delivery:store-fixture', 'DeliveryId'),
      sessionId: brandId('session:store-fixture', 'SessionId'),
      payload: { value: 'delivered' },
      critical: true,
    }],
    correlationId: 'store-fixture',
  }
}

function fixtureDeliveryRequest() {
  const observationEvent = { observationId: 'observation:store-fixture', content: 'visible' } as const
  return {
    sessionId: brandId('session:store-fixture', 'SessionId'),
    sessionDeliverySeq: 1,
    deliveryId: brandId('delivery:store-fixture', 'DeliveryId'),
    payloadHash: hashWorldJson('session-observation', observationEvent),
    observationEvent,
    correlationId: 'store-fixture',
  }
}

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-store-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SQLite ownership helpers', () => {
  it('round-trips validated JSON and rejects ownership/version mismatches', () => {
    expect(parseWorldJson(worldJsonText({ b: 2, a: 1 }))).toEqual({ a: 1, b: 2 })
    expect(() => parseWorldJson('{"value":1.5}')).toThrow(TypeError)
    const path = database('owned.sqlite')
    const first = openOwnedDatabase(path, 1234, 'CREATE TABLE IF NOT EXISTS owned(id INTEGER PRIMARY KEY) STRICT;')
    first.close()
    expect(() => openOwnedDatabase(path, 4321, '')).toThrow('application_id mismatch')

    const versionPath = database('version.sqlite')
    const raw = new DatabaseSync(versionPath)
    raw.exec('PRAGMA user_version = 2')
    raw.close()
    expect(() => openOwnedDatabase(versionPath, 1234, '')).toThrow('user_version mismatch')

    const memoryOwned = openOwnedDatabase(':memory:', 1234, '')
    memoryOwned.close()
    expect(() => openOwnedDatabase(database('invalid-schema.sqlite'), 1234, 'NOT VALID SQL')).toThrow()

    const fake = { prepare: () => ({ get: () => ({ application_id: 'invalid' }) }) } as unknown as DatabaseSync
    expect(() => readPragmaInteger(fake, 'application_id')).toThrow('not an integer')

    const memory = new DatabaseSync(':memory:')
    const original = new Error('original')
    expect(() => rollbackAndThrow(memory, original)).toThrow(original)
    memory.close()
  })

  it('applies contiguous migrations once and rejects invalid migration catalogs', () => {
    expect(() => openMigratedDatabase(':memory:', 1234, [])).toThrow('contiguous')
    expect(() => openMigratedDatabase(':memory:', 1234, [{ version: 2, sql: '' }])).toThrow('contiguous')
    const path = database('migrations.sqlite')
    const v1 = openMigratedDatabase(path, 5678, [{ version: 1, sql: 'CREATE TABLE first(id INTEGER PRIMARY KEY) STRICT;' }])
    v1.close()
    const v2 = openMigratedDatabase(path, 5678, [
      { version: 1, sql: 'CREATE TABLE first(id INTEGER PRIMARY KEY) STRICT;' },
      { version: 2, sql: 'CREATE TABLE second(id INTEGER PRIMARY KEY) STRICT;' },
    ])
    expect(readPragmaInteger(v2, 'user_version')).toBe(2)
    expect(v2.prepare(`SELECT name FROM sqlite_schema WHERE name = 'second'`).get()).toBeDefined()
    v2.close()
    expect(() => openMigratedDatabase(path, 5678, [{ version: 1, sql: '' }])).toThrow('user_version mismatch')
  })
})

describe('WriterLeaseService', () => {
  it('serializes durable ownership and advances fencing tokens after expiry', () => {
    const path = database('writer-lease.sqlite')
    const address = fixtureAddress('lease')
    const world = new WorldStore(path)
    world.createBranch(address)
    world.close()
    let now = 1_000
    const leases = new WriterLeaseService(path, () => now)
    expect(() => leases.acquire(address, '')).toThrow(TypeError)
    expect(() => leases.acquire(address, 'owner:a', 0)).toThrow(RangeError)
    expect(() => leases.acquire(fixtureAddress('missing'), 'owner:a')).toThrow('unknown world branch')
    const first = leases.acquire(address, 'owner:a', 100)
    expect(first).toEqual({ ownerId: 'owner:a', fencingToken: 1, expiresAtMs: 1_100 })
    expect(leases.acquire(address, 'owner:a', 200)).toEqual(first)
    expect(() => leases.acquire(address, 'owner:b')).toThrow('another writer')
    expect(leases.renew(address, 'owner:a', 1, 200)).toEqual({ ownerId: 'owner:a', fencingToken: 1, expiresAtMs: 1_200 })
    now = 1_200
    expect(() => leases.renew(address, 'owner:a', 1)).toThrow('expired or was fenced')
    const second = leases.acquire(address, 'owner:b')
    expect(second.fencingToken).toBe(2)
    expect(leases.release(address, 'owner:a', 1)).toBe(false)
    expect(leases.release(address, 'owner:b', 2)).toBe(true)
    leases.close()

    const raw = new DatabaseSync(path)
    expect(readPragmaInteger(raw, 'application_id')).toBe(WORLD_APPLICATION_ID)
    expect(readPragmaInteger(raw, 'user_version')).toBe(WORLD_SCHEMA_VERSION)
    raw.close()
  })

  it('fences commits after a branch enters leased operation', async () => {
    const path = database('writer-fencing.sqlite')
    const address = fixtureAddress('fenced')
    let now = 5_000
    const world = new WorldStore(path, undefined, () => now)
    world.createBranch(address)
    const leases = new WriterLeaseService(path, () => now)
    const lease = leases.acquire(address, 'kernel')
    const request = fixtureCommitRequest(address)
    await expect(world.commitRound(request)).rejects.toMatchObject({ envelope: { errorCode: 'WRITER_LEASE_LOST' } })
    await expect(world.commitRound({ ...request, writerFencingToken: lease.fencingToken + 1 }))
      .rejects.toMatchObject({ envelope: { errorCode: 'WRITER_LEASE_LOST' } })
    const committed = await world.commitRound({ ...request, writerFencingToken: lease.fencingToken })
    now = lease.expiresAtMs
    await expect(world.commitRound({
      ...request,
      transactionId: brandId('transaction:expired', 'TransactionId'),
      roundId: brandId('round:expired', 'InteractionRoundId'),
      expectedHeadSeq: committed.headSeq,
      expectedTick: committed.tick,
      nextTick: committed.tick + 1,
      writerFencingToken: lease.fencingToken,
    })).rejects.toMatchObject({ envelope: { errorCode: 'WRITER_LEASE_LOST' } })
    expect(leases.release(address, 'kernel', lease.fencingToken)).toBe(true)
    await expect(world.commitRound({
      ...request,
      transactionId: brandId('transaction:missing-lease', 'TransactionId'),
      roundId: brandId('round:missing-lease', 'InteractionRoundId'),
      expectedHeadSeq: committed.headSeq,
      expectedTick: committed.tick,
      nextTick: committed.tick + 1,
      writerFencingToken: lease.fencingToken,
    })).rejects.toMatchObject({ envelope: { errorCode: 'WRITER_LEASE_LOST' } })
    await expect(world.commitRound({ ...request, writerFencingToken: lease.fencingToken }))
      .resolves.toEqual({ ...committed, status: 'already_committed' })
    leases.close()
    world.close()
  })
})

describe('RoundInbox', () => {
  it('persists FIFO admission, retries, fencing takeover, and completion', async () => {
    const path = database('round-inbox.sqlite')
    const address = fixtureAddress('inbox')
    let now = 1_000
    const world = new WorldStore(path, undefined, () => now)
    world.createBranch(address)
    const inbox = new RoundInbox(path, () => now)
    const leases = new WriterLeaseService(path, () => now)
    const firstLease = leases.acquire(address, 'kernel:a', 100)
    const request = {
      address,
      idempotencyKey: 'input:1',
      principalId: 'principal:player',
      input: { type: 'speak', text: 'hello' },
      correlationId: 'inbox-test',
    } as const
    expect(() => inbox.enqueue({ ...request, idempotencyKey: '' }, 1)).toThrow(TypeError)
    expect(() => inbox.enqueue({ ...request, principalId: ' padded ' }, 1)).toThrow(TypeError)
    expect(() => inbox.enqueue(request, 0)).toThrow(RangeError)
    expect(() => inbox.enqueue({ ...request, address: fixtureAddress('missing') }, 1)).toThrow('unknown world branch')
    const first = inbox.enqueue(request, 1)
    expect(first).toMatchObject({ status: 'enqueued', inboxSeq: 1 })
    expect(inbox.enqueue(request, 1)).toEqual({ ...first, status: 'already_enqueued' })
    expect(() => inbox.enqueue({ ...request, input: { type: 'speak', text: 'changed' } }, 1)).toThrow('different player input')
    expect(() => inbox.enqueue({ ...request, idempotencyKey: 'input:2' }, 1)).toThrow('queue is full')
    const administration = new BranchAdministration(path)
    administration.setAdmission(address, 'draining', 'maintenance', 'inbox-draining')
    expect(inbox.enqueue(request, 1)).toEqual({ ...first, status: 'already_enqueued' })
    expect(() => inbox.enqueue({ ...request, idempotencyKey: 'input:draining' }, 2))
      .toThrow('branch admission is draining')
    administration.setAdmission(address, 'open', 'resume', 'inbox-open')
    administration.close()
    expect(() => inbox.claimNext(address, '', 1)).toThrow(TypeError)
    expect(() => inbox.claimNext(address, 'kernel:a', 0)).toThrow(RangeError)
    const claimed = inbox.claimNext(address, 'kernel:a', firstLease.fencingToken)
    expect(claimed).toMatchObject({ inboxSeq: 1, idempotencyKey: 'input:1', input: request.input })
    expect(inbox.claimNext(address, 'kernel:a', firstLease.fencingToken)).toEqual(claimed)
    expect(inbox.readCompleted(address, 'input:1')).toBeUndefined()
    const firstCommitRequest = fixtureCommitRequest(address)
    const firstCommit = await world.commitRound({ ...firstCommitRequest, writerFencingToken: firstLease.fencingToken })
    const firstProof = { transactionId: firstCommitRequest.transactionId, bundleHash: firstCommit.bundleHash }
    expect(() => inbox.complete(address, 999, 'kernel:a', firstLease.fencingToken, firstProof, {
      status: 'missing', bundleHash: firstCommit.bundleHash,
    })).toThrow('not owned')
    expect(() => inbox.complete(address, 1, 'kernel:b', firstLease.fencingToken, firstProof, {
      status: 'wrong-owner', bundleHash: firstCommit.bundleHash,
    }))
      .toThrow('current Writer Lease')
    expect(() => inbox.complete(address, 1, 'kernel:a', firstLease.fencingToken, {
      transactionId: brandId('transaction:missing-proof', 'TransactionId'),
      bundleHash: firstCommit.bundleHash,
    }, { status: 'missing-proof', bundleHash: firstCommit.bundleHash })).toThrow('no matching authoritative commit proof')
    expect(() => inbox.complete(address, 1, 'kernel:a', firstLease.fencingToken, firstProof, {
      status: 'wrong-bundle', bundleHash: 'sha256:wrong',
    })).toThrow('not bound to its authoritative commit bundle')
    for (const unbound of [null, [], { status: 'unbound', bundleHash: 1 }]) {
      expect(() => inbox.complete(address, 1, 'kernel:a', firstLease.fencingToken, firstProof, unbound as never))
        .toThrow('not bound to its authoritative commit bundle')
    }
    const result = { status: 'committed', bundleHash: firstCommit.bundleHash } as const
    const completed = inbox.complete(address, 1, 'kernel:a', firstLease.fencingToken, firstProof, result)
    expect(completed.status).toBe('completed')
    expect(inbox.complete(address, 1, 'kernel:a', firstLease.fencingToken, firstProof, result))
      .toEqual({ ...completed, status: 'already_completed' })
    expect(() => inbox.complete(address, 1, 'kernel:a', firstLease.fencingToken, firstProof, {
      status: 'different', bundleHash: firstCommit.bundleHash,
    }))
      .toThrow('different result')
    expect(inbox.readCompleted(address, 'input:1')).toEqual(result)

    const second = inbox.enqueue({ ...request, idempotencyKey: 'input:2', input: { type: 'move', locationId: 'location:a' } }, 1)
    expect(second.inboxSeq).toBe(2)
    expect(leases.release(address, 'kernel:a', firstLease.fencingToken)).toBe(true)
    const oldLease = leases.acquire(address, 'kernel:old', 100)
    const oldClaim = inbox.claimNext(address, 'kernel:old', oldLease.fencingToken)
    expect(oldClaim?.inboxSeq).toBe(2)
    now = oldLease.expiresAtMs
    const newLease = leases.acquire(address, 'kernel:new', 100)
    expect(() => inbox.complete(address, 2, 'kernel:old', oldLease.fencingToken, firstProof, {
      status: 'stale', bundleHash: firstCommit.bundleHash,
    }))
      .toThrow('current Writer Lease')
    const takenOver = inbox.claimNext(address, 'kernel:new', newLease.fencingToken)
    expect(takenOver).toEqual(oldClaim)
    const secondCommitRequest = {
      ...fixtureCommitRequest(address),
      transactionId: brandId('transaction:round-inbox-second', 'TransactionId'),
      roundId: brandId('round:round-inbox-second', 'InteractionRoundId'),
      expectedHeadSeq: firstCommit.headSeq,
      expectedTick: firstCommit.tick,
      nextTick: firstCommit.tick + 1,
      outbox: [],
      writerFencingToken: newLease.fencingToken,
    }
    const secondCommit = await world.commitRound(secondCommitRequest)
    const secondProof = { transactionId: secondCommitRequest.transactionId, bundleHash: secondCommit.bundleHash }
    inbox.complete(address, 2, 'kernel:new', newLease.fencingToken, secondProof, {
      status: 'rejected', bundleHash: secondCommit.bundleHash,
    })
    const proofReuse = inbox.enqueue({
      ...request,
      idempotencyKey: 'input:proof-reuse',
      input: { type: 'speak', text: 'proof reuse' },
    }, 1)
    const proofClaim = inbox.claimNext(address, 'kernel:new', newLease.fencingToken)
    expect(proofClaim?.inboxSeq).toBe(proofReuse.inboxSeq)
    const proofCommitRequest = {
      ...fixtureCommitRequest(address),
      transactionId: brandId('transaction:proof-owner', 'TransactionId'),
      roundId: brandId('round:proof-owner', 'InteractionRoundId'),
      expectedHeadSeq: secondCommit.headSeq,
      expectedTick: secondCommit.tick,
      nextTick: secondCommit.tick + 1,
      outbox: [],
      admissionProof: { inboxSeq: proofReuse.inboxSeq, inputHash: proofReuse.inputHash },
      writerFencingToken: newLease.fencingToken,
    }
    const proofCommit = await world.commitRound(proofCommitRequest)
    await expect(world.commitRound({
      ...proofCommitRequest,
      transactionId: brandId('transaction:proof-reused', 'TransactionId'),
      roundId: brandId('round:proof-reused', 'InteractionRoundId'),
      expectedHeadSeq: proofCommit.headSeq,
      expectedTick: proofCommit.tick,
      nextTick: proofCommit.tick + 1,
    })).rejects.toMatchObject({ envelope: { errorCode: 'IDEMPOTENCY_KEY_CONFLICT' } })
    inbox.complete(address, proofReuse.inboxSeq, 'kernel:new', newLease.fencingToken, {
      transactionId: proofCommitRequest.transactionId,
      bundleHash: proofCommit.bundleHash,
    }, { status: 'accepted', bundleHash: proofCommit.bundleHash })
    expect(inbox.claimNext(address, 'kernel:new', newLease.fencingToken)).toBeUndefined()
    inbox.close()

    const restarted = new RoundInbox(path, () => now)
    expect(restarted.readCompleted(address, 'input:1')).toEqual(result)
    restarted.enqueue({ ...request, idempotencyKey: 'input:corrupt' }, 1)
    restarted.close()
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE round_inbox SET input_json = 'not-json' WHERE idempotency_key = 'input:corrupt'`).run()
    raw.close()
    const corrupted = new RoundInbox(path, () => now)
    expect(() => corrupted.claimNext(address, 'kernel:new', newLease.fencingToken)).toThrow(SyntaxError)
    corrupted.close()
    const corruptResult = new DatabaseSync(path)
    corruptResult.prepare(`UPDATE round_inbox SET result_hash = 'sha256:corrupt' WHERE idempotency_key = 'input:1'`).run()
    corruptResult.close()
    const integrity = new RoundInbox(path, () => now)
    expect(() => integrity.readCompleted(address, 'input:1')).toThrow('result or commit proof is corrupt')
    integrity.close()
    const corruptProof = new DatabaseSync(path)
    corruptProof.prepare(`UPDATE round_commits SET bundle_hash = 'sha256:corrupt' WHERE transaction_id = ?`)
      .run(secondCommitRequest.transactionId)
    corruptProof.close()
    const proofIntegrity = new RoundInbox(path, () => now)
    expect(() => proofIntegrity.readCompleted(address, 'input:2')).toThrow('commit proof is missing or divergent')
    proofIntegrity.close()
    leases.close()
    world.close()
  })
})

describe('SessionDeliveryAdapter', () => {
  it('atomically applies and deduplicates one ordered delivery', async () => {
    const path = database('session.sqlite')
    const adapter = new SessionDeliveryAdapter(path)
    const request = fixtureDeliveryRequest()
    await expect(adapter.appendIfAbsent(request)).resolves.toEqual({ status: 'applied', cursor: 1 })
    await expect(adapter.appendIfAbsent(request)).resolves.toEqual({ status: 'already_applied', cursor: 1 })
    expect(adapter.cursor(request.sessionId)).toBe(1)
    expect(adapter.readEvent(request.sessionId, 1)).toEqual({ payloadHash: request.payloadHash, payload: request.observationEvent })
    expect(adapter.readEvent(request.sessionId, 2)).toBeUndefined()
    adapter.close()
  })

  it('rejects invalid, divergent, reused, and out-of-order deliveries', async () => {
    const adapter = new SessionDeliveryAdapter(database('session-errors.sqlite'))
    const request = fixtureDeliveryRequest()
    await expect(adapter.appendIfAbsent({ ...request, sessionDeliverySeq: 0 })).rejects.toMatchObject({ envelope: { errorCode: 'INVALID_REQUEST' } })
    await adapter.appendIfAbsent(request)
    await expect(adapter.appendIfAbsent({ ...request, deliveryId: brandId('delivery:other', 'DeliveryId') }))
      .rejects.toMatchObject({ envelope: { errorCode: 'SESSION_DELIVERY_DIVERGED' } })
    await expect(adapter.appendIfAbsent({ ...request, payloadHash: hashWorldJson('different', 1) }))
      .rejects.toMatchObject({ envelope: { errorCode: 'SESSION_DELIVERY_DIVERGED' } })
    await expect(adapter.appendIfAbsent({ ...request, sessionId: brandId('session:other', 'SessionId'), sessionDeliverySeq: 1 }))
      .rejects.toMatchObject({ envelope: { errorCode: 'SESSION_DELIVERY_DIVERGED' } })
    await expect(adapter.appendIfAbsent({
      ...request,
      deliveryId: brandId('delivery:later', 'DeliveryId'),
      sessionDeliverySeq: 3,
    })).rejects.toMatchObject({ envelope: { errorCode: 'SESSION_DELIVERY_OUT_OF_ORDER' } })
    adapter.close()
  })

  it.each([
    'session-delivery.after-inbox-insert',
    'session-delivery.after-observation-append',
  ] as const)('rolls back a simulated pre-commit fault at %s', async (point) => {
    const path = database(`${point}.sqlite`)
    const failing = new SessionDeliveryAdapter(path, new ThrowingFaultInjector(point))
    await expect(failing.appendIfAbsent(fixtureDeliveryRequest())).rejects.toThrow('simulated fault')
    failing.close()
    const recovered = new SessionDeliveryAdapter(path)
    expect(recovered.cursor(fixtureDeliveryRequest().sessionId)).toBe(0)
    recovered.close()
  })

  it('preserves a commit when the caller fails after COMMIT', async () => {
    const path = database('session-after-commit.sqlite')
    const failing = new SessionDeliveryAdapter(path, new ThrowingFaultInjector('session-delivery.after-commit'))
    await expect(failing.appendIfAbsent(fixtureDeliveryRequest())).rejects.toThrow('simulated fault')
    failing.close()
    const recovered = new SessionDeliveryAdapter(path)
    expect(recovered.cursor(fixtureDeliveryRequest().sessionId)).toBe(1)
    recovered.close()
  })
})

describe('WorldStore and temporal projections', () => {
  it('commits Event/Tick/Head/Outbox atomically and replays idempotently', async () => {
    const store = new WorldStore(database('world.sqlite'))
    const address = fixtureAddress()
    store.createBranch(address)
    const baseRequest = fixtureCommitRequest(address)
    const request = { ...baseRequest, outbox: baseRequest.outbox.map(item => ({ ...item, critical: false })) }
    const committed = await store.commitRound(request)
    expect(committed).toMatchObject({ status: 'committed', headSeq: 1, tick: 1 })
    expect(store.head(address)).toMatchObject({ headSeq: 1, tick: 1 })
    expect(store.readEvents(address)).toHaveLength(1)
    expect(store.readOutbox(address)).toMatchObject([{ worldSeq: 1, critical: false, payload: { value: 'delivered' } }])
    expect(store.roundBase(request.transactionId)).toEqual({ headSeq: 0, tick: 0 })
    await expect(store.commitRound(request)).resolves.toEqual({ ...committed, status: 'already_committed' })
    await expect(store.commitRound({ ...request, events: [{ ...request.events[0] as WorldEventDraft, data: { changed: true } }] }))
      .rejects.toMatchObject({ envelope: { errorCode: 'IDEMPOTENCY_KEY_CONFLICT' } })
    store.close()
  })

  it('validates branch heads, tick movement, and request content', async () => {
    const store = new WorldStore(database('world-errors.sqlite'))
    const address = fixtureAddress()
    store.createBranch(address)
    expect(() => store.createBranch(address)).toThrow()
    const request = fixtureCommitRequest(address)
    await expect(store.commitRound({ ...request, events: [] })).rejects.toThrow('at least one event')
    await expect(store.commitRound({ ...request, nextTick: 2 })).rejects.toThrow('exactly one tick')
    await expect(store.commitRound({ ...request, expectedHeadSeq: 1 })).rejects.toMatchObject({ envelope: { errorCode: 'WRITER_LEASE_LOST' } })
    expect(() => store.head(fixtureAddress('unknown'))).toThrow('unknown')
    expect(() => store.readEvents(fixtureAddress('unknown'))).toThrow('unknown')
    expect(store.roundBase(brandId('transaction:unknown', 'TransactionId'))).toBeUndefined()
    store.close()
  })

  it.each(['store.after-event-insert', 'store.before-commit'] as const)('rolls back a simulated pre-commit fault at %s', async (point) => {
    const path = database(`${point}.sqlite`)
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    setup.close()
    const failing = new WorldStore(path, new ThrowingFaultInjector(point))
    await expect(failing.commitRound(fixtureCommitRequest())).rejects.toThrow('simulated fault')
    failing.close()
    const recovered = new WorldStore(path)
    expect(recovered.head(fixtureAddress()).headSeq).toBe(0)
    expect(recovered.readOutbox(fixtureAddress())).toEqual([])
    const audit = new BranchAdministration(path)
    expect(audit.readAudit(fixtureAddress())).toEqual([])
    audit.close()
    recovered.close()
  })

  it('preserves a world commit when the caller fails after COMMIT', async () => {
    const path = database('world-after-commit.sqlite')
    const setup = new WorldStore(path)
    setup.createBranch(fixtureAddress())
    setup.close()
    const failing = new WorldStore(path, new ThrowingFaultInjector('store.after-commit'))
    await expect(failing.commitRound(fixtureCommitRequest())).rejects.toThrow('simulated fault')
    failing.close()
    const recovered = new WorldStore(path)
    expect(recovered.head(fixtureAddress()).headSeq).toBe(1)
    const audit = new BranchAdministration(path)
    expect(audit.readAudit(fixtureAddress())).toMatchObject([{
      operation: 'round.committed',
      details: { transactionId: fixtureCommitRequest().transactionId, headSeq: 1, tick: 1 },
    }])
    audit.close()
    recovered.close()
  })

  it('rebuilds a child at forkSeq without parent future canaries', async () => {
    const store = new WorldStore(database('fork.sqlite'))
    const parent = fixtureAddress('parent')
    const child = fixtureAddress('child')
    store.createBranch(parent)
    const first = fixtureCommitRequest(parent)
    const kinds = ['observation', 'claim', 'goal', 'visibility'] as const
    await store.commitRound({
      ...first,
      events: kinds.map((kind, index) => ({ eventType: `${kind}.upsert`, eventVersion: 1, data: { id: `${kind}:base`, value: { index } } })),
      outbox: [],
    })
    const forkSeq = store.head(parent).headSeq
    store.forkBranch(parent, child, forkSeq)
    const genesisChild = fixtureAddress('genesis-child')
    store.forkBranch(parent, genesisChild, 0)
    expect(store.head(genesisChild)).toEqual({ headSeq: 0, tick: 0, eventHash: 'genesis' })
    expect(() => store.forkBranch(parent, child, forkSeq)).toThrow()
    const parentHead = store.head(parent)
    await store.commitRound({
      ...first,
      transactionId: brandId('transaction:future', 'TransactionId'),
      roundId: brandId('round:future', 'InteractionRoundId'),
      expectedHeadSeq: parentHead.headSeq,
      expectedTick: parentHead.tick,
      nextTick: parentHead.tick + 1,
      events: [{ eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:FUTURE_CANARY', value: 'future' } }],
      outbox: [],
    })
    const rebuilder = new ProjectionRebuilder(store)
    const bundle = rebuilder.rebuildAt(child, forkSeq)
    expect(bundle.observations).toHaveLength(1)
    expect(bundle.claims.map(value => value.id)).toEqual(['claim:base'])
    expect(JSON.stringify(bundle)).not.toContain('FUTURE_CANARY')
    expect(() => store.forkBranch(parent, fixtureAddress('bad-negative'), -1)).toThrow(RangeError)
    expect(() => store.forkBranch(parent, fixtureAddress('bad-future'), 999)).toThrow(RangeError)
    store.close()
  })

  it('fails closed when a fork boundary event is missing from corrupted storage', async () => {
    const path = database('corrupt-fork.sqlite')
    const parent = fixtureAddress('corrupt-parent')
    const setup = new WorldStore(path)
    setup.createBranch(parent)
    await setup.commitRound(fixtureCommitRequest(parent))
    setup.close()
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA foreign_keys = OFF; DELETE FROM events;')
    raw.close()
    const corrupted = new WorldStore(path)
    expect(() => corrupted.forkBranch(parent, fixtureAddress('corrupt-child'), 1)).toThrow('fork event')
    corrupted.close()
  })

  it('inherits manifests, audits forks, and enforces world and depth boundaries', () => {
    const path = database('fork-policy.sqlite')
    const root = fixtureAddress('depth-0')
    const store = new WorldStore(path, undefined, () => 777)
    const manifest = { address: root, name: 'fork-policy' } as const
    const genesisEvents = [{ eventType: 'world.created', eventVersion: 1, data: { name: 'fork-policy' } }] as const
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    store.activateBranch({
      address: root,
      manifest,
      manifestHash,
      genesisEvents,
      genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
      transactionId: brandId('transaction:fork-policy', 'TransactionId'),
      roundId: brandId('round:fork-policy', 'InteractionRoundId'),
      correlationId: 'fork-policy',
    })
    const firstChild = fixtureAddress('depth-1')
    store.forkBranch(root, firstChild, 1)
    expect(store.readManifest(firstChild)).toEqual({ manifest, manifestHash })
    expect(store.readManifest(fixtureAddress('missing-manifest'))).toBeUndefined()
    const audit = new BranchAdministration(path)
    expect(audit.readAudit(firstChild)).toMatchObject([{ operation: 'branch.forked', operationalTimeMs: 777 }])
    audit.close()

    let parent = firstChild
    for (let depth = 2; depth <= 8; depth += 1) {
      const child = fixtureAddress(`depth-${depth}`)
      store.forkBranch(parent, child, 1)
      parent = child
    }
    expect(() => store.forkBranch(parent, fixtureAddress('depth-9'), 1))
      .toThrow('depth limit 8')
    expect(() => store.forkBranch(root, {
      ...fixtureAddress('cross-world'),
      worldId: brandId('world:other', 'WorldId'),
    }, 1)).toThrow('parent tenant and world')
    store.close()

    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.prepare(`UPDATE branches SET parent_address_key = 'missing-parent' WHERE branch_id = ?`).run(firstChild.branchId)
    raw.close()
    const corrupted = new WorldStore(path)
    expect(() => corrupted.forkBranch(firstChild, fixtureAddress('corrupt-depth-child'), 0)).toThrow('unknown world branch missing-parent')
    corrupted.close()
    const operations = new OperationalAuditLog(`${path}.audit.sqlite`)
    expect(operations.read().map(event => event.operation)).toEqual(expect.arrayContaining([
      'world.activate.requested', 'world.branch.fork.requested',
    ]))
    operations.close()
  })

  it('materializes temporal revisions/removals and validates projection events', async () => {
    const world = new WorldStore(database('projection-world.sqlite'))
    const address = fixtureAddress('projection')
    world.createBranch(address)
    const request = fixtureCommitRequest(address)
    await world.commitRound({
      ...request,
      events: [
        { eventType: 'ignored.event', eventVersion: 1, data: {} },
        { eventType: 'goal.upsert', eventVersion: 1, data: { id: 'goal:z', value: 'first' } },
        { eventType: 'goal.upsert', eventVersion: 1, data: { id: 'goal:z', value: 'second' } },
        { eventType: 'goal.remove', eventVersion: 1, data: { id: 'goal:z' } },
      ],
      outbox: [],
    })
    const events = world.readEvents(address)
    const projection = new ProjectionStore(database('projection.sqlite'))
    projection.replaceFromEvents(address, events)
    expect(projection.readAt(address, 2)).toMatchObject([{ id: 'goal:z', value: 'first' }])
    expect(projection.readAt(address, 3)).toMatchObject([{ id: 'goal:z', value: 'second' }])
    expect(projection.readAt(address, 4)).toEqual([])
    expect(new ProjectionRebuilder(world).rebuildAt(address, 4).goals).toEqual([])
    projection.close()

    const badIdStore = new WorldStore(database('bad-id.sqlite'))
    badIdStore.createBranch(address)
    await badIdStore.commitRound({ ...request, events: [{ eventType: 'claim.upsert', eventVersion: 1, data: { value: 1 } }], outbox: [] })
    expect(() => new ProjectionRebuilder(badIdStore).rebuildAt(address, 1)).toThrow('string id')
    const invalidProjection = new ProjectionStore(database('invalid-projection.sqlite'))
    expect(() => invalidProjection.replaceFromEvents(address, badIdStore.readEvents(address))).toThrow('string id')
    expect(invalidProjection.readAt(address, 1)).toEqual([])
    invalidProjection.close()
    badIdStore.close()

    const badValueStore = new WorldStore(database('bad-value.sqlite'))
    badValueStore.createBranch(address)
    await badValueStore.commitRound({ ...request, events: [{ eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim' } }], outbox: [] })
    expect(() => new ProjectionRebuilder(badValueStore).rebuildAt(address, 1)).toThrow('requires value')
    badValueStore.close()
    world.close()
  })
})
