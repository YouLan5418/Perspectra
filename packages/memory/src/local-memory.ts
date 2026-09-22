import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  RECALL_HYBRID_TOKENIZER_ID,
  RECALL_KEYWORD_STRATEGY_ID,
  RECALL_KEYWORD_TOKENIZER_ID,
  worldAddressKey,
  type CognitiveEpistemicKind,
  type CognitiveMemoryEntry,
  type CognitiveMemoryKind,
  type CognitiveMemoryReceipt,
  type CognitiveMemoryWatermark,
  type CognitiveRecallResult,
  type CognitiveRecallResultV2,
  type CharacterId,
  type CharacterView,
  type ContextSourceRef,
  type ExtractiveL1Summary,
  type RecallClue,
  type RecallExclusionReasonV2,
  type RecallKeywordRanking,
  type RecallQueryPlan,
  type RecallQueryPlanV2,
  type RecallReceipt,
  type RecallReceiptV2,
  type RecallTokenizerId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { tokenizeHybridText } from './hybrid-tokenizer.ts'
import { tokenizeKeywordText, type KeywordToken } from './ngram-tokenizer.ts'
import {
  CognitionProjectionRebuilder,
  CharacterViewBuilder,
  openMigratedDatabase,
  parseWorldJson,
  rollbackAndThrow,
  type WorldStore,
  worldJsonText,
} from '@harness-world/store-sqlite'

export const MEMORY_APPLICATION_ID = 0x4843574c
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

/**
 * Versioned keyword index. Terms are a pure function of a captured entry's text, so the index is
 * derived and disposable: it can always be rebuilt from the sources at the same as-of. The namespace
 * row records which tokenizer built it, so a namespace indexed by an older tokenizer is rebuilt once
 * instead of being matched with stale boundaries.
 */
const MEMORY_COGNITIVE_V2_KEYWORD_SCHEMA = `
CREATE TABLE cognitive_memory_v2_terms (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_kind TEXT NOT NULL CHECK(token_kind IN ('cjk-2', 'cjk-3', 'word')),
  token_weight INTEGER NOT NULL CHECK(token_weight > 0),
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  PRIMARY KEY(namespace_key, memory_id, token)
) STRICT;
CREATE INDEX cognitive_memory_v2_terms_lookup ON cognitive_memory_v2_terms(namespace_key, token);
ALTER TABLE cognitive_memory_v2_namespaces ADD COLUMN terms_tokenizer_id TEXT;
`

/**
 * Widens the term kinds for the segmenter-backed tokenizer and clears every marker, so each namespace
 * rebuilds once with the tokenizer it uses. Recreating the table is safe because it holds derived data
 * only: every row can be recomputed from the captured sources.
 */
const MEMORY_COGNITIVE_V2_HYBRID_SCHEMA = `
DROP TABLE cognitive_memory_v2_terms;
CREATE TABLE cognitive_memory_v2_terms (
  namespace_key TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  token TEXT NOT NULL,
  token_kind TEXT NOT NULL CHECK(token_kind IN ('cjk-2', 'cjk-3', 'word', 'jieba-word')),
  token_weight INTEGER NOT NULL CHECK(token_weight > 0),
  source_seq INTEGER NOT NULL CHECK(source_seq >= 0),
  PRIMARY KEY(namespace_key, memory_id, token)
) STRICT;
CREATE INDEX cognitive_memory_v2_terms_lookup ON cognitive_memory_v2_terms(namespace_key, token);
UPDATE cognitive_memory_v2_namespaces SET terms_tokenizer_id = NULL;
`

/**
 * L1 Summaries used to be grouped by record count, which cut an arbitrary line through the middle of a
 * committed Round and dropped a trailing group of one — so the newest Memories had no Summary at all.
 * Summaries are derived data rebuilt on every catch-up, so dropping the old rows is enough: the next
 * catch-up writes Round-grouped ones. Continuity Checkpoints name Summaries by identity, so they drop
 * their own derived rows the same way.
 */
const MEMORY_COGNITIVE_V2_DIGEST_SCHEMA = `
DELETE FROM cognitive_memory_v2_summaries;
`

export const MEMORY_SCHEMA_VERSION = 8

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

