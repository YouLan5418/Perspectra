import type { DatabaseSync } from 'node:sqlite'
import {
  failWorld,
  type AppendDeliveryRequest,
  type AppendDeliveryResult,
  type FaultInjector,
  type SessionId,
  type WorldHash,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  openMigratedDatabase,
  parseWorldJson,
  rollbackAndThrow,
  SESSION_APPLICATION_ID,
  worldJsonText,
} from './sqlite.ts'

export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_delivery_cursor (
  session_id TEXT PRIMARY KEY,
  last_delivery_seq INTEGER NOT NULL CHECK(last_delivery_seq >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS session_delivery_inbox (
  session_id TEXT NOT NULL,
  session_delivery_seq INTEGER NOT NULL CHECK(session_delivery_seq > 0),
  delivery_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, session_delivery_seq)
) STRICT;
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  session_event_seq INTEGER NOT NULL CHECK(session_event_seq > 0),
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, session_event_seq),
  FOREIGN KEY (session_id, session_event_seq)
    REFERENCES session_delivery_inbox(session_id, session_delivery_seq)
) STRICT;
`

const SESSION_COMPACTION_SCHEMA = `
CREATE TABLE session_summaries (
  session_id TEXT NOT NULL,
  summary_id TEXT NOT NULL,
  from_delivery_seq INTEGER NOT NULL CHECK(from_delivery_seq > 0),
  to_delivery_seq INTEGER NOT NULL CHECK(to_delivery_seq >= from_delivery_seq),
  content_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY(session_id, summary_id),
  UNIQUE(session_id, from_delivery_seq, to_delivery_seq)
) STRICT;
`

export const SESSION_SCHEMA_VERSION = 2

export function openSessionDatabase(path: string): DatabaseSync {
  return openMigratedDatabase(path, SESSION_APPLICATION_ID, [
    { version: 1, sql: SESSION_SCHEMA },
    { version: SESSION_SCHEMA_VERSION, sql: SESSION_COMPACTION_SCHEMA },
  ])
}

interface InboxRow {
  readonly delivery_id: string
  readonly payload_hash: string
}
/** SQLite consumer-side adapter for atomic, idempotent Observation delivery. */
export class SessionDeliveryAdapter {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly faultInjector?: FaultInjector) {
    this.#db = openSessionDatabase(path)
  }

  /** Atomically claim a delivery, append its Observation, and advance the cursor. */
  async appendIfAbsent(request: AppendDeliveryRequest): Promise<AppendDeliveryResult> {
    if (!Number.isSafeInteger(request.sessionDeliverySeq) || request.sessionDeliverySeq < 1) {
      failWorld({
        errorCode: 'INVALID_REQUEST',
        category: 'admission',
        message: 'sessionDeliverySeq must be a positive safe integer',
        retryable: false,
        correlationId: request.correlationId,
      })
    }
    const payloadText = worldJsonText(request.observationEvent)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const sameSequence = this.#db.prepare(`
        SELECT delivery_id, payload_hash
        FROM session_delivery_inbox
        WHERE session_id = ? AND session_delivery_seq = ?
      `).get(request.sessionId, request.sessionDeliverySeq) as InboxRow | undefined
      if (sameSequence !== undefined) {
        if (sameSequence.delivery_id === request.deliveryId && sameSequence.payload_hash === request.payloadHash) {
          this.#db.exec('COMMIT')
          return { status: 'already_applied', cursor: request.sessionDeliverySeq }
        }
        this.#diverged(request, 'the delivery sequence already contains different content')
      }

      const sameDelivery = this.#db.prepare(`
        SELECT session_id, session_delivery_seq, payload_hash
        FROM session_delivery_inbox WHERE delivery_id = ?
      `).get(request.deliveryId) as Record<string, unknown> | undefined
      if (sameDelivery !== undefined) this.#diverged(request, 'the delivery id is already bound to another sequence or session')

      const cursorRow = this.#db.prepare(`
        SELECT last_delivery_seq FROM session_delivery_cursor WHERE session_id = ?
      `).get(request.sessionId) as { last_delivery_seq: number } | undefined
      const cursor = cursorRow?.last_delivery_seq ?? 0
      if (request.sessionDeliverySeq !== cursor + 1) {
        failWorld({
          errorCode: 'SESSION_DELIVERY_OUT_OF_ORDER',
          category: 'persistence',
          message: `expected session delivery ${cursor + 1}, got ${request.sessionDeliverySeq}`,
          retryable: true,
          correlationId: request.correlationId,
          details: { sessionId: request.sessionId, cursor },
        })
      }

      this.#db.prepare(`
        INSERT INTO session_delivery_inbox(session_id, session_delivery_seq, delivery_id, payload_hash)
        VALUES (?, ?, ?, ?)
      `).run(request.sessionId, request.sessionDeliverySeq, request.deliveryId, request.payloadHash)
      await this.faultInjector?.hit('session-delivery.after-inbox-insert')

      this.#db.prepare(`
        INSERT INTO session_events(session_id, session_event_seq, event_type, payload_hash, payload_json)
        VALUES (?, ?, 'world/observation', ?, ?)
      `).run(request.sessionId, request.sessionDeliverySeq, request.payloadHash, payloadText)
      await this.faultInjector?.hit('session-delivery.after-observation-append')

      this.#db.prepare(`
        INSERT INTO session_delivery_cursor(session_id, last_delivery_seq) VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET last_delivery_seq = excluded.last_delivery_seq
      `).run(request.sessionId, request.sessionDeliverySeq)
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
    await this.faultInjector?.hit('session-delivery.after-commit')
    return { status: 'applied', cursor: request.sessionDeliverySeq }
  }

  /** Read a delivered Observation for recovery assertions and future Session bridges. */
  readEvent(sessionId: SessionId, sequence: number): { readonly payloadHash: WorldHash; readonly payload: WorldJsonValue } | undefined {
    const row = this.#db.prepare(`
      SELECT payload_hash, payload_json FROM session_events
      WHERE session_id = ? AND session_event_seq = ?
    `).get(sessionId, sequence) as { payload_hash: WorldHash; payload_json: string } | undefined
    return row === undefined ? undefined : { payloadHash: row.payload_hash, payload: parseWorldJson(row.payload_json) }
  }

  /** Return the last atomically applied delivery sequence. */
  cursor(sessionId: SessionId): number {
    const row = this.#db.prepare(`
      SELECT last_delivery_seq FROM session_delivery_cursor WHERE session_id = ?
    `).get(sessionId) as { last_delivery_seq: number } | undefined
    return row?.last_delivery_seq ?? 0
  }

  close(): void {
    this.#db.close()
  }

  #diverged(request: AppendDeliveryRequest, message: string): never {
    failWorld({
      errorCode: 'SESSION_DELIVERY_DIVERGED',
      category: 'integrity',
      message,
      retryable: false,
      correlationId: request.correlationId,
      details: { sessionId: request.sessionId, sessionDeliverySeq: request.sessionDeliverySeq },
    })
  }
}
