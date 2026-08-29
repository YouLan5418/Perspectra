import { hashWorldJson, type WorldHash, type WorldJsonObject, type WorldJsonValue } from './world-json.ts'

export interface Phase8RegistryMember extends WorldJsonObject {
  readonly id: string
  readonly version: string
  readonly contractHash: WorldHash
}

export interface Phase8RegistryManifest extends WorldJsonObject {
  readonly registryId: string
  readonly version: '1.0.0'
  readonly members: readonly Phase8RegistryMember[]
}

export interface Phase8RegistryLock extends WorldJsonObject {
  readonly registryId: string
  readonly version: '1.0.0'
  readonly registryHash: WorldHash
}

export interface Phase8ContextProfile extends WorldJsonObject {
  readonly profileId: 'compact' | 'standard' | 'deep'
  readonly maximumRequestBytes: number
  readonly recentInteractionBlocks: number
  readonly recallResults: number
  readonly checkpointActiveCognition: number
  readonly sceneVisibleSubjects: number
  readonly activeClaims: number
  readonly activeGoals: number
  readonly relationshipFacets: number
  readonly activeAffects: number
  readonly activeInnerTensions: number
  readonly activeCommitments: number
  readonly openLoops: number
}

export interface Phase8ReflectionProfile extends WorldJsonObject {
  readonly profileId: 'standard'
  readonly maximumOperations: 4
  readonly maximumNewActivePerKind: 2
  readonly maximumMagnitudeChangePermille: 200
  readonly maximumNarrativeBytesPerOperation: number
  readonly maximumNarrativeBytesPerBatch: number
}

export interface Phase8ProviderQualityProfile extends WorldJsonObject {
  readonly schemaVersion: 'provider-quality/v1'
  readonly invalidReflectionThreshold: 3
  readonly reflectionPauseEligibleTicks: 4
  readonly invalidResponseThreshold: 3
  readonly probeBackoffEligibleTicks: readonly [1, 2, 4, 8]
}

export interface Phase8SubmitActionsProfile extends WorldJsonObject {
  readonly schemaVersion: 'submit_actions/v2'
  readonly maximumExternalActions: 2
  readonly maximumReflectionOperations: 4
}

export const PHASE8_REFLECTION_PROFILE: Phase8ReflectionProfile = Object.freeze({
  profileId: 'standard',
  maximumOperations: 4,
  maximumNewActivePerKind: 2,
  maximumMagnitudeChangePermille: 200,
  maximumNarrativeBytesPerOperation: 4 * 1024,
  maximumNarrativeBytesPerBatch: 16 * 1024,
})

export const PHASE8_PROVIDER_QUALITY_PROFILE: Phase8ProviderQualityProfile = Object.freeze({
  schemaVersion: 'provider-quality/v1',
  invalidReflectionThreshold: 3,
  reflectionPauseEligibleTicks: 4,
  invalidResponseThreshold: 3,
  probeBackoffEligibleTicks: Object.freeze([1, 2, 4, 8] as const),
})

export const PHASE8_SUBMIT_ACTIONS_PROFILE: Phase8SubmitActionsProfile = Object.freeze({
  schemaVersion: 'submit_actions/v2',
  maximumExternalActions: 2,
  maximumReflectionOperations: 4,
})

