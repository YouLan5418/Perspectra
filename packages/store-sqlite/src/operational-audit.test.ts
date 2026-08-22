import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationalAuditLog } from './operational-audit.ts'

const directories: string[] = []

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-audit-'))
  directories.push(directory)
  return join(directory, 'operations.audit.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('OperationalAuditLog', () => {
  it('appends durable low-cardinality operation evidence and filters by scope', () => {
    const path = database()
    const audit = new OperationalAuditLog(path, () => 42)
    expect(audit.record('world:a', 'backup.requested', 'audit:one', { targetHash: 'sha256:value' })).toMatchObject({
      auditSeq: 1, scopeKey: 'world:a', operation: 'backup.requested', operationalTimeMs: 42,
    })
    const second = audit.record('world:b', 'restore.requested', 'audit:two', {})
    expect(second.previousHash).toBe(audit.read()[0]!.recordHash)
    expect(audit.read()).toHaveLength(2)
    expect(audit.read('world:a')).toMatchObject([{ correlationId: 'audit:one', details: { targetHash: 'sha256:value' } }])
    expect(audit.read('missing')).toEqual([])
    expect(() => audit.record('', 'operation', 'correlation', {})).toThrow(TypeError)
    expect(() => audit.record('world:a', ' padded ', 'correlation', {})).toThrow(TypeError)
    audit.close()

    const reopened = new OperationalAuditLog(path)
    expect(reopened.read()).toHaveLength(2)
    reopened.close()
  })

  it('backfills legacy rows and detects later hash-chain tampering', () => {
    const path = database()
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      PRAGMA application_id = 0x48435741;
      PRAGMA user_version = 1;
      CREATE TABLE operational_audit_events (
        audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        operational_time_ms INTEGER NOT NULL CHECK(operational_time_ms >= 0)
      ) STRICT;
      INSERT INTO operational_audit_events(scope_key, operation, correlation_id, details_json, operational_time_ms)
      VALUES ('world:legacy', 'legacy.requested', 'audit:legacy', '{}', 1);
    `)
    legacy.close()
    const migrated = new OperationalAuditLog(path)
    expect(migrated.read()).toMatchObject([{ previousHash: 'genesis', recordHash: expect.stringMatching(/^sha256:/) }])
    migrated.close()

    const tamper = new DatabaseSync(path)
    tamper.prepare(`UPDATE operational_audit_events SET details_json = ? WHERE audit_seq = 1`).run('{"tampered":true}')
    tamper.close()
    const divergent = new OperationalAuditLog(path)
    expect(() => divergent.read()).toThrow('hash chain is divergent')
    divergent.close()

    const malformedPath = database()
    const malformed = new DatabaseSync(malformedPath)
    malformed.exec(`
      PRAGMA application_id = 0x48435741;
      PRAGMA user_version = 1;
      CREATE TABLE operational_audit_events (
        audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        operational_time_ms INTEGER NOT NULL CHECK(operational_time_ms >= 0)
      ) STRICT;
      INSERT INTO operational_audit_events(scope_key, operation, correlation_id, details_json, operational_time_ms)
      VALUES ('world:legacy', 'legacy.requested', 'audit:malformed', '{', 1);
    `)
    malformed.close()
    expect(() => new OperationalAuditLog(malformedPath)).toThrow()
  })

  it('rejects an invalid operational clock without appending partial evidence', () => {
    const path = database()
    const audit = new OperationalAuditLog(path, () => -1)
    expect(() => audit.record('world:a', 'operation', 'audit:clock', {})).toThrow()
    expect(audit.read()).toEqual([])
    audit.close()
  })
})
