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
  ProjectionRebuilder,
  ProjectionStore,
  SessionDeliveryAdapter,
  WorldStore,
  openOwnedDatabase,
  parseWorldJson,
  readPragmaInteger,
  rollbackAndThrow,
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