export const PHASE8_CONTEXT_PROFILES: readonly Phase8ContextProfile[] = Object.freeze([
  Object.freeze({
    profileId: 'compact', maximumRequestBytes: 32 * 1024, recentInteractionBlocks: 4, recallResults: 6,
    checkpointActiveCognition: 12, sceneVisibleSubjects: 16, activeClaims: 8, activeGoals: 4,
    relationshipFacets: 8, activeAffects: 4, activeInnerTensions: 2, activeCommitments: 4, openLoops: 6,
  }),
  Object.freeze({
    profileId: 'standard', maximumRequestBytes: 96 * 1024, recentInteractionBlocks: 10, recallResults: 16,
    checkpointActiveCognition: 32, sceneVisibleSubjects: 48, activeClaims: 16, activeGoals: 8,
    relationshipFacets: 16, activeAffects: 8, activeInnerTensions: 4, activeCommitments: 8, openLoops: 12,
  }),
  Object.freeze({
    profileId: 'deep', maximumRequestBytes: 192 * 1024, recentInteractionBlocks: 20, recallResults: 32,
    checkpointActiveCognition: 64, sceneVisibleSubjects: 96, activeClaims: 32, activeGoals: 16,
    relationshipFacets: 32, activeAffects: 12, activeInnerTensions: 8, activeCommitments: 16, openLoops: 24,
  }),
])

function member(id: string, version: string, contract: WorldJsonValue): Phase8RegistryMember {
  return Object.freeze({ id, version, contractHash: hashWorldJson('phase8-registry-member-contract/v1', contract) })
}

function registry(registryId: string, members: readonly Phase8RegistryMember[]): Phase8RegistryManifest {
  return Object.freeze({ registryId, version: '1.0.0', members: Object.freeze([...members]) })
}

export const PHASE8_REGISTRIES: readonly Phase8RegistryManifest[] = Object.freeze([
  registry('context-registry/v1', [
    member('character-controller', '2.0.0', { schemaVersion: 'character-controller/v2' }),
    member('director-planning', '1.0.0', { schemaVersion: 'director-planning/v1' }),
    member('context-receipt', '1.0.0', { schemaVersion: 'context-receipt/v1' }),
    member('continuity-checkpoint', '1.0.0', { schemaVersion: 'continuity-checkpoint/v1', summarySource: 'memory-l1/v1' }),
  ]),
  registry('scene-registry/v1', [
    member('scene-decision', '2.0.0', { schemaVersion: 'scene-decision/v2', visibilityScopes: ['scene_public', 'direct', 'private', 'self'] }),
  ]),
  registry('memory-registry/v1', [
    member('cognitive-memory', '2.0.0', {
      schemaVersion: 'cognitive-memory/v2',
      captureKinds: ['episodic', 'communication', 'belief', 'intention'],
      summaryPolicy: 'deterministic-extractive-l1/v1',
    }),
  ]),
  registry('cognitive-policy-registry/v1', [
    member('cognitive-policy', '1.0.0', { schemaVersion: 'cognitive-policy/v1' }),
    member('reflection-policy:standard', '1.0.0', PHASE8_REFLECTION_PROFILE),
    member('provider-quality', '1.0.0', PHASE8_PROVIDER_QUALITY_PROFILE),
  ]),
  registry('renderer-registry/v1', [
    member('character-controller-cache', '1.0.0', { schemaVersion: 'character-controller-cache/v1' }),
    member('structured-prompt-renderer', '1.0.0', { schemaVersion: 'structured-prompt-renderer/v1' }),
  ]),
  registry('tool-schema-registry/v1', [
    member('submit_actions', '2.0.0', PHASE8_SUBMIT_ACTIONS_PROFILE),
    member('submit_director_plan', '1.0.0', { schemaVersion: 'submit_director_plan/v1' }),
  ]),
  registry('context-profile-registry/v1', PHASE8_CONTEXT_PROFILES.map(profile => (
    member(`context-profile:${profile.profileId}`, '1.0.0', profile)
  ))),
])

export const PHASE8_REGISTRY_LOCKS: readonly Phase8RegistryLock[] = Object.freeze(
  PHASE8_REGISTRIES.map(manifest => Object.freeze({
    registryId: manifest.registryId,
    version: manifest.version,
    registryHash: hashWorldJson('phase8-registry/v1', manifest),
  })),
)

export const PHASE8_REGISTRY_SET_HASH = hashWorldJson('phase8-registry-set/v1', { locks: PHASE8_REGISTRY_LOCKS })
