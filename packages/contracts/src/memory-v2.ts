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
