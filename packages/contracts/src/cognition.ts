import { hashWorldJson, type WorldHash, type WorldJsonObject } from './world-json.ts'

export const AWARENESS_LEVELS = Object.freeze(['conscious', 'partially_conscious', 'unrecognized'] as const)
export type AwarenessLevel = typeof AWARENESS_LEVELS[number]

export const CLAIM_STANCES = Object.freeze(['believed', 'suspected', 'doubted', 'denied'] as const)
export type ClaimStance = typeof CLAIM_STANCES[number]

export const RELATIONSHIP_TYPES = Object.freeze([
  'affection', 'trust', 'distrust', 'respect', 'dependence',
  'obligation', 'resentment', 'fear', 'envy', 'rivalry',
] as const)
export type RelationshipType = typeof RELATIONSHIP_TYPES[number]
export const RELATIONSHIP_STATUSES = Object.freeze(['active', 'resolved'] as const)
export type RelationshipStatus = typeof RELATIONSHIP_STATUSES[number]

export const AFFECT_TYPES = Object.freeze([
  'joy', 'sadness', 'anger', 'fear', 'anxiety', 'shame', 'guilt',
  'relief', 'hope', 'disgust', 'pride', 'loneliness', 'surprise', 'curiosity',
] as const)
export type AffectType = typeof AFFECT_TYPES[number]
export const AFFECT_EXPRESSION_MODES = Object.freeze(['concealed', 'restrained', 'leaking', 'overt'] as const)
export type AffectExpressionMode = typeof AFFECT_EXPRESSION_MODES[number]
export const AFFECT_DURATIONS = Object.freeze(['momentary', 'short_lived', 'sustained', 'persistent_until_resolved'] as const)
export type AffectDuration = typeof AFFECT_DURATIONS[number]
export const AFFECT_STATUSES = Object.freeze(['active', 'resolved'] as const)
export type AffectStatus = typeof AFFECT_STATUSES[number]

export const TENSION_POLE_TENDENCIES = Object.freeze(['pursue', 'avoid', 'preserve', 'change', 'express', 'conceal'] as const)
export type TensionPoleTendency = typeof TENSION_POLE_TENDENCIES[number]
export const TENSION_RESOLUTION_KINDS = Object.freeze([
  'choice_made', 'integrated', 'external_condition_changed', 'source_state_resolved', 'superseded',
] as const)
export type TensionResolutionKind = typeof TENSION_RESOLUTION_KINDS[number]
export const TENSION_STATUSES = Object.freeze(['active', 'resolved'] as const)
export type TensionStatus = typeof TENSION_STATUSES[number]

export const GOAL_STATUSES = Object.freeze(['active', 'blocked', 'completed', 'abandoned', 'failed'] as const)
export type GoalStatus = typeof GOAL_STATUSES[number]
export const GOAL_OBJECTIVE_KINDS = Object.freeze(['registered', 'narrative'] as const)
export type GoalObjectiveKind = typeof GOAL_OBJECTIVE_KINDS[number]

export const COMMITMENT_ORIGINS = Object.freeze(['promise', 'agreement', 'accepted_request', 'duty', 'self_commitment'] as const)
export type CommitmentOrigin = typeof COMMITMENT_ORIGINS[number]
export const COMMITMENT_STATUSES = Object.freeze(['active', 'fulfilled', 'breached', 'released', 'renounced'] as const)
export type CommitmentStatus = typeof COMMITMENT_STATUSES[number]

export const OPEN_LOOP_KINDS = Object.freeze(['question', 'request', 'offer', 'decision_pending', 'follow_up'] as const)
export type OpenLoopKind = typeof OPEN_LOOP_KINDS[number]
export const OPEN_LOOP_STATUSES = Object.freeze(['open', 'answered', 'resolved', 'dismissed', 'expired'] as const)
export type OpenLoopStatus = typeof OPEN_LOOP_STATUSES[number]

export interface VocabularyManifest extends WorldJsonObject {
  readonly vocabularyId: string
  readonly termGroups: WorldJsonObject
}

export interface VocabularyLock extends WorldJsonObject {
  readonly vocabularyId: string
  readonly vocabularyHash: WorldHash
}

function vocabulary(vocabularyId: string, termGroups: WorldJsonObject): VocabularyManifest {
  return Object.freeze({ vocabularyId, termGroups: Object.freeze({ ...termGroups }) })
}

export const PHASE8_VOCABULARIES = Object.freeze([
  vocabulary('cognition-basic/v1', {
    awarenessLevels: AWARENESS_LEVELS,
    claimStances: CLAIM_STANCES,
    goalObjectiveKinds: GOAL_OBJECTIVE_KINDS,
    goalStatuses: GOAL_STATUSES,
    commitmentOrigins: COMMITMENT_ORIGINS,
    commitmentStatuses: COMMITMENT_STATUSES,
    openLoopKinds: OPEN_LOOP_KINDS,
    openLoopStatuses: OPEN_LOOP_STATUSES,
  }),
  vocabulary('relationship-basic/v1', {
    relationshipTypes: RELATIONSHIP_TYPES,
    relationshipStatuses: RELATIONSHIP_STATUSES,
  }),
  vocabulary('affect-basic/v1', {
    affectTypes: AFFECT_TYPES,
    expressionModes: AFFECT_EXPRESSION_MODES,
    durations: AFFECT_DURATIONS,
    affectStatuses: AFFECT_STATUSES,
  }),
  vocabulary('inner-tension-basic/v1', {
    poleTendencies: TENSION_POLE_TENDENCIES,
    resolutionKinds: TENSION_RESOLUTION_KINDS,
    tensionStatuses: TENSION_STATUSES,
  }),
])

export const PHASE8_VOCABULARY_LOCKS: readonly VocabularyLock[] = Object.freeze(
  PHASE8_VOCABULARIES.map(entry => Object.freeze({
    vocabularyId: entry.vocabularyId,
    vocabularyHash: hashWorldJson('phase8-vocabulary/v1', entry),
  })),
)

export const PHASE8_VOCABULARY_REGISTRY_HASH = hashWorldJson(
  'phase8-vocabulary-registry/v1',
  { locks: PHASE8_VOCABULARY_LOCKS },
)
