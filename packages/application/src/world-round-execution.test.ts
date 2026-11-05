import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId, type FaultInjector, type WorldJsonObject } from '@harness-world/contracts'
import { FrozenInteractionRulebook, WorldBootstrap } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { executeWorldRound, type WorldRoundEffects } from './world-round-execution.ts'

const roots: { root: string; store: WorldStore; leases: WriterLeaseService }[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const { root, store, leases } of roots.splice(0)) {
    leases.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture(faultInjector?: FaultInjector) {
  const root = mkdtempSync(join(tmpdir(), 'world-round-'))
  const path = join(root, 'world.sqlite'),
    store = new WorldStore(path, faultInjector),
    leases = new WriterLeaseService(path)
  roots.push({ root, store, leases })
  const compiled = frozenInteractionWorld()
  new WorldBootstrap(store, false, new FrozenInteractionRulebook([basicInteractionPackage])).activate(compiled)
  const input = { store, leases, address: compiled.manifest.address, owner: 'round:probe', actorId: 'character:player' }
  const before = store.head(input.address)
  const effects: WorldRoundEffects = {
    authority: { actorId: input.actorId, status: 'accepted' },
    events: [
      {
        eventType: 'entity.upsert',
        eventVersion: 1,
        data: { entityId: 'entity:cup', kind: 'clean cup', locationId: 'location:room' },
      },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: 'observation:probe',
          value: { observerId: 'character:player', content: { text: 'Cleaned the cup.' } },
        },
      },
    ],
  }
  return { ...input, input, before, effects }
}

it('commits facts, observations and authority together, and gives a retry its existing authority', async () => {
  const f = fixture()
  expect(
    await executeWorldRound(f.input, snapshot => {
      expect(snapshot.head).toEqual(f.before)
      expect(snapshot.prior).toBeUndefined()
      return f.effects
    }),
  ).toEqual({ afterSeq: f.before.headSeq })
  const after = f.store.head(f.address)
  expect(after.tick).toBe(f.before.tick + 1)
  expect(f.store.readEventsRange(f.address, f.before.headSeq, after.headSeq).map(row => row.eventType)).toEqual([
    'entity.upsert',
    'observation.upsert',
    'world.tick-advanced',
  ])
  expect(
    await executeWorldRound(f.input, snapshot => {
      expect(snapshot.prior?.authority).toEqual(f.effects.authority)
      return undefined
    }),
  ).toBeUndefined()
  expect(f.store.head(f.address)).toEqual(after)
})

it('rejects an unbound player, forged actor or unknown observation recipient without changing facts', async () => {
  const f = fixture(),
    calculate = vi.fn(() => f.effects)
  await expect(executeWorldRound({ ...f.input, actorId: 'character:npc' }, calculate)).rejects.toThrow('bound player')
  expect(calculate).not.toHaveBeenCalled()
  await expect(
    executeWorldRound(f.input, () => ({ ...f.effects, authority: { actorId: 'character:npc' } })),
  ).rejects.toThrow('authority actor')
  const bad = structuredClone(f.effects)
  Object.assign((bad.events[1]!.data as WorldJsonObject).value as WorldJsonObject, { observerId: 'character:unknown' })
  await expect(executeWorldRound(f.input, () => bad)).rejects.toThrow('observation recipient')
  expect(f.store.head(f.address)).toEqual(f.before)
})

it('does not publish a result that returns after cancellation and releases its writer lease', async () => {
  const f = fixture(),
    controller = new AbortController()
  let finish!: (effects: WorldRoundEffects) => void
  const work = executeWorldRound(
    { ...f.input, signal: controller.signal },
    () =>
      new Promise(resolve => {
        finish = resolve
      }),
  )
  controller.abort(new Error('world closed'))
  finish(f.effects)
  await expect(work).rejects.toThrow('world closed')
  expect(f.store.head(f.address)).toEqual(f.before)
  const lease = f.leases.acquire(f.address, 'next-writer')
  expect(f.leases.release(f.address, 'next-writer', lease.fencingToken)).toBe(true)
})

it('refuses a stale prefix after asynchronous preparation instead of retrying external work', async () => {
  const f = fixture(),
    build = vi.fn(async () => {
      const lease = f.leases.acquire(f.address, f.owner)
      await f.store.commitRound({
        address: f.address,
        transactionId: brandId('transaction:intervening', 'TransactionId'),
        roundId: brandId('round:intervening', 'InteractionRoundId'),
        expectedHeadSeq: f.before.headSeq,
        expectedTick: f.before.tick,
        nextTick: f.before.tick + 1,
        events: [{ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: f.before.tick + 1 } }],
        writerFencingToken: lease.fencingToken,
        outbox: [],
        correlationId: 'intervening',
      })
      return f.effects
    })
  await expect(executeWorldRound(f.input, build)).rejects.toThrow('branch head changed before Round commit')
  expect(build).toHaveBeenCalledTimes(1)
  expect(f.store.head(f.address).headSeq).toBe(f.before.headSeq + 1)
  expect(f.store.readRoundAuthority(f.address, brandId(f.owner, 'TransactionId'))).toBeUndefined()
})

it('refuses a fenced writer even if the authoritative head has not changed', async () => {
  const f = fixture()
  await expect(
    executeWorldRound(f.input, async () => {
      const previous = f.leases.acquire(f.address, f.owner)
      f.leases.release(f.address, f.owner, previous.fencingToken)
      f.leases.acquire(f.address, 'replacement-writer')
      return f.effects
    }),
  ).rejects.toThrow('database writer lease is missing, expired, or fenced')
  expect(f.store.head(f.address)).toEqual(f.before)
  expect(() => f.leases.acquire(f.address, 'unrelated-writer')).toThrow('another writer')
})

it('rolls back all effects and authority on a storage fault and allows a clean retry', async () => {
  let armed = false
  const f = fixture({
    hit: point => {
      if (armed && point === 'store.before-commit') throw new Error('storage fault')
    },
  })
  armed = true
  await expect(executeWorldRound(f.input, () => f.effects)).rejects.toThrow('storage fault')
  expect(f.store.head(f.address)).toEqual(f.before)
  expect(f.store.readRoundAuthority(f.address, brandId(f.owner, 'TransactionId'))).toBeUndefined()
  armed = false
  await expect(executeWorldRound(f.input, () => f.effects)).resolves.toEqual({ afterSeq: f.before.headSeq })
})
