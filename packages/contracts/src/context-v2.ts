import type {
  CharacterId,
  ContinuityCheckpointId,
  ContextReceiptId,
  InteractionRoundId,
  TransactionId,
} from './ids.ts'
import { assertProtocolString } from './ids.ts'
import type { WorldAddress } from './protocol.ts'
import { hashWorldJson, type WorldHash, type WorldJsonObject, type WorldJsonValue } from './world-json.ts'

export const CHARACTER_CONTEXT_SEGMENT_KINDS = Object.freeze([
  'host_protocol',
  'controller_contract',
  'world_public_anchor',
  'character_anchor',
  'continuity_checkpoint',
  'recent_interaction_tail',
  'current_self_state',
  'current_scene',
  'verified_recall',
  'current_stimulus',
  'affordances',
  'output_reminder',
] as const)
export type CharacterContextSegmentKind = typeof CHARACTER_CONTEXT_SEGMENT_KINDS[number]

export type ContextParticipantKind = 'character' | 'director'
export type ContextProfileId = 'compact' | 'standard' | 'deep'

export const DRAMATIC_SIGNAL_TYPES = Object.freeze([
  'scene_stalled',
  'open_loop_high_priority',
  'conflict_pressure_high',
  'participant_unavailable',
] as const)
export type DramaticSignalType = typeof DRAMATIC_SIGNAL_TYPES[number]

export const DIRECTOR_DIRECTIVE_TYPES = Object.freeze([
  'take_initiative',
  'address_open_loop',
  'attend_to_visible_entity',
  'consider_active_goal',
  'deescalate',
  'maintain_restraint',
  'pause_and_observe',
] as const)
export type DirectorDirectiveType = typeof DIRECTOR_DIRECTIVE_TYPES[number]

export interface ContextSourceRef extends WorldJsonObject {
  readonly sourceKind: string
  readonly sourceId: string
  readonly sourceSeq: number
  readonly sourceHash: WorldHash
}

export interface ContextSegment extends WorldJsonObject {
  readonly segmentKind: CharacterContextSegmentKind
  readonly content: WorldJsonValue
  readonly sourceRefs: readonly ContextSourceRef[]
  readonly segmentHash: WorldHash
}

export interface CharacterContextHashInput extends WorldJsonObject {
  readonly schemaVersion: 'character-controller/v2'
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly characterId: CharacterId
  readonly controllerId: string
  readonly controllerEpoch: number
  readonly baseHeadSeq: number
  readonly asOfWorldSeq: number
  readonly tick: number
  readonly manifestHash: WorldHash
  readonly contextProfileId: ContextProfileId
  readonly segments: readonly ContextSegment[]
}

export interface CharacterContextBundle extends CharacterContextHashInput {
  readonly contextHash: WorldHash
}

export interface CheckpointCognitionEntry extends WorldJsonObject {
  readonly kind: string
  readonly id: string
  readonly value: WorldJsonValue
  readonly sourceRef: ContextSourceRef
}

export interface CheckpointSummaryRef extends WorldJsonObject {
  readonly summaryId: string
  readonly sourceStartSeq: number
  readonly sourceEndSeq: number
  readonly summaryHash: WorldHash
}

export interface CharacterContinuityCheckpointInput extends WorldJsonObject {
  readonly schemaVersion: 'continuity-checkpoint/v1'
  readonly checkpointId: ContinuityCheckpointId
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly memoryEpoch: number
  readonly sourceStartSeq: number
  readonly sourceEndSeq: number
  readonly activeCognition: readonly CheckpointCognitionEntry[]
  readonly summaryRefs: readonly CheckpointSummaryRef[]
}

export interface CharacterContinuityCheckpoint extends CharacterContinuityCheckpointInput {
  readonly checkpointHash: WorldHash
}

export interface InteractionObservation extends WorldJsonObject {
  readonly observationId: string
  readonly content: WorldJsonValue
  readonly sourceRef: ContextSourceRef
}

export interface InteractionBlockInput extends WorldJsonObject {
  readonly schemaVersion: 'interaction-block/v1'
  readonly transactionId: TransactionId
  readonly roundId: InteractionRoundId
  readonly startSeq: number
  readonly endSeq: number
  readonly tick: number
  readonly observations: readonly InteractionObservation[]
  readonly authorityHash: WorldHash | null
}

export interface InteractionBlock extends InteractionBlockInput {
  readonly blockHash: WorldHash
}

export interface InteractionTailInput extends WorldJsonObject {
  readonly schemaVersion: 'interaction-tail/v1'
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly afterSeq: number
  readonly asOfWorldSeq: number
  readonly blocks: readonly InteractionBlock[]
}

