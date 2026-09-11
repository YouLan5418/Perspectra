import type { CharacterId } from './ids.ts'
import type { ContextSourceRef } from './context-v2.ts'
import type { WorldAddress } from './protocol.ts'
import type { WorldHash, WorldJsonObject, WorldJsonValue } from './world-json.ts'

export const COGNITIVE_MEMORY_KINDS = Object.freeze([
  'episodic', 'communication', 'belief', 'intention',
] as const)
export type CognitiveMemoryKind = typeof COGNITIVE_MEMORY_KINDS[number]

export const COGNITIVE_EPISTEMIC_KINDS = Object.freeze([
  'direct_observation', 'observed_action', 'reported_speech',
  'subjective_inference', 'self_intention', 'derived_summary',
] as const)
export type CognitiveEpistemicKind = typeof COGNITIVE_EPISTEMIC_KINDS[number]

export interface CognitiveMemoryEntry extends WorldJsonObject {
  readonly memoryId: string
  readonly memoryKind: CognitiveMemoryKind
  readonly epistemicKind: CognitiveEpistemicKind
  readonly text: string
  readonly metadata: WorldJsonValue
  readonly sourceRef: ContextSourceRef
  readonly captureHash: WorldHash
}

export interface CognitiveMemoryWatermark extends WorldJsonObject {
  readonly schemaVersion: 'cognitive-memory-watermark/v2'
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly verifiedThroughSeq: number
  readonly capturedThroughSeq: number
  readonly memoryEpoch: number
  readonly sourceMapHash: WorldHash
}

export interface CognitiveMemoryReceipt extends WorldJsonObject {
  readonly schemaVersion: 'cognitive-memory-receipt/v2'
  readonly receiptId: string
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly requiredAsOfSeq: number
  readonly watermark: CognitiveMemoryWatermark
  readonly sourceBundleHash: WorldHash
  readonly capturedMemoryIds: readonly string[]
  readonly summaryIds: readonly string[]
  readonly receiptHash: WorldHash
}

export interface RecallQueryPlan extends WorldJsonObject {
  readonly schemaVersion: 'recall-query-plan/v1'
  readonly planId: string
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly query: string
  readonly limit: number
  readonly rankingAlgorithm: 'fts5-bm25-stable/v1'
}

export interface RecallRanking extends WorldJsonObject {
  readonly memoryId: string
  readonly rank: number
  readonly sourceRef: ContextSourceRef
}

export interface RecallReceipt extends WorldJsonObject {
  readonly schemaVersion: 'recall-receipt/v1'
  readonly receiptId: string
  readonly planHash: WorldHash
  readonly queryHash: WorldHash
  readonly resultHash: WorldHash
  readonly watermark: CognitiveMemoryWatermark
  readonly selectedSourceRefs: readonly ContextSourceRef[]
  readonly ranking: readonly RecallRanking[]
  readonly exclusionReasons: readonly ('as_of_future' | 'source_unverified' | 'retention_ineligible')[]
  readonly receiptHash: WorldHash
}

export interface CognitiveRecallResult extends WorldJsonObject {
  readonly memories: readonly CognitiveMemoryEntry[]
  readonly receipt: RecallReceipt
}

export interface ExtractiveL1Summary extends WorldJsonObject {
  readonly schemaVersion: 'memory-l1/v1'
  readonly summaryId: string
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly sourceStartSeq: number
  readonly sourceEndSeq: number
  readonly sourceRefs: readonly ContextSourceRef[]
  readonly extracts: readonly string[]
  readonly algorithmId: 'deterministic-extractive-l1/v1'
  readonly summaryHash: WorldHash
}

/**
 * Identifiers of the versioned keyword Recall path. The contract names the versions; the Memory
 * package implements them. An unknown identifier fails closed instead of falling back to another rule.
 */
export const RECALL_KEYWORD_STRATEGY_ID = 'cjk-ngram-stable/v1'
export type RecallKeywordStrategyId = typeof RECALL_KEYWORD_STRATEGY_ID
/**
 * Tokenizer versions. `cjk-ngram/v1` is the in-repo overlapping n-gram tokenizer and stays the
 * dependency-free fallback; `jieba-hybrid/v1` adds real word boundaries from the pinned `jieba-wasm`
 * segmenter on top of the same n-grams, which remain the recall floor so a partial mention of a longer
 * or compound word still matches.
 */
