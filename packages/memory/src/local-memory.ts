import type { DatabaseSync } from 'node:sqlite'
import {
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type CharacterId,
  type CharacterView,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openOwnedDatabase, parseWorldJson, rollbackAndThrow, worldJsonText } from '@harness-world/store-sqlite'

const MEMORY_APPLICATION_ID = 0x4843574c
const MEMORY_SCHEMA = `
CREATE TABLE memory_source_mappings (
  namespace_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, source_kind, source_id)
) STRICT;
CREATE TABLE memory_entries (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  text_value TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  capture_hash TEXT NOT NULL,
  source_max_seq INTEGER NOT NULL CHECK(source_max_seq >= 0),
  forgotten_seq INTEGER CHECK(forgotten_seq >= source_max_seq),
  PRIMARY KEY(namespace_key, memory_id)
) STRICT;
CREATE TABLE memory_sources (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, memory_id, source_kind, source_id),
  FOREIGN KEY(namespace_key, memory_id) REFERENCES memory_entries(namespace_key, memory_id)
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(namespace_key UNINDEXED, memory_id UNINDEXED, text_value);
`

export const TENCENTDB_MEMORY_ENABLED = false

export type MemorySourceKind = 'observation' | 'claim' | 'summary'

export interface MemorySourceRef extends WorldJsonObject {
  readonly sourceKind: MemorySourceKind
  readonly sourceId: string
  readonly sourceSeq: number
  readonly sourceHash: WorldHash
}

export interface CaptureMemoryRequest {
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly memoryId: string
  readonly text: string
  readonly metadata: WorldJsonValue
  readonly sources: readonly MemorySourceRef[]
  readonly asOfWorldSeq: number
  readonly correlationId: string
}

export interface RecalledMemory extends WorldJsonObject {
  readonly memoryId: string
  readonly text: string
  readonly metadata: WorldJsonValue
  readonly sourceMaxSeq: number
  readonly captureHash: WorldHash
}

function namespace(address: WorldAddress, characterId: CharacterId): string {
  return `${worldAddressKey(address)}\u001f${characterId}`
}

function sourceHash(kind: 'observation' | 'claim', record: CharacterView['observations'][number]): WorldHash {
  return hashWorldJson(`memory-source/${kind}`, record)
}

