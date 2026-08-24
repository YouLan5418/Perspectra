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
      await store.commitRound({
        address: child,
        transactionId: brandId('transaction:p5:child-after-parent-archive', 'TransactionId'),
        roundId: brandId('round:p5:child-after-parent-archive', 'InteractionRoundId'),
        expectedHeadSeq: 1,
        expectedTick: 1,
        nextTick: 2,
        events: [{ eventType: 'goal.upsert', eventVersion: 1, data: { id: 'goal:child', value: { independent: true } } }],
        outbox: [],
        correlationId: 'p5:child-after-parent-archive',
      })
      expect(store.readEvents(parent)[0]!.eventHash).toBe(eventHash)
      expect(store.readEvents(child)).toHaveLength(2)
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
        expect(recovered.readEvents(child)).toHaveLength(2)
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
      await rpc.close()

      const migratedPath = join(directory, 'migrated.sqlite')
      const preMigration = new WorldStore(migratedPath)
      preMigration.createBranch(address('migrated'))
      preMigration.close()
      const raw = new DatabaseSync(migratedPath)
      raw.exec(`
        DROP TABLE round_clarifications;
        DROP INDEX world_cognitive_jobs_pending;
        DROP TABLE world_cognitive_jobs;
        DROP TABLE branch_audit_events;
        DROP TABLE branch_failures;
        DROP TABLE character_runtime_availability;
        DROP INDEX round_authority_address_round;
        DROP TABLE round_authority;
        ALTER TABLE round_commits DROP COLUMN authority_hash;
        DROP TABLE branch_controls;
        DROP INDEX outbox_retry_schedule;
        ALTER TABLE outbox DROP COLUMN first_attempt_at_ms;
        ALTER TABLE outbox DROP COLUMN next_attempt_at_ms;
        DROP INDEX outbox_claim_token_unique;
        ALTER TABLE outbox DROP COLUMN claim_owner_id;
        ALTER TABLE outbox DROP COLUMN claim_token;
        ALTER TABLE outbox DROP COLUMN claim_expires_at_ms;
        DROP TABLE round_inbox;
        CREATE TABLE round_inbox (
          address_key TEXT NOT NULL,
          inbox_seq INTEGER NOT NULL CHECK(inbox_seq >= 1),
          idempotency_key TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          input_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed')),
          claim_owner_id TEXT,
          claim_fencing_token INTEGER,
          result_hash TEXT,
          result_json TEXT,
          PRIMARY KEY(address_key, inbox_seq),
          UNIQUE(address_key, idempotency_key),
          FOREIGN KEY(address_key) REFERENCES branches(address_key),
          CHECK (
            (status = 'pending' AND claim_owner_id IS NULL AND claim_fencing_token IS NULL AND result_hash IS NULL AND result_json IS NULL)
            OR (status = 'claimed' AND claim_owner_id IS NOT NULL AND claim_fencing_token IS NOT NULL AND result_hash IS NULL AND result_json IS NULL)
            OR (status = 'completed' AND claim_owner_id IS NOT NULL AND claim_fencing_token IS NOT NULL AND result_hash IS NOT NULL AND result_json IS NOT NULL)
          )
        ) STRICT;
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
