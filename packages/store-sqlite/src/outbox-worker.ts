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
}

export interface DeadLetterRecord extends ClaimedOutboxDelivery {
  readonly lastError: string
}

export interface SessionDeliveryPort {
  appendIfAbsent(request: AppendDeliveryRequest): Promise<AppendDeliveryResult>
}

/** Sender-side durable Outbox state and Receipt owner. */
export class WorldOutbox {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly faultInjector?: FaultInjector) {
    this.#db = openWorldDatabase(path)
  }

  claimNext(): ClaimedOutboxDelivery | undefined {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#db.prepare(`
        SELECT o.delivery_id, o.session_id, o.payload_hash, o.payload_json, o.critical,
          o.attempt_count, o.session_delivery_seq
        FROM outbox o
        WHERE o.delivery_status IN ('pending', 'inflight')
          AND NOT EXISTS (
            SELECT 1 FROM outbox earlier
            WHERE earlier.session_id = o.session_id
              AND (earlier.world_seq < o.world_seq OR (earlier.world_seq = o.world_seq AND earlier.delivery_id < o.delivery_id))
              AND (earlier.delivery_status IN ('pending', 'inflight')
                OR (earlier.delivery_status = 'dead_letter' AND earlier.critical = 1))
          )
        ORDER BY o.world_seq, o.delivery_id LIMIT 1
      `).get() as {
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
      this.#db.prepare(`
        UPDATE outbox SET delivery_status = 'inflight', attempt_count = ?, session_delivery_seq = ?, last_error = NULL
        WHERE delivery_id = ?
      `).run(attemptCount, sequence, row.delivery_id)
      this.#db.exec('COMMIT')
      return {
        deliveryId: row.delivery_id,
        sessionId: row.session_id,
        sessionDeliverySeq: sequence,
        payloadHash: row.payload_hash,
        payload: parseWorldJson(row.payload_json),
        critical: row.critical === 1,
        attemptCount,
      }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  async recordDelivered(delivery: ClaimedOutboxDelivery): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`
        INSERT INTO outbox_delivery_receipts(delivery_id, session_id, session_delivery_seq, payload_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(delivery_id) DO NOTHING
      `).run(delivery.deliveryId, delivery.sessionId, delivery.sessionDeliverySeq, delivery.payloadHash)
      const result = this.#db.prepare(`
        UPDATE outbox SET delivery_status = 'delivered', last_error = NULL
        WHERE delivery_id = ? AND session_id = ? AND session_delivery_seq = ? AND payload_hash = ?
      `).run(delivery.deliveryId, delivery.sessionId, delivery.sessionDeliverySeq, delivery.payloadHash)
      if (result.changes !== 1) throw new Error('Outbox delivery receipt does not match the claimed item')
      await this.faultInjector?.hit('outbox.before-receipt-commit')
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
    await this.faultInjector?.hit('outbox.after-receipt-commit')
  }

  recordFailed(deliveryId: DeliveryId, message: string, maxAttempts: number): 'retry_scheduled' | 'dead_letter' {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new RangeError('maxAttempts must be a positive safe integer')
    const row = this.#db.prepare(`
      SELECT attempt_count FROM outbox WHERE delivery_id = ? AND delivery_status = 'inflight'
    `).get(deliveryId) as { attempt_count: number } | undefined
    if (row === undefined) throw new Error('Outbox item is not inflight')
    const status = row.attempt_count >= maxAttempts ? 'dead_letter' : 'pending'
    this.#db.prepare(`UPDATE outbox SET delivery_status = ?, last_error = ? WHERE delivery_id = ?`)
      .run(status, message, deliveryId)
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
      UPDATE outbox SET delivery_status = 'pending', last_error = NULL WHERE delivery_id = ? AND delivery_status = 'dead_letter'
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
      const status = this.outbox.recordFailed(delivery.deliveryId, message, this.maxAttempts)
      return { status, deliveryId: delivery.deliveryId }
    }
    await this.outbox.recordDelivered(delivery)
    return { status: 'delivered', deliveryId: delivery.deliveryId }
  }
}