export const RECALL_KEYWORD_TOKENIZER_ID = 'cjk-ngram/v1'
export const RECALL_HYBRID_TOKENIZER_ID = 'jieba-hybrid/v1'
export type RecallKeywordTokenizerId = typeof RECALL_KEYWORD_TOKENIZER_ID
export type RecallHybridTokenizerId = typeof RECALL_HYBRID_TOKENIZER_ID
export type RecallTokenizerId = RecallKeywordTokenizerId | RecallHybridTokenizerId

/**
 * One structural clue that widens Recall beyond the current stimulus. A clue is derived from an
 * authorized, rebuildable source — the Scene's authoritative membership, or one of this character's own
 * active records — and carries the searchable text that source implies. Clues never widen permission,
 * as-of or source closure; they only add candidates at the lowest weight tier.
 */
export interface RecallClue extends WorldJsonObject {
  readonly kind: 'present_character' | 'open_objective'
  /** The authorized identity the clue came from: a Scene member or one of this character's records. */
  readonly sourceId: string
  /** Searchable text derived from that source, tokenized by the tokenizer the plan names. */
  readonly text: string
}

/**
 * Recall plan v2, coexisting with v1. A world that has not declared the new strategy keeps using v1,
 * so its existing receipts stay rebuildable and an upgrade cannot change an already-prepared Round.
 *
 * `dictionaryEnabled` declares that the versioned proper-noun dictionary participates in ranking.
 * Until that dictionary exists the Memory package rejects `true` rather than accepting a plan whose
 * behaviour it cannot honour; the field is part of the shape now so the receipt format does not have
 * to change when the dictionary lands.
 */
export interface RecallQueryPlanV2 extends WorldJsonObject {
  readonly schemaVersion: 'recall-query-plan/v2'
  readonly planId: string
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly queryText: string
  readonly strategyId: RecallKeywordStrategyId
  readonly tokenizerId: RecallTokenizerId
  readonly dictionaryEnabled: boolean
  readonly dictionaryWatermark: number | null
  /** Structural clues used for this Recall; empty means this Recall is keyword-only. */
  readonly clues: readonly RecallClue[]
  readonly resultLimit: number
}

/** Why the keyword strategy withheld something a caller might have expected. */
export const RECALL_EXCLUSION_REASONS_V2 = Object.freeze(['no_match', 'result_limit'] as const)
export type RecallExclusionReasonV2 = typeof RECALL_EXCLUSION_REASONS_V2[number]

export interface RecallKeywordRanking extends WorldJsonObject {
  readonly memoryId: string
  readonly rank: number
  /** Integer relevance from this namespace and as-of prefix only; larger means more relevant. */
  readonly score: number
  readonly matchedTokens: readonly string[]
  /** True when this candidate matched at least one structural clue rather than only the query text. */
  readonly clueMatched: boolean
  readonly sourceRef: ContextSourceRef
}

/** Recall receipt v2. It records what the result limit hid, which the v1 shape had no field for. */
export interface RecallReceiptV2 extends WorldJsonObject {
  readonly schemaVersion: 'recall-receipt/v2'
  readonly receiptId: string
  readonly planHash: WorldHash
  readonly strategyId: RecallKeywordStrategyId
  readonly tokenizerId: RecallTokenizerId
  readonly dictionaryEnabled: boolean
  readonly dictionaryWatermark: number | null
  /** The structural clues this Recall ran with, so an operator can explain what widened it. */
  readonly clueIds: readonly string[]
  readonly watermark: CognitiveMemoryWatermark
  /** Candidates that matched at least one query token, before the result limit was applied. */
  readonly matchedCount: number
  /** Candidates the result limit withheld; zero when everything that matched was returned. */
  readonly droppedByResultLimit: number
  readonly selectedSourceRefs: readonly ContextSourceRef[]
  readonly ranking: readonly RecallKeywordRanking[]
  readonly exclusionReasons: readonly RecallExclusionReasonV2[]
  readonly resultHash: WorldHash
  readonly receiptHash: WorldHash
}

export interface CognitiveRecallResultV2 extends WorldJsonObject {
  readonly memories: readonly CognitiveMemoryEntry[]
  readonly receipt: RecallReceiptV2
}

/**
 * A consumer receives whichever version the producing Memory boundary selected, so both must be
 * handled explicitly. A plan and its receipt always share one generation: a v2 plan is answered by a v2
 * receipt, and a mismatch is an integrity fault rather than something to reinterpret.
 */
export type AnyRecallQueryPlan = RecallQueryPlan | RecallQueryPlanV2
export type AnyCognitiveRecallResult = CognitiveRecallResult | CognitiveRecallResultV2
