import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type CognitiveEpistemicKind,
  type CognitiveMemoryEntry,
  type CognitiveMemoryKind,
  type CognitiveMemoryReceipt,
  type CognitiveMemoryWatermark,
  type CognitiveRecallResult,
  type CharacterId,
  type CharacterView,
  type ContextSourceRef,
  type ExtractiveL1Summary,
  type RecallQueryPlan,
  type RecallReceipt,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  CognitionProjectionRebuilder,
  CharacterViewBuilder,
  openMigratedDatabase,
  parseWorldJson,
  rollbackAndThrow,
  type WorldStore,
  worldJsonText,
} from '@harness-world/store-sqlite'

const MEMORY_APPLICATION_ID = 0x4843574c
const MEMORY_SCHEMA = `
CREATE TABLE memory_source_mappings (
  namespace_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
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
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, memory_id, source_kind, source_id),
  FOREIGN KEY(namespace_key, memory_id) REFERENCES memory_entries(namespace_key, memory_id)
) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(namespace_key UNINDEXED, memory_id UNINDEXED, text_value);
`

const MEMORY_RECONCILE_SCHEMA = `
CREATE TABLE memory_namespace_watermarks (
  namespace_key TEXT PRIMARY KEY,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  bundle_hash TEXT NOT NULL
) STRICT;
`

const MEMORY_COGNITIVE_JOB_SCHEMA = `
CREATE TABLE cognitive_jobs (
  namespace_key TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  job_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  last_error TEXT,
  PRIMARY KEY(namespace_key, as_of_seq)
) STRICT;
`

const MEMORY_GOAL_SOURCE_SCHEMA = `
ALTER TABLE memory_source_mappings RENAME TO memory_source_mappings_v3;
CREATE TABLE memory_source_mappings (
  namespace_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, source_kind, source_id)
) STRICT;
INSERT INTO memory_source_mappings SELECT * FROM memory_source_mappings_v3;
DROP TABLE memory_source_mappings_v3;
ALTER TABLE memory_sources RENAME TO memory_sources_v3;
CREATE TABLE memory_sources (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('observation', 'claim', 'goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, memory_id, source_kind, source_id),
  FOREIGN KEY(namespace_key, memory_id) REFERENCES memory_entries(namespace_key, memory_id)
) STRICT;
INSERT INTO memory_sources SELECT * FROM memory_sources_v3;
DROP TABLE memory_sources_v3;
`

const MEMORY_COGNITIVE_V2_SCHEMA = `
CREATE TABLE cognitive_memory_v2_namespaces (
  namespace_key TEXT PRIMARY KEY,
  verified_through_seq INTEGER NOT NULL CHECK(verified_through_seq >= 0),
  captured_through_seq INTEGER NOT NULL CHECK(captured_through_seq >= 0),
  memory_epoch INTEGER NOT NULL CHECK(memory_epoch >= 1),
  source_map_hash TEXT NOT NULL,
  source_bundle_hash TEXT NOT NULL
) STRICT;
CREATE TABLE cognitive_memory_v2_sources (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('observation', 'subjective_claim', 'character_goal')),
  source_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  source_hash TEXT NOT NULL,
  memory_kind TEXT NOT NULL CHECK(memory_kind IN ('episodic', 'communication', 'belief', 'intention')),
  epistemic_kind TEXT NOT NULL CHECK(epistemic_kind IN (
    'direct_observation', 'observed_action', 'reported_speech', 'subjective_inference', 'self_intention'
  )),
  text_value TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  capture_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, source_id),
  UNIQUE(namespace_key, memory_id)
) STRICT;
CREATE VIRTUAL TABLE cognitive_memory_v2_fts USING fts5(namespace_key UNINDEXED, memory_id UNINDEXED, text_value);
CREATE TABLE cognitive_memory_v2_summaries (
  namespace_key TEXT NOT NULL,
  summary_id TEXT NOT NULL,
  source_start_seq INTEGER NOT NULL CHECK(source_start_seq >= 0),
  source_end_seq INTEGER NOT NULL CHECK(source_end_seq >= source_start_seq),
  source_refs_json TEXT NOT NULL,
  extracts_json TEXT NOT NULL,
  summary_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, summary_id)
) STRICT;
CREATE TABLE cognitive_memory_v2_receipts (
  receipt_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  required_as_of_seq INTEGER NOT NULL CHECK(required_as_of_seq >= 0),
  receipt_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
CREATE TABLE cognitive_memory_v2_recall_receipts (
  receipt_id TEXT PRIMARY KEY,
  namespace_key TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  receipt_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
`