export interface InteractionTail extends InteractionTailInput {
  readonly tailHash: WorldHash
}

export interface DramaticSignal extends WorldJsonObject {
  readonly signalType: DramaticSignalType
  readonly sourceRefs: readonly ContextSourceRef[]
}

export interface DirectorPlanningContextHashInput extends WorldJsonObject {
  readonly schemaVersion: 'director-planning/v1'
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly controllerId: string
  readonly controllerEpoch: number
  readonly baseHeadSeq: number
  readonly asOfWorldSeq: number
  readonly tick: number
  readonly manifestHash: WorldHash
  readonly focalSceneId: string
  readonly publicContext: WorldJsonValue
  readonly dramaticSignals: readonly DramaticSignal[]
  readonly environmentAffordances: readonly string[]
  readonly directiveTargets: readonly string[]
}

export interface DirectorPlanningContext extends DirectorPlanningContextHashInput {
  readonly contextHash: WorldHash
}

export interface ContextVersionLocks extends WorldJsonObject {
  readonly contextSchema: 'character-controller/v2' | 'director-planning/v1'
  readonly contextReceiptSchema: 'context-receipt/v1'
  readonly sceneDecisionSchema: string
  readonly memorySchema: string
  readonly checkpointSchema: string
  readonly rendererSchema: string
}

export interface ContextComponentHashes extends WorldJsonObject {
  readonly characterViewHash: WorldHash | null
  readonly sceneDecisionHash: WorldHash
  readonly checkpointHash: WorldHash | null
  readonly tailHash: WorldHash
  readonly recallHash: WorldHash
  readonly affordanceHash: WorldHash
}

export type ContextExclusionReason =
  | 'audience_forbidden'
  | 'as_of_future'
  | 'profile_capacity'
  | 'budget_trimmed'
  | 'source_unverified'
  | 'not_applicable'

export interface ContextExclusion extends WorldJsonObject {
  readonly reason: ContextExclusionReason
  readonly sourceRefHash: WorldHash | null
}

export interface ContextReceiptInput extends WorldJsonObject {
  readonly schemaVersion: 'context-receipt/v1'
  readonly receiptId: ContextReceiptId
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantKind: ContextParticipantKind
  readonly participantId: string
  readonly subjectCharacterId: CharacterId | null
  readonly controllerId: string
  readonly controllerEpoch: number
  readonly baseHeadSeq: number
  readonly asOfWorldSeq: number
  readonly tick: number
  readonly manifestHash: WorldHash
  readonly contextProfileId: ContextProfileId
  readonly contextProfileHash: WorldHash
  readonly versionLocks: ContextVersionLocks
  readonly componentHashes: ContextComponentHashes
  readonly includedSourceRefs: readonly ContextSourceRef[]
  readonly exclusions: readonly ContextExclusion[]
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
}

export interface ContextReceipt extends ContextReceiptInput {
  readonly receiptHash: WorldHash
}

export interface ProviderRequestHashInput extends WorldJsonObject {
  readonly schemaVersion: 'provider-request-hash/v1'
  readonly contextHash: WorldHash
  readonly rendererId: string
  readonly rendererHash: WorldHash
  readonly toolSchemaId: string
  readonly toolSchemaHash: WorldHash
  readonly providerId: string
  readonly modelId: string
  readonly sampling: WorldJsonObject
  readonly providerUserPartitionValue: string
  readonly exactRequestUtf8Hex: string
}

/** Create one Context segment with a domain-separated content/source hash. */
export function createContextSegment(
  segmentKind: CharacterContextSegmentKind,
  content: WorldJsonValue,
  sourceRefs: readonly ContextSourceRef[],
): ContextSegment {
  if (!(CHARACTER_CONTEXT_SEGMENT_KINDS as readonly string[]).includes(segmentKind)) {
    throw new TypeError(`unknown character context segment ${segmentKind}`)
  }
  const base = { segmentKind, content, sourceRefs: Object.freeze([...sourceRefs]) }
  return Object.freeze({ ...base, segmentHash: hashWorldJson('character-context-segment/v1', base) })
}

