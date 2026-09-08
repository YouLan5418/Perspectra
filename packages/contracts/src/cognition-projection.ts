import type { CharacterId } from './ids.ts'
import type { ContextSourceRef } from './context-v2.ts'
import type { WorldAddress } from './protocol.ts'
import type { WorldHash, WorldJsonObject, WorldJsonValue } from './world-json.ts'
import { hashWorldJson } from './world-json.ts'

export const COGNITION_PROJECTION_KINDS = Object.freeze([
  'subjective-claim', 'character-goal', 'relationship-attitude', 'affect-episode',
  'inner-tension', 'commitment', 'open-loop',
] as const)

export type CognitionProjectionKind = typeof COGNITION_PROJECTION_KINDS[number]

export interface CognitionProjectionRecord extends WorldJsonObject {
  readonly kind: CognitionProjectionKind
  readonly id: string
  readonly characterId: CharacterId
  readonly value: WorldJsonValue
  readonly validFromSeq: number
  readonly validToSeq: number | null
  readonly sourceRef: ContextSourceRef
}

export interface CognitionProjectionBundle extends WorldJsonObject {
  readonly address: WorldAddress
  readonly asOfWorldSeq: number
  readonly claims: readonly CognitionProjectionRecord[]
  readonly goals: readonly CognitionProjectionRecord[]
  readonly relationships: readonly CognitionProjectionRecord[]
  readonly affects: readonly CognitionProjectionRecord[]
  readonly innerTensions: readonly CognitionProjectionRecord[]
  readonly commitments: readonly CognitionProjectionRecord[]
  readonly openLoops: readonly CognitionProjectionRecord[]
  readonly bundleHash: WorldHash
}

export interface CharacterCognitionView extends WorldJsonObject {
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly claims: readonly CognitionProjectionRecord[]
  readonly goals: readonly CognitionProjectionRecord[]
  readonly relationships: readonly CognitionProjectionRecord[]
  readonly affects: readonly CognitionProjectionRecord[]
  readonly innerTensions: readonly CognitionProjectionRecord[]
  readonly commitments: readonly CognitionProjectionRecord[]
  readonly openLoops: readonly CognitionProjectionRecord[]
  readonly bundleHash: WorldHash
}

export interface ReflectionOperation extends WorldJsonObject {
  readonly operationId: string
  readonly kind: CognitionProjectionKind
  readonly recordId: string
  /** Null means the record must not exist at the Context Receipt waterline. */
  readonly expectedStateHash: WorldHash | null
  readonly basisRefs: readonly ContextSourceRef[]
  /** The candidate state only. Host-owned source and basisRefs are added after validation. */
  readonly value: WorldJsonObject
}

export interface ReflectionBatch extends WorldJsonObject {
  readonly operations: readonly ReflectionOperation[]
}

export interface SubmitActionsV2 extends WorldJsonObject {
  readonly schemaVersion: 2
  readonly decision: 'act' | 'abstain'
  readonly actions: readonly WorldJsonObject[]
  readonly reflection?: ReflectionBatch
}

export type ManifestationChannel = 'facial' | 'gaze' | 'posture' | 'gesture' | 'voice' | 'appearance'

export interface EventOnlyManifestationCue extends WorldJsonObject {
  readonly cueId: string
  readonly channel: ManifestationChannel
  readonly description: string
  readonly persistence: 'event_only'
}

export interface PersistentManifestationCue extends WorldJsonObject {
  readonly cueId: string
  readonly channel: 'posture' | 'appearance'
  readonly description: string
  readonly persistence: 'until_changed'
  readonly stateKey: string
  readonly operation: 'set' | 'clear'
}

export type ManifestationCueProposal = EventOnlyManifestationCue | PersistentManifestationCue

/** One externally observable performance proposal bound to the output's single Action attempt. */
export interface ManifestationProposal extends WorldJsonObject {
  readonly description?: string
  readonly cues: readonly ManifestationCueProposal[]
}

/** ADR-0083 provider output; older submit_actions versions remain byte-for-byte closed. */
export interface SubmitActionsV3 extends WorldJsonObject {
  readonly schemaVersion: 3
  readonly decision: 'act' | 'abstain'
  readonly actions: readonly WorldJsonObject[]
  readonly reflection?: ReflectionBatch
  readonly manifestation?: ManifestationProposal
}

export interface CognitivePolicyReceipt extends WorldJsonObject {
  readonly schemaVersion: 'cognitive-policy-receipt/v1'
  readonly policyId: 'reflection-policy/standard-v1'
  readonly participantId: string
  readonly characterId: CharacterId
  readonly contextReceiptId: string
  readonly baseStateHash: WorldHash
  readonly candidateStateHash: WorldHash
  readonly status: 'accepted' | 'rejected'
  readonly operationHashes: readonly WorldHash[]
  readonly reasonCode: 'accepted' | 'model_schema_invalid' | 'source_forbidden' | 'state_limit'
  readonly receiptHash: WorldHash
}

/** Hash one current cognition record without coupling optimistic checks to event sequence metadata. */
export function hashCognitionRecordState(
  kind: CognitionProjectionKind,
  id: string,
  characterId: CharacterId,
  value: WorldJsonValue,
): WorldHash {
  return hashWorldJson('character-cognition-record-state/v1', { kind, id, characterId, value })
}
