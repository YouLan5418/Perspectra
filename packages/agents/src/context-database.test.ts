import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_APPLICATION_ID,
  CONTEXT_SCHEMA_VERSION,
  openContextDatabase,
} from './context-database.ts'

const directories: string[] = []

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-context-schema-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tables(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>).map(row => row.name)
}

describe('Context database migration catalog', () => {
  it('migrates legacy call identities without delimiter collisions or rewriting hashes', () => {
    const path = database('legacy-calls.sqlite')
    const db = openContextDatabase(path)
    db.exec(`DROP INDEX provider_calls_work;
      ALTER TABLE provider_calls DROP COLUMN purpose;
      ALTER TABLE provider_calls DROP COLUMN work_id;
      ALTER TABLE provider_calls DROP COLUMN request_json;
      DROP TABLE player_intent_late_responses;
      PRAGMA user_version = 5;`)
    const insert = db.prepare(`INSERT INTO provider_calls(model_call_id,namespace_key,round_id,participant_id,
      receipt_id,receipt_hash,controller_epoch,context_hash,provider_request_hash,state) VALUES (?,?,?,?,?,'receipt-hash',0,'context-hash','request-hash','prepared')`)
    insert.run('call:1', 'namespace', 'round:a', 'b', 'receipt:1')
    insert.run('call:2', 'namespace', 'round', 'a:b', 'receipt:2')
    const original = db.prepare('SELECT * FROM provider_calls ORDER BY model_call_id').all()
    db.close()
    const migrated = openContextDatabase(path)
    const rows = migrated.prepare('SELECT * FROM provider_calls ORDER BY model_call_id').all()
    expect(rows.map(({ purpose, work_id, request_json, ...row }) => {
      expect(purpose).toBe('round_participant')
      expect(work_id).toBe(row.model_call_id)
      expect(request_json).toBeNull()
      return row
    })).toEqual(original)
    migrated.close()
  })

  it('owns a fresh database and installs the complete contiguous schema', () => {
    const db = openContextDatabase(database('fresh.sqlite'))
    expect((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id)
      .toBe(CONTEXT_APPLICATION_ID)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(CONTEXT_SCHEMA_VERSION)
    expect(tables(db)).toEqual([
      'context_receipts',
      'continuity_checkpoints',
      'player_intent_late_responses',
      'provider_calls',
      'provider_quality_audit',
      'provider_quality_outcomes',
      'provider_quality_state',
      'provider_quality_ticks',
    ])
    db.close()
  })

  it('repairs legacy component-first layouts without rewriting existing rows', () => {
    const path = database('legacy-v1.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE continuity_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        namespace_key TEXT NOT NULL,
        as_of_seq INTEGER NOT NULL,
        checkpoint_json TEXT NOT NULL,
        checkpoint_hash TEXT NOT NULL,
        UNIQUE(namespace_key, as_of_seq)
      );
      INSERT INTO continuity_checkpoints VALUES ('checkpoint:legacy', 'legacy', 0, '{}', 'sha256:legacy');
      PRAGMA user_version = 1;
    `)
    legacy.close()
    const migrated = openContextDatabase(path)
    expect(migrated.prepare('SELECT checkpoint_id FROM continuity_checkpoints').get())
      .toEqual({ checkpoint_id: 'checkpoint:legacy' })
    expect(tables(migrated)).toHaveLength(8)
    migrated.close()

    const partialPath = database('legacy-v4-partial.sqlite')
    const partial = new DatabaseSync(partialPath)
    partial.exec('PRAGMA user_version = 4')
    partial.close()
    const repaired = openContextDatabase(partialPath)
    expect(tables(repaired)).toHaveLength(8)
    repaired.close()
  })

  it('rejects a foreign database identity and a future schema version', () => {
    const foreignPath = database('foreign.sqlite')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('PRAGMA application_id = 1')
    foreign.close()
    expect(() => openContextDatabase(foreignPath)).toThrow('application_id mismatch')

    const futurePath = database('future.sqlite')
    const future = new DatabaseSync(futurePath)
    future.exec(`PRAGMA user_version = ${CONTEXT_SCHEMA_VERSION + 1}`)
    future.close()
    expect(() => openContextDatabase(futurePath)).toThrow('user_version mismatch')
  })
})