/** Hash the post-budget semantic Character Context, excluding Provider layout and transport state. */
export function hashCharacterContext(input: CharacterContextHashInput): WorldHash {
  if (input.segments.length !== CHARACTER_CONTEXT_SEGMENT_KINDS.length) {
    throw new TypeError('character context must contain every fixed segment exactly once')
  }
  for (let index = 0; index < CHARACTER_CONTEXT_SEGMENT_KINDS.length; index += 1) {
    const segment = input.segments[index]
    const expectedKind = CHARACTER_CONTEXT_SEGMENT_KINDS[index]
    if (segment === undefined || segment.segmentKind !== expectedKind) {
      throw new TypeError(`character context segment ${index} must be ${expectedKind}`)
    }
    const expectedHash = hashWorldJson('character-context-segment/v1', {
      segmentKind: segment.segmentKind,
      content: segment.content,
      sourceRefs: segment.sourceRefs,
    })
    if (segment.segmentHash !== expectedHash) {
      throw new TypeError(`character context segment ${segment.segmentKind} hash diverged`)
    }
  }
  const envelope: CharacterContextHashInput = {
    schemaVersion: input.schemaVersion,
    address: input.address,
    roundId: input.roundId,
    participantId: input.participantId,
    characterId: input.characterId,
    controllerId: input.controllerId,
    controllerEpoch: input.controllerEpoch,
    baseHeadSeq: input.baseHeadSeq,
    asOfWorldSeq: input.asOfWorldSeq,
    tick: input.tick,
    manifestHash: input.manifestHash,
    contextProfileId: input.contextProfileId,
    segments: input.segments,
  }
  return hashWorldJson('character-context/v2', envelope)
}

export function hashContinuityCheckpoint(input: CharacterContinuityCheckpointInput): WorldHash {
  return hashWorldJson('continuity-checkpoint/v1', input)
}

export function hashInteractionBlock(input: InteractionBlockInput): WorldHash {
  return hashWorldJson('interaction-block/v1', input)
}

export function hashInteractionTail(input: InteractionTailInput): WorldHash {
  for (const block of input.blocks) {
    const { blockHash: _blockHash, ...base } = block
    if (block.blockHash !== hashInteractionBlock(base)) throw new TypeError('interaction block hash diverged')
  }
  return hashWorldJson('interaction-tail/v1', input)
}

/** Hash the least-privilege Director planning input independently from Character Context. */
export function hashDirectorContext(input: DirectorPlanningContextHashInput): WorldHash {
  const envelope: DirectorPlanningContextHashInput = {
    schemaVersion: input.schemaVersion,
    address: input.address,
    roundId: input.roundId,
    participantId: input.participantId,
    controllerId: input.controllerId,
    controllerEpoch: input.controllerEpoch,
    baseHeadSeq: input.baseHeadSeq,
    asOfWorldSeq: input.asOfWorldSeq,
    tick: input.tick,
    manifestHash: input.manifestHash,
    focalSceneId: input.focalSceneId,
    publicContext: input.publicContext,
    dramaticSignals: input.dramaticSignals,
    environmentAffordances: input.environmentAffordances,
    directiveTargets: input.directiveTargets,
  }
  return hashWorldJson('director-context/v1', envelope)
}

/** Hash a Context receipt independently from the semantic Context and exact Provider request. */
export function hashContextReceipt(input: ContextReceiptInput): WorldHash {
  return hashWorldJson('context-receipt/v1', input)
}

/** Hash exact Provider-visible request bytes and stable layout metadata, excluding transport state. */
export function hashProviderRequest(input: ProviderRequestHashInput): WorldHash {
  assertProtocolString(input.rendererId, 'rendererId')
  assertProtocolString(input.toolSchemaId, 'toolSchemaId')
  assertProtocolString(input.providerId, 'providerId')
  assertProtocolString(input.modelId, 'modelId')
  assertProtocolString(input.providerUserPartitionValue, 'providerUserPartitionValue')
  if (input.exactRequestUtf8Hex.length === 0
    || input.exactRequestUtf8Hex.length % 2 !== 0
    || !/^[0-9a-f]+$/.test(input.exactRequestUtf8Hex)) {
    throw new TypeError('exactRequestUtf8Hex must be non-empty lowercase hexadecimal bytes')
  }
  const envelope: ProviderRequestHashInput = {
    schemaVersion: input.schemaVersion,
    contextHash: input.contextHash,
    rendererId: input.rendererId,
    rendererHash: input.rendererHash,
    toolSchemaId: input.toolSchemaId,
    toolSchemaHash: input.toolSchemaHash,
    providerId: input.providerId,
    modelId: input.modelId,
    sampling: input.sampling,
    providerUserPartitionValue: input.providerUserPartitionValue,
    exactRequestUtf8Hex: input.exactRequestUtf8Hex,
  }
  return hashWorldJson('provider-request/v1', envelope)
}
