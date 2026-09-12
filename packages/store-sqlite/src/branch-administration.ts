import type { DatabaseSync } from 'node:sqlite'
import {
  assertProtocolString,
  failWorld,
  worldAddressKey,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { openReactionCycleId } from './reaction-cycle.ts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

export interface BranchControlState extends WorldJsonObject {
  readonly admissionState: 'open' | 'draining'
  readonly lifecycleState: 'active' | 'archived'
  readonly runtimePhase: 'active' | 'maintenance' | 'quarantined' | 'archived'
  readonly runtimeEpoch: number
  readonly reason: string | null
  readonly revision: number
}

export interface BranchAuditEvent extends WorldJsonObject {
  readonly auditSeq: number
  readonly operation: string
  readonly correlationId: string
  readonly details: WorldJsonValue
  readonly operationalTimeMs: number
}

/** Durable audit operation recorded when one Host scheduling quantum fails (ADR-0079). */
export const BRANCH_WORK_FAILURE_OPERATION = 'branch.work.failed'

/** Durable administrative barrier and append-only audit for one World database. */
export class BranchAdministration {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly operationalNow: () => number = Date.now) {
    this.#db = openWorldDatabase(path)
  }

  status(address: WorldAddress): BranchControlState {
    const row = this.#db.prepare(`
      SELECT admission_state, lifecycle_state, runtime_phase, runtime_epoch, reason, revision
      FROM branch_controls WHERE address_key = ?
    `).get(worldAddressKey(address)) as {
      admission_state: BranchControlState['admissionState']
      lifecycle_state: BranchControlState['lifecycleState']
      runtime_phase: BranchControlState['runtimePhase']
      runtime_epoch: number
      reason: string | null
      revision: number
    } | undefined
    if (row === undefined) throw new Error(`unknown world branch ${worldAddressKey(address)}`)
    return {
      admissionState: row.admission_state,
      lifecycleState: row.lifecycle_state,
      runtimePhase: row.runtime_phase,
      runtimeEpoch: row.runtime_epoch,
      reason: row.reason,
      revision: row.revision,
    }
  }

  setAdmission(address: WorldAddress, state: 'open' | 'draining', reason: string, correlationId: string): BranchControlState {
    assertProtocolString(reason, 'administrative reason')
    assertProtocolString(correlationId, 'correlationId')
    return this.#mutate(address, 'branch.admission.changed', correlationId, (current) => {
      if (current.runtimePhase !== 'active') {
        failWorld({
          errorCode: current.runtimePhase === 'quarantined' ? 'BRANCH_QUARANTINED' : 'BRANCH_DRAINING',
          category: 'admin', message: `branch is ${current.runtimePhase}`, retryable: false,
          correlationId, address,
        })
      }
      return { ...current, admissionState: state, reason }
    })
  }

  enterMaintenance(address: WorldAddress, reason: string, correlationId: string): BranchControlState {
    assertProtocolString(reason, 'administrative reason')
    assertProtocolString(correlationId, 'correlationId')
    return this.#mutate(address, 'maintenance.entered', correlationId, (current, key, now) => {
      const activeLease = this.#db.prepare(`
        SELECT 1 AS present FROM writer_leases WHERE address_key = ? AND expires_at_ms > ?
      `).get(key, now)
      const unfinishedRound = this.#db.prepare(`
        SELECT 1 AS present FROM round_inbox WHERE address_key = ? AND status IN ('pending', 'claimed')
        UNION ALL SELECT 1 FROM player_input_jobs WHERE address_key = ?
          AND status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued') LIMIT 1
      `).get(key, key)
      const openCycle = openReactionCycleId(this.#db, address)
      const criticalInflight = this.#db.prepare(`
        SELECT 1 FROM outbox WHERE address_key = ? AND critical = 1 AND delivery_status = 'inflight' LIMIT 1
      `).get(key)
      if (current.runtimePhase !== 'active' || current.lifecycleState !== 'active'
        || current.admissionState !== 'draining' || activeLease !== undefined || unfinishedRound !== undefined
        || openCycle !== undefined || criticalInflight !== undefined) {
        failWorld({
          errorCode: 'BRANCH_DRAINING', category: 'admin',
          message: 'maintenance requires a drained active branch with no active writer, unfinished Round, Reaction Cycle, or critical inflight delivery',
          retryable: true, correlationId, address,
        })
      }
      return { ...current, runtimePhase: 'maintenance', reason }
    })
  }

  exitMaintenance(address: WorldAddress, reason: string, correlationId: string): BranchControlState {
    assertProtocolString(reason, 'administrative reason')
    assertProtocolString(correlationId, 'correlationId')
    return this.#mutate(address, 'maintenance.exited', correlationId, (current, key, now) => {
      const activeLease = this.#db.prepare(`
        SELECT 1 AS present FROM writer_leases WHERE address_key = ? AND expires_at_ms > ?
      `).get(key, now)
      if (current.runtimePhase !== 'maintenance' || current.lifecycleState !== 'active' || activeLease !== undefined) {
        failWorld({
          errorCode: 'BRANCH_DRAINING', category: 'admin',
          message: 'only an offline maintenance branch can return to active service',
          retryable: true, correlationId, address,
        })
      }
      return {
        ...current,
        admissionState: 'open',
        runtimePhase: 'active',
        runtimeEpoch: current.runtimeEpoch + 1,
        reason,
      }
    })
  }

  archive(address: WorldAddress, reason: string, correlationId: string): BranchControlState {
    assertProtocolString(reason, 'administrative reason')
    assertProtocolString(correlationId, 'correlationId')
    return this.#mutate(address, 'branch.archived', correlationId, (current, key, now) => {
      this.#assertArchiveReady(address, key, current, correlationId, now)
      return { ...current, lifecycleState: 'archived', runtimePhase: 'archived', reason }
    })
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

  recordBranchWorkFailure(
    address: WorldAddress,
    correlationId: string,
    details: WorldJsonObject,
  ): BranchAuditEvent {
    assertProtocolString(correlationId, 'correlationId')
    const key = worldAddressKey(address)
    const operationalTimeMs = this.operationalNow()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.status(address)
      const result = this.#db.prepare(`
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, BRANCH_WORK_FAILURE_OPERATION, correlationId, worldJsonText(details), operationalTimeMs)
      this.#db.exec('COMMIT')
      return {
        auditSeq: Number(result.lastInsertRowid), operation: BRANCH_WORK_FAILURE_OPERATION, correlationId,
        details, operationalTimeMs,
      }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  close(): void {
    this.#db.close()
  }

  #mutate(
    address: WorldAddress,
    operation: string,
    correlationId: string,
    update: (current: BranchControlState, addressKey: string, operationalTimeMs: number) => BranchControlState,
  ): BranchControlState {
    const key = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const operationalTimeMs = this.operationalNow()
      const current = this.status(address)
      const candidate = update(current, key, operationalTimeMs)
      const next = { ...candidate, revision: current.revision + 1 }
      this.#db.prepare(`
        UPDATE branch_controls SET admission_state = ?, lifecycle_state = ?, runtime_phase = ?, runtime_epoch = ?,
          reason = ?, revision = ? WHERE address_key = ?
      `).run(
        next.admissionState, next.lifecycleState, next.runtimePhase, next.runtimeEpoch,
        next.reason, next.revision, key,
      )
      this.#db.prepare(`
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, operation, correlationId, worldJsonText({ before: current, after: next }), operationalTimeMs)
      this.#db.exec('COMMIT')
      return next
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  #assertArchiveReady(
    address: WorldAddress,
    addressKey: string,
    current: BranchControlState,
    correlationId: string,
    operationalTimeMs: number,
  ): void {
    const activeLease = this.#db.prepare(`
      SELECT 1 AS present FROM writer_leases WHERE address_key = ? AND expires_at_ms > ?
    `).get(addressKey, operationalTimeMs)
    const unfinishedRound = this.#db.prepare(`
      SELECT 1 AS present FROM round_inbox WHERE address_key = ? AND status IN ('pending', 'claimed')
      UNION ALL SELECT 1 FROM player_input_jobs WHERE address_key = ?
        AND status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued') LIMIT 1
    `).get(addressKey, addressKey)
    const unresolvedCriticalDelivery = this.#db.prepare(`
      SELECT 1 AS present FROM outbox
      WHERE address_key = ? AND critical = 1 AND delivery_status <> 'delivered' LIMIT 1
    `).get(addressKey)
    const openCycle = openReactionCycleId(this.#db, address)
    if (
      current.admissionState !== 'draining'
      || current.runtimePhase !== 'active'
      || activeLease !== undefined
      || unfinishedRound !== undefined
      || unresolvedCriticalDelivery !== undefined
      || openCycle !== undefined
    ) {
      failWorld({
        errorCode: 'BRANCH_DRAINING', category: 'admin',
        message: 'branch archive requires a drained admission barrier with no active writer, unfinished Round, critical delivery, or Reaction Cycle',
        retryable: true, correlationId, address,
      })
    }
  }
}
