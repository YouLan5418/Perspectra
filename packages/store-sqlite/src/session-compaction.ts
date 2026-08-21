import type { DatabaseSync } from 'node:sqlite'
import {
  deterministicId,
  hashWorldJson,
  type SessionId,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { openSessionDatabase } from './session-delivery.ts'
import { parseWorldJson, worldJsonText } from './sqlite.ts'

export interface SessionSummary extends WorldJsonObject {
  readonly summaryVersion: 1
  readonly summaryId: string
  readonly sessionId: SessionId
  readonly sourceDeliveryRange: { readonly from: number; readonly to: number }
  readonly observationIds: readonly string[]
  readonly minWorldSeq: number | null
  readonly maxWorldSeq: number | null
  readonly contentHash: WorldHash
}

/** Builds deterministic Session context summaries without deleting or rewriting source events. */
export class SessionCompactor {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openSessionDatabase(path)
  }

  compact(sessionId: SessionId, fromDeliverySeq: number, toDeliverySeq: number): SessionSummary {
    if (!Number.isSafeInteger(fromDeliverySeq) || fromDeliverySeq < 1
      || !Number.isSafeInteger(toDeliverySeq) || toDeliverySeq < fromDeliverySeq) {
      throw new RangeError('Session compaction requires a valid positive delivery range')
    }
    const rows = this.#db.prepare(`
      SELECT session_event_seq, payload_hash, payload_json FROM session_events
      WHERE session_id = ? AND session_event_seq BETWEEN ? AND ? ORDER BY session_event_seq
    `).all(sessionId, fromDeliverySeq, toDeliverySeq) as Array<{
      session_event_seq: number
      payload_hash: WorldHash
      payload_json: string
    }>
    if (rows.length !== toDeliverySeq - fromDeliverySeq + 1) throw new Error('Session compaction range is not contiguous and complete')
    const payloads = rows.map(row => parseWorldJson(row.payload_json))
    const objects = payloads.map(value => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as WorldJsonObject : undefined)
    const observationIds = objects
      .map(value => value?.observationId)
      .filter((value): value is string => typeof value === 'string')
    const worldSeqs = objects
      .map(value => value?.worldSeq)
      .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    const contentHash = hashWorldJson('session-compaction-content', {
      sessionId,
      sourceDeliveryRange: { from: fromDeliverySeq, to: toDeliverySeq },
      payloadHashes: rows.map(row => row.payload_hash),
      observationIds,
      worldSeqs,
    })
    const summaryId = deterministicId('session-summary', { sessionId, fromDeliverySeq, toDeliverySeq, contentHash })
    const summary: SessionSummary = {
      summaryVersion: 1,
      summaryId,
      sessionId,
      sourceDeliveryRange: { from: fromDeliverySeq, to: toDeliverySeq },
      observationIds,
      minWorldSeq: worldSeqs.length === 0 ? null : Math.min(...worldSeqs),
      maxWorldSeq: worldSeqs.length === 0 ? null : Math.max(...worldSeqs),
      contentHash,
    }
    const existing = this.#db.prepare(`
      SELECT content_hash, summary_json FROM session_summaries
      WHERE session_id = ? AND from_delivery_seq = ? AND to_delivery_seq = ?
    `).get(sessionId, fromDeliverySeq, toDeliverySeq) as { content_hash: WorldHash; summary_json: string } | undefined
    if (existing !== undefined) {
      if (existing.content_hash !== contentHash || existing.summary_json !== worldJsonText(summary)) {
        throw new Error('Session summary range is bound to different content')
      }
      return parseWorldJson(existing.summary_json) as SessionSummary
    }
    this.#db.prepare(`
      INSERT INTO session_summaries(session_id, summary_id, from_delivery_seq, to_delivery_seq, content_hash, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, summaryId, fromDeliverySeq, toDeliverySeq, contentHash, worldJsonText(summary))
    return summary
  }

  readSummaries(sessionId: SessionId): SessionSummary[] {
    const rows = this.#db.prepare(`
      SELECT summary_json FROM session_summaries WHERE session_id = ? ORDER BY from_delivery_seq
    `).all(sessionId) as Array<{ summary_json: string }>
    return rows.map(row => parseWorldJson(row.summary_json) as SessionSummary)
  }

  close(): void {
    this.#db.close()
  }
}
