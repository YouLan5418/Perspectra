import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  worldAddressKey,
  type CommitRoundRequest,
  type FaultInjector,
  type FaultPoint,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonValue,
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
  openWorldDatabase,
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

function worldSchemaRows(db: DatabaseSync): WorldJsonValue {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string }>
  return rows.map(row => ({ type: row.type, name: row.name, tableName: row.tbl_name, sql: row.sql }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

function insertReactionCycle(
  db: DatabaseSync,
  input: {
    readonly cycleId: string
    readonly addressKey: string
    readonly rootRoundId: string
    readonly rootTransactionId: string
    readonly status?: 'active' | 'stop_requested' | 'terminal'
    readonly stopReason?: string | null
    readonly terminalReason?: string | null
    readonly terminalAtSeq?: number | null
  },
): void {
  db.prepare(`
    INSERT INTO world_reaction_cycles(
      cycle_id, address_key, root_round_id, root_transaction_id, created_at_seq,
      policy_version, profile_id, max_waves, max_npc_calls, max_calls_per_character,
      max_actions_per_call, allowed_action_types_json, initial_token_budget, deadline_at_ms,
      budget_hash, status, stop_reason, terminal_reason, terminal_at_seq, cycle_hash, state_hash
    ) VALUES (?, ?, ?, ?, 1, 'reaction-policy/v1', 'responsive/v1', 3, 8, 2, 1,
      '["speak@1"]', 4096, 1000, 'sha256:budget', ?, ?, ?, ?, 'sha256:cycle', 'sha256:state')
  `).run(
    input.cycleId,
    input.addressKey,
    input.rootRoundId,
    input.rootTransactionId,
    input.status ?? 'active',
    input.stopReason ?? null,
    input.terminalReason ?? null,
    input.terminalAtSeq ?? null,
  )
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

    const rollbackPath = database('migration-rollback.sqlite')
    const beforeFailure = openMigratedDatabase(rollbackPath, 6789, [{
      version: 1,
      sql: 'CREATE TABLE durable(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO durable VALUES (1, \'kept\');',
    }])
    beforeFailure.close()
    expect(() => openMigratedDatabase(rollbackPath, 6789, [
      { version: 1, sql: '' },
      { version: 2, sql: 'CREATE TABLE rolled_back(id INTEGER PRIMARY KEY) STRICT; INSERT INTO missing VALUES (1);' },
    ])).toThrow()
    const afterFailure = new DatabaseSync(rollbackPath)
    expect(readPragmaInteger(afterFailure, 'user_version')).toBe(1)
    expect(afterFailure.prepare('SELECT * FROM durable').all()).toEqual([{ id: 1, value: 'kept' }])
    expect(afterFailure.prepare(`SELECT name FROM sqlite_schema WHERE name = 'rolled_back'`).get()).toBeUndefined()
    afterFailure.close()
  })
})

