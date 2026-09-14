import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { currentCharacterRelations } from '@harness-world/kernel'
import {
  WorldArchiveService, WorldLogicalTransferService, WorldStore,
} from '@harness-world/store-sqlite'
import { frozenInteractionWorld } from './fixtures/frozen-interaction-world.ts'

/**
 * A v10 world through the surfaces that are not the round itself: fork, logical transfer and the
 * backup/restore pair. The frozen selection is part of the stored Manifest, so every one of them has to
 * carry it - and the way to know is to open the result and act in it, not to compare a manifest hash.
 */
const compiled = frozenInteractionWorld()
const address = compiled.manifest.address
const holdHand = { actionType: 'interact', parameters: { targetRef: { kind: 'character', id: 'character:npc' },
  bindingId: 'binding:character:npc:base:hold-hand', definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {} } }

const app = (worldPath: string, root: string) => new WorldApplication({ worldPath,
  sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20 })

const submit = (application: WorldApplication, key: string, branch = address) =>
  application.submit(branch, { idempotencyKey: key, principalId: 'principal:player',
    correlationId: `frozen-deploy:${key}`, action: holdHand })

describe('a v10 world outside its own round', () => {
  it('forks, and the child holds hands on its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-fork-'))
    const worldPath = join(root, 'world.sqlite')
    const child = { ...address, branchId: brandId('branch:child', 'BranchId') }
    try {
      const seed = app(worldPath, root)
      try {
        seed.activate(compiled)
        await submit(seed, 'parent-hold')
      } finally { await seed.close() }
      const store = new WorldStore(worldPath)
      const head = store.head(address)
      store.forkBranch(address, child, head.headSeq)
      store.close()
      // The fork carries the whole stored Manifest, so the child's own round resolves the same frozen
      // definition - which it can only do if the selection came with it.
      const forked = app(worldPath, root)
      try {
        forked.activate(compiled)
        await submit(forked, 'child-hold', child)
      } finally { await forked.close() }
      const read = new WorldStore(worldPath)
      const events = read.readEvents(child)
      const resolved = events.find(event => event.eventType === 'action.resolved')!
      const authority = read.readRoundAuthority(child, resolved.transactionId)!.authority
      read.close()
      expect(authority.schemaVersion).toBe(6)
      expect((authority.resolutions as readonly Record<string, unknown>[])
        .some(entry => entry.interaction !== undefined)).toBe(true)
      expect(events.filter(event => event.eventType === 'character.relation-started')).toHaveLength(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('exports and imports a world that still holds hands afterwards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-transfer-'))
    const worldPath = join(root, 'world.sqlite')
    const importedPath = join(root, 'imported.sqlite')
    const file = join(root, 'world.dshworld')
    let eventHash = ''
    try {
      const seed = app(worldPath, root)
      try {
        seed.activate(compiled)
        await submit(seed, 'seed-hold')
      } finally { await seed.close() }
      const read = new WorldStore(worldPath)
      const events = read.readEvents(address)
      read.close()
      eventHash = events.at(-1)!.eventHash
      const transfer = new WorldLogicalTransferService(worldPath)
      transfer.exportAuthority(file, 'frozen:export')
      transfer.importAuthority(file, importedPath, 'frozen:import')
      const imported = new WorldStore(importedPath)
      try {
        expect(imported.readEvents(address).map(event => event.eventHash)).toEqual(
          events.map(event => event.eventHash))
      } finally { imported.close() }
      // The imported world is a world, not a copy of a log: it opens, takes a round of its own, and the
      // frozen fold ends the contact a move ends - which it can only do if the selection came with it.
      const replayed = app(importedPath, root)
      try {
        replayed.activate(compiled)
        await replayed.submit(address, { idempotencyKey: 'imported-move', principalId: 'principal:player',
          correlationId: 'frozen-deploy:imported-move', action: { actionType: 'move', parameters: { locationId: 'location:next' } } })
      } finally { await replayed.close() }
      const after = new WorldStore(importedPath)
      const events2 = after.readEvents(address)
      after.close()
      expect(events2.at(-1)!.eventHash).not.toBe(eventHash)
      expect(events2.filter(event => event.eventType === 'character.relation-ended').map(event => event.data))
        .toEqual([{ relationId: currentCharacterRelations(events2)[0]!.relationId,
          endedByCharacterId: 'character:player', reason: 'participant_moved' }])
      expect(currentCharacterRelations(events2).filter(relation => relation.active)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('backs up and restores a world that still holds hands afterwards', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-backup-'))
    const worldPath = join(root, 'world.sqlite')
    const backupPath = join(root, 'world.backup')
    const restoredPath = join(root, 'restored.sqlite')
    try {
      const seed = app(worldPath, root)
      try {
        seed.activate(compiled)
        await submit(seed, 'seed-hold')
      } finally { await seed.close() }
      const read = new WorldStore(worldPath)
      const events = read.readEvents(address)
      read.close()
      const archives = new WorldArchiveService(worldPath)
      const artifact = await archives.backup(backupPath, 'frozen:backup')
      archives.restore(backupPath, restoredPath, artifact.fileHash, 'frozen:restore')
      const restored = new WorldStore(restoredPath)
      try {
        expect(restored.readEvents(address).map(event => event.eventHash)).toEqual(
          events.map(event => event.eventHash))
      } finally { restored.close() }
      const replayed = app(restoredPath, root)
      try {
        replayed.activate(compiled)
        await replayed.submit(address, { idempotencyKey: 'restored-move', principalId: 'principal:player',
          correlationId: 'frozen-deploy:restored-move', action: { actionType: 'move', parameters: { locationId: 'location:next' } } })
      } finally { await replayed.close() }
      const after = new WorldStore(restoredPath)
      const restoredEvents = after.readEvents(address)
      after.close()
      expect(restoredEvents.filter(event => event.eventType === 'character.relation-ended')).toHaveLength(1)
      expect(currentCharacterRelations(restoredEvents).filter(relation => relation.active)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)
})