export const MEMORY_SCHEMA_VERSION = 5

export const TENCENTDB_MEMORY_ENABLED = false

export type MemorySourceKind = 'observation' | 'claim' | 'goal' | 'summary' | 'world_event'

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

export interface ReconcileMemoryRequest {
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly correlationId: string
}

function namespace(address: WorldAddress, characterId: CharacterId): string {
  return `${worldAddressKey(address)}\u001f${characterId}`
}

function sourceHash(kind: 'observation' | 'claim' | 'goal', record: CharacterView['observations'][number]): WorldHash {
  return hashWorldJson(`memory-source/${kind}`, record)
}

export function memorySourceRef(
  kind: 'observation' | 'claim' | 'goal',
  record: CharacterView['observations'][number],
): MemorySourceRef {
  return { sourceKind: kind, sourceId: record.id, sourceSeq: record.sourceSeq, sourceHash: sourceHash(kind, record) }
}

export interface CognitiveJobRecord extends WorldJsonObject {
  readonly asOfWorldSeq: number
  readonly status: 'pending' | 'completed' | 'failed'
  readonly attemptCount: number
  readonly lastError: string | null
  readonly jobHash: WorldHash
}

interface CognitiveSourceCandidate {
  readonly sourceType: 'observation' | 'subjective_claim' | 'character_goal'
  readonly sourceRef: ContextSourceRef
  readonly memoryKind: CognitiveMemoryKind
  readonly epistemicKind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
  readonly text: string
  readonly metadata: WorldJsonValue
}

const EPISODIC_OBSERVATION_KINDS = new Set<CognitiveEpistemicKind>([
  'direct_observation',
  'observed_action',
  'subjective_inference',
  'self_intention',
])

function objectValue(value: WorldJsonValue, path: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as WorldJsonObject
}

