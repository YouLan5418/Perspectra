import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { LocalJsonRpcRouter, executeLocalCli } from '@harness-world/operations'
import {
  BranchAdministration,
  ProjectionRebuilder,
  SnapshotStore,
  WorldArchiveService,
  WorldLogicalTransferService,
  WorldStore,
} from '@harness-world/store-sqlite'

function address(branch: string): WorldAddress {
  return {
    tenantId: brandId('tenant:p5', 'TenantId'),
    worldId: brandId('world:p5', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

describe('Phase 5 local operations acceptance', () => {
  it('closes fork, barrier, snapshot, backup, transfer, RPC, and migration paths end to end', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p5-'))
    const worldPath = join(directory, 'world.sqlite')
    const parent = address('main')
    const child = address('fork')
    try {
      const store = new WorldStore(worldPath)
      store.createBranch(parent)
      await store.commitRound({
        address: parent,
        transactionId: brandId('transaction:p5:base', 'TransactionId'),
        roundId: brandId('round:p5:base', 'InteractionRoundId'),
        expectedHeadSeq: 0,
        expectedTick: 0,
        nextTick: 1,
        events: [{ eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:p5', value: { proposition: 'durable' } } }],
        outbox: [],
        correlationId: 'p5:base',
      })
      const eventHash = store.readEvents(parent)[0]!.eventHash
      store.forkBranch(parent, child, 1)
      const admin = new BranchAdministration(worldPath)
      admin.setAdmission(parent, 'draining', 'snapshot window', 'p5:drain')
      expect(() => store.assertAdmissionOpen(parent, 'p5:blocked')).toThrow('draining')

      const projection = new ProjectionRebuilder(store).rebuildAt(parent, 1)
      const snapshots = new SnapshotStore(join(directory, 'snapshots.sqlite'))
      const snapshot = snapshots.create(parent, 1, { projection }, 'p5:snapshot')
      expect(snapshot.bundle.bundleHash).toMatch(/^sha256:/)
      snapshots.close()
      admin.setAdmission(parent, 'open', 'snapshot complete', 'p5:open')
      admin.setAdmission(parent, 'draining', 'archive barrier', 'p5:archive-drain')
      admin.archive(parent, 'world complete', 'p5:archive')
      expect(store.readEvents(parent)[0]!.eventHash).toBe(eventHash)
      admin.close()
      store.close()

      const archives = new WorldArchiveService(worldPath)
      const backupPath = join(directory, 'backup.sqlite')
      const artifact = await archives.backup(backupPath, 'p5:backup')
      const restoredPath = join(directory, 'restored.sqlite')
      archives.restore(backupPath, restoredPath, artifact.fileHash, 'p5:restore')
      const exportPath = join(directory, 'world.export.json')
      await archives.exportPortable(exportPath, 'p5:export')
      const importedPath = join(directory, 'imported.sqlite')
      archives.importPortable(exportPath, importedPath, 'p5:import')
      for (const candidate of [restoredPath, importedPath]) {
        const recovered = new WorldStore(candidate)
        expect(recovered.readEvents(parent)[0]!.eventHash).toBe(eventHash)
        expect(recovered.readEvents(child)).toHaveLength(1)
        recovered.close()
      }

      const logical = new WorldLogicalTransferService(worldPath)
      const logicalPath = join(directory, 'world.dshworld')
      const logicalHash = logical.exportAuthority(logicalPath, 'p5:logical-export')
      const logicalTarget = join(directory, 'logical-import.sqlite')
      expect(logical.importAuthority(logicalPath, logicalTarget, 'p5:logical-import')).toBe(logicalHash)
      const logicalWorld = new WorldStore(logicalTarget)
      expect(logicalWorld.readEvents(parent)[0]!.eventHash).toBe(eventHash)
      logicalWorld.close()

      const rpc = new LocalJsonRpcRouter(restoredPath)
      expect(JSON.parse(await executeLocalCli(['health'], rpc))).toMatchObject({ result: { status: 'ready', branchCount: 2 } })
      await expect(rpc.handle({ jsonrpc: '2.0', id: 'p5:status', method: 'branch.status', params: { address: parent } }))
        .resolves.toMatchObject({ result: { lifecycleState: 'archived' } })
      rpc.close()

      const migratedPath = join(directory, 'migrated.sqlite')
      const preMigration = new WorldStore(migratedPath)
      preMigration.createBranch(address('migrated'))
      preMigration.close()
      const raw = new DatabaseSync(migratedPath)
      raw.exec(`
        DROP TABLE branch_audit_events;
        DROP TABLE branch_controls;
        DROP INDEX outbox_claim_token_unique;
        ALTER TABLE outbox DROP COLUMN claim_owner_id;
        ALTER TABLE outbox DROP COLUMN claim_token;
        ALTER TABLE outbox DROP COLUMN claim_expires_at_ms;
        DROP INDEX round_inbox_commit_transaction_unique;
        ALTER TABLE round_inbox DROP COLUMN commit_transaction_id;
        ALTER TABLE round_inbox DROP COLUMN commit_bundle_hash;
        PRAGMA user_version = 5;
      `)
      raw.close()
      const migrated = new WorldStore(migratedPath)
      migrated.close()
      const migratedAdmin = new BranchAdministration(migratedPath)
      expect(migratedAdmin.status(address('migrated'))).toMatchObject({ admissionState: 'open', revision: 0 })
      migratedAdmin.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('replays a deterministic 64-round stress fixture and freezes a midpoint fork', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p5-stress-'))
    const path = join(directory, 'world.sqlite')
    const parent = address('stress')
    const child = address('stress-midpoint')
    try {
      const store = new WorldStore(path)
      store.createBranch(parent)
      for (let index = 1; index <= 64; index += 1) {
        await store.commitRound({
          address: parent,
          transactionId: brandId(`transaction:p5:stress:${index}`, 'TransactionId'),
          roundId: brandId(`round:p5:stress:${index}`, 'InteractionRoundId'),
          expectedHeadSeq: index - 1,
          expectedTick: index - 1,
          nextTick: index,
          events: [{ eventType: 'goal.upsert', eventVersion: 1, data: { id: `goal:${index}`, value: { index } } }],
          outbox: [],
          correlationId: `p5:stress:${index}`,
        })
        if (index === 32) store.forkBranch(parent, child, 32)
      }
      expect(store.head(parent)).toMatchObject({ headSeq: 64, tick: 64 })
      expect(store.readEvents(parent)).toHaveLength(64)
      expect(store.readEvents(child)).toHaveLength(32)
      expect(new ProjectionRebuilder(store).rebuildAt(child, 32).goals).toHaveLength(32)
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
