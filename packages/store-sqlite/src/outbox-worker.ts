import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  type AppendDeliveryRequest,
  type AppendDeliveryResult,
  type DeliveryId,
  type FaultInjector,
  type SessionId,
  type WorldHash,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { parseWorldJson, rollbackAndThrow } from './sqlite.ts'

export interface ClaimedOutboxDelivery {
  readonly deliveryId: DeliveryId
  readonly sessionId: SessionId
  readonly sessionDeliverySeq: number
  readonly payloadHash: WorldHash
  readonly payload: WorldJsonValue
  readonly critical: boolean
  readonly attemptCount: number
  readonly claimOwnerId: string
  readonly claimToken: string
  readonly claimExpiresAtMs: number
}

export interface DeadLetterRecord extends Omit<ClaimedOutboxDelivery, 'claimOwnerId' | 'claimToken' | 'claimExpiresAtMs'> {
  readonly lastError: string
}

export interface WorldOutboxOptions {
  readonly workerId?: string
  readonly claimTtlMs?: number
  readonly now?: () => number
  readonly createClaimToken?: () => string
}

export interface SessionDeliveryPort {
  appendIfAbsent(request: AppendDeliveryRequest): Promise<AppendDeliveryResult>
}

/** Sender-side durable Outbox state and Receipt owner. */
export class WorldOutbox {
  readonly #db: DatabaseSync
  readonly #workerId: string
  readonly #claimTtlMs: number
  readonly #now: () => number
  readonly #createClaimToken: () => string

