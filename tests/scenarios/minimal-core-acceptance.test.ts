import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { brandId, hashWorldJson, type WorldAddress, type WorldEventDraft } from '@harness-world/contracts'
import {
  StatusState,
  WorldApplication,
  adjudicateItemChanges,
  executeWorldRound,
  type WorldRoundEffects,
} from '@harness-world/application'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

// M7: no official model, memory, RP default, activity script or gameplay package. The core alone keeps entities,
// events, authorization, generic status facts and branches, and refuses what a mechanism may not make true.
const PLAYER = 'character:player',
  NPC = 'character:npc',
  CUP = 'entity:cup'

function emptySelectionWorld() {
  const original = frozenInteractionWorld()
  const manifest = {
    ...original.manifest,
    plugins: [],
    interactionCatalog: { version: 'interaction-catalog/v3' as const, packages: [], definitions: [], bindings: [] },
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = original.genesisEvents.map(event =>
    event.eventType === 'world.manifest-locked'
      ? { ...event, data: { ...(event.data as object), manifestHash } }
      : event,
  )
  return {
    ...original,
    manifest,
    manifestHash,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
  }
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function open() {
  const root = mkdtempSync(join(tmpdir(), 'minimal-core-'))
  const worldPath = join(root, 'world.sqlite'),
    world = emptySelectionWorld(),
    app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite') })
  app.activate(world)
  const store = new WorldStore(worldPath),
    leases = new WriterLeaseService(worldPath)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(async () => {
    leases.close()
    store.close()
    await app.close()
  })
  const address = world.manifest.address
  let serial = 0
  const round = (
    effects: Partial<WorldRoundEffects> & Pick<WorldRoundEffects, 'events'>,
    options: { actorId?: string; signal?: AbortSignal; at?: WorldAddress } = {},
  ) =>
    executeWorldRound(
      {
        store,
        leases,
        address: options.at ?? address,
        owner: 'round:' + ++serial,
        actorId: options.actorId ?? PLAYER,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      () => ({ authority: { actorId: options.actorId ?? PLAYER, status: 'accepted' }, ...effects }),
    )
  const events = (at: WorldAddress = address) => store.readEvents(at)
  return { app, store, address, world, round, events, worldPath }
}

const transfer = (data: Record<string, string | null>): WorldEventDraft => ({
  eventType: 'entity.transferred',
  eventVersion: 1,
  data: {
    entityId: CUP,
    characterId: PLAYER,
    interactionId: 'test',
    fromHolderId: null,
    fromLocationId: 'location:room',
    toHolderId: PLAYER,
    toLocationId: null,
    ...data,
  },
})
const moved = (data: Record<string, string>): WorldEventDraft => ({
  eventType: 'character.moved',
  eventVersion: 1,
  data: { characterId: PLAYER, fromLocationId: 'location:room', toLocationId: 'location:next', ...data },
})

it('refuses effects that contradict or invent physical facts, and leaves the world readable', async () => {
  const f = open(),
    before = f.store.head(f.address)
  for (const [effect, reason] of [
    [transfer({ fromLocationId: 'location:next' }), 'custody'],
    [transfer({ fromHolderId: NPC, fromLocationId: null }), 'custody'],
    [transfer({ toHolderId: 'character:unknown' }), 'declared character'],
    [transfer({ toHolderId: null, toLocationId: 'location:unknown' }), 'declared location'],
    [transfer({ entityId: 'entity:unknown' }), 'custody'],
    [moved({ toLocationId: 'location:unknown' }), 'declared location'],
    [moved({ characterId: 'character:unknown' }), 'declared character'],
    [moved({ fromLocationId: 'location:next' }), 'current location'],
    [moved({ characterId: NPC }), 'bound player'],
  ] as const)
    await expect(f.round({ events: [effect] }), JSON.stringify(effect.data)).rejects.toThrow(reason)
  expect(f.store.head(f.address)).toEqual(before)
  // A refused effect never reached the log, so every later fold still works.
  expect(currentEntityState(f.events(), CUP)).toMatchObject({ holderId: null, locationId: 'location:room' })
  // The same effects are accepted when they match the committed prefix.
  await f.round({ events: [transfer({})] })
  await f.round({ events: [moved({})] })
  expect(currentEntityState(f.events(), CUP)).toMatchObject({ holderId: PLAYER, locationId: null })
  expect(currentLocation(f.events(), PLAYER)).toBe('location:next')
  // Two transfers in one round are checked in order, the second against the first's result.
  await expect(
    f.round({
      events: [
        transfer({ fromHolderId: PLAYER, fromLocationId: null, toHolderId: NPC }),
        transfer({ fromHolderId: PLAYER, fromLocationId: null, toHolderId: NPC }),
      ],
    }),
  ).rejects.toThrow('custody')
  expect(currentEntityState(f.events(), CUP)).toMatchObject({ holderId: PLAYER })
})

it('refuses illegal callers, cancelled work and stale prefixes through the same execution path', async () => {
  const f = open(),
    before = f.store.head(f.address)
  await expect(f.round({ events: [] }, { actorId: NPC })).rejects.toThrow('bound player')
  await expect(f.round({ events: [], authority: { actorId: NPC } })).rejects.toThrow('authority actor')
  const controller = new AbortController()
  controller.abort(new Error('world closed'))
  await expect(f.round({ events: [transfer({})] }, { signal: controller.signal })).rejects.toThrow('world closed')
  const leases = new WriterLeaseService(f.worldPath)
  cleanups.push(() => leases.close())
  await expect(
    executeWorldRound(
      { store: f.store, leases, address: f.address, owner: 'round:stale', actorId: PLAYER },
      async () => {
        const other = leases.acquire(f.address, 'round:stale')
        await f.store.commitRound({
          address: f.address,
          transactionId: brandId('transaction:between', 'TransactionId'),
          roundId: brandId('round:between', 'InteractionRoundId'),
          expectedHeadSeq: before.headSeq,
          expectedTick: before.tick,
          nextTick: before.tick + 1,
          events: [{ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: before.tick + 1 } }],
          writerFencingToken: other.fencingToken,
          outbox: [],
          correlationId: 'between',
        })
        return { authority: { actorId: PLAYER, status: 'accepted' }, events: [transfer({})] }
      },
    ),
  ).rejects.toThrow('branch head changed')
  expect(currentEntityState(f.events(), CUP)).toMatchObject({ holderId: null })
})

it('keeps generic status facts authorized per observer, and rejects undeclared or invented values', async () => {
  const f = open()
  const status = new StatusState(
    {
      statuses: [
        { key: 'time', label: '时间', owner: 'public', type: 'number', alwaysKnown: true },
        { key: 'secret', label: '秘密', owner: 'character', type: 'string' },
      ],
      operations: [],
    },
    [NPC, PLAYER, 'character:bob'],
    f.world.manifest.entities,
  )
  await f.round({
    events: [
      status.initialEvent({
        public: { time: 1 },
        characters: {
          [NPC]: { secret: 'npc-only' },
          [PLAYER]: { secret: 'player-only' },
          'character:bob': { secret: 'bob-only' },
        },
      }),
    ],
  })
  const updates = () => f.events().filter(event => event.eventType === 'status.updated')
  expect(status.truth(updates()).characters[NPC]).toEqual({ secret: 'npc-only' })
  const known = status.known(updates(), PLAYER)
  expect(known.map(row => [row.holderId, row.key, row.value])).toEqual([
    [null, 'time', 1],
    [PLAYER, 'secret', 'player-only'],
  ])
  const source = { kind: 'operation', operation: 'x', actorId: PLAYER } as const
  const scene = [PLAYER, NPC]
  for (const [data, reason] of [
    [{ source, changes: [{ holderId: null, key: 'missing', value: 1 }], reveals: [] }, '未声明'],
    [{ source, changes: [{ holderId: null, key: 'time', value: 'noon' }], reveals: [] }, 'schema'],
    [{ source, changes: [{ holderId: NPC, key: 'time', value: 2 }], reveals: [] }, '归属'],
    [
      {
        source,
        changes: [],
        reveals: [{ observerId: PLAYER, holderId: NPC, key: 'secret', value: 'guessed' }],
      },
      '真实值',
    ],
    [
      {
        source,
        changes: [],
        reveals: [{ observerId: 'character:bob', holderId: NPC, key: 'secret', value: 'npc-only' }],
      },
      '当前场景',
    ],
  ] as const)
    expect(() => status.validate(updates(), data as never, scene), reason).toThrow(reason)
  // Reopening folds the same facts from the log.
  await f.app.close()
  const reopened = new WorldStore(f.worldPath)
  try {
    const rows = reopened.readEvents(f.address).filter(event => event.eventType === 'status.updated')
    expect(status.truth(rows).public).toEqual({ time: 1 })
  } finally {
    reopened.close()
  }
})

it('gives a forked branch the committed facts and then keeps both branches apart', async () => {
  const f = open()
  await f.round({ events: [transfer({})] })
  const child: WorldAddress = { ...f.address, branchId: brandId('branch:other-ending', 'BranchId') }
  const forked = await f.app.admin.forkAtHead(f.address, child, 'try another ending', 'fork:m7')
  expect(forked.forkSeq).toBe(f.store.head(f.address).headSeq)
  expect(currentEntityState(f.events(child), CUP)).toMatchObject({ holderId: PLAYER })
  // The fork ran through the application's branch runtime, which holds the parent's writer until released.
  await f.app.release(f.address)
  await f.round({ events: [transfer({ fromHolderId: PLAYER, fromLocationId: null, toHolderId: NPC })] }, { at: child })
  await f.round({
    events: [transfer({ fromHolderId: PLAYER, fromLocationId: null, toHolderId: null, toLocationId: 'location:room' })],
  })
  expect(currentEntityState(f.events(child), CUP)).toMatchObject({ holderId: NPC })
  expect(currentEntityState(f.events(), CUP)).toMatchObject({ holderId: null, locationId: 'location:room' })
  // The item validator stays usable without any gameplay installed, against the branch's own prefix.
  expect(() =>
    adjudicateItemChanges({
      events: f.events(child),
      actorId: PLAYER,
      interactionId: 'status:take',
      sceneIds: [PLAYER, NPC],
      entityIds: [CUP],
      value: [{ entityId: CUP, to: { holderId: PLAYER } }],
    }),
  ).not.toThrow()
})

it('bundles the core entry without any official mechanism, gameplay package or host adapter', async () => {
  const { metafile } = await build({
    entryPoints: ['packages/application/src/index.ts'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    external: ['node:*'],
    logLevel: 'silent',
  })
  const inputs = Object.keys(metafile.inputs).map(path => path.replaceAll('\\', '/'))
  expect(inputs.length).toBeGreaterThan(50)
  expect(inputs.filter(path => /packages\/(official-|interactions-basic)|(^|\/)desktop\//u.test(path))).toEqual([])
}, 60_000)
