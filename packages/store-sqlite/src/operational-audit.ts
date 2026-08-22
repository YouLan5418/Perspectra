import type { DatabaseSync } from 'node:sqlite'
import { failWorld, hashWorldJson, type WorldHash, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { openMigratedDatabase, parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

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
const AUDIT_HASH_CHAIN_SCHEMA = `
ALTER TABLE operational_audit_events ADD COLUMN previous_hash TEXT;
ALTER TABLE operational_audit_events ADD COLUMN record_hash TEXT;
CREATE UNIQUE INDEX operational_audit_record_hash_unique
  ON operational_audit_events(record_hash) WHERE record_hash IS NOT NULL;
`

export interface OperationalAuditEvent extends WorldJsonObject {
  readonly auditSeq: number
  readonly scopeKey: string
  readonly operation: string
  readonly correlationId: string
  readonly details: WorldJsonValue
  readonly operationalTimeMs: number
  readonly previousHash: WorldHash | 'genesis'
  readonly recordHash: WorldHash
}

/** Append-only operational audit sidecar, deliberately excluded from authoritative World hashes. */
export class OperationalAuditLog {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly operationalNow: () => number = Date.now) {
    this.#db = openMigratedDatabase(path, AUDIT_APPLICATION_ID, [
      { version: 1, sql: AUDIT_SCHEMA },
      { version: 2, sql: AUDIT_HASH_CHAIN_SCHEMA },
    ])
    try {
      this.#backfillChain()
    } catch (error: unknown) {
      this.#db.close()
      throw error
    }
  }

  record(scopeKey: string, operation: string, correlationId: string, details: WorldJsonValue): OperationalAuditEvent {
    if ([scopeKey, operation, correlationId].some(value => value.length === 0 || value.trim() !== value)) {
      throw new TypeError('audit scope, operation, and correlationId must be non-empty unpadded strings')
    }
    const operationalTimeMs = this.operationalNow()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const tail = this.#db.prepare(`SELECT record_hash FROM operational_audit_events ORDER BY audit_seq DESC LIMIT 1`)
        .get() as { record_hash: WorldHash } | undefined
      const previousHash = tail?.record_hash ?? 'genesis'
      const recordHash = this.#hash(scopeKey, operation, correlationId, details, operationalTimeMs, previousHash)
      const result = this.#db.prepare(`
        INSERT INTO operational_audit_events(
          scope_key, operation, correlation_id, details_json, operational_time_ms, previous_hash, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(scopeKey, operation, correlationId, worldJsonText(details), operationalTimeMs, previousHash, recordHash)
      this.#db.exec('COMMIT')
      return {
        auditSeq: Number(result.lastInsertRowid), scopeKey, operation, correlationId, details,
        operationalTimeMs, previousHash, recordHash,
      }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  read(scopeKey?: string): OperationalAuditEvent[] {
    const rows = this.#db.prepare(`SELECT * FROM operational_audit_events ORDER BY audit_seq`).all() as Array<{
        audit_seq: number
        scope_key: string
        operation: string
        correlation_id: string
        details_json: string
        operational_time_ms: number
        previous_hash: WorldHash
        record_hash: WorldHash
      }>
    let previousHash: WorldHash | 'genesis' = 'genesis'
    const events = rows.map(row => {
      const details = parseWorldJson(row.details_json)
      const actual = this.#hash(
        row.scope_key, row.operation, row.correlation_id, details, row.operational_time_ms, previousHash,
      )
      if (row.previous_hash !== previousHash || row.record_hash !== actual) {
        failWorld({
          errorCode: 'BACKUP_INVALID', category: 'integrity', message: 'operational audit hash chain is divergent',
          retryable: false, correlationId: row.correlation_id,
        })
      }
      previousHash = row.record_hash
      return {
        auditSeq: row.audit_seq,
        scopeKey: row.scope_key,
        operation: row.operation,
        correlationId: row.correlation_id,
        details,
        operationalTimeMs: row.operational_time_ms,
        previousHash: row.previous_hash,
        recordHash: row.record_hash,
      }
    })
    return scopeKey === undefined ? events : events.filter(event => event.scopeKey === scopeKey)
  }

  close(): void {
    this.#db.close()
  }

  #backfillChain(): void {
    const rows = this.#db.prepare(`
      SELECT audit_seq, scope_key, operation, correlation_id, details_json, operational_time_ms, previous_hash, record_hash
      FROM operational_audit_events ORDER BY audit_seq
    `).all() as Array<{
      audit_seq: number
      scope_key: string
      operation: string
      correlation_id: string
      details_json: string
      operational_time_ms: number
      previous_hash: WorldHash | null
      record_hash: WorldHash | null
    }>
    if (rows.every(row => row.previous_hash !== null && row.record_hash !== null)) return
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      let previousHash: WorldHash | 'genesis' = 'genesis'
      for (const row of rows) {
        const details = parseWorldJson(row.details_json)
        const recordHash = this.#hash(
          row.scope_key, row.operation, row.correlation_id, details, row.operational_time_ms, previousHash,
        )
        this.#db.prepare(`
          UPDATE operational_audit_events SET previous_hash = ?, record_hash = ? WHERE audit_seq = ?
        `).run(previousHash, recordHash, row.audit_seq)
        previousHash = recordHash
      }
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  #hash(
    scopeKey: string,
    operation: string,
    correlationId: string,
    details: WorldJsonValue,
    operationalTimeMs: number,
    previousHash: WorldHash | 'genesis',
  ): WorldHash {
    return hashWorldJson('operational-audit-record', {
      scopeKey, operation, correlationId, details, operationalTimeMs, previousHash,
    })
  }
}
