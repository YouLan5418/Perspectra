import type { DatabaseSync } from 'node:sqlite'
import {
  assertProtocolString,
  canonicalizeWorldJson,
  createErrorEnvelope,
  failWorld,
  hashWorldJson,
  WorldError,
  worldAddressKey,
  type ErrorEnvelope,
  type FaultInjector,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { quarantineReactionCycleInTransaction } from './reaction-cycle.ts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

export interface QuarantineRequest {
  readonly address: WorldAddress
  readonly error: ErrorEnvelope
  readonly source: string
}

export interface QuarantineResult extends WorldJsonObject {
  readonly status: 'quarantined' | 'already_quarantined'
  readonly failureId: string
  readonly abortedRoundCount: number
  readonly runtimeEpoch: number
  readonly quarantinedCycleId: string | null
  readonly terminalizedJobCount: number
  readonly unresolvedReactionCycle?: true
}

export interface BranchFailureRecord extends WorldJsonObject {
  readonly failureId: string
  readonly errorHash: WorldHash
  readonly error: WorldJsonValue
  readonly source: string
  readonly status: 'open' | 'recovered'
  readonly occurredAtMs: number
  readonly recoveredAtMs: number | null
  readonly recoveryCorrelationId: string | null
}

export interface QuarantineExplanation extends WorldJsonObject {
  readonly runtimePhase: 'active' | 'maintenance' | 'quarantined' | 'archived'
  readonly runtimeEpoch: number
  readonly admissionState: 'open' | 'draining'
  readonly failures: readonly BranchFailureRecord[]
}

export interface QuarantineRecoveryResult extends WorldJsonObject {
  readonly status: 'recovered'
  readonly runtimeEpoch: number
  readonly validationHash: WorldHash
}

interface BranchControlRow {
  readonly admission_state: 'open' | 'draining'
  readonly runtime_phase: 'active' | 'maintenance' | 'quarantined' | 'archived'
  readonly runtime_epoch: number
}

function admissionBeforeQuarantine(db: DatabaseSync, key: string, control: BranchControlRow): 'open' | 'draining' {
  if (control.runtime_phase === 'active') return control.admission_state
  const row = db.prepare(`
    SELECT details_json FROM branch_audit_events
    WHERE address_key = ? AND operation = 'branch.quarantined'
    ORDER BY audit_seq DESC LIMIT 1
  `).get(key) as { details_json: string } | undefined
  if (row === undefined) return control.admission_state
  const details = parseWorldJson(row.details_json) as Record<string, WorldJsonValue>
  return details.priorAdmissionState === 'draining' ? 'draining' : 'open'
}

function controlRow(db: DatabaseSync, key: string): BranchControlRow {
  const row = db.prepare(`
    SELECT admission_state, runtime_phase, runtime_epoch FROM branch_controls WHERE address_key = ?
  `).get(key) as BranchControlRow | undefined
  if (row === undefined) throw new Error(`unknown world branch ${key}`)
  return row
}

/** Apply the emergency barrier inside the caller's existing SQLite transaction. */
export function applyBranchQuarantine(
  db: DatabaseSync,
  request: QuarantineRequest,
  occurredAtMs: number,
): QuarantineResult {
  assertProtocolString(request.source, 'quarantine source')
  if (request.error.address !== undefined && worldAddressKey(request.error.address) !== worldAddressKey(request.address)) {
    throw new TypeError('quarantine ErrorEnvelope address does not match the target branch')
  }
  const key = worldAddressKey(request.address)
  const errorText = worldJsonText(request.error as unknown as WorldJsonValue)
  const errorHash = hashWorldJson('branch-failure-envelope', request.error as unknown as WorldJsonValue)
  const control = controlRow(db, key)
  if (control.runtime_phase === 'archived') {
    failWorld({
      errorCode: 'BRANCH_DRAINING', category: 'admin', message: 'archived branch cannot enter quarantine',
      retryable: false, correlationId: request.error.correlationId, address: request.address,
    })
  }
  const existing = db.prepare(`
    SELECT error_hash, status FROM branch_failures WHERE failure_id = ?
  `).get(request.error.errorId) as { error_hash: WorldHash; status: 'open' | 'recovered' } | undefined
  if (existing !== undefined) {
    if (existing.error_hash !== errorHash) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
        message: 'failureId is already bound to another ErrorEnvelope', retryable: false,
        correlationId: request.error.correlationId, address: request.address,
      })
    }
    if (existing.status === 'open' && control.runtime_phase === 'quarantined') {
      return {
        status: 'already_quarantined', failureId: request.error.errorId,
        abortedRoundCount: 0, runtimeEpoch: control.runtime_epoch,
        quarantinedCycleId: null, terminalizedJobCount: 0,
      }
    }
    db.prepare(`
      UPDATE branch_failures SET status = 'open', recovered_at_ms = NULL, recovery_correlation_id = NULL
      WHERE failure_id = ?
    `).run(request.error.errorId)
  } else {
    db.prepare(`
      INSERT INTO branch_failures(
        failure_id, address_key, error_hash, error_json, source, status, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(request.error.errorId, key, errorHash, errorText, request.source, occurredAtMs)
  }
  const priorAdmissionState = admissionBeforeQuarantine(db, key, control)
  const rounds = db.prepare(`
    SELECT inbox_seq FROM round_inbox
    WHERE address_key = ? AND status IN ('pending', 'claimed') AND commit_transaction_id IS NULL
    ORDER BY inbox_seq
  `).all(key) as Array<{ inbox_seq: number }>
  for (const round of rounds) {
    const result = {
      status: 'failed',
      failureId: request.error.errorId,
      errorCode: request.error.errorCode,
    } as const
    db.prepare(`
      UPDATE round_inbox SET status = 'failed', result_hash = ?, result_json = ?
      WHERE address_key = ? AND inbox_seq = ? AND status IN ('pending', 'claimed') AND commit_transaction_id IS NULL
    `).run(hashWorldJson('player-round-result', result), worldJsonText(result), key, round.inbox_seq)
  }
  db.prepare(`DELETE FROM writer_leases WHERE address_key = ?`).run(key)
  const headRow = db.prepare('SELECT head_seq FROM heads WHERE address_key = ?').get(key) as { head_seq: number }
  const quarantinedCycle = quarantineReactionCycleInTransaction(db, request.address, {
    terminalAtSeq: headRow.head_seq,
    claimOwnerId: `quarantine:${request.error.errorId}`,
    claimExpiresAtMs: occurredAtMs,
  })
  const unresolved = quarantinedCycle !== undefined && 'unresolvedReactionCycle' in quarantinedCycle
    ? { unresolvedReactionCycle: true as const } : {}
  const finalized = quarantinedCycle !== undefined && 'cycleId' in quarantinedCycle ? quarantinedCycle : undefined
  const quarantinedCycleId = finalized?.cycleId ?? null
  const terminalizedJobCount = finalized?.terminalizedJobCount ?? 0
  db.prepare(`
    UPDATE branch_controls SET admission_state = 'draining', runtime_phase = 'quarantined',
      reason = ?, revision = revision + 1 WHERE address_key = ?
  `).run(request.error.errorCode, key)
  db.prepare(`
    INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
    VALUES (?, 'branch.quarantined', ?, ?, ?)
  `).run(key, request.error.correlationId, worldJsonText({
    failureId: request.error.errorId,
    errorCode: request.error.errorCode,
    errorHash,
    source: request.source,
    abortedRoundCount: rounds.length,
    priorAdmissionState,
    quarantinedCycleId,
    terminalizedJobCount,
    ...unresolved,
  }), occurredAtMs)
  return {
    status: 'quarantined', failureId: request.error.errorId,
    abortedRoundCount: rounds.length, runtimeEpoch: control.runtime_epoch,
    quarantinedCycleId, terminalizedJobCount,
    ...unresolved,
  }
}

/** Emergency Branch write barrier and durable integrity-failure ledger. */
export class BranchQuarantineService {
  readonly #db: DatabaseSync

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
    private readonly faultInjector?: FaultInjector,
  ) {
    this.#db = openWorldDatabase(path)
  }

  quarantine(request: QuarantineRequest): QuarantineResult {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = applyBranchQuarantine(this.#db, request, this.now())
      this.faultInjector?.hit('quarantine.before-commit')
      this.#db.exec('COMMIT')
      this.faultInjector?.hit('quarantine.after-commit')
      return result
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  explain(address: WorldAddress): QuarantineExplanation {
    const key = worldAddressKey(address)
    const control = this.#control(key)
    const rows = this.#db.prepare(`
      SELECT failure_id, error_hash, error_json, source, status, occurred_at_ms,
        recovered_at_ms, recovery_correlation_id
      FROM branch_failures WHERE address_key = ? ORDER BY occurred_at_ms, failure_id
    `).all(key) as Array<{
      failure_id: string
      error_hash: WorldHash
      error_json: string
      source: string
      status: 'open' | 'recovered'
      occurred_at_ms: number
      recovered_at_ms: number | null
      recovery_correlation_id: string | null
    }>
    return {
      runtimePhase: control.runtime_phase,
      runtimeEpoch: control.runtime_epoch,
      admissionState: control.admission_state,
      failures: rows.map(row => ({
        failureId: row.failure_id,
        errorHash: row.error_hash,
        error: parseWorldJson(row.error_json),
        source: row.source,
        status: row.status,
        occurredAtMs: row.occurred_at_ms,
        recoveredAtMs: row.recovered_at_ms,
        recoveryCorrelationId: row.recovery_correlation_id,
      })),
    }
  }

  recover(address: WorldAddress, correlationId: string, validate: () => WorldJsonValue): QuarantineRecoveryResult {
    assertProtocolString(correlationId, 'correlationId')
    const key = worldAddressKey(address)
    this.#enterMaintenance(address, key, correlationId)
    let validation: WorldJsonValue
    try {
      validation = validate()
      canonicalizeWorldJson(validation)
    } catch (error: unknown) {
      const envelope = createErrorEnvelope({
        errorCode: 'RECOVERY_VALIDATION_FAILED', category: 'integrity',
        message: 'controlled quarantine recovery validation failed', retryable: false,
        correlationId, address,
        details: error instanceof WorldError
          ? { causedByErrorCode: error.envelope.errorCode, causedByErrorId: error.envelope.errorId }
          : { causeType: typeof error },
      })
      this.quarantine({ address, error: envelope, source: 'quarantine.recover' })
      throw new WorldError(envelope)
    }
    const validationHash = hashWorldJson('quarantine-recovery-validation', validation)
    const recoveredAtMs = this.now()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const control = this.#control(key)
      if (control.runtime_phase !== 'maintenance') throw new Error('branch left maintenance during recovery')
      this.#db.prepare(`
        UPDATE branch_failures SET status = 'recovered', recovered_at_ms = ?, recovery_correlation_id = ?
        WHERE address_key = ? AND status = 'open'
      `).run(recoveredAtMs, correlationId, key)
      this.#db.prepare(`
        UPDATE branch_controls SET admission_state = ?, runtime_phase = 'active', runtime_epoch = runtime_epoch + 1,
          reason = NULL, revision = revision + 1 WHERE address_key = ?
      `).run(admissionBeforeQuarantine(this.#db, key, control), key)
      this.#db.prepare(`
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, 'branch.quarantine.recovered', ?, ?, ?)
      `).run(key, correlationId, worldJsonText({ validationHash, nextRuntimeEpoch: control.runtime_epoch + 1 }), recoveredAtMs)
      this.faultInjector?.hit('quarantine-recovery.before-commit')
      this.#db.exec('COMMIT')
      this.faultInjector?.hit('quarantine-recovery.after-commit')
      return { status: 'recovered', runtimeEpoch: control.runtime_epoch + 1, validationHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  close(): void {
    this.#db.close()
  }

  #enterMaintenance(address: WorldAddress, key: string, correlationId: string): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const control = this.#control(key)
      if (control.runtime_phase !== 'quarantined' && control.runtime_phase !== 'maintenance') {
        failWorld({
          errorCode: 'INVALID_REQUEST', category: 'admin',
          message: 'quarantine recovery requires a quarantined branch', retryable: false,
          correlationId, address,
        })
      }
      const entered = control.runtime_phase === 'quarantined'
      if (entered) {
        const operationalTimeMs = this.now()
        this.#db.prepare(`
          UPDATE branch_controls SET runtime_phase = 'maintenance', reason = 'quarantine recovery',
            revision = revision + 1 WHERE address_key = ?
        `).run(key)
        this.#db.prepare(`
          INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
          VALUES (?, 'branch.quarantine.recovery-started', ?, ?, ?)
        `).run(key, correlationId, worldJsonText({ runtimeEpoch: control.runtime_epoch }), operationalTimeMs)
      }
      this.#db.exec('COMMIT')
      if (entered) this.faultInjector?.hit('quarantine-recovery.after-maintenance-commit')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  #control(key: string): BranchControlRow {
    return controlRow(this.#db, key)
  }
}
