import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId, worldAddressKey, type WorldAddress } from '@harness-world/contracts'
import { WorldStore } from './world-store.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'world-event-cache-')),
    path = join(root, 'world.sqlite'),
    address: WorldAddress = {
      tenantId: brandId('tenant:cache', 'TenantId'),
      worldId: brandId('world:cache', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
    store = new WorldStore(path)
  roots.push(root)
  store.createBranch(address)
  return { path, address, store }
}

async function append(store: WorldStore, address: WorldAddress, value: number) {
  const head = store.head(address)
  return store.commitRound({
    address,
    transactionId: brandId(`transaction:cache:${value}`, 'TransactionId'),
    roundId: brandId(`round:cache:${value}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events: [{ eventType: 'fixture.value', eventVersion: 1, data: { value } }],
    outbox: [],
    correlationId: `cache:${value}`,
  })
}

it('shares parsed prefixes across connections and awaited phases, then reads only new committed events', async () => {
  const f = fixture(),
    other = new WorldStore(f.path)
  try {
    await append(f.store, f.address, 1)
    await WorldStore.withEventReadCache(async () => {
      const parse = vi.spyOn(JSON, 'parse'),
        first = f.store.readEvents(f.address)
      expect(parse).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      const same = other.readEventsRange(f.address, 0, 1, ['fixture.value'])
      expect(same[0]).toBe(first[0])
      expect(parse).toHaveBeenCalledTimes(1)
      expect(Reflect.set(first[0]!.data as object, 'value', 999)).toBe(false)
      same.pop()
      expect(other.readEvents(f.address)).toHaveLength(1)
      await append(other, f.address, 2)
      parse.mockClear()
      const advanced = f.store.readEvents(f.address)
      expect(parse).toHaveBeenCalledTimes(1)
      expect(advanced.map(e => e.data)).toEqual([{ value: 1 }, { value: 2 }])
      expect(advanced[0]).toBe(first[0])
      expect(other.readEvents(f.address, 1)).toEqual(first)
      expect(other.readEventsRange(f.address, 0, 2, ['missing'])).toEqual([])
      parse.mockRestore()
    })
    expect(Object.isFrozen(f.store.readEvents(f.address)[0]!.data)).toBe(false)
  } finally {
    other.close()
    f.store.close()
  }
})

it('keeps fork prefixes and different databases separate', async () => {
  const f = fixture(),
    other = fixture(),
    child = { ...f.address, branchId: brandId('branch:child', 'BranchId') }
  try {
    await append(f.store, f.address, 1)
    f.store.forkBranch(f.address, child, 1)
    await append(f.store, f.address, 2)
    await append(other.store, other.address, 9)
    await WorldStore.withEventReadCache(async () => {
      expect(f.store.readEvents(f.address).map(e => e.data)).toEqual([{ value: 1 }, { value: 2 }])
      expect(f.store.readEvents(child).map(e => e.data)).toEqual([{ value: 1 }])
      expect(other.store.readEvents(other.address).map(e => e.data)).toEqual([{ value: 9 }])
    })
  } finally {
    f.store.close()
    other.store.close()
  }
})

it('always verifies current storage and discards the snapshot after an operation fails', async () => {
  const f = fixture(),
    raw = new DatabaseSync(f.path)
  try {
    await append(f.store, f.address, 1)
    await expect(
      WorldStore.withEventReadCache(async () => {
        f.store.readEvents(f.address)
        raw
          .prepare('UPDATE events SET data_json = ? WHERE address_key = ?')
          .run('{"value":999}', worldAddressKey(f.address))
        expect(() => f.store.verifyBranchIntegrity(f.address)).toThrow('Event chain is divergent')
        throw new Error('operation failed')
      }),
    ).rejects.toThrow('operation failed')
    await WorldStore.withEventReadCache(async () => {
      expect(f.store.readEvents(f.address)[0]!.data).toEqual({ value: 999 })
    })
    raw
      .prepare('UPDATE events SET data_json = ? WHERE address_key = ?')
      .run('{"value":1.5}', worldAddressKey(f.address))
    await expect(WorldStore.withEventReadCache(async () => f.store.readEvents(f.address))).rejects.toThrow(
      'safe integers',
    )
  } finally {
    raw.close()
    f.store.close()
  }
})

it('isolates concurrent operations on the same database', async () => {
  const f = fixture()
  try {
    await append(f.store, f.address, 1)
    const values = await Promise.all(
      [0, 1].map(() =>
        WorldStore.withEventReadCache(async () => {
          const first = f.store.readEvents(f.address)[0]
          await Promise.resolve()
          expect(f.store.readEvents(f.address)[0]).toBe(first)
          return first
        }),
      ),
    )
    expect(values[0]).not.toBe(values[1])
  } finally {
    f.store.close()
  }
})

it('disables the snapshot for background work that outlives its originating operation', async () => {
  const f = fixture()
  let continueWork!: () => void
  const gate = new Promise<void>(resolve => {
    continueWork = resolve
  })
  try {
    await append(f.store, f.address, 1)
    let background!: Promise<boolean>
    await WorldStore.withEventReadCache(async () => {
      const snapshot = f.store.readEvents(f.address)[0]
      background = (async () => {
        await gate
        return f.store.readEvents(f.address)[0] === snapshot
      })()
    })
    continueWork()
    expect(await background).toBe(false)
  } finally {
    f.store.close()
  }
})
