import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId, worldAddressKey } from '@harness-world/contracts'
import { BranchAdministration, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { WorldApplication, WorldBranchComponentFactory } from './world-application.ts'
import { RoundCoordinator } from './round-coordinator.ts'

const fixtures: { app: WorldApplication; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { app, root } of fixtures.splice(0)) {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'branch-runtime-reuse-'))
  const worldPath = join(root, 'world.sqlite'),
    memoryPath = join(root, 'memory.sqlite'),
    world = frozenInteractionWorld('responsive/v1')
  const app = new WorldApplication({
    worldPath,
    memoryPath,
    sessionPath: join(root, 'session.sqlite'),
    interactionPackages: [basicInteractionPackage],
  })
  fixtures.push({ app, root })
  app.activate(world)
  return { app, worldPath, memoryPath, address: world.manifest.address }
}

it('retains components while yielding, captures externally committed authorized sources on resume, and still disposes on release', async () => {
  const f = fixture(),
    creates = vi.spyOn(WorldBranchComponentFactory.prototype, 'create'),
    before = await f.app.head(f.address),
    writer = new WriterLeaseService(f.worldPath),
    store = new WorldStore(f.worldPath)
  try {
    expect(creates).toHaveBeenCalledTimes(1)
    await f.app.yieldWriter(f.address)
    await f.app.yieldWriter(f.address)
    expect(f.app.activeBranchCount).toBe(1)
    const lease = writer.acquire(f.address, 'external-character')
    const committed = await store.commitRound({
      address: f.address,
      transactionId: brandId('transaction:external-reuse', 'TransactionId'),
      roundId: brandId('round:external-reuse', 'InteractionRoundId'),
      expectedHeadSeq: before.headSeq,
      expectedTick: before.tick,
      nextTick: before.tick + 1,
      events: [
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: {
            id: 'observation:external-reuse',
            value: {
              observerId: 'character:npc',
              content: {
                actorId: 'character:player',
                actionType: 'speak',
                status: 'accepted',
                speech: { characterId: 'character:player', text: 'NPC_ONLY_RESUMED_SOURCE' },
              },
            },
          },
        },
        { eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: before.tick + 1 } },
      ],
      outbox: [],
      cognitiveJobs: [{ characterId: brandId('character:npc', 'CharacterId') }],
      writerFencingToken: lease.fencingToken,
      correlationId: 'external-reuse',
    })
    expect(writer.release(f.address, lease.ownerId, lease.fencingToken)).toBe(true)
    expect(await f.app.head(f.address)).toMatchObject({ headSeq: committed.headSeq })
    expect(creates).toHaveBeenCalledTimes(1)
    expect(store.readCognitiveJobs(f.address)).toEqual([])
    const memory = new DatabaseSync(f.memoryPath, { readOnly: true })
    try {
      const sources = memory
        .prepare('SELECT namespace_key FROM cognitive_memory_v2_sources WHERE text_value LIKE ?')
        .all('%NPC_ONLY_RESUMED_SOURCE%')
      expect(sources).toHaveLength(1)
      expect(sources[0]!.namespace_key).toBe(worldAddressKey(f.address) + '\u001fcharacter:npc')
    } finally {
      memory.close()
    }
    await f.app.release(f.address)
    expect(f.app.activeBranchCount).toBe(0)
    const next = writer.acquire(f.address, 'after-dispose')
    expect(next.fencingToken).toBeGreaterThan(lease.fencingToken)
    writer.release(f.address, next.ownerId, next.fencingToken)
    await f.app.head(f.address)
    expect(creates).toHaveBeenCalledTimes(2)
  } finally {
    store.close()
    writer.close()
  }
})

it('refuses to resume over another writer and never releases that writer during failed-resume cleanup', async () => {
  const f = fixture(),
    writer = new WriterLeaseService(f.worldPath)
  try {
    await f.app.head(f.address)
    await f.app.yieldWriter(f.address)
    const lease = writer.acquire(f.address, 'contending-writer')
    await expect(f.app.head(f.address)).rejects.toMatchObject({ envelope: { errorCode: 'WORLDSTORE_BUSY' } })
    expect(f.app.activeBranchCount).toBe(0)
    expect(writer.renew(f.address, lease.ownerId, lease.fencingToken).fencingToken).toBe(lease.fencingToken)
    writer.release(f.address, lease.ownerId, lease.fencingToken)
    await expect(f.app.head(f.address)).resolves.toMatchObject({ headSeq: expect.any(Number) })
  } finally {
    writer.close()
  }
})

it('releases the reacquired writer and retained stores when resume synchronization fails', async () => {
  const f = fixture(),
    writer = new WriterLeaseService(f.worldPath)
  try {
    await f.app.head(f.address)
    await f.app.yieldWriter(f.address)
    vi.spyOn(RoundCoordinator.prototype, 'processCognitiveJobs').mockImplementationOnce(() => {
      throw new Error('resume synchronization failed')
    })
    await expect(f.app.head(f.address)).rejects.toThrow('resume synchronization failed')
    expect(f.app.activeBranchCount).toBe(0)
    const lease = writer.acquire(f.address, 'after-failed-resume')
    expect(writer.release(f.address, lease.ownerId, lease.fencingToken)).toBe(true)
  } finally {
    writer.close()
  }
})

it('checks the current maintenance barrier before resuming a retained branch', async () => {
  const f = fixture(),
    administration = new BranchAdministration(f.worldPath)
  try {
    await f.app.head(f.address)
    await f.app.yieldWriter(f.address)
    administration.setAdmission(f.address, 'draining', 'reuse barrier', 'reuse:drain')
    administration.enterMaintenance(f.address, 'reuse barrier', 'reuse:maintenance')
    await expect(f.app.head(f.address)).rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING' } })
    expect(f.app.activeBranchCount).toBe(0)
  } finally {
    administration.close()
  }
})