describe('World schema v18', () => {
  it('freezes the formal four-table Reaction schema, constraints, indexes, and Golden hash', async () => {
    const path = database('world-v16.sqlite')
    const firstAddress = fixtureAddress('reaction-schema-a')
    const secondAddress = fixtureAddress('reaction-schema-b')
    const store = new WorldStore(path)
    store.createBranch(firstAddress)
    store.createBranch(secondAddress)
    const firstRequest = { ...fixtureCommitRequest(firstAddress), transactionId: brandId('transaction:reaction-schema-a', 'TransactionId'), roundId: brandId('round:reaction-schema-a', 'InteractionRoundId'), outbox: [] }
    const secondRequest = { ...fixtureCommitRequest(secondAddress), transactionId: brandId('transaction:reaction-schema-b', 'TransactionId'), roundId: brandId('round:reaction-schema-b', 'InteractionRoundId'), outbox: [] }
    await store.commitRound(firstRequest)
    await store.commitRound(secondRequest)
    store.close()

    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA foreign_keys = ON')
    expect(readPragmaInteger(raw, 'user_version')).toBe(WORLD_SCHEMA_VERSION)
    const names = (worldSchemaRows(raw) as Array<{ readonly name: string }>).map(row => row.name)
    expect(names).toEqual(expect.arrayContaining([
      'events_type_range',
      'world_reaction_cycles',
      'world_reaction_cycles_one_open',
      'world_reaction_job_stimuli',
      'world_reaction_jobs',
      'world_reaction_jobs_claim_order',
      'world_reaction_jobs_cycle_wave_status',
      'world_reaction_jobs_provider_call',
      'world_reaction_waves',
      'world_reaction_waves_reaction_round',
      'world_reaction_waves_result_transaction',
    ]))
    expect(hashWorldJson('world-sqlite-schema/v18', (worldSchemaRows(raw) as { name: string }[]).filter(row => row.name !== 'player_input_jobs')))
      .toBe('sha256:fca11e7158047f7bdfe074fa0c7e7d13fd80fe977863521bbfb0e9d49b8553af')

    insertReactionCycle(raw, {
      cycleId: 'cycle:valid',
      addressKey: worldAddressKey(firstAddress),
      rootRoundId: firstRequest.roundId,
      rootTransactionId: firstRequest.transactionId,
    })
    expect(() => insertReactionCycle(raw, {
      cycleId: 'cycle:duplicate-open',
      addressKey: worldAddressKey(firstAddress),
      rootRoundId: 'round:duplicate-open',
      rootTransactionId: secondRequest.transactionId,
    })).toThrow()
    expect(() => insertReactionCycle(raw, {
      cycleId: 'cycle:invalid-state',
      addressKey: worldAddressKey(secondAddress),
      rootRoundId: secondRequest.roundId,
      rootTransactionId: secondRequest.transactionId,
      status: 'active',
      stopReason: 'player_preempted',
    })).toThrow()
    expect(() => insertReactionCycle(raw, {
      cycleId: 'cycle:missing-branch',
      addressKey: 'missing-address',
      rootRoundId: 'round:missing',
      rootTransactionId: secondRequest.transactionId,
    })).toThrow()
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    raw.close()
  })

  it('migrates a v15 authority prefix without rewriting historical rows', () => {
    const path = database('world-v15-to-v16.sqlite')
    const address = fixtureAddress('legacy-v15')
    const key = worldAddressKey(address)
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      PRAGMA application_id = ${WORLD_APPLICATION_ID};
      PRAGMA user_version = 15;
      CREATE TABLE branches(address_key TEXT PRIMARY KEY) STRICT;
      CREATE TABLE round_commits(
        transaction_id TEXT PRIMARY KEY,
        address_key TEXT NOT NULL,
        round_id TEXT NOT NULL,
        authority_hash TEXT
      ) STRICT;
      CREATE TABLE events(
        address_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        PRIMARY KEY(address_key, seq)
      ) STRICT;
    `)
    legacy.prepare('INSERT INTO branches VALUES (?)').run(key)
    legacy.prepare('INSERT INTO round_commits VALUES (?, ?, ?, ?)')
      .run('transaction:legacy', key, 'round:legacy', 'sha256:legacy-authority')
    legacy.prepare('INSERT INTO events VALUES (?, 1, ?, ?)')
      .run(key, 'observation.upsert', 'transaction:legacy')
    const before = {
      branches: legacy.prepare('SELECT * FROM branches').all(),
      rounds: legacy.prepare('SELECT * FROM round_commits').all(),
      events: legacy.prepare('SELECT * FROM events').all(),
    }
    legacy.close()

    const migrated = openWorldDatabase(path)
    expect(readPragmaInteger(migrated, 'user_version')).toBe(WORLD_SCHEMA_VERSION)
    expect({
      branches: migrated.prepare('SELECT * FROM branches').all(),
      rounds: migrated.prepare('SELECT * FROM round_commits').all(),
      events: migrated.prepare('SELECT * FROM events').all(),
    }).toEqual(before)
    for (const table of [
      'world_reaction_cycles', 'world_reaction_waves', 'world_reaction_jobs', 'world_reaction_job_stimuli',
    ]) expect((migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0)
    expect(migrated.prepare(`SELECT name FROM sqlite_schema WHERE name = 'events_type_range'`).get()).toBeDefined()
    migrated.close()
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
    const missingControlAddress = fixtureAddress('missing-control')
    world.createBranch(missingControlAddress)
    const rawControl = new DatabaseSync(path)
    rawControl.prepare(`DELETE FROM branch_controls WHERE address_key = ?`).run(worldAddressKey(missingControlAddress))
    rawControl.close()
    expect(() => inbox.enqueue({
      address: missingControlAddress,
      idempotencyKey: 'missing-control',
      principalId: 'principal:player',
      input: { type: 'speak' },
      correlationId: 'missing-control',
    }, 1)).toThrow('unknown world branch')
    const archivedAddress = fixtureAddress('archived-inbox')
    world.createBranch(archivedAddress)
    const archivedAdmin = new BranchAdministration(path, () => now)
    archivedAdmin.setAdmission(archivedAddress, 'draining', 'archive fixture', 'archive-fixture-drain')
    archivedAdmin.archive(archivedAddress, 'archive fixture', 'archive-fixture')
    expect(() => inbox.enqueue({
      address: archivedAddress,
      idempotencyKey: 'archived',
      principalId: 'principal:player',
      input: { type: 'speak' },
      correlationId: 'archived',
    }, 1)).toThrow('branch is archived')
    archivedAdmin.close()
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
    const blocked = inbox.enqueue({
      ...request,
      idempotencyKey: 'input:blocked-bind',
      input: { type: 'speak', text: 'blocked bind' },
    }, 1)
    inbox.claimNext(address, 'kernel:new', newLease.fencingToken)
    const trigger = new DatabaseSync(path)
    trigger.exec(`
      CREATE TRIGGER block_round_admission_bind
      BEFORE UPDATE OF commit_transaction_id ON round_inbox
      WHEN NEW.idempotency_key = 'input:blocked-bind'
      BEGIN SELECT RAISE(IGNORE); END;
    `)
    trigger.close()
    const blockedRequest = {
      ...fixtureCommitRequest(address),
      transactionId: brandId('transaction:blocked-bind', 'TransactionId'),
      roundId: brandId('round:blocked-bind', 'InteractionRoundId'),
      expectedHeadSeq: proofCommit.headSeq,
      expectedTick: proofCommit.tick,
      nextTick: proofCommit.tick + 1,
      outbox: [],
      admissionProof: { inboxSeq: blocked.inboxSeq, inputHash: blocked.inputHash },
      writerFencingToken: newLease.fencingToken,
    }
    await expect(world.commitRound(blockedRequest)).rejects.toThrow('could not be bound')
    const dropTrigger = new DatabaseSync(path)
    dropTrigger.exec(`DROP TRIGGER block_round_admission_bind`)
    dropTrigger.close()
    const blockedCommit = await world.commitRound(blockedRequest)
    inbox.complete(address, blocked.inboxSeq, 'kernel:new', newLease.fencingToken, {
      transactionId: blockedRequest.transactionId,
      bundleHash: blockedCommit.bundleHash,
    }, { status: 'accepted', bundleHash: blockedCommit.bundleHash })
    await expect(world.commitRound({
      ...blockedRequest,
      transactionId: brandId('transaction:invalid-proof', 'TransactionId'),
      roundId: brandId('round:invalid-proof', 'InteractionRoundId'),
      expectedHeadSeq: blockedCommit.headSeq,
      expectedTick: blockedCommit.tick,
      nextTick: blockedCommit.tick + 1,
      admissionProof: { inboxSeq: 999, inputHash: blocked.inputHash },
    })).rejects.toThrow('no matching durable admission proof')
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

  it('verifies reconstructable Session observation bindings and empty Session state', async () => {
    const path = database('session-integrity.sqlite')
    const adapter = new SessionDeliveryAdapter(path)
    const address = fixtureAddress('session-integrity')
    expect(adapter.verifyIntegrity(address, 'session:empty')).toMatchObject({ sessionCount: 0, deliveryCount: 0 })
    for (const [session, delivery, payload] of [
      ['session:integrity:a', 'delivery:integrity:a', { observation: 'a' }],
      ['session:integrity:b', 'delivery:integrity:b', { observation: 'b' }],
    ] as const) {
      await adapter.appendIfAbsent({
        sessionId: brandId(session, 'SessionId'),
        sessionDeliverySeq: 1,
        deliveryId: brandId(delivery, 'DeliveryId'),
        payloadHash: hashWorldJson('world-outbox-payload', payload),
        observationEvent: payload,
        correlationId: delivery,
      })
    }
    expect(adapter.verifyIntegrity(address, 'session:verified')).toMatchObject({
      sessionCount: 2, deliveryCount: 2, verificationHash: expect.stringMatching(/^sha256:/),
    })
    adapter.close()
  })

  it.each([
    ['missing-event', `DELETE FROM session_events`, 'sequence or Observation'],
    ['event-hash', `UPDATE session_events SET payload_hash = 'sha256:wrong'`, 'sequence or Observation'],
    ['payload', `UPDATE session_events SET payload_json = '{"forged":true}'`, 'payload is divergent'],
    ['missing-cursor', `DELETE FROM session_delivery_cursor`, 'cursor or SQLite'],
    ['cursor-value', `UPDATE session_delivery_cursor SET last_delivery_seq = 2`, 'cursor or SQLite'],
  ] as const)('rejects %s Session reconstruction corruption', async (suffix, mutation, message) => {
    const path = database(`session-integrity-${suffix}.sqlite`)
    const adapter = new SessionDeliveryAdapter(path)
    const payload = { observation: 'verified' }
    await adapter.appendIfAbsent({
      sessionId: brandId('session:integrity', 'SessionId'),
      sessionDeliverySeq: 1,
      deliveryId: brandId('delivery:integrity', 'DeliveryId'),
      payloadHash: hashWorldJson('world-outbox-payload', payload),
      observationEvent: payload,
      correlationId: 'session:integrity',
    })
    const raw = new DatabaseSync(path)
    raw.exec(mutation)
    raw.close()
    expect(() => adapter.verifyIntegrity(fixtureAddress('session-integrity'), `session:${suffix}`)).toThrow(message)
    adapter.close()
  })
})

describe('WorldStore and temporal projections', () => {
  it.each([
    ['empty-events', `DELETE FROM events`, 'boundaries'],
    ['missing-event', `DELETE FROM events WHERE event_ordinal = 1`, 'boundaries'],
    ['event-seq', `UPDATE events SET seq = seq + 10 WHERE event_ordinal = 0`, 'boundaries'],
    ['event-tick', `UPDATE events SET tick = tick + 1 WHERE event_ordinal = 0`, 'boundaries'],
    ['event-ordinal', `UPDATE events SET event_ordinal = 5 WHERE event_ordinal = 1`, 'boundaries'],
    ['outbox-seq', `UPDATE outbox SET world_seq = world_seq + 1`, 'boundaries'],
    ['event-chain', `UPDATE events SET previous_hash = 'sha256:bad-chain' WHERE event_ordinal = 1`, 'chain'],
    ['event-hash', `UPDATE events SET event_hash = 'sha256:bad-event' WHERE event_ordinal = 0`, 'event hash'],
    ['authority-json', `UPDATE round_authority SET authority_json = '{"forged":true}'`, 'authority content'],
    ['authority-missing', `DELETE FROM round_authority`, 'authority binding'],
    ['bundle-hash', `UPDATE round_commits SET bundle_hash = 'sha256:bad-bundle'`, 'bundle hash'],
  ] as const)('rejects %s corruption while reading a committed Round', async (suffix, mutation, message) => {
    const path = database(`committed-round-${suffix}.sqlite`)
    const address = fixtureAddress(`committed-${suffix}`)
    const store = new WorldStore(path)
    store.createBranch(address)
    const request = {
      ...fixtureCommitRequest(address),
      authority: { schemaVersion: 1, actions: [{ actionId: 'action:corruption-fixture' }] },
      events: [
        { eventType: 'fixture.first', eventVersion: 1, data: { ordinal: 0 } },
        { eventType: 'fixture.second', eventVersion: 1, data: { ordinal: 1 } },
      ],
    }
    await store.commitRound(request)
    expect(store.verifyBranchIntegrity(address)).toMatchObject({
      headSeq: 2, tick: 1, eventCount: 2, roundCount: 1, verificationHash: expect.stringMatching(/^sha256:/),
    })
    const raw = new DatabaseSync(path)
    raw.exec(mutation)
    raw.close()
    expect(() => store.committedRound(address, request.transactionId)).toThrow(message)
    expect(() => store.verifyBranchIntegrity(address)).toThrow()
    store.close()
  })

  it('commits Event/Tick/Head/Outbox atomically and replays idempotently', async () => {
    const store = new WorldStore(database('world.sqlite'))
    const address = fixtureAddress()
    store.createBranch(address)
    expect(store.verifyBranchIntegrity(address)).toMatchObject({ headSeq: 0, tick: 0, eventCount: 0, roundCount: 0 })
    const baseRequest = fixtureCommitRequest(address)
    const authority = {
      schemaVersion: 1,
      participants: [{ participantId: 'player', terminalStatus: 'proposed' }],
      actions: [{ actionId: 'action:store-fixture', parameters: { text: 'hello' } }],
      resolutions: [{ actionId: 'action:store-fixture', status: 'accepted' }],
    } as const
    const request = {
      ...baseRequest,
      outbox: baseRequest.outbox.map(item => ({ ...item, critical: false })),
      authority,
    }
    const committed = await store.commitRound(request)
    expect(committed).toMatchObject({ status: 'committed', headSeq: 1, tick: 1 })
    expect(store.head(address)).toMatchObject({ headSeq: 1, tick: 1 })
    expect(store.readEvents(address)).toHaveLength(1)
    expect(store.readOutbox(address)).toMatchObject([{ worldSeq: 1, critical: false, payload: { value: 'delivered' } }])
    expect(store.readRoundAuthority(address, request.transactionId)).toMatchObject({
      roundId: request.roundId,
      authorityHash: expect.stringMatching(/^sha256:/),
      authority,
    })
    expect(store.roundBase(request.transactionId)).toEqual({ headSeq: 0, tick: 0 })
    await expect(store.commitRound(request)).resolves.toEqual({ ...committed, status: 'already_committed' })
    await expect(store.commitRound({ ...request, events: [{ ...request.events[0] as WorldEventDraft, data: { changed: true } }] }))
      .rejects.toMatchObject({ envelope: { errorCode: 'IDEMPOTENCY_KEY_CONFLICT' } })
    await expect(store.commitRound({ ...request, authority: { ...authority, schemaVersion: 2 } }))
      .rejects.toMatchObject({ envelope: { errorCode: 'IDEMPOTENCY_KEY_CONFLICT' } })
    store.close()
  })

  it('commits cognitive work with the Round and fences its idempotent worker receipt', async () => {
    const path = database('world-cognitive-job.sqlite')
    const address = fixtureAddress('cognitive-job')
    const characterId = brandId('character:cognitive-worker', 'CharacterId')
    const interrupted = new WorldStore(path, new ThrowingFaultInjector('store.before-commit'))
    interrupted.createBranch(address)
    const request = { ...fixtureCommitRequest(address), outbox: [], cognitiveJobs: [{ characterId }] }
    await expect(interrupted.commitRound(request)).rejects.toThrow('store.before-commit')
    expect(interrupted.readCognitiveJobs(address, true)).toEqual([])
    interrupted.close()

    const store = new WorldStore(path)
    await expect(store.commitRound(request)).resolves.toMatchObject({ status: 'committed' })
    await expect(store.commitRound(request)).resolves.toMatchObject({ status: 'already_committed' })
    await expect(store.commitRound({ ...request, cognitiveJobs: [{ characterId }, { characterId }] }))
      .rejects.toThrow('must be unique')
    const pending = store.readCognitiveJobs(address)
    expect(pending).toMatchObject([{
      characterId, asOfWorldSeq: 1, status: 'pending', attemptCount: 0, lastError: null,
      jobHash: expect.stringMatching(/^sha256:/),
    }])

    const leases = new WriterLeaseService(path)
    const lease = leases.acquire(address, 'cognitive-worker')
    expect(() => store.recordCognitiveJobResult(
      address, 'job:missing', 'cognitive-worker', lease.fencingToken, 'completed', null, 'worker:missing',
    )).toThrow('missing')
    expect(() => store.recordCognitiveJobResult(
      address, pending[0]!.jobId, 'wrong-owner', lease.fencingToken, 'completed', null, 'worker:wrong',
    )).toThrow('lost its database writer lease')
    store.recordCognitiveJobResult(
      address, pending[0]!.jobId, 'cognitive-worker', lease.fencingToken, 'completed', null, 'worker:complete',
    )
    store.recordCognitiveJobResult(
      address, pending[0]!.jobId, 'cognitive-worker', lease.fencingToken, 'completed', null, 'worker:replay',
    )
    expect(store.readCognitiveJobs(address)).toEqual([])
    expect(store.readCognitiveJobs(address, true)[0]).toMatchObject({ status: 'completed', attemptCount: 1 })
    expect(() => store.recordCognitiveJobResult(
      address, pending[0]!.jobId, 'cognitive-worker', lease.fencingToken, 'failed', 'late', 'worker:late',
    )).toThrow('cannot regress')
    leases.close()
    store.close()

    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE world_cognitive_jobs SET job_hash = 'sha256:forged'`).run()
    raw.close()
    const divergent = new WorldStore(path)
    expect(() => divergent.readCognitiveJobs(address, true)).toThrow('job hash is divergent')
    divergent.close()
  })

  it('stores clarification replay, conflict, audit, and divergent hashes fail-closed', () => {
    const path = database('world-clarification.sqlite')
    const address = fixtureAddress('clarification')
    const store = new WorldStore(path)
    store.createBranch(address)
    const input = { text: '/unknown' }
    const result = { status: 'clarification_required', reason: 'unknown command' }
    expect(store.recordClarification(address, 'clarification:1', input, result, 'clarification:first')).toEqual(result)
    expect(store.recordClarification(address, 'clarification:1', input, result, 'clarification:replay')).toEqual(result)
    expect(() => store.recordClarification(
      address, 'clarification:1', { text: '/different' }, result, 'clarification:conflict',
    )).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'IDEMPOTENCY_KEY_CONFLICT' }) }))
    const administration = new BranchAdministration(path)
    expect(administration.readAudit(address)).toMatchObject([{
      operation: 'round.clarified', correlationId: 'clarification:first',
    }])
    administration.close()

    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE round_clarifications SET result_hash = 'sha256:forged' WHERE idempotency_key = ?`)
      .run('clarification:1')
    raw.close()
    expect(() => store.recordClarification(address, 'clarification:1', input, result, 'clarification:divergent-record'))
      .toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'BUNDLE_HASH_MISMATCH' }) }))
    expect(() => store.readClarification(address, 'clarification:1'))
      .toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'BUNDLE_HASH_MISMATCH' }) }))
    store.close()
  })

  it('admits only new clarifications on active open branches while replay remains readable', () => {
    const path = database('world-clarification-admission.sqlite')
    const store = new WorldStore(path)
    const cases = [
      { suffix: 'draining', admission: 'draining', lifecycle: 'active', phase: 'active', errorCode: 'BRANCH_DRAINING' },
      { suffix: 'maintenance', admission: 'open', lifecycle: 'active', phase: 'maintenance', errorCode: 'BRANCH_DRAINING' },
      { suffix: 'quarantined', admission: 'open', lifecycle: 'active', phase: 'quarantined', errorCode: 'BRANCH_QUARANTINED' },
      { suffix: 'archived', admission: 'open', lifecycle: 'archived', phase: 'archived', errorCode: 'BRANCH_DRAINING' },
    ] as const
    for (const value of cases) {
      const address = fixtureAddress(`clarification-${value.suffix}`)
      store.createBranch(address)
      const input = { text: `/existing-${value.suffix}` }
      const result = { status: 'clarification_required', reason: value.suffix }
      store.recordClarification(address, 'clarification:existing', input, result, `clarification:${value.suffix}:first`)
      const raw = new DatabaseSync(path)
      raw.prepare(`
        UPDATE branch_controls SET admission_state = ?, lifecycle_state = ?, runtime_phase = ? WHERE address_key = ?
      `).run(value.admission, value.lifecycle, value.phase, worldAddressKey(address))
      raw.close()
      expect(store.recordClarification(
        address, 'clarification:existing', input, result, `clarification:${value.suffix}:replay`,
      )).toEqual(result)
      expect(store.readClarification(address, 'clarification:existing', input)).toEqual(result)
      expect(() => store.recordClarification(
        address,
        'clarification:new',
        { text: `/new-${value.suffix}` },
        result,
        `clarification:${value.suffix}:blocked`,
      )).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: value.errorCode }),
      }))
      const administration = new BranchAdministration(path)
      expect(administration.readAudit(address).filter(event => event.operation === 'round.clarified')).toHaveLength(1)
      administration.close()
    }
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
    const request = { ...fixtureCommitRequest(), operationalSummary: { marker: 'same-transaction' } }
    await expect(failing.commitRound(request)).rejects.toThrow('simulated fault')
    failing.close()
    const recovered = new WorldStore(path)
    expect(recovered.head(fixtureAddress()).headSeq).toBe(1)
    expect(recovered.committedRoundOperationalSummary(fixtureAddress(), request.transactionId))
      .toMatchObject({ transactionId: request.transactionId, marker: 'same-transaction' })
    expect(recovered.committedRoundOperationalSummary(
      fixtureAddress(), brandId('transaction:absent-summary', 'TransactionId'),
    )).toBeUndefined()
    const audit = new BranchAdministration(path)
    expect(audit.readAudit(fixtureAddress())).toMatchObject([{
      operation: 'round.committed',
      details: { transactionId: fixtureCommitRequest().transactionId, headSeq: 1, tick: 1 },
    }])
    audit.close()
    const duplicate = new DatabaseSync(path)
    duplicate.prepare(`
      INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
      VALUES (?, 'round.committed', 'malformed-audit', '[]', 0)
    `).run(worldAddressKey(fixtureAddress()))
    expect(recovered.committedRoundOperationalSummary(fixtureAddress(), request.transactionId))
      .toMatchObject({ marker: 'same-transaction' })
    duplicate.exec(`
      INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
      SELECT address_key, operation, correlation_id, details_json, operational_time_ms
      FROM branch_audit_events WHERE operation = 'round.committed';
    `)
    duplicate.close()
    expect(() => recovered.committedRoundOperationalSummary(fixtureAddress(), request.transactionId))
      .toThrow('operational summaries')
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
      authority: { schemaVersion: 1, marker: 'BASE_AUTHORITY' },
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
      authority: { schemaVersion: 1, marker: 'FUTURE_AUTHORITY_CANARY' },
      events: [{ eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:FUTURE_CANARY', value: 'future' } }],
      outbox: [],
    })
    const rebuilder = new ProjectionRebuilder(store)
    const bundle = rebuilder.rebuildAt(child, forkSeq)
    expect(store.verifyBranchIntegrity(child)).toMatchObject({ headSeq: forkSeq, eventCount: forkSeq, roundCount: 0 })
    expect(bundle.observations).toHaveLength(1)
    expect(bundle.claims.map(value => value.id)).toEqual(['claim:base'])
    expect(JSON.stringify(bundle)).not.toContain('FUTURE_CANARY')
    expect(store.readRoundAuthority(child, first.transactionId)).toMatchObject({
      authority: { marker: 'BASE_AUTHORITY' },
    })
    expect(store.readRoundAuthority(child, brandId('transaction:future', 'TransactionId'))).toBeUndefined()
    const unrelated = fixtureAddress('unrelated')
    store.createBranch(unrelated)
    const unrelatedTransaction = brandId('transaction:unrelated', 'TransactionId')
    await store.commitRound({
      ...fixtureCommitRequest(unrelated),
      transactionId: unrelatedTransaction,
      roundId: brandId('round:unrelated', 'InteractionRoundId'),
      authority: { schemaVersion: 1, marker: 'UNRELATED_AUTHORITY' },
      outbox: [],
    })
    expect(store.readRoundAuthority(child, unrelatedTransaction)).toBeUndefined()
    expect(store.readEventsRange(
      child, 1, forkSeq, ['observation.upsert', 'goal.upsert', 'goal.upsert'],
    ).map(event => event.seq)).toEqual([3])
    expect(store.readEventsRange(child, forkSeq, forkSeq)).toEqual([])
    expect(store.readEventsRange(parent, forkSeq, store.head(parent).headSeq, ['claim.upsert'])
      .map(event => event.data)).toEqual([{ id: 'claim:FUTURE_CANARY', value: 'future' }])
    expect(store.readEventsRange(child, 0, forkSeq, [])).toEqual([])
    for (const bounds of [[-1, 1], [0.5, 1], [2, 1], [0, 1.5]] as const) {
      expect(() => store.readEventsRange(child, bounds[0], bounds[1])).toThrow(RangeError)
    }
    expect(() => store.readEventsRange(child, 0, forkSeq, [''])).toThrow(TypeError)
    expect(() => store.readEventsRange(child, 0, forkSeq, [' padded '])).toThrow(TypeError)
    expect(() => store.forkBranch(parent, fixtureAddress('bad-negative'), -1)).toThrow(RangeError)
    expect(() => store.forkBranch(parent, fixtureAddress('bad-future'), 999)).toThrow(RangeError)
    store.close()
  })

  it('fails closed when an effective Authority lookup encounters a corrupted ancestor link', async () => {
    const path = database('corrupt-authority-ancestor.sqlite')
    const parent = fixtureAddress('authority-parent')
    const child = fixtureAddress('authority-child')
    const unrelated = fixtureAddress('authority-unrelated')
    const setup = new WorldStore(path)
    setup.createBranch(parent)
    await setup.commitRound(fixtureCommitRequest(parent))
    setup.forkBranch(parent, child, setup.head(parent).headSeq)
    setup.createBranch(unrelated)
    const transactionId = brandId('transaction:authority-unrelated', 'TransactionId')
    await setup.commitRound({
      ...fixtureCommitRequest(unrelated), transactionId,
      roundId: brandId('round:authority-unrelated', 'InteractionRoundId'), outbox: [],
      authority: { schemaVersion: 1 },
    })
    setup.close()
    const corrupt = new DatabaseSync(path)
    corrupt.exec('PRAGMA foreign_keys = OFF')
    corrupt.prepare('UPDATE branches SET parent_address_key = ? WHERE address_key = ?')
      .run('missing\u001fancestor\u001fkey', worldAddressKey(child))
    corrupt.close()
    const reopened = new WorldStore(path)
    expect(() => reopened.readRoundAuthority(child, transactionId)).toThrow('unknown world branch')
    reopened.close()
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
