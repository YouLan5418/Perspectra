import type { DatabaseSync } from 'node:sqlite'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { openOwnedDatabase, parseWorldJson, worldJsonText } from './sqlite.ts'

const AUDIT_APPLICATION_ID = 0x48435741
const AUDIT_SCHEMA = `
CREATE TABLE operational_audit_events (
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  operational_time_ms INTEGER NOT NULL CHECK(operational_time_ms >= 0)
) STRICT;
`

export interface OperationalAuditEvent extends WorldJsonObject {
  readonly auditSeq: number
  readonly scopeKey: string
  readonly operation: string
  readonly correlationId: string
  readonly details: WorldJsonValue
  readonly operationalTimeMs: number
}

/** Append-only operational audit sidecar, deliberately excluded from authoritative World hashes. */
export class OperationalAuditLog {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly operationalNow: () => number = Date.now) {
    this.#db = openOwnedDatabase(path, AUDIT_APPLICATION_ID, AUDIT_SCHEMA)
  }

  record(scopeKey: string, operation: string, correlationId: string, details: WorldJsonValue): OperationalAuditEvent {
    if ([scopeKey, operation, correlationId].some(value => value.length === 0 || value.trim() !== value)) {
      throw new TypeError('audit scope, operation, and correlationId must be non-empty unpadded strings')
    }
    const operationalTimeMs = this.operationalNow()
    const result = this.#db.prepare(`
      INSERT INTO operational_audit_events(scope_key, operation, correlation_id, details_json, operational_time_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(scopeKey, operation, correlationId, worldJsonText(details), operationalTimeMs)
    return { auditSeq: Number(result.lastInsertRowid), scopeKey, operation, correlationId, details, operationalTimeMs }
  }

  read(scopeKey?: string): OperationalAuditEvent[] {
    const rows = (scopeKey === undefined
      ? this.#db.prepare(`SELECT * FROM operational_audit_events ORDER BY audit_seq`).all()
      : this.#db.prepare(`SELECT * FROM operational_audit_events WHERE scope_key = ? ORDER BY audit_seq`).all(scopeKey)) as Array<{
        audit_seq: number
        scope_key: string
        operation: string
        correlation_id: string
        details_json: string
        operational_time_ms: number
      }>
    return rows.map(row => ({
      auditSeq: row.audit_seq,
      scopeKey: row.scope_key,
      operation: row.operation,
      correlationId: row.correlation_id,
      details: parseWorldJson(row.details_json),
      operationalTimeMs: row.operational_time_ms,
    }))
  }

  close(): void {
    this.#db.close()
  }
}
