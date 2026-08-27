import type { CharacterId } from './ids.ts'
import type { ContextSourceRef } from './context-v2.ts'
import type { WorldAddress } from './protocol.ts'
import type { WorldHash, WorldJsonObject, WorldJsonValue } from './world-json.ts'

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