function observedManifestation(
  value: WorldJsonValue | undefined,
  path: string,
): { readonly characterId: string; readonly text: string; readonly value: WorldJsonObject } | undefined {
  if (value === undefined) return undefined
  const manifestation = objectValue(value, path)
  if (typeof manifestation.characterId !== 'string' || manifestation.characterId.length === 0) {
    throw new Error('manifestation observation requires characterId')
  }
  if (manifestation.description !== null && manifestation.description !== undefined
    && typeof manifestation.description !== 'string') {
    throw new Error('manifestation observation description must be string or null')
  }
  if (!Array.isArray(manifestation.cues) || manifestation.cues.length === 0) {
    throw new Error('manifestation observation requires accepted cues')
  }
  const cueDescriptions = manifestation.cues.map((entry, index) => {
    const cue = objectValue(entry, `${path}.cues[${index}]`)
    if (typeof cue.description !== 'string' || cue.description.length === 0) {
      throw new Error('manifestation observation cue requires description')
    }
    return cue.description
  })
  return {
    characterId: manifestation.characterId,
    text: typeof manifestation.description === 'string'
      ? manifestation.description
      : cueDescriptions.join('；'),
    value: manifestation,
  }
}

function orderedSources(values: readonly CognitiveSourceCandidate[]): CognitiveSourceCandidate[] {
  // One authoritative World Event can produce at most one captured record for one character.
  return [...values].sort((left, right) => left.sourceRef.sourceSeq - right.sourceRef.sourceSeq)
}

/** How many committed Rounds one L1 Summary covers. */
const SUMMARY_ROUNDS_PER_GROUP = 4

/** The sequence that closes one committed Round, together with the Tick it advanced to. */
interface SummaryRound {
  readonly endSeq: number
  readonly tick: number
}

/** Reduce a captured Memory to one Summary line: the speech marker becomes a plain separator. */
function digestText(text: string): string {
  return text.replace(' said: ', '：')
}

/**
 * The ordinal of the Round a sequence belongs to, as an index into `rounds`.
 *
 * The result is the first boundary at or after the sequence. When the sequence closes no Round — a
 * catch-up that stops mid-Round, or a World whose log carries no Tick event — the ordinal clamps to the
 * last known Round, so those Memories still form a Summary instead of none.
 */
function roundOrdinal(rounds: readonly SummaryRound[], sourceSeq: number): number {
  let low = 0
  let high = rounds.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (rounds[middle]!.endSeq >= sourceSeq) high = middle
    else low = middle + 1
  }
  return Math.min(low, rounds.length - 1)
}

/**
 * Group Memories, which arrive ordered by source sequence, into whole-Round Summaries.
 *
 * A group is a run of entries whose Round ordinals land in the same bucket of `SUMMARY_ROUNDS_PER_GROUP`.
 * A trailing bucket that is not full still becomes a Summary: discarding it is why the newest Memories
 * used to have no Summary at all, and why the Continuity baseline reached further than the Summaries did.
 */
