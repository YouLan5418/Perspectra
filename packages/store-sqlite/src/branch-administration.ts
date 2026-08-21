import type { DatabaseSync } from 'node:sqlite'
import {
  failWorld,
  worldAddressKey,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

export interface BranchControlState extends WorldJsonObject {
  readonly admissionState: 'open' | 'draining'
  readonly lifecycleState: 'active' | 'archived'
  readonly reason: string | null
  readonly revision: number
}

export interface BranchAuditEvent {
  readonly auditSeq: number
  readonly operation: string
  readonly correlationId: string
  readonly details: WorldJsonValue
  readonly operationalTimeMs: number
}

/** Durable administrative barrier and append-only audit for one World database. */
export class BranchAdministration {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly operationalNow: () => number = Date.now) {
    this.#db = openWorldDatabase(path)
  }

  status(address: WorldAddress): BranchControlState {
    const row = this.#db.prepare(`
      SELECT admission_state, lifecycle_state, reason, revision FROM branch_controls WHERE address_key = ?
    `).get(worldAddressKey(address)) as {
      admission_state: BranchControlState['admissionState']
      lifecycle_state: BranchControlState['lifecycleState']
      reason: string | null
      revision: number
    } | undefined
    if (row === undefined) throw new Error(`unknown world branch ${worldAddressKey(address)}`)
    return { admissionState: row.admission_state, lifecycleState: row.lifecycle_state, reason: row.reason, revision: row.revision }
  }

  setAdmission(address: WorldAddress, state: 'open' | 'draining', reason: string, correlationId: string): BranchControlState {
    if (reason.length === 0 || correlationId.length === 0) throw new TypeError('administrative reason and correlationId are required')
    return this.#mutate(address, 'branch.admission.changed', correlationId, (current) => {
      if (current.lifecycleState === 'archived' && state === 'open') {
        failWorld({
          errorCode: 'BRANCH_DRAINING', category: 'admin', message: 'archived branch cannot reopen admission', retryable: false,
          correlationId, address,
        })
      }
      return { ...current, admissionState: state, reason }
    })
  }

  archive(address: WorldAddress, reason: string, correlationId: string): BranchControlState {
    if (reason.length === 0 || correlationId.length === 0) throw new TypeError('administrative reason and correlationId are required')
    return this.#mutate(address, 'branch.archived', correlationId, current => ({
      ...current,
      admissionState: 'draining',
      lifecycleState: 'archived',
      reason,
    }))
  }

  readAudit(address: WorldAddress): BranchAuditEvent[] {
    const rows = this.#db.prepare(`
      SELECT audit_seq, operation, correlation_id, details_json, operational_time_ms
      FROM branch_audit_events WHERE address_key = ? ORDER BY audit_seq
    `).all(worldAddressKey(address)) as Array<{
      audit_seq: number
      operation: string
      correlation_id: string
      details_json: string
      operational_time_ms: number
    }>
    return rows.map(row => ({
      auditSeq: row.audit_seq,
      operation: row.operation,
      correlationId: row.correlation_id,
      details: parseWorldJson(row.details_json),
      operationalTimeMs: row.operational_time_ms,
    }))
  }

  close(): void {
    this.#db.close()
  }

  #mutate(
    address: WorldAddress,
    operation: string,
    correlationId: string,
    update: (current: BranchControlState) => BranchControlState,
  ): BranchControlState {
    const key = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.status(address)
      const candidate = update(current)
      const next = { ...candidate, revision: current.revision + 1 }
      this.#db.prepare(`
        UPDATE branch_controls SET admission_state = ?, lifecycle_state = ?, reason = ?, revision = ? WHERE address_key = ?
      `).run(next.admissionState, next.lifecycleState, next.reason, next.revision, key)
      this.#db.prepare(`
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, operation, correlationId, worldJsonText({ before: current, after: next }), this.operationalNow())
      this.#db.exec('COMMIT')
      return next
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }
}