/** Local FTS5 memory with mandatory character/branch namespace and source closure checks. */
export class LocalMemoryStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openOwnedDatabase(path, MEMORY_APPLICATION_ID, MEMORY_SCHEMA)
  }

  reconcile(view: CharacterView): number {
    const key = namespace(view.address, view.characterId)
    const sources = [
      ...view.observations.map(record => ({ kind: 'observation' as const, record })),
      ...view.claims.map(record => ({ kind: 'claim' as const, record })),
    ]
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const source of sources) {
        this.#db.prepare(`
          INSERT INTO memory_source_mappings(namespace_key, source_kind, source_id, source_seq, source_hash)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(namespace_key, source_kind, source_id) DO UPDATE SET
            source_seq = excluded.source_seq, source_hash = excluded.source_hash
        `).run(key, source.kind, source.record.id, source.record.sourceSeq, sourceHash(source.kind, source.record))
      }
      this.#db.exec('COMMIT')
      return sources.length
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  capture(request: CaptureMemoryRequest): 'captured' | 'already_captured' {
    this.#validateCapture(request)
    const key = namespace(request.address, request.characterId)
    const sortedSources = [...request.sources].sort((left, right) => left.sourceKind.localeCompare(right.sourceKind) || left.sourceId.localeCompare(right.sourceId))
    const captureHash = hashWorldJson('local-memory-capture', {
      namespace: key,
      memoryId: request.memoryId,
      text: request.text,
      metadata: request.metadata,
      sources: sortedSources,
    })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db.prepare(`
        SELECT capture_hash FROM memory_entries WHERE namespace_key = ? AND memory_id = ?
      `).get(key, request.memoryId) as { capture_hash: WorldHash } | undefined
      if (existing !== undefined) {
        if (existing.capture_hash !== captureHash) this.#unverified(request, 'memoryId is already bound to different content')
        this.#db.exec('COMMIT')
        return 'already_captured'
      }
      for (const source of sortedSources) {
        if (source.sourceKind === 'summary') this.#unverified(request, 'Session Summary cannot be a Memory source')
        const mapping = this.#db.prepare(`
          SELECT source_seq, source_hash FROM memory_source_mappings
          WHERE namespace_key = ? AND source_kind = ? AND source_id = ?
        `).get(key, source.sourceKind, source.sourceId) as { source_seq: number; source_hash: WorldHash } | undefined
        if (mapping === undefined || mapping.source_seq !== source.sourceSeq || mapping.source_hash !== source.sourceHash) {
          this.#unverified(request, 'Memory source mapping is missing or divergent')
        }
        if (source.sourceSeq > request.asOfWorldSeq) this.#unverified(request, 'Memory source is later than asOfWorldSeq')
      }
      const sourceMaxSeq = Math.max(...sortedSources.map(source => source.sourceSeq))
      this.#db.prepare(`
        INSERT INTO memory_entries(namespace_key, memory_id, text_value, metadata_json, capture_hash, source_max_seq, forgotten_seq)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(key, request.memoryId, request.text, worldJsonText(request.metadata), captureHash, sourceMaxSeq)
      for (const source of sortedSources) {
        this.#db.prepare(`
          INSERT INTO memory_sources(namespace_key, memory_id, source_kind, source_id, source_seq, source_hash)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(key, request.memoryId, source.sourceKind, source.sourceId, source.sourceSeq, source.sourceHash)
      }
      this.#db.prepare(`INSERT INTO memory_fts(namespace_key, memory_id, text_value) VALUES (?, ?, ?)`)
        .run(key, request.memoryId, request.text)
      this.#db.exec('COMMIT')
      return 'captured'
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  recall(address: WorldAddress, characterId: CharacterId, query: string, asOfWorldSeq: number, limit = 10): RecalledMemory[] {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be a positive safe integer')
    const terms = query.trim().split(/\s+/u).filter(Boolean).map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    if (terms.length === 0) return []
    const key = namespace(address, characterId)
    const rows = this.#db.prepare(`
      SELECT e.memory_id, e.text_value, e.metadata_json, e.source_max_seq, e.capture_hash
      FROM memory_fts f JOIN memory_entries e
        ON e.namespace_key = f.namespace_key AND e.memory_id = f.memory_id
      WHERE memory_fts MATCH ? AND e.namespace_key = ?
        AND e.source_max_seq <= ?
        AND (e.forgotten_seq IS NULL OR e.forgotten_seq > ?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_sources s
          LEFT JOIN memory_source_mappings m
            ON m.namespace_key = s.namespace_key AND m.source_kind = s.source_kind AND m.source_id = s.source_id
          WHERE s.namespace_key = e.namespace_key AND s.memory_id = e.memory_id
            AND (m.source_id IS NULL OR m.source_seq != s.source_seq OR m.source_hash != s.source_hash OR s.source_seq > ?)
        )
      ORDER BY bm25(memory_fts), e.memory_id LIMIT ?
    `).all(terms, key, asOfWorldSeq, asOfWorldSeq, asOfWorldSeq, limit) as Array<{
      memory_id: string
      text_value: string
      metadata_json: string
      source_max_seq: number
      capture_hash: WorldHash
    }>
    return rows.map(row => ({
      memoryId: row.memory_id,
      text: row.text_value,
      metadata: parseWorldJson(row.metadata_json),
      sourceMaxSeq: row.source_max_seq,
      captureHash: row.capture_hash,
    }))
  }

  forget(address: WorldAddress, characterId: CharacterId, memoryId: string, atWorldSeq: number): void {
    const result = this.#db.prepare(`
      UPDATE memory_entries SET forgotten_seq = ?
      WHERE namespace_key = ? AND memory_id = ? AND source_max_seq <= ?
    `).run(atWorldSeq, namespace(address, characterId), memoryId, atWorldSeq)
    if (result.changes !== 1) throw new Error('Memory cannot be forgotten before its sources exist or it is missing')
  }

  close(): void {
    this.#db.close()
  }

  #validateCapture(request: CaptureMemoryRequest): void {
    if (request.memoryId.length === 0 || request.memoryId.trim() !== request.memoryId) throw new TypeError('memoryId must be a non-empty string')
    if (request.text.length === 0) throw new TypeError('Memory text cannot be empty')
    if (request.sources.length === 0) this.#unverified(request, 'Memory capture requires committed sources')
    if (!Number.isSafeInteger(request.asOfWorldSeq) || request.asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
  }

  #unverified(request: CaptureMemoryRequest, message: string): never {
    failWorld({
      errorCode: 'MEMORY_SOURCE_UNVERIFIED',
      category: 'integrity',
      message,
      retryable: false,
      correlationId: request.correlationId,
      address: request.address,
    })
  }
}