function groupMemoriesByRounds(
  entries: readonly CognitiveMemoryEntry[],
  rounds: readonly SummaryRound[],
): CognitiveMemoryEntry[][] {
  const groups: CognitiveMemoryEntry[][] = []
  let current: CognitiveMemoryEntry[] = []
  let currentBucket = Number.NaN
  for (const entry of entries) {
    const bucket = Math.floor(roundOrdinal(rounds, entry.sourceRef.sourceSeq) / SUMMARY_ROUNDS_PER_GROUP)
    if (current.length > 0 && bucket !== currentBucket) {
      groups.push(current)
      current = []
    }
    currentBucket = bucket
    current.push(entry)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** One line per Round the group covers, in time order, so the reader gets the episode rather than a record dump. */
function digestExtracts(group: readonly CognitiveMemoryEntry[], rounds: readonly SummaryRound[]): string[] {
  const byRound = new Map<number, string[]>()
  for (const entry of group) {
    const ordinal = roundOrdinal(rounds, entry.sourceRef.sourceSeq)
    byRound.set(ordinal, [...byRound.get(ordinal) ?? [], digestText(entry.text)])
  }
  return [...byRound].map(([ordinal, lines]) => {
    const round = rounds[ordinal]
    return round === undefined ? lines.join(' ｜ ') : `第 ${round.tick} 轮 ｜ ${lines.join(' ｜ ')}`
  })
}

/**
 * The FTS5 MATCH expression for one Recall query. Recall and its diagnostics share this so the counted
 * candidate set can never drift from the set a real Recall ranks.
 */
function recallTerms(query: string): string {
  return query.trim().split(/\s+/u).filter(Boolean).map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}

/** Canonical text of a CharacterGoal objective; capture and its recall clue must tokenize identically. */
export function goalObjectiveText(value: WorldJsonValue): string {
  return canonicalText(objectValue(value, 'CharacterGoal').objective as WorldJsonValue)
}

/** The result limit one Recall applies when the caller does not choose one. */
export const DEFAULT_RECALL_LIMIT = 10

/**
 * Tokenize one text with the versioned tokenizer the plan or the namespace selected. Unknown identifiers
 * never reach this function: a plan is validated first, so an unknown tokenizer fails closed instead of
 * silently falling back to another rule.
 */
function tokenizeFor(tokenizerId: RecallTokenizerId, text: string): readonly KeywordToken[] {
  return tokenizerId === RECALL_HYBRID_TOKENIZER_ID ? tokenizeHybridText(text) : tokenizeKeywordText(text)
}

/**
 * How many candidates one Recall plan matches at its as-of, before the plan limit truncates them. This is a
 * diagnostic surface: it is never persisted, so it cannot change what a Recall or a Receipt records.
 */
export interface RecallCandidateDiagnostics extends WorldJsonObject {
  readonly schemaVersion: 'recall-candidates/v1'
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly query: string
  /** Candidates this query matches at this as-of, before `limit` is applied. */
  readonly matchedCount: number
  readonly limit: number
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
      { version: 5, sql: MEMORY_COGNITIVE_V2_SCHEMA },
      { version: 6, sql: MEMORY_COGNITIVE_V2_KEYWORD_SCHEMA },
      { version: 7, sql: MEMORY_COGNITIVE_V2_HYBRID_SCHEMA },
      { version: MEMORY_SCHEMA_VERSION, sql: MEMORY_COGNITIVE_V2_DIGEST_SCHEMA },
    ])
    this.#worldStore = worldStore
    this.#viewBuilder = new CharacterViewBuilder(worldStore)
  }

  /**
   * Rebuild, verify, capture, summarize, and receipt one Phase 8 character namespace at an exact World prefix.
   *
   * `keywordTokenizerId` is set only by a world that declared the versioned keyword strategy. A world that
   * did not keeps paying nothing for an index it never queries, and the index is built from the same
   * captured sources inside this transaction, so it stays derived and reproducible.
   */
  catchUpV2(
    address: WorldAddress,
    characterId: CharacterId,
    requiredAsOfSeq: number,
    correlationId: string,
    heartbeat?: () => void,
    options?: { readonly keywordTokenizerId?: RecallTokenizerId },
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
        text: goalObjectiveText(record.value),
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
      const summaries = this.#replaceV2Summaries(
        key, address, characterId, rows, this.#summaryRounds(address, requiredAsOfSeq),
      )
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
      if (options?.keywordTokenizerId !== undefined) {
        this.#ensureV2KeywordIndex(key, rows, options.keywordTokenizerId)
      }
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
    const { key, watermark } = this.#assertV2RecallPlan(plan)
    const terms = recallTerms(plan.query)
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
    this.#persistV2RecallReceipt(key, plan, receipt)
    return { memories, receipt }
  }

  /**
   * Recall through the versioned keyword strategy: any query token matches, then candidates rank by an
   * integer relevance computed only from this namespace and as-of prefix. The result limit stays a hard
   * limit, and the v2 receipt records how many matching candidates it withheld.
   */
  recallKeywords(plan: RecallQueryPlanV2): CognitiveRecallResultV2 {
    const { key, watermark } = this.#assertV2KeywordPlan(plan)
    const queryTokens = tokenizeFor(plan.tokenizerId, plan.queryText)
    const clueTokens = plan.clues.flatMap(clue => tokenizeFor(plan.tokenizerId, clue.text))
    const candidates = queryTokens.length === 0 && clueTokens.length === 0
      ? []
      : this.#readV2KeywordCandidates(key, plan.asOfWorldSeq, queryTokens, clueTokens, this.#dictionaryFor(key, plan))
    const selected = candidates.slice(0, plan.resultLimit)
    const memories = this.#readV2KeywordEntries(key, selected.map(candidate => candidate.memoryId))
    const ranking: RecallKeywordRanking[] = selected.map((candidate, index) => ({
      memoryId: candidate.memoryId, rank: index + 1, score: candidate.score,
      matchedTokens: candidate.matchedTokens, clueMatched: candidate.clueMatched,
      sourceRef: candidate.sourceRef,
    }))
    const receiptInput = {
      schemaVersion: 'recall-receipt/v2' as const,
      receiptId: deterministicId('recall-receipt/v2', {
        address: plan.address, characterId: plan.characterId, planId: plan.planId,
      }),
      planHash: hashWorldJson('recall-query-plan/v2', plan),
      strategyId: plan.strategyId, tokenizerId: plan.tokenizerId,
      dictionaryEnabled: plan.dictionaryEnabled, dictionaryWatermark: plan.dictionaryWatermark,
      clueIds: plan.clues.map(clue => clue.sourceId),
      watermark, matchedCount: candidates.length,
      droppedByResultLimit: candidates.length - selected.length,
      selectedSourceRefs: memories.map(memory => memory.sourceRef), ranking,
      exclusionReasons: (candidates.length === 0
        ? ['no_match']
        : candidates.length > selected.length ? ['result_limit'] : []) as readonly RecallExclusionReasonV2[],
      resultHash: hashWorldJson('cognitive-memory-recall-result/v3', { memories, ranking }),
    }
    const receipt: RecallReceiptV2 = { ...receiptInput, receiptHash: hashWorldJson('recall-receipt/v2', receiptInput) }
    this.#persistV2RecallReceipt(key, plan, receipt)
    return { memories, receipt }
  }

  /**
   * Report how many candidates one Recall plan matches before its result limit is applied. Nothing durable
   * records the candidates a limited Recall drops, so this is how that gap is measured instead of guessed.
   */
  recallDiagnostics(plan: RecallQueryPlan | RecallQueryPlanV2): RecallCandidateDiagnostics {
    if (plan.schemaVersion === 'recall-query-plan/v2') {
      const { key } = this.#assertV2KeywordPlan(plan)
      const queryTokens = tokenizeFor(plan.tokenizerId, plan.queryText)
      const clueTokens = plan.clues.flatMap(clue => tokenizeFor(plan.tokenizerId, clue.text))
      return {
        schemaVersion: 'recall-candidates/v1', address: plan.address, characterId: plan.characterId,
        asOfWorldSeq: plan.asOfWorldSeq, query: plan.queryText, limit: plan.resultLimit,
        matchedCount: queryTokens.length === 0 && clueTokens.length === 0
          ? 0
          : this.#readV2KeywordCandidates(key, plan.asOfWorldSeq, queryTokens, clueTokens, this.#dictionaryFor(key, plan)).length,
      }
    }
    const { key } = this.#assertV2RecallPlan(plan)
    const terms = recallTerms(plan.query)
    const matchedCount = terms.length === 0 ? 0 : this.#countV2Recall(key, terms, plan.asOfWorldSeq)
    return {
      schemaVersion: 'recall-candidates/v1', address: plan.address, characterId: plan.characterId,
      asOfWorldSeq: plan.asOfWorldSeq, query: plan.query, matchedCount, limit: plan.limit,
    }
  }

  /** Append one Recall receipt once, failing closed when the same identity already holds another result. */
  #persistV2RecallReceipt(
    key: string,
    plan: { readonly planId: string; readonly address: WorldAddress; readonly asOfWorldSeq: number },
    receipt: { readonly receiptId: string; readonly receiptHash: WorldHash },
  ): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db.prepare(`
        SELECT receipt_hash FROM cognitive_memory_v2_recall_receipts WHERE receipt_id = ?
      `).get(receipt.receiptId) as { receipt_hash: WorldHash } | undefined
      if (existing !== undefined && existing.receipt_hash !== receipt.receiptHash) {
        this.#unverifiedV2(plan.address, `recall:${plan.planId}`, 'Recall receipt identity is bound to another result')
      }
      this.#db.prepare(`
        INSERT OR IGNORE INTO cognitive_memory_v2_recall_receipts(receipt_id, namespace_key, as_of_seq, receipt_hash, receipt_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(receipt.receiptId, key, plan.asOfWorldSeq, receipt.receiptHash, worldJsonText(receipt))
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /**
   * The open objectives of one character, read from the goals this namespace already captured rather
   * than from a separate projection: the clue is then the same set the term index covers, at the same
   * as-of, with no extra rebuild. A goal that is no longer active stops being a clue.
   */
  openObjectiveClues(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number): readonly RecallClue[] {
    const rows = this.#db.prepare(`
      SELECT source_id, text_value, metadata_json FROM cognitive_memory_v2_sources
      WHERE namespace_key = ? AND source_seq <= ? AND source_type = 'character_goal'
      ORDER BY source_seq, source_id
    `).all(namespace(address, characterId), asOfWorldSeq) as Array<{
      source_id: string
      text_value: string
      metadata_json: string
    }>
    const clues: RecallClue[] = []
    for (const row of rows) {
      if ((parseWorldJson(row.metadata_json) as WorldJsonObject).status !== 'active') continue
      clues.push({ kind: 'open_objective', sourceId: row.source_id, text: row.text_value })
    }
    return clues
  }

  cognitiveWatermark(address: WorldAddress, characterId: CharacterId): CognitiveMemoryWatermark | undefined {    const row = this.#db.prepare(`
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
      algorithmId: 'deterministic-rollup-l1/v2', summaryHash: row.summary_hash,
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
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_terms WHERE namespace_key = ?`).run(key)
      this.#db.prepare(`
        INSERT INTO cognitive_memory_v2_namespaces(
          namespace_key, verified_through_seq, captured_through_seq, memory_epoch, source_map_hash, source_bundle_hash
        ) VALUES (?, 0, 0, ?, ?, ?)
        ON CONFLICT(namespace_key) DO UPDATE SET
          verified_through_seq = 0, captured_through_seq = 0, memory_epoch = excluded.memory_epoch,
          source_map_hash = excluded.source_map_hash, source_bundle_hash = excluded.source_bundle_hash,
          terms_tokenizer_id = NULL
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

  /**
   * Count the candidates this query matches in the local index before a v1 Recall's limit truncates them.
   * It mirrors `recall`'s filters exactly, and writes nothing.
   */
  countRecall(address: WorldAddress, characterId: CharacterId, query: string, asOfWorldSeq: number): number {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    const terms = recallTerms(query)
    if (terms.length === 0) return 0
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS matched
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
    `).get(
      terms, namespace(address, characterId), asOfWorldSeq, asOfWorldSeq, asOfWorldSeq,
    ) as { matched: number }
    return row.matched
  }

  recall(address: WorldAddress, characterId: CharacterId, query: string, asOfWorldSeq: number, limit = DEFAULT_RECALL_LIMIT): RecalledMemory[] {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('limit must be a positive safe integer')
    const terms = recallTerms(query)
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
    for (const [index, event] of this.#worldStore.readEventsRange(
      address,
      0,
      asOfWorldSeq,
      ['observation.upsert'],
    ).entries()) {
      if (index % 128 === 0) heartbeat?.()
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
        const manifestation = observedManifestation(
          contentObject?.manifestation,
          `observation.upsert@${event.seq}.value.content.manifestation`,
        )
        let memoryKind: CognitiveMemoryKind = 'episodic'
        let epistemicKind: Exclude<CognitiveEpistemicKind, 'derived_summary'>
        let text = canonicalText(content)
        let metadata: WorldJsonValue = { observationId: data.id }
        if (speechValue !== undefined) {
          const speech = objectValue(speechValue, `observation.upsert@${event.seq}.value.content.speech`)
          if (typeof speech.characterId !== 'string' || typeof speech.text !== 'string'
            || (speech.narration !== undefined && typeof speech.narration !== 'string')) {
            throw new Error('communication observation speech requires characterId and text')
          }
          memoryKind = 'communication'
          epistemicKind = 'reported_speech'
          text = (speech.text.length === 0 ? '' : `${speech.characterId} said: ${speech.text}`)
            + (typeof speech.narration === 'string' && speech.narration.length > 0
              ? `${speech.text.length === 0 ? '' : '; '}${speech.characterId} published narration (not an adjudicated outcome): ${speech.narration}` : '')
            + (manifestation === undefined ? '' : `; ${manifestation.characterId} appeared: ${manifestation.text}`)
          metadata = {
            observationId: data.id,
            speakerId: speech.characterId,
            ...(speech.narration === undefined ? {} : { narration: speech.narration }),
            ...(manifestation === undefined ? {} : { manifestation: manifestation.value }),
          }
        } else if (manifestation !== undefined) {
          epistemicKind = 'direct_observation'
          text = `${manifestation.characterId} appeared: ${manifestation.text}`
          metadata = { observationId: data.id, manifestation: manifestation.value }
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

  /** Shared plan validation and watermark gate, so a diagnostic cannot describe a different candidate set. */
  #assertV2RecallPlan(
    plan: RecallQueryPlan,
  ): { readonly key: string; readonly watermark: CognitiveMemoryWatermark } {
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
    return { key, watermark }
  }

  #countV2Recall(key: string, terms: string, asOfWorldSeq: number): number {
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS matched
      FROM cognitive_memory_v2_fts f JOIN cognitive_memory_v2_sources s
        ON s.namespace_key = f.namespace_key AND s.memory_id = f.memory_id
      WHERE cognitive_memory_v2_fts MATCH ? AND s.namespace_key = ? AND s.source_seq <= ?
    `).get(terms, key, asOfWorldSeq) as { matched: number }
    return row.matched
  }

  #readV2Recall(key: string, terms: string, asOfWorldSeq: number, limit: number): CognitiveMemoryEntry[] {    const rows = this.#db.prepare(`
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

  /**
   * Keep the keyword index in step with the captured sources. A namespace whose marker names another
   * tokenizer is rebuilt once; otherwise only entries that have no terms yet are tokenized, so a normal
   * catch-up never rewrites terms that are already correct.
   */
  #ensureV2KeywordIndex(key: string, rows: readonly CognitiveMemoryEntry[], tokenizerId: RecallTokenizerId): void {
    if (this.#v2TermsTokenizer(key) !== tokenizerId) {
      this.#db.prepare(`DELETE FROM cognitive_memory_v2_terms WHERE namespace_key = ?`).run(key)
      for (const entry of rows) {
        this.#insertV2Terms(key, entry.memoryId, entry.sourceRef.sourceSeq, entry.text, tokenizerId)
      }
    } else {
      const missing = this.#db.prepare(`
        SELECT s.memory_id, s.source_seq, s.text_value FROM cognitive_memory_v2_sources s
        WHERE s.namespace_key = ? AND NOT EXISTS (
          SELECT 1 FROM cognitive_memory_v2_terms t
          WHERE t.namespace_key = s.namespace_key AND t.memory_id = s.memory_id
        )
      `).all(key) as Array<{ memory_id: string; source_seq: number; text_value: string }>
      for (const row of missing) {
        this.#insertV2Terms(key, row.memory_id, row.source_seq, row.text_value, tokenizerId)
      }
    }
    this.#db.prepare(`UPDATE cognitive_memory_v2_namespaces SET terms_tokenizer_id = ? WHERE namespace_key = ?`)
      .run(tokenizerId, key)
  }

  #insertV2Terms(
    key: string,
    memoryId: string,
    sourceSeq: number,
    text: string,
    tokenizerId: RecallTokenizerId,
  ): void {
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO cognitive_memory_v2_terms(namespace_key, memory_id, token, token_kind, token_weight, source_seq)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const token of tokenizeFor(tokenizerId, text)) {
      insert.run(key, memoryId, token.token, token.kind, token.weight, sourceSeq)
    }
  }

  /**
   * The proper-noun terms this namespace may treat as names, derived only from identities its own
   * captured sources already carry. Two consequences follow from that source: a name another character
   * learned privately can never enter this dictionary, and the dictionary is a pure function of the
   * as-of prefix, so the same watermark always yields the same one.
   */
  #dictionaryTerms(key: string, asOfWorldSeq: number, tokenizerId: RecallTokenizerId): ReadonlySet<string> {
    const rows = this.#db.prepare(`
      SELECT metadata_json FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND source_seq <= ?
    `).all(key, asOfWorldSeq) as Array<{ metadata_json: string }>
    const terms = new Set<string>()
    for (const row of rows) {
      const speakerId = (parseWorldJson(row.metadata_json) as WorldJsonObject).speakerId
      if (typeof speakerId !== 'string') continue
      for (const token of tokenizeFor(tokenizerId, speakerId)) terms.add(token.token)
    }
    return terms
  }

  /** Which tokenizer built the terms of this namespace, or `null` when the index was never built. */
  #v2TermsTokenizer(key: string): string | null {
    const row = this.#db.prepare(`SELECT terms_tokenizer_id FROM cognitive_memory_v2_namespaces WHERE namespace_key = ?`)
      .get(key) as { terms_tokenizer_id: string | null } | undefined
    return row?.terms_tokenizer_id ?? null
  }

  /** The dictionary a plan asks for: empty when the world disabled it, derived from its own sources when not. */
  #dictionaryFor(key: string, plan: RecallQueryPlanV2): ReadonlySet<string> {
    return plan.dictionaryEnabled
      ? this.#dictionaryTerms(key, plan.asOfWorldSeq, plan.tokenizerId)
      : new Set<string>()
  }

  #countV2Documents(key: string, asOfWorldSeq: number): number {
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS total FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND source_seq <= ?
    `).get(key, asOfWorldSeq) as { total: number }
    return row.total
  }

  /**
   * Match candidates and rank them with statistics taken only from this namespace and as-of prefix, so
   * another character's text or a later event cannot change this result. A token's rarity inside the
   * prefix is what separates an entry that is about the query from one that merely shares a common word.
   *
   * Clue terms take part in matching so a memory the current situation points at is not missed, but only
   * at the lowest weight tier, and a term the query already carries keeps the query's higher weight.
   *
   * `dictionaryTerms` are names the character may treat as proper nouns. They only raise a term's weight,
   * never admit a candidate on their own, which is why a dictionary change cannot alter what is findable.
   */
  #readV2KeywordCandidates(
    key: string,
    asOfWorldSeq: number,
    queryTokens: readonly KeywordToken[],
    clueTokens: readonly KeywordToken[],
    dictionaryTerms: ReadonlySet<string>,
  ): readonly {
    readonly memoryId: string
    readonly score: number
    readonly matchedTokens: readonly string[]
    readonly clueMatched: boolean
    readonly sourceRef: ContextSourceRef
  }[] {
    const documentCount = this.#countV2Documents(key, asOfWorldSeq)
    const weights = new Map(queryTokens.map(token => [token.token, token.weight]))
    const clueTerms = new Set<string>()
    for (const token of clueTokens) {
      if (weights.has(token.token)) continue
      weights.set(token.token, 1)
      clueTerms.add(token.token)
    }
    const terms = [...weights.keys()]
    const placeholders = terms.map(() => '?').join(', ')
    const rows = this.#db.prepare(`
      SELECT t.memory_id, t.token, s.source_id, s.source_seq, s.source_hash
      FROM cognitive_memory_v2_terms t
      JOIN cognitive_memory_v2_sources s
        ON s.namespace_key = t.namespace_key AND s.memory_id = t.memory_id
      WHERE t.namespace_key = ? AND t.source_seq <= ? AND t.token IN (${placeholders})
    `).all(key, asOfWorldSeq, ...terms) as Array<{
      memory_id: string
      token: string
      source_id: string
      source_seq: number
      source_hash: WorldHash
    }>
    const documentsByToken = new Map<string, Set<string>>()
    const matched = new Map<string, {
      tokens: string[]
      sourceId: string
      sourceSeq: number
      sourceHash: WorldHash
    }>()
    for (const row of rows) {
      const documentIds = documentsByToken.get(row.token) ?? new Set<string>()
      documentIds.add(row.memory_id)
      documentsByToken.set(row.token, documentIds)
      const document = matched.get(row.memory_id)
      if (document === undefined) {
        matched.set(row.memory_id, {
          tokens: [row.token], sourceId: row.source_id, sourceSeq: row.source_seq, sourceHash: row.source_hash,
        })
      } else {
        document.tokens.push(row.token)
      }
    }
    return [...matched.entries()].map(([memoryId, document]) => ({
      memoryId,
      matchedTokens: [...document.tokens].sort(compareWorldText),
      score: document.tokens.reduce((total, token) => total
        + (documentCount + 1 - documentsByToken.get(token)!.size) * weights.get(token)!
          * (dictionaryTerms.has(token) ? 2 : 1), 0),
      clueMatched: document.tokens.some(token => clueTerms.has(token)),
      sourceRef: {
        sourceKind: 'world_event' as const, sourceId: document.sourceId,
        sourceSeq: document.sourceSeq, sourceHash: document.sourceHash,
      },
    // Relevance, then recent first, then the canonical text order. Three stable passes rather than one
    // chained comparator, because a chain would hide its last key behind two keys that never both tie.
    })).sort((left, right) => compareWorldText(left.memoryId, right.memoryId))
      .sort((left, right) => right.sourceRef.sourceSeq - left.sourceRef.sourceSeq)
      .sort((left, right) => right.score - left.score)
  }

  /** Read the selected entries in ranking order. Every identity came from the term join above. */
  #readV2KeywordEntries(key: string, memoryIds: readonly string[]): CognitiveMemoryEntry[] {
    if (memoryIds.length === 0) return []
    const placeholders = memoryIds.map(() => '?').join(', ')
    const rows = this.#db.prepare(`
      SELECT memory_id, memory_kind, epistemic_kind, text_value, metadata_json,
             source_id, source_seq, source_hash, capture_hash
      FROM cognitive_memory_v2_sources WHERE namespace_key = ? AND memory_id IN (${placeholders})
    `).all(key, ...memoryIds) as Array<{
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
    const byId = new Map(rows.map(row => [row.memory_id, row]))
    return memoryIds.map(memoryId => {
      const row = byId.get(memoryId)!
      return {
        memoryId: row.memory_id, memoryKind: row.memory_kind, epistemicKind: row.epistemic_kind,
        text: row.text_value, metadata: parseWorldJson(row.metadata_json),
        sourceRef: {
          sourceKind: 'world_event', sourceId: row.source_id,
          sourceSeq: row.source_seq, sourceHash: row.source_hash,
        },
        captureHash: row.capture_hash,
      }
    })
  }

  /**
   * Validate a keyword plan and refuse one whose namespace has no keyword index. An unbuilt index means a
   * world declared the strategy without a catch-up building it, so this degrades the participant for the
   * Round instead of quietly returning an empty Recall that looks like "nothing was remembered".
   */
  #assertV2KeywordPlan(
    plan: RecallQueryPlanV2,
  ): { readonly key: string; readonly watermark: CognitiveMemoryWatermark } {
    if (!Number.isSafeInteger(plan.asOfWorldSeq) || plan.asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    if (!Number.isSafeInteger(plan.resultLimit) || plan.resultLimit <= 0) throw new RangeError('resultLimit must be a positive safe integer')
    if (plan.strategyId !== RECALL_KEYWORD_STRATEGY_ID) throw new TypeError('strategyId is unsupported')
    if (plan.tokenizerId !== RECALL_KEYWORD_TOKENIZER_ID && plan.tokenizerId !== RECALL_HYBRID_TOKENIZER_ID) {
      throw new TypeError('tokenizerId is unsupported')
    }
    for (const clue of plan.clues) {
      if (clue.kind !== 'present_character' && clue.kind !== 'open_objective') {
        throw new TypeError('clue kind is unsupported')
      }
    }
    const key = namespace(plan.address, plan.characterId)
    if (this.#v2TermsTokenizer(key) !== plan.tokenizerId) {
      failWorld({
        errorCode: 'MEMORY_CATCHUP_FAILED', category: 'runtime',
        message: 'Cognitive Memory keyword index has not been built for this namespace', retryable: true,
        correlationId: `recall:${plan.planId}`, address: plan.address,
        details: { characterId: plan.characterId, tokenizerId: plan.tokenizerId },
      })
    }
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
    return { key, watermark }
  }

  /**
   * Rebuild the namespace's L1 Summaries from the committed Rounds they cover.
   *
   * A group is a whole number of Rounds rather than a fixed record count, because `world.tick-advanced`
   * is committed exactly once per Round and therefore names where one Round ends and the next begins.
   * Grouping by record count cut an arbitrary line through the middle of a Round and discarded a
   * trailing group of one, so the newest Memories had no Summary at all.
   */
  #replaceV2Summaries(
    key: string,
    address: WorldAddress,
    characterId: CharacterId,
    entries: readonly CognitiveMemoryEntry[],
    rounds: readonly SummaryRound[],
  ): ExtractiveL1Summary[] {
    this.#db.prepare(`DELETE FROM cognitive_memory_v2_summaries WHERE namespace_key = ?`).run(key)
    const summaries: ExtractiveL1Summary[] = []
    for (const chunk of groupMemoriesByRounds(entries, rounds)) {
      const sourceRefs = chunk.map(entry => entry.sourceRef)
      const extracts = digestExtracts(chunk, rounds)
      const sourceStartSeq = sourceRefs[0]!.sourceSeq
      const sourceEndSeq = sourceRefs.at(-1)!.sourceSeq
      const summaryId = deterministicId('memory-l1-summary/v1', { address, characterId, sourceRefs })
      const summaryInput = {
        schemaVersion: 'memory-l1/v1' as const, summaryId, address, characterId,
        sourceStartSeq, sourceEndSeq, sourceRefs, extracts,
        algorithmId: 'deterministic-rollup-l1/v2' as const,
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

  /**
   * The sequence that closes each committed Round, read from the World Event Log.
   *
   * A Summary groups whole Rounds, and the Tick event is the only durable statement of where one Round
   * ends. It reads one event per Round rather than the whole log.
   */
  #summaryRounds(address: WorldAddress, asOfWorldSeq: number): SummaryRound[] {
    return this.#worldStore.readEventsRange(address, 0, asOfWorldSeq, ['world.tick-advanced'])
      .map(event => {
        const data = objectValue(event.data, `world.tick-advanced@${event.seq}`)
        if (!Number.isSafeInteger(data.tick) || (data.tick as number) < 0) {
          throw new Error(`world.tick-advanced@${event.seq} requires a non-negative integer tick`)
        }
        return { endSeq: event.seq, tick: data.tick as number }
      })
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
