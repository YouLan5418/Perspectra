import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  failWorld,
  hashWorldJson,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { parseWorldJson } from './sqlite.ts'
import { OperationalAuditLog } from './operational-audit.ts'

type SqlValue = string | number | null
type SqlRow = Record<string, SqlValue>

const TABLES = [
  'world_manifests', 'branches', 'heads', 'round_commits', 'events', 'outbox', 'branch_activations', 'branch_controls',
] as const

const COLUMNS: Record<(typeof TABLES)[number], readonly string[]> = {
  world_manifests: ['manifest_hash', 'manifest_json'],
  branches: ['address_key', 'tenant_id', 'world_id', 'branch_id', 'parent_address_key', 'fork_seq'],
  heads: ['address_key', 'head_seq', 'tick', 'event_hash'],
  round_commits: ['transaction_id', 'address_key', 'request_hash', 'round_id', 'base_head_seq', 'base_tick', 'head_seq', 'tick', 'bundle_hash'],
  events: ['address_key', 'seq', 'tick', 'event_type', 'event_version', 'data_json', 'previous_hash', 'event_hash', 'transaction_id', 'event_ordinal'],
  outbox: ['delivery_id', 'address_key', 'session_id', 'world_seq', 'payload_hash', 'payload_json', 'critical', 'transaction_id', 'delivery_status', 'attempt_count', 'session_delivery_seq', 'last_error'],
  branch_activations: ['address_key', 'activation_hash', 'manifest_hash', 'genesis_hash', 'transaction_id'],
  branch_controls: ['address_key', 'admission_state', 'lifecycle_state', 'reason', 'revision'],
}

interface LogicalAuthorityData extends WorldJsonObject {
  readonly tables: WorldJsonObject
}

interface LogicalAuthorityEnvelope extends WorldJsonObject {
  readonly format: 'dshworld-authority/v1'
  readonly data: LogicalAuthorityData
  readonly bundleHash: WorldHash
}

/** Authority-only logical transfer. Session, Memory, Audit, Presentation, and process state are intentionally omitted. */
export class WorldLogicalTransferService {
  constructor(private readonly sourcePath: string) {}

  exportAuthority(targetPath: string, correlationId: string): WorldHash {
    this.#guardTarget(targetPath, correlationId)
    this.#audit('authority.export.requested', correlationId, { targetPath })
    const db = new DatabaseSync(this.sourcePath, { readOnly: true })
    try {
      const tables: Record<string, WorldJsonValue> = {}
      for (const table of TABLES) {
        tables[table] = db.prepare(`SELECT ${COLUMNS[table].join(', ')} FROM ${table} ORDER BY rowid`).all() as SqlRow[]
      }
      const data: LogicalAuthorityData = { tables }
      const bundleHash = hashWorldJson('logical-authority-export', data)
      const envelope: LogicalAuthorityEnvelope = { format: 'dshworld-authority/v1', data, bundleHash }
      writeFileSync(targetPath, canonicalizeWorldJson(envelope), { flag: 'wx' })
      return bundleHash
    } finally {
      db.close()
    }
  }

  importAuthority(exportPath: string, targetPath: string, correlationId: string): WorldHash {
    this.#guardTarget(targetPath, correlationId)
    this.#audit('authority.import.requested', correlationId, { exportPath, targetPath })
    let envelope: LogicalAuthorityEnvelope
    try {
      envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as LogicalAuthorityEnvelope
      canonicalizeWorldJson(envelope)
    } catch (error: unknown) {
      this.#invalid('logical export is invalid', correlationId, error)
    }
    if (envelope.format !== 'dshworld-authority/v1') this.#invalid('logical export format is unsupported', correlationId)
    const actualHash = hashWorldJson('logical-authority-export', envelope.data)
    if (actualHash !== envelope.bundleHash) this.#invalid('logical export hash is invalid', correlationId)
    const db = openWorldDatabase(targetPath)
    try {
      db.exec('BEGIN IMMEDIATE')
      for (const table of TABLES) {
        const rows = envelope.data.tables[table]
        if (!Array.isArray(rows)) this.#invalid(`logical table ${table} is missing`, correlationId)
        const columns = COLUMNS[table]
        const insert = db.prepare(`INSERT INTO ${table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        for (const row of rows) {
          if (typeof row !== 'object' || row === null || Array.isArray(row)) this.#invalid(`logical table ${table} has an invalid row`, correlationId)
          insert.run(...columns.map(column => (row as WorldJsonObject)[column] as SqlValue))
        }
      }
      this.#validateEvents(db, correlationId)
      db.exec('COMMIT')
      return actualHash
    } catch (error: unknown) {
      try { db.exec('ROLLBACK') } catch { /* validation may fail after SQLite ended the transaction */ }
      db.close()
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${targetPath}${suffix}`, { force: true })
      throw error
    } finally {
      if (db.isOpen) db.close()
    }
  }

  #validateEvents(db: DatabaseSync, correlationId: string): void {
    const rows = db.prepare(`
      SELECT e.*, b.tenant_id, b.world_id, b.branch_id FROM events e
      JOIN branches b ON b.address_key = e.address_key ORDER BY e.address_key, e.seq
    `).all() as Array<{
      tenant_id: string
      world_id: string
      branch_id: string
      seq: number
      tick: number
      event_type: string
      event_version: number
      data_json: string
      previous_hash: string
      transaction_id: string
      event_ordinal: number
      event_hash: WorldHash
    }>
    for (const row of rows) {
      const address = { tenantId: row.tenant_id, worldId: row.world_id, branchId: row.branch_id } as WorldAddress
      const actual = hashWorldJson('world-event-envelope', {
        address,
        seq: row.seq,
        tick: row.tick,
        eventType: row.event_type,
        eventVersion: row.event_version,
        data: parseWorldJson(row.data_json),
        previousHash: row.previous_hash,
        transactionId: row.transaction_id,
        eventOrdinal: row.event_ordinal,
      })
      if (actual !== row.event_hash) this.#invalid('logical export contains a divergent Event hash', correlationId)
    }
  }

  #guardTarget(targetPath: string, correlationId: string): void {
    if (resolve(targetPath) === resolve(this.sourcePath) || existsSync(targetPath)) {
      failWorld({
        errorCode: 'IMPORT_ID_CONFLICT', category: 'admin', message: 'logical transfer target already exists or aliases the source',
        retryable: false, correlationId,
      })
    }
  }

  #invalid(message: string, correlationId: string, error?: unknown): never {
    failWorld({
      errorCode: 'BACKUP_INVALID', category: 'integrity', message: error === undefined ? message : `${message}: ${String(error)}`,
      retryable: false, correlationId,
    })
  }

  #audit(operation: string, correlationId: string, details: WorldJsonObject): void {
    const audit = new OperationalAuditLog(`${this.sourcePath}.audit.sqlite`)
    try {
      audit.record(resolve(this.sourcePath), operation, correlationId, details)
    } finally {
      audit.close()
    }
  }
}