  constructor(path: string, private readonly faultInjector?: FaultInjector, options: WorldOutboxOptions = {}) {
    this.#workerId = options.workerId ?? `outbox-worker:${randomUUID()}`
    this.#claimTtlMs = options.claimTtlMs ?? 30_000
    this.#now = options.now ?? Date.now
    this.#createClaimToken = options.createClaimToken ?? randomUUID
    if (this.#workerId.length === 0 || this.#workerId.trim() !== this.#workerId) {
      throw new TypeError('workerId must be a non-empty, unpadded string')
    }
    if (!Number.isSafeInteger(this.#claimTtlMs) || this.#claimTtlMs <= 0) {
      throw new RangeError('claimTtlMs must be a positive safe integer')
    }
    this.#db = openWorldDatabase(path)
  }

  claimNext(): ClaimedOutboxDelivery | undefined {
    const now = this.#now()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#db.prepare(`
        SELECT o.delivery_id, o.session_id, o.payload_hash, o.payload_json, o.critical,
          o.attempt_count, o.session_delivery_seq
        FROM outbox o
        WHERE (o.delivery_status = 'pending'
          OR (o.delivery_status = 'inflight' AND (o.claim_token IS NULL OR o.claim_expires_at_ms <= ?)))
          AND NOT EXISTS (
            SELECT 1 FROM outbox earlier
            WHERE earlier.session_id = o.session_id
              AND (earlier.world_seq < o.world_seq OR (earlier.world_seq = o.world_seq AND earlier.delivery_id < o.delivery_id))
              AND (earlier.delivery_status IN ('pending', 'inflight')
                OR (earlier.delivery_status = 'dead_letter' AND earlier.critical = 1))
          )
        ORDER BY o.world_seq, o.delivery_id LIMIT 1
      `).get(now) as {
        delivery_id: DeliveryId
        session_id: SessionId
        payload_hash: WorldHash
        payload_json: string
        critical: number
        attempt_count: number
        session_delivery_seq: number | null
      } | undefined
      if (row === undefined) {
        this.#db.exec('COMMIT')
        return undefined
      }
      let sequence = row.session_delivery_seq
      if (sequence === null) {
        this.#db.prepare(`
          INSERT INTO outbox_session_counters(session_id, next_delivery_seq) VALUES (?, 1)
          ON CONFLICT(session_id) DO NOTHING
        `).run(row.session_id)
        const counter = this.#db.prepare(`
          SELECT next_delivery_seq FROM outbox_session_counters WHERE session_id = ?
        `).get(row.session_id) as { next_delivery_seq: number }
        sequence = counter.next_delivery_seq
        this.#db.prepare(`UPDATE outbox_session_counters SET next_delivery_seq = ? WHERE session_id = ?`)
          .run(sequence + 1, row.session_id)
      }
      const attemptCount = row.attempt_count + 1
      const claimToken = `outbox-claim:${this.#createClaimToken()}`
      const claimExpiresAtMs = now + this.#claimTtlMs
      this.#db.prepare(`
        UPDATE outbox SET delivery_status = 'inflight', attempt_count = ?, session_delivery_seq = ?, last_error = NULL,
          claim_owner_id = ?, claim_token = ?, claim_expires_at_ms = ?
        WHERE delivery_id = ? AND (delivery_status = 'pending'
          OR (delivery_status = 'inflight' AND (claim_token IS NULL OR claim_expires_at_ms <= ?)))
      `).run(
        attemptCount,
        sequence,
        this.#workerId,
        claimToken,
        claimExpiresAtMs,
        row.delivery_id,
        now,
      )
      this.#db.exec('COMMIT')
      return {
        deliveryId: row.delivery_id,
        sessionId: row.session_id,
        sessionDeliverySeq: sequence,
        payloadHash: row.payload_hash,
        payload: parseWorldJson(row.payload_json),
        critical: row.critical === 1,
        attemptCount,
        claimOwnerId: this.#workerId,
        claimToken,
        claimExpiresAtMs,
      }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  async recordDelivered(delivery: ClaimedOutboxDelivery): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#db.prepare(`
        UPDATE outbox SET delivery_status = 'delivered', last_error = NULL,
          claim_owner_id = NULL, claim_token = NULL, claim_expires_at_ms = NULL
        WHERE delivery_id = ? AND session_id = ? AND session_delivery_seq = ? AND payload_hash = ?
          AND delivery_status = 'inflight' AND attempt_count = ? AND claim_owner_id = ? AND claim_token = ?
      `).run(
        delivery.deliveryId,
        delivery.sessionId,
        delivery.sessionDeliverySeq,
        delivery.payloadHash,
        delivery.attemptCount,
        delivery.claimOwnerId,
        delivery.claimToken,
      )
      if (result.changes !== 1) throw new Error('Outbox delivery claim is stale or does not match the claimed item')
      this.#db.prepare(`
        INSERT INTO outbox_delivery_receipts(delivery_id, session_id, session_delivery_seq, payload_hash)
        VALUES (?, ?, ?, ?)
      `).run(delivery.deliveryId, delivery.sessionId, delivery.sessionDeliverySeq, delivery.payloadHash)
      this.faultInjector?.hit('outbox.before-receipt-commit')
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
    this.faultInjector?.hit('outbox.after-receipt-commit')
  }

  recordFailed(delivery: ClaimedOutboxDelivery, message: string, maxAttempts: number): 'retry_scheduled' | 'dead_letter' {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new RangeError('maxAttempts must be a positive safe integer')
    const status = delivery.attemptCount >= maxAttempts ? 'dead_letter' : 'pending'
    const result = this.#db.prepare(`
      UPDATE outbox SET delivery_status = ?, last_error = ?,
        claim_owner_id = NULL, claim_token = NULL, claim_expires_at_ms = NULL
      WHERE delivery_id = ? AND delivery_status = 'inflight' AND attempt_count = ?
        AND claim_owner_id = ? AND claim_token = ?
    `).run(
      status,
      message,
      delivery.deliveryId,
      delivery.attemptCount,
      delivery.claimOwnerId,
      delivery.claimToken,
    )
    if (result.changes !== 1) throw new Error('Outbox delivery claim is stale')
    return status === 'dead_letter' ? 'dead_letter' : 'retry_scheduled'
  }

  deadLetters(): DeadLetterRecord[] {
    const rows = this.#db.prepare(`
      SELECT delivery_id, session_id, session_delivery_seq, payload_hash, payload_json, critical, attempt_count, last_error
      FROM outbox WHERE delivery_status = 'dead_letter' ORDER BY world_seq, delivery_id
    `).all() as Array<{
      delivery_id: DeliveryId
      session_id: SessionId
      session_delivery_seq: number
      payload_hash: WorldHash
      payload_json: string
      critical: number
      attempt_count: number
      last_error: string
    }>
    return rows.map(row => ({
      deliveryId: row.delivery_id,
      sessionId: row.session_id,
      sessionDeliverySeq: row.session_delivery_seq,
      payloadHash: row.payload_hash,
      payload: parseWorldJson(row.payload_json),
      critical: row.critical === 1,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
    }))
  }

  retryDeadLetter(deliveryId: DeliveryId): void {
    const result = this.#db.prepare(`
      UPDATE outbox SET delivery_status = 'pending', last_error = NULL,
        claim_owner_id = NULL, claim_token = NULL, claim_expires_at_ms = NULL
      WHERE delivery_id = ? AND delivery_status = 'dead_letter'
    `).run(deliveryId)
    if (result.changes !== 1) throw new Error('Outbox item is not a dead letter')
  }

  hasReceipt(deliveryId: DeliveryId): boolean {
    return this.#db.prepare(`SELECT 1 AS present FROM outbox_delivery_receipts WHERE delivery_id = ?`).get(deliveryId) !== undefined
  }

  close(): void {
    this.#db.close()
  }
}

export type OutboxWorkerResult =
  | { readonly status: 'idle' }
  | { readonly status: 'delivered'; readonly deliveryId: DeliveryId }
  | { readonly status: 'retry_scheduled' | 'dead_letter'; readonly deliveryId: DeliveryId }

/** One-step worker; the host controls scheduling and parallelism across Sessions. */
export class SessionOutboxWorker {
  constructor(
    private readonly outbox: WorldOutbox,
    private readonly session: SessionDeliveryPort,
    private readonly maxAttempts = 3,
  ) {}

  async runOnce(correlationId = 'outbox-worker'): Promise<OutboxWorkerResult> {
    const delivery = this.outbox.claimNext()
    if (delivery === undefined) return { status: 'idle' }
    try {
      await this.session.appendIfAbsent({
        sessionId: delivery.sessionId,
        sessionDeliverySeq: delivery.sessionDeliverySeq,
        deliveryId: delivery.deliveryId,
        payloadHash: delivery.payloadHash,
        observationEvent: delivery.payload,
        correlationId,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown Session delivery failure'
      const status = this.outbox.recordFailed(delivery, message, this.maxAttempts)
      return { status, deliveryId: delivery.deliveryId }
    }
    await this.outbox.recordDelivered(delivery)
    return { status: 'delivered', deliveryId: delivery.deliveryId }
  }
}
