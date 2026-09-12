import type { DatabaseSync } from 'node:sqlite'
import { assertProtocolString, deterministicId, failWorld, hashWorldJson, worldAddressKey,
  type WorldAddress, type WorldHash, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'
import type { WriterLease } from './writer-lease.ts'

export const PLAYER_INPUT_TRANSITIONS = {
  received: ['prepared', 'validated', 'clarification_required', 'cancelled'],
  prepared: ['dispatch_started', 'clarification_required', 'cancelled'],
  dispatch_started: ['response_received', 'timed_out', 'timed_out_ambiguous', 'invalid_response', 'cancelled'],
  response_received: ['validated', 'clarification_required', 'invalid_response', 'timed_out_ambiguous', 'cancelled'],
  validated: ['round_enqueued'], round_enqueued: ['completed'], completed: [],
  clarification_required: [], invalid_response: [], timed_out: [], timed_out_ambiguous: [], cancelled: [],
} as const
export type PlayerInputStatus = keyof typeof PLAYER_INPUT_TRANSITIONS
export interface PlayerInputJob extends WorldJsonObject {
  readonly version: 'player-input-job/v1'
  readonly inputId: string
  readonly address: WorldAddress
  readonly inputSeq: number
  readonly idempotencyKey: string
  readonly principalId: string
  readonly input: WorldJsonValue
  readonly inputHash: WorldHash
  readonly status: PlayerInputStatus
  /** Append-only state evidence; original input is never overwritten. */
  readonly records: WorldJsonObject
}
export interface PlayerInputRow {
  readonly address_key: string; readonly input_seq: number; readonly idempotency_key: string
  readonly input_hash: WorldHash; readonly status: PlayerInputStatus; readonly job_json: string; readonly state_hash: WorldHash
}

export function readPlayerInputRow(row: PlayerInputRow): PlayerInputJob {
  const job = parseWorldJson(row.job_json) as PlayerInputJob
  if (job.version !== 'player-input-job/v1' || worldAddressKey(job.address) !== row.address_key
    || job.inputSeq !== row.input_seq || job.idempotencyKey !== row.idempotency_key || job.status !== row.status
    || !Object.hasOwn(PLAYER_INPUT_TRANSITIONS, job.status)
    || hashWorldJson('player-input-state/v1', job) !== row.state_hash
    || hashWorldJson('player-input/v1', { principalId: job.principalId, input: job.input }) !== row.input_hash
    || job.inputHash !== row.input_hash
    || job.inputId !== deterministicId('player-input', { address: job.address, inputSeq: job.inputSeq, inputHash: job.inputHash })) {
    failWorld({ errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false,
      message: 'player input authority is inconsistent', correlationId: 'player-input:read' })
  }
  return job
}

/** World-authoritative input FIFO. Network calls never run inside its transactions. */
export class PlayerInputJobs {
  readonly #db: DatabaseSync
  constructor(path: string, private readonly now: () => number = Date.now) { this.#db = openWorldDatabase(path) }
  close(): void { this.#db.close() }

  read(address: WorldAddress, idempotencyKey: string): PlayerInputJob | undefined {
    const row = this.#db.prepare('SELECT * FROM player_input_jobs WHERE address_key = ? AND idempotency_key = ?')
      .get(worldAddressKey(address), idempotencyKey) as PlayerInputRow | undefined
    return row === undefined ? undefined : readPlayerInputRow(row)
  }

  receive(address: WorldAddress, principalId: string, idempotencyKey: string, input: WorldJsonValue, queueLimit: number): PlayerInputJob {
    assertProtocolString(principalId, 'principalId')
    assertProtocolString(idempotencyKey, 'idempotencyKey')
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 1) throw new TypeError('input queueLimit must be positive')
    const key = worldAddressKey(address)
    const inputHash = hashWorldJson('player-input/v1', { principalId, input })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const old = this.read(address, idempotencyKey)
      if (old !== undefined) {
        if (old.inputHash !== inputHash) this.#fail('IDEMPOTENCY_KEY_CONFLICT', address, 'input key has different content')
        this.#db.exec('COMMIT')
        return old
      }
      const control = this.#db.prepare('SELECT admission_state, runtime_phase, lifecycle_state FROM branch_controls WHERE address_key = ?')
        .get(key) as { admission_state: string; runtime_phase: string; lifecycle_state: string } | undefined
      if (control === undefined || control.admission_state !== 'open' || control.runtime_phase !== 'active' || control.lifecycle_state !== 'active') {
        this.#fail('BRANCH_DRAINING', address, 'player input admission is not open')
      }
      const rows = this.#db.prepare('SELECT * FROM player_input_jobs WHERE address_key = ? ORDER BY input_seq').all(key) as unknown as PlayerInputRow[]
      const jobs = rows.map(readPlayerInputRow)
      if (jobs.filter(job => PLAYER_INPUT_TRANSITIONS[job.status].length > 0).length >= queueLimit) this.#fail('ROUND_QUEUE_FULL', address, 'player input queue is full')
      const inputSeq = (jobs.at(-1)?.inputSeq ?? 0) + 1
      const job: PlayerInputJob = { version: 'player-input-job/v1', inputId: deterministicId('player-input', { address, inputSeq, inputHash }),
        address, inputSeq, idempotencyKey, principalId, input, inputHash, status: 'received', records: {} }
      this.#db.prepare('INSERT INTO player_input_jobs(address_key,input_seq,idempotency_key,input_hash,status,job_json,state_hash) VALUES (?,?,?,?,?,?,?)')
        .run(key, inputSeq, idempotencyKey, inputHash, job.status, worldJsonText(job), hashWorldJson('player-input-state/v1', job))
      this.#db.exec('COMMIT')
      return this.read(address, idempotencyKey)!
    } catch (error) { rollbackAndThrow(this.#db, error) }
  }

  /** Returns the earliest unfinished item; another input cannot overtake it. */
  claim(address: WorldAddress, lease: WriterLease): PlayerInputJob | undefined {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#lease(address, lease)
      const rows = this.#db.prepare('SELECT * FROM player_input_jobs WHERE address_key = ? ORDER BY input_seq')
        .all(worldAddressKey(address)) as unknown as PlayerInputRow[]
      const next = rows.map(readPlayerInputRow).find(job => PLAYER_INPUT_TRANSITIONS[job.status].length > 0)
      if (next !== undefined) this.#db.prepare('UPDATE player_input_jobs SET claim_owner_id = ?, claim_fencing_token = ? WHERE address_key = ? AND input_seq = ?')
        .run(lease.ownerId, lease.fencingToken, worldAddressKey(address), next.inputSeq)
      this.#db.exec('COMMIT')
      return next
    } catch (error) { rollbackAndThrow(this.#db, error) }
  }

  advance(job: PlayerInputJob, lease: WriterLease, status: PlayerInputStatus, evidence: WorldJsonValue): PlayerInputJob {
    const key = worldAddressKey(job.address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#lease(job.address, lease)
      const current = this.read(job.address, job.idempotencyKey)
      if (current === undefined) throw new TypeError('player input job is missing')
      const evidenceHash = hashWorldJson('player-input-evidence/v1', evidence)
      if (current.status === status && hashWorldJson('player-input-evidence/v1', current.records[status]!) === evidenceHash) {
        this.#db.exec('COMMIT')
        return current
      }
      if (hashWorldJson('player-input-state/v1', current) !== hashWorldJson('player-input-state/v1', job)
        || !(PLAYER_INPUT_TRANSITIONS[current.status] as readonly string[]).includes(status)) throw new TypeError('player input transition is invalid or stale')
      const next: PlayerInputJob = { ...current, status, records: { ...current.records, [status]: evidence } }
      const result = this.#db.prepare('UPDATE player_input_jobs SET status = ?, job_json = ?, state_hash = ? WHERE address_key = ? AND input_seq = ? AND claim_owner_id = ? AND claim_fencing_token = ?')
        .run(status, worldJsonText(next), hashWorldJson('player-input-state/v1', next), key, job.inputSeq, lease.ownerId, lease.fencingToken)
      if (result.changes !== 1) this.#fail('WRITER_LEASE_LOST', job.address, 'player input was not claimed by this writer')
      this.#db.exec('COMMIT')
      return this.read(job.address, job.idempotencyKey)!
    } catch (error) { rollbackAndThrow(this.#db, error) }
  }

  #lease(address: WorldAddress, lease: WriterLease): void {
    const row = this.#db.prepare('SELECT owner_id, fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?')
      .get(worldAddressKey(address)) as { owner_id: string; fencing_token: number; expires_at_ms: number } | undefined
    if (row === undefined || row.owner_id !== lease.ownerId || row.fencing_token !== lease.fencingToken || row.expires_at_ms <= this.now()) {
      this.#fail('WRITER_LEASE_LOST', address, 'player input writer lease lost')
    }
  }
  #fail(errorCode: 'IDEMPOTENCY_KEY_CONFLICT' | 'BRANCH_DRAINING' | 'ROUND_QUEUE_FULL' | 'WRITER_LEASE_LOST', address: WorldAddress, message: string): never {
    failWorld({ errorCode, address, message, category: 'admission', retryable: false, correlationId: 'player-input' })
  }
}