function canonicalText(value: WorldJsonValue): string {
  return typeof value === 'string' ? value : Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function orderedSources(values: readonly CognitiveSourceCandidate[]): CognitiveSourceCandidate[] {
  // One authoritative World Event can produce at most one captured record for one character.
  return [...values].sort((left, right) => left.sourceRef.sourceSeq - right.sourceRef.sourceSeq)
}

/** Local FTS5 memory with mandatory character/branch namespace and source closure checks. */
export class LocalMemoryStore {
  readonly #db: DatabaseSync
  readonly #viewBuilder: CharacterViewBuilder
  readonly #worldStore: WorldStore

  constructor(path: string, worldStore: WorldStore) {
    this.#db = openMigratedDatabase(path, MEMORY_APPLICATION_ID, [
      { version: 1, sql: MEMORY_SCHEMA },
      { version: 2, sql: MEMORY_RECONCILE_SCHEMA },
      { version: 3, sql: MEMORY_COGNITIVE_JOB_SCHEMA },
      { version: 4, sql: MEMORY_GOAL_SOURCE_SCHEMA },
      { version: MEMORY_SCHEMA_VERSION, sql: MEMORY_COGNITIVE_V2_SCHEMA },
    ])
    this.#worldStore = worldStore
    this.#viewBuilder = new CharacterViewBuilder(worldStore)
  }

  /** Rebuild, verify, capture, summarize, and receipt one Phase 8 character namespace at an exact World prefix. */
  catchUpV2(
    address: WorldAddress,
    characterId: CharacterId,
    requiredAsOfSeq: number,
    correlationId: string,
    heartbeat?: () => void,
  ): CognitiveMemoryReceipt {
    if (!Number.isSafeInteger(requiredAsOfSeq) || requiredAsOfSeq < 0) {
      throw new RangeError('requiredAsOfSeq must be a non-negative safe integer')
    }
    const characterView = this.#viewBuilder.rebuildAt(address, characterId, requiredAsOfSeq, heartbeat)
    const cognitionHistory = new CognitionProjectionRebuilder(this.#worldStore).historyAt(address, requiredAsOfSeq, heartbeat)
      .filter(record => record.characterId === characterId)
    const candidates = orderedSources([
      ...this.#observationCandidates(address, characterId, requiredAsOfSeq, correlationId, heartbeat),
      ...cognitionHistory.filter(record => record.kind === 'subjective-claim').map(record => ({
        sourceType: 'subjective_claim' as const,
        sourceRef: record.sourceRef,
        memoryKind: 'belief' as const,
        epistemicKind: 'subjective_inference' as const,
        text: canonicalText(objectValue(record.value, 'SubjectiveClaim').proposition as WorldJsonValue),
        metadata: { projectionId: record.id, stance: objectValue(record.value, 'SubjectiveClaim').stance as WorldJsonValue },
      })),
      ...cognitionHistory.filter(record => record.kind === 'character-goal').map(record => ({
        sourceType: 'character_goal' as const,
        sourceRef: record.sourceRef,
        memoryKind: 'intention' as const,
        epistemicKind: 'self_intention' as const,
        text: canonicalText(objectValue(record.value, 'CharacterGoal').objective as WorldJsonValue),
        metadata: { projectionId: record.id, status: objectValue(record.value, 'CharacterGoal').status as WorldJsonValue },
      })),
    ])
    const sourceRefs = candidates.map(candidate => candidate.sourceRef)
    const sourceMapHash = hashWorldJson('cognitive-memory-source-map/v2', { address, characterId, sourceRefs })
    const sourceBundleHash = hashWorldJson('cognitive-memory-source-bundle/v2', {
      characterViewHash: characterView.bundleHash,
      cognitionHistoryHash: hashWorldJson('cognitive-memory-cognition-history/v2', cognitionHistory),
      sourceMapHash,
    })
    const key = namespace(address, characterId)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#db.prepare(`
        SELECT verified_through_seq, captured_through_seq, memory_epoch, source_map_hash
        FROM cognitive_memory_v2_namespaces WHERE namespace_key = ?
      `).get(key) as {
        verified_through_seq: number
        captured_through_seq: number
        memory_epoch: number
        source_map_hash: WorldHash
      } | undefined
      if (current !== undefined && current.verified_through_seq > requiredAsOfSeq) {
        this.#unverifiedV2(address, correlationId, 'Cognitive Memory watermark cannot move backward')
      }
      if (current?.verified_through_seq === requiredAsOfSeq && current.source_map_hash !== sourceMapHash) {
        this.#unverifiedV2(address, correlationId, 'Cognitive Memory source map diverged at one watermark')
      }
      const memoryEpoch = current?.memory_epoch ?? 1
      for (const candidate of candidates) this.#captureV2Candidate(key, address, characterId, candidate, correlationId)
      const rows = this.#readV2Entries(key, requiredAsOfSeq)
      const summaries = this.#replaceV2Summaries(key, address, characterId, rows)
      const watermark: CognitiveMemoryWatermark = {
        schemaVersion: 'cognitive-memory-watermark/v2', address, characterId,
        verifiedThroughSeq: requiredAsOfSeq, capturedThroughSeq: requiredAsOfSeq,
        memoryEpoch, sourceMapHash,
      }
      this.#db.prepare(`
        INSERT INTO cognitive_memory_v2_namespaces(
          namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace_key) DO UPDATE SET
          verified_through_seq = excluded.verified_through_seq,
          captured_through_seq = excluded.captured_through_seq,
          source_map_hash = excluded.source_map_hash,
          source_bundle_hash = excluded.source_bundle_hash
      `).run(key, requiredAsOfSeq, requiredAsOfSeq, memoryEpoch, sourceMapHash, sourceBundleHash)
      const receiptId = deterministicId('cognitive-memory-receipt/v2', { address, characterId, requiredAsOfSeq, memoryEpoch })
      const receiptInput = {
        schemaVersion: 'cognitive-memory-receipt/v2' as const,
        receiptId, address, characterId, requiredAsOfSeq, watermark, sourceBundleHash,
        capturedMemoryIds: rows.map(row => row.memoryId),
        summaryIds: summaries.map(summary => summary.summaryId),
      }
      const receipt: CognitiveMemoryReceipt = {
        ...receiptInput,
        receiptHash: hashWorldJson('cognitive-memory-receipt/v2', receiptInput),
      }
      const existing = this.#db.prepare(`
        SELECT receipt_hash FROM cognitive_memory_v2_receipts WHERE receipt_id = ?
      `).get(receiptId) as { receipt_hash: WorldHash } | undefined
      if (existing !== undefined && existing.receipt_hash !== receipt.receiptHash) {
        this.#unverifiedV2(address, correlationId, 'Cognitive Memory receipt diverged for one identity')
      }
      this.#db.prepare(`
        INSERT OR IGNORE INTO cognitive_memory_v2_receipts(
          receipt_id, namespace_key, required_as_of_seq, receipt_hash, receipt_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(receiptId, key, requiredAsOfSeq, receipt.receiptHash, worldJsonText(receipt))
      this.#db.exec('COMMIT')
      heartbeat?.()
      return receipt
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Recall only from the Host-bound character namespace and persist the exact stable ranking receipt. */
  recallV2(plan: RecallQueryPlan): CognitiveRecallResult {
    if (!Number.isSafeInteger(plan.asOfWorldSeq) || plan.asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    if (!Number.isSafeInteger(plan.limit) || plan.limit <= 0) throw new RangeError('limit must be a positive safe integer')
    if (plan.rankingAlgorithm !== 'fts5-bm25-stable/v1') throw new TypeError('rankingAlgorithm is unsupported')
    const key = namespace(plan.address, plan.characterId)
    const watermark = this.cognitiveWatermark(plan.address, plan.characterId)
    if (watermark === undefined || watermark.verifiedThroughSeq < plan.asOfWorldSeq
      || watermark.capturedThroughSeq < plan.asOfWorldSeq) {
      failWorld({
        errorCode: 'MEMORY_CATCHUP_FAILED', category: 'runtime',
        message: 'Cognitive Memory has not reached the required as-of sequence', retryable: true,
        correlationId: `recall:${plan.planId}`, address: plan.address,
        details: { characterId: plan.characterId, requiredAsOfSeq: plan.asOfWorldSeq },
      })
    }
    const terms = plan.query.trim().split(/\s+/u).filter(Boolean).map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    const memories = terms.length === 0 ? [] : this.#readV2Recall(key, terms, plan.asOfWorldSeq, plan.limit)
    const selectedSourceRefs = memories.map(memory => memory.sourceRef)
    const ranking = memories.map((memory, index) => ({ memoryId: memory.memoryId, rank: index + 1, sourceRef: memory.sourceRef }))
    const planHash = hashWorldJson('recall-query-plan/v1', plan)
    const queryHash = hashWorldJson('recall-query/v1', { query: plan.query })
    const resultHash = hashWorldJson('cognitive-memory-recall-result/v2', { memories, ranking })
    const receiptId = deterministicId('recall-receipt/v1', { address: plan.address, characterId: plan.characterId, planId: plan.planId })
    const receiptInput = {
      schemaVersion: 'recall-receipt/v1' as const,
      receiptId, planHash, queryHash, resultHash, watermark,
      selectedSourceRefs, ranking, exclusionReasons: [] as const,
    }
    const receipt: RecallReceipt = { ...receiptInput, receiptHash: hashWorldJson('recall-receipt/v1', receiptInput) }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db.prepare(`
        SELECT receipt_hash FROM cognitive_memory_v2_recall_receipts WHERE receipt_id = ?
      `).get(receiptId) as { receipt_hash: WorldHash } | undefined
      if (existing !== undefined && existing.receipt_hash !== receipt.receiptHash) {
        this.#unverifiedV2(plan.address, `recall:${plan.planId}`, 'Recall receipt identity is bound to another result')
      }
      this.#db.prepare(`
        INSERT OR IGNORE INTO cognitive_memory_v2_recall_receipts(receipt_id, namespace_key, as_of_seq, receipt_hash, receipt_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(receiptId, key, plan.asOfWorldSeq, receipt.receiptHash, worldJsonText(receipt))
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
    return { memories, receipt }
  }

  cognitiveWatermark(address: WorldAddress, characterId: CharacterId): CognitiveMemoryWatermark | undefined {
    const row = this.#db.prepare(`
      SELECT verified_through_seq, captured_through_seq, memory_epoch, source_map_hash
      FROM cognitive_memory_v2_namespaces WHERE namespace_key = ?
    `).get(namespace(address, characterId)) as {
      verified_through_seq: number
      captured_through_seq: number
      memory_epoch: number
      source_map_hash: WorldHash
    } | undefined
    return row === undefined ? undefined : {
      schemaVersion: 'cognitive-memory-watermark/v2', address, characterId,
      verifiedThroughSeq: row.verified_through_seq, capturedThroughSeq: row.captured_through_seq,
      memoryEpoch: row.memory_epoch, sourceMapHash: row.source_map_hash,
    }
  }

  cognitiveReceipt(receiptId: string): CognitiveMemoryReceipt | undefined {
    const row = this.#db.prepare(`SELECT receipt_json FROM cognitive_memory_v2_receipts WHERE receipt_id = ?`)
      .get(receiptId) as { receipt_json: string } | undefined
    return row === undefined ? undefined : parseWorldJson(row.receipt_json) as CognitiveMemoryReceipt
  }

  cognitiveSummaries(address: WorldAddress, characterId: CharacterId): ExtractiveL1Summary[] {
    const rows = this.#db.prepare(`
      SELECT summary_id, source_start_seq, source_end_seq, source_refs_json, extracts_json, summary_hash
      FROM cognitive_memory_v2_summaries WHERE namespace_key = ? ORDER BY source_start_seq, summary_id
    `).all(namespace(address, characterId)) as Array<{
      summary_id: string
      source_start_seq: number
      source_end_seq: number
      source_refs_json: string
      extracts_json: string
      summary_hash: WorldHash
    }>
    return rows.map(row => ({
      schemaVersion: 'memory-l1/v1', summaryId: row.summary_id, address, characterId,
      sourceStartSeq: row.source_start_seq, sourceEndSeq: row.source_end_seq,
      sourceRefs: parseWorldJson(row.source_refs_json) as readonly ContextSourceRef[],
      extracts: parseWorldJson(row.extracts_json) as readonly string[],
      algorithmId: 'deterministic-extractive-l1/v1', summaryHash: row.summary_hash,
    }))
  }

  /** Delete only the v2 derived namespace and advance its epoch before deterministic rebuild. */
  resetCognitiveNamespace(address: WorldAddress, characterId: CharacterId): number {
    const key = namespace(address, characterId)
    const nextEpoch = (this.cognitiveWatermark(address, characterId)?.memoryEpoch ?? 0) + 1
    const emptyHash = hashWorldJson('cognitive-memory-source-map/v2', { address, characterId, sourceRefs: [] })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_fts WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_sources WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_summaries WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_receipts WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_recall_receipts WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`
        INSERT INTO cognitive_memory_v2_namespaces(
          namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
        ) VALUES (?, 0, 0, ?, ?, ?)
        ON CONFLICT(namespace_key) DO UPDATE SET
          verified_through_seq = 0, captured_through_seq = 0, memory_epoch = excluded.memory_epoch,
          source_map_hash = excluded.source_map_hash, source_bundle_hash = excluded.source_bundle_hash
      `).run(key, nextEpoch, emptyHash, emptyHash)
      this.#db.exec('COMMIT')
      return nextEpoch
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  reconcile(request: ReconcileMemoryRequest, heartbeat?: () => void): number {
    if (!Number.isSafeInteger(request.asOfWorldSeq) || request.asOfWorldSeq < 0) {
      throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    }
    const view = this.#viewBuilder.rebuildAt(request.address, request.characterId, request.asOfWorldSeq, heartbeat)
    const key = namespace(view.address, view.characterId)
    const sources = [
      ...view.observations.map(record => ({ kind: 'observation' as const, record })),
      ...view.claims.map(record => ({ kind: 'claim' as const, record })),
      ...view.goals.map(record => ({ kind: 'goal' as const, record })),
    ]
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const watermark = this.#db.prepare(`
        SELECT as_of_seq, bundle_hash FROM memory_namespace_watermarks WHERE namespace_key = ?
      `).get(key) as { as_of_seq: number; bundle_hash: WorldHash } | undefined
      if (watermark !== undefined && watermark.as_of_seq > request.asOfWorldSeq) {
        this.#unverifiedReconcile(request, 'Memory reconciliation cannot move a namespace backward')
      }
      if (watermark?.as_of_seq === request.asOfWorldSeq && watermark.bundle_hash !== view.bundleHash) {
        this.#unverifiedReconcile(request, 'Memory reconciliation diverged at the same asOfWorldSeq')
      }
      const currentMappings = this.#db.prepare(`
        SELECT source_kind, source_id, source_seq, source_hash
        FROM memory_source_mappings WHERE namespace_key = ?
      `).all(key) as Array<{
        source_kind: 'observation' | 'claim' | 'goal'
        source_id: string
        source_seq: number
        source_hash: WorldHash
      }>
      const sourceKeys = new Set(sources.map(source => `${source.kind}\u001f${source.record.id}`))
      for (const [index, current] of currentMappings.entries()) {
        if (index % 128 === 0) heartbeat?.()
        if (!sourceKeys.has(`${current.source_kind}\u001f${current.source_id}`)) {
          this.#db.prepare(`
            DELETE FROM memory_source_mappings
            WHERE namespace_key = ? AND source_kind = ? AND source_id = ?
          `).run(key, current.source_kind, current.source_id)
        }
      }
      for (const [index, source] of sources.entries()) {
        if (index % 128 === 0) heartbeat?.()
        const hash = sourceHash(source.kind, source.record)
        const current = currentMappings.find(value => value.source_kind === source.kind && value.source_id === source.record.id)
        if (current !== undefined && current.source_seq > source.record.sourceSeq) {
          this.#unverifiedReconcile(request, 'Memory source sequence cannot move backward')
        }
        if (current?.source_seq === source.record.sourceSeq && current.source_hash !== hash) {
          this.#unverifiedReconcile(request, 'Memory source hash diverged at the same sequence')
        }
        this.#db.prepare(`
          INSERT INTO memory_source_mappings(namespace_key, source_kind, source_id, source_seq, source_hash)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(namespace_key, source_kind, source_id) DO UPDATE SET
            source_seq = excluded.source_seq, source_hash = excluded.source_hash
        `).run(key, source.kind, source.record.id, source.record.sourceSeq, hash)
      }
      this.#db.prepare(`
        INSERT INTO memory_namespace_watermarks(namespace_key, as_of_seq, bundle_hash) VALUES (?, ?, ?)
        ON CONFLICT(namespace_key) DO UPDATE SET as_of_seq = excluded.as_of_seq, bundle_hash = excluded.bundle_hash
      `).run(key, request.asOfWorldSeq, view.bundleHash)
      this.#db.exec('COMMIT')
      heartbeat?.()
      return sources.length
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  capture(request: CaptureMemoryRequest): 'captured' | 'already_captured' {
    this.#validateCapture(request)
    const key = namespace(request.address, request.characterId)
    const sortedSources = [...request.sources].sort((left, right) => compareWorldText(left.sourceKind, right.sourceKind)
      || compareWorldText(left.sourceId, right.sourceId))
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

  enqueueCognitiveJob(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number): 'enqueued' | 'already_enqueued' {
    const key = namespace(address, characterId)
    const jobHash = hashWorldJson('cognitive-memory-job', { address, characterId, asOfWorldSeq })
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO cognitive_jobs(namespace_key, as_of_seq, job_hash, status, attempt_count, last_error)
      VALUES (?, ?, ?, 'pending', 0, NULL)
    `).run(key, asOfWorldSeq, jobHash)
    return result.changes === 1 ? 'enqueued' : 'already_enqueued'
  }

  recordCognitiveJobResult(
    address: WorldAddress,
    characterId: CharacterId,
    asOfWorldSeq: number,
    status: 'completed' | 'failed',
    error: string | null,
  ): void {
    const result = this.#db.prepare(`
      UPDATE cognitive_jobs
      SET status = ?, attempt_count = attempt_count + 1, last_error = ?
      WHERE namespace_key = ? AND as_of_seq = ?
    `).run(status, error, namespace(address, characterId), asOfWorldSeq)
    if (result.changes !== 1) throw new Error('cognitive job is missing')
  }

  cognitiveJob(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number): CognitiveJobRecord | undefined {
    const row = this.#db.prepare(`
      SELECT as_of_seq, status, attempt_count, last_error, job_hash
      FROM cognitive_jobs WHERE namespace_key = ? AND as_of_seq = ?
    `).get(namespace(address, characterId), asOfWorldSeq) as {
      as_of_seq: number
      status: CognitiveJobRecord['status']
      attempt_count: number
      last_error: string | null
      job_hash: WorldHash
    } | undefined
    return row === undefined ? undefined : {
      asOfWorldSeq: row.as_of_seq,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      jobHash: row.job_hash,
    }
  }

  /** Delete one derived namespace so it can be rebuilt exclusively from the verified World prefix. */
  resetNamespace(address: WorldAddress, characterId: CharacterId): void {
    const key = namespace(address, characterId)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`DELETE FROM memory_fts WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM memory_sources WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM memory_entries WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM memory_source_mappings WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM memory_namespace_watermarks WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`DELETE FROM cognitive_jobs WHERE namespace_key = ?`).run(key)
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  #observationCandidates(
    address: WorldAddress,
    characterId: CharacterId,
    asOfWorldSeq: number,
    correlationId: string,
    heartbeat?: () => void,
  ): CognitiveSourceCandidate[] {
    const candidates: CognitiveSourceCandidate[] = []
    for (const [index, event] of this.#worldStore.readEvents(address, asOfWorldSeq).entries()) {
      if (index % 128 === 0) heartbeat?.()
      if (event.eventType !== 'observation.upsert') continue
      try {
        const data = objectValue(event.data, `observation.upsert@${event.seq}`)
        if (typeof data.id !== 'string' || data.id.length === 0) throw new Error('observation id must be a non-empty string')
        const value = objectValue(data.value as WorldJsonValue, `observation.upsert@${event.seq}.value`)
        if (value.observerId !== characterId) continue
        const content = value.content ?? value
        const contentObject = typeof content === 'object' && content !== null && !Array.isArray(content)
          ? content as WorldJsonObject
          : undefined
        const speechValue = contentObject?.speech
        let memoryKind: CognitiveMemoryKind = 'episodic'
        let epistemicKind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
        let text = canonicalText(content)
        let metadata: WorldJsonValue = { observationId: data.id }
        if (speechValue !== undefined) {
          const speech = objectValue(speechValue, `observation.upsert@${event.seq}.value.content.speech`)
          if (typeof speech.characterId !== 'string' || typeof speech.text !== 'string') {
            throw new Error('communication observation speech requires characterId and text')
          }
          memoryKind = 'communication'
          epistemicKind = 'reported_speech'
          text = `${speech.characterId} said: ${speech.text}`
          metadata = { observationId: data.id, speakerId: speech.characterId }
        } else {
          const declared = value.epistemicKind
          if (declared !== undefined && !EPISODIC_OBSERVATION_KINDS.has(declared as CognitiveEpistemicKind)) {
            throw new Error('observation epistemicKind is unsupported for episodic capture')
          }
          epistemicKind = declared as Exclude<CognitiveEpistemicKind, 'derived_summary'> | undefined
            ?? (contentObject?.actionType === undefined ? 'direct_observation' : 'observed_action')
        }
        candidates.push({
          sourceType: 'observation',
          sourceRef: { sourceKind: 'world_event', sourceId: `event:${event.seq}`, sourceSeq: event.seq, sourceHash: event.eventHash },
          memoryKind, epistemicKind, text, metadata,
        })
      } catch (error: unknown) {
        this.#unverifiedV2(address, correlationId, `Observation source is malformed: ${String(error)}`)
      }
    }
    return candidates
  }

  #captureV2Candidate(
    key: string,
    address: WorldAddress,
    characterId: CharacterId,
    candidate: CognitiveSourceCandidate,
    correlationId: string,
  ): void {
    const memoryId = deterministicId('cognitive-memory-entry/v2', {
      address, characterId, sourceType: candidate.sourceType, sourceRef: candidate.sourceRef,
    })
    const captureInput = {
      memoryId, memoryKind: candidate.memoryKind, epistemicKind: candidate.epistemicKind,
      text: candidate.text, metadata: candidate.metadata, sourceRef: candidate.sourceRef,
    }
    const captureHash = hashWorldJson('cognitive-memory-capture/v2', captureInput)
    const existing = this.#db.prepare(`
      SELECT source_seq, source_hash, capture_hash FROM cognitive_memory_v2_sources
      WHERE namespace_key = ? AND source_id = ?
    `).get(key, candidate.sourceRef.sourceId) as {
      source_seq: number
      source_hash: WorldHash
      capture_hash: WorldHash
    } | undefined
    if (existing !== undefined && (existing.source_seq !== candidate.sourceRef.sourceSeq
      || existing.source_hash !== candidate.sourceRef.sourceHash || existing.capture_hash !== captureHash)) {
      this.#unverifiedV2(address, correlationId, 'Cognitive Memory source identity is bound to divergent content')
    }
    const inserted = this.#db.prepare(`
      INSERT OR IGNORE INTO cognitive_memory_v2_sources(
        namespace_key, memory_id, source_type, source_id, source_seq, source_hash,
        memory_kind, epistemic_kind, text_value, metadata_json, capture_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key, memoryId, candidate.sourceType, candidate.sourceRef.sourceId, candidate.sourceRef.sourceSeq,
      candidate.sourceRef.sourceHash, candidate.memoryKind, candidate.epistemicKind,
      candidate.text, worldJsonText(candidate.metadata), captureHash,
    )
    if (inserted.changes === 1) {
      this.#db.prepare(`INSERT INTO cognitive_memory_v2_fts(namespace_key, memory_id, text_value) VALUES (?, ?, ?)`)
        .run(key, memoryId, candidate.text)
    }
  }

  #readV2Entries(key: string, asOfWorldSeq: number): CognitiveMemoryEntry[] {
    const rows = this.#db.prepare(`
      SELECT memory_id, memory_kind, epistemic_kind, text_value, metadata_json,
             source_id, source_seq, source_hash, capture_hash
      FROM cognitive_memory_v2_sources
      WHERE namespace_key = ? AND source_seq <= ?
      ORDER BY source_seq, source_type, source_id
    `).all(key, asOfWorldSeq) as Array<{
      memory_id: string
      memory_kind: CognitiveMemoryKind
      epistemic_kind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
      text_value: string
      metadata_json: string
      source_id: string
      source_seq: number
      source_hash: WorldHash
      capture_hash: WorldHash
    }>
    return rows.map(row => ({
      memoryId: row.memory_id, memoryKind: row.memory_kind, epistemicKind: row.epistemic_kind,
      text: row.text_value, metadata: parseWorldJson(row.metadata_json),
      sourceRef: { sourceKind: 'world_event', sourceId: row.source_id, sourceSeq: row.source_seq, sourceHash: row.source_hash },
      captureHash: row.capture_hash,
    }))
  }

  #readV2Recall(key: string, terms: string, asOfWorldSeq: number, limit: number): CognitiveMemoryEntry[] {
    const rows = this.#db.prepare(`
      SELECT s.memory_id, s.memory_kind, s.epistemic_kind, s.text_value, s.metadata_json,
             s.source_id, s.source_seq, s.source_hash, s.capture_hash
      FROM cognitive_memory_v2_fts f JOIN cognitive_memory_v2_sources s
        ON s.namespace_key = f.namespace_key AND s.memory_id = f.memory_id
      WHERE cognitive_memory_v2_fts MATCH ? AND s.namespace_key = ? AND s.source_seq <= ?
      ORDER BY bm25(cognitive_memory_v2_fts), s.source_seq DESC, s.memory_id
      LIMIT ?
    `).all(terms, key, asOfWorldSeq, limit) as Array<{
      memory_id: string
      memory_kind: CognitiveMemoryKind
      epistemic_kind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
      text_value: string
      metadata_json: string
      source_id: string
      source_seq: number
      source_hash: WorldHash
      capture_hash: WorldHash
    }>
    return rows.map(row => ({
      memoryId: row.memory_id, memoryKind: row.memory_kind, epistemicKind: row.epistemic_kind,
      text: row.text_value, metadata: parseWorldJson(row.metadata_json),
      sourceRef: { sourceKind: 'world_event', sourceId: row.source_id, sourceSeq: row.source_seq, sourceHash: row.source_hash },
      captureHash: row.capture_hash,
    }))
  }

  #replaceV2Summaries(
    key: string,
    address: WorldAddress,
    characterId: CharacterId,
    entries: readonly CognitiveMemoryEntry[],
  ): ExtractiveL1Summary[] {
    this.#db.prepare(`DELETE FROM cognitive_memory_v2_summaries WHERE namespace_key = ?`).run(key)
    const summaries: ExtractiveL1Summary[] = []
    for (let index = 0; index < entries.length; index += 8) {
      const chunk = entries.slice(index, index + 8)
      if (chunk.length < 2) continue
      const sourceRefs = chunk.map(entry => entry.sourceRef)
      const extracts = chunk.map(entry => entry.text)
      const sourceStartSeq = sourceRefs[0]!.sourceSeq
      const sourceEndSeq = sourceRefs.at(-1)!.sourceSeq
      const summaryId = deterministicId('memory-l1-summary/v1', { address, characterId, sourceRefs })
      const summaryInput = {
        schemaVersion: 'memory-l1/v1' as const, summaryId, address, characterId,
        sourceStartSeq, sourceEndSeq, sourceRefs, extracts,
        algorithmId: 'deterministic-extractive-l1/v1' as const,
      }
      const summary: ExtractiveL1Summary = {
        ...summaryInput, summaryHash: hashWorldJson('memory-l1-summary/v1', summaryInput),
      }
      this.#db.prepare(`
        INSERT INTO cognitive_memory_v2_summaries(
          namespace_key, summary_id, source_start_seq, source_end_seq, source_refs_json, extracts_json, summary_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        key, summaryId, sourceStartSeq, sourceEndSeq,
        worldJsonText(sourceRefs), worldJsonText(extracts), summary.summaryHash,
      )
      summaries.push(summary)
    }
    return summaries
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

  #unverifiedReconcile(request: ReconcileMemoryRequest, message: string): never {
    failWorld({
      errorCode: 'MEMORY_SOURCE_UNVERIFIED',
      category: 'integrity',
      message,
      retryable: false,
      correlationId: request.correlationId,
      address: request.address,
    })
  }

  #unverifiedV2(address: WorldAddress, correlationId: string, message: string): never {
    failWorld({
      errorCode: 'MEMORY_SOURCE_UNVERIFIED', category: 'integrity', message, retryable: false,
      correlationId, address,
    })
  }
}
