import type {
  AffectDuration,
  AffectExpressionMode,
  AffectStatus,
  AffectType,
  AwarenessLevel,
  BrandedId,
  CharacterId,
  ClaimStance,
  CommitmentOrigin,
  CommitmentStatus,
  GoalObjectiveKind,
  GoalStatus,
  InteractionCatalogV3,
  InteractionPackageDescription,
  OpenLoopKind,
  OpenLoopStatus,
  Phase8RegistryLock,
  RelationshipStatus,
  RelationshipType,
  SessionId,
  TensionPoleTendency,
  TensionStatus,
  VocabularyLock,
  WorldAddress,
  WorldHash,
  WorldJsonObject,
  WorldJsonValue,
} from '@harness-world/contracts'

export type WorldPackId = BrandedId<'WorldPackId'>
export type WorldPackSlotId = BrandedId<'WorldPackSlotId'>

export const WORLD_PACK_SOURCE_SCHEMA_VERSION = 'worldpack-source/v1' as const
export const WORLD_PACK_COMPILED_SCHEMA_VERSION = 'worldpack/v1' as const
export const WORLD_PACK_COMPILER_ID = 'harness-world-pack-compiler' as const
export const WORLD_PACK_COMPILER_VERSION = '0.1.0' as const
export const WORLD_PACK_COMPILER_CONTRACT_VERSION = 'worldpack-compiler/v1' as const
export const WORLD_PACK_LIMITS_PROFILE = 'worldpack-limits/v1' as const
export const WORLD_PACK_SOURCE_SCHEMA_VERSION_V2 = 'worldpack-source/v2' as const
export const WORLD_PACK_COMPILED_SCHEMA_VERSION_V2 = 'worldpack/v2' as const
export const WORLD_PACK_COMPILER_VERSION_V2 = '0.2.0' as const
export const WORLD_PACK_COMPILER_CONTRACT_VERSION_V2 = 'worldpack-compiler/v2' as const
export const WORLD_PACK_LIMITS_PROFILE_V2 = 'worldpack-limits/v2' as const
export const WORLD_PACK_SOURCE_SCHEMA_VERSION_V3 = 'worldpack-source/v3' as const
export const WORLD_PACK_COMPILED_SCHEMA_VERSION_V3 = 'worldpack/v3' as const
export const WORLD_PACK_COMPILER_VERSION_V3 = '0.3.0' as const
export const WORLD_PACK_COMPILER_CONTRACT_VERSION_V3 = 'worldpack-compiler/v3' as const
export const WORLD_PACK_REACTION_SCHEMA_VERSION = 'worldpack-reaction/v1' as const
export const WORLD_PACK_SOURCE_SCHEMA_VERSION_V4 = 'worldpack-source/v4' as const
export const WORLD_PACK_COMPILED_SCHEMA_VERSION_V4 = 'worldpack/v4' as const
export const WORLD_PACK_COMPILER_VERSION_V4 = '0.4.0' as const
export const WORLD_PACK_COMPILER_CONTRACT_VERSION_V4 = 'worldpack-compiler/v4' as const
export const WORLD_PACK_MANIFESTATION_SCHEMA_VERSION = 'worldpack-manifestation/v1' as const
export const WORLD_PACK_SOURCE_SCHEMA_VERSION_V5 = 'worldpack-source/v5' as const
export const WORLD_PACK_COMPILED_SCHEMA_VERSION_V5 = 'worldpack/v5' as const
export const WORLD_PACK_COMPILER_VERSION_V5 = '0.5.0' as const
export const WORLD_PACK_COMPILER_CONTRACT_VERSION_V5 = 'worldpack-compiler/v5' as const
export const WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2 = 'worldpack-entities/v2' as const
export const WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3 = 'worldpack-characters/v3' as const
export const WORLD_PACK_INTERACTIONS_SCHEMA_VERSION = 'worldpack-interactions/v1' as const

/** Author-declared interaction binding. Identity and version, never a label, select the definition. */
export interface WorldPackInteractionBindingSource extends WorldJsonObject {
  readonly bindingId: string
  readonly definition: { readonly id: string; readonly version: number }
  readonly config: WorldJsonObject
}

export interface WorldPackEntitySourceV2 extends WorldJsonObject {
  readonly entityId: string
  readonly locationId: string
  readonly kind: string
  /** Absent means the target declares no interaction. An empty array is equivalent and allowed. */
  readonly interactionBindings?: readonly WorldPackInteractionBindingSource[]
}

export interface WorldPackEntitiesSourceV2 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_ENTITIES_SCHEMA_VERSION_V2
  readonly entities: readonly WorldPackEntitySourceV2[]
}

export interface WorldPackCharacterSourceV3 extends WorldPackCharacterSourceV2 {
  /** Absent means the target declares no interaction. An empty array is equivalent and allowed. */
  readonly interactionBindings?: readonly WorldPackInteractionBindingSource[]
}

export interface WorldPackCharactersSourceV3 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V3
  readonly characters: readonly WorldPackCharacterSourceV3[]
}

/**
 * A binding to a relation *class*. `relationClass` names the definition whose relation instances the
 * bound definition may address; an instance is never named here, because a relation id is derived at
 * runtime from the source Action and the pair.
 */
export interface WorldPackRelationBindingSource extends WorldJsonObject {
  readonly bindingId: string
  readonly relationClass: string
  readonly definition: { readonly id: string; readonly version: number }
  readonly config: WorldJsonObject
}

/** The world's explicit package and definition selection. Trusted locks are resolved by the compiler. */
export interface WorldPackInteractionsSource extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_INTERACTIONS_SCHEMA_VERSION
  readonly packages: readonly { readonly id: string; readonly version: number }[]
  readonly definitions: readonly { readonly id: string; readonly version: number }[]
  readonly relationBindings?: readonly WorldPackRelationBindingSource[]
}

export interface WorldPackCompileOptions {
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE
}
export interface WorldPackCompileOptionsV2 {
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE_V2
}

export interface WorldPackRulebookProfile extends WorldJsonObject {
  readonly rulebookId: 'builtin:speak-move'
  readonly version: 2
}
export interface WorldPackPluginProfile extends WorldJsonObject {
  readonly pluginId: string
  readonly version: string
}
export interface WorldPackPresentationProfile extends WorldJsonObject {
  readonly profileId: 'builtin:deterministic-presentation'
  readonly version: '1.0.0'
}
export interface WorldPackCoreProfiles extends WorldJsonObject {
  readonly rulebook: WorldPackRulebookProfile
  readonly sceneDecision: WorldPackPluginProfile
  readonly agentContext: WorldPackPluginProfile
  readonly presentation: WorldPackPresentationProfile
}

export const PHASE7_CORE_PROFILES: WorldPackCoreProfiles = Object.freeze({
  rulebook: Object.freeze({ rulebookId: 'builtin:speak-move', version: 2 }),
  sceneDecision: Object.freeze({ pluginId: 'builtin:scene-decision', version: '1.0.0' }),
  agentContext: Object.freeze({ pluginId: 'builtin:agent-context', version: '2.0.0' }),
  presentation: Object.freeze({ profileId: 'builtin:deterministic-presentation', version: '1.0.0' }),
})

export const PHASE8_CORE_PROFILES: WorldPackCoreProfiles = Object.freeze({
  rulebook: Object.freeze({ rulebookId: 'builtin:speak-move', version: 2 }),
  sceneDecision: Object.freeze({ pluginId: 'builtin:scene-decision', version: '2.0.0' }),
  agentContext: Object.freeze({ pluginId: 'builtin:agent-context', version: '2.0.0' }),
  presentation: Object.freeze({ profileId: 'builtin:deterministic-presentation', version: '1.0.0' }),
})

export interface WorldPackSourceManifest extends WorldJsonObject {
  readonly sourceSchemaVersion: typeof WORLD_PACK_SOURCE_SCHEMA_VERSION
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly worldFile: string
  readonly characterFiles: readonly string[]
  readonly locationFiles: readonly string[]
  readonly entityFiles: readonly string[]
  readonly sceneFiles: readonly string[]
  readonly playerSlotFiles: readonly string[]
  readonly presentationFiles: readonly string[]
  readonly markdownFiles: readonly string[]
  readonly assetFiles: readonly string[]
  readonly assertionFiles: readonly string[]
}

export interface WorldPackSourceManifestV2 extends WorldJsonObject {
  readonly sourceSchemaVersion: typeof WORLD_PACK_SOURCE_SCHEMA_VERSION_V2
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly worldFile: string
  readonly characterFiles: readonly string[]
  readonly locationFiles: readonly string[]
  readonly entityFiles: readonly string[]
  readonly sceneFiles: readonly string[]
  readonly playerSlotFiles: readonly string[]
  readonly presentationFiles: readonly string[]
  readonly cognitionFiles: readonly string[]
  readonly memoryFiles: readonly string[]
  readonly documentFiles: readonly string[]
  readonly markdownFiles: readonly string[]
  readonly assetFiles: readonly string[]
  readonly assertionFiles: readonly string[]
}

export interface WorldPackSourceManifestV3 extends WorldJsonObject {
  readonly sourceSchemaVersion: typeof WORLD_PACK_SOURCE_SCHEMA_VERSION_V3
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly worldFile: string
  readonly characterFiles: readonly string[]
  readonly locationFiles: readonly string[]
  readonly entityFiles: readonly string[]
  readonly sceneFiles: readonly string[]
  readonly playerSlotFiles: readonly string[]
  readonly presentationFiles: readonly string[]
  readonly cognitionFiles: readonly string[]
  readonly memoryFiles: readonly string[]
  readonly documentFiles: readonly string[]
  readonly markdownFiles: readonly string[]
  readonly assetFiles: readonly string[]
  readonly assertionFiles: readonly string[]
  readonly reactionFile: string
}

export interface WorldPackSourceManifestV4 extends WorldJsonObject {
  readonly sourceSchemaVersion: typeof WORLD_PACK_SOURCE_SCHEMA_VERSION_V4
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly worldFile: string
  readonly characterFiles: readonly string[]
  readonly locationFiles: readonly string[]
  readonly entityFiles: readonly string[]
  readonly sceneFiles: readonly string[]
  readonly playerSlotFiles: readonly string[]
  readonly presentationFiles: readonly string[]
  readonly cognitionFiles: readonly string[]
  readonly memoryFiles: readonly string[]
  readonly documentFiles: readonly string[]
  readonly markdownFiles: readonly string[]
  readonly assetFiles: readonly string[]
  readonly assertionFiles: readonly string[]
  readonly reactionFile: string
  readonly manifestationFile: string
}

/** V5 adds the world's interaction selection file; every V4 field keeps its meaning. */
export interface WorldPackSourceManifestV5 extends WorldJsonObject {
  readonly sourceSchemaVersion: typeof WORLD_PACK_SOURCE_SCHEMA_VERSION_V5
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly worldFile: string
  readonly characterFiles: readonly string[]
  readonly locationFiles: readonly string[]
  readonly entityFiles: readonly string[]
  readonly sceneFiles: readonly string[]
  readonly playerSlotFiles: readonly string[]
  readonly presentationFiles: readonly string[]
  readonly cognitionFiles: readonly string[]
  readonly memoryFiles: readonly string[]
  readonly documentFiles: readonly string[]
  readonly markdownFiles: readonly string[]
  readonly assetFiles: readonly string[]
  readonly assertionFiles: readonly string[]
  readonly reactionFile: string
  readonly manifestationFile: string
  readonly interactionFile: string
}

export type WorldPackReactionSource =
  | { readonly schemaVersion: typeof WORLD_PACK_REACTION_SCHEMA_VERSION; readonly mode: 'disabled' }
  | { readonly schemaVersion: typeof WORLD_PACK_REACTION_SCHEMA_VERSION; readonly mode: 'responsive'; readonly profile: 'responsive/v1' }

export type WorldPackManifestationSource =
  | { readonly schemaVersion: typeof WORLD_PACK_MANIFESTATION_SCHEMA_VERSION; readonly mode: 'disabled' }
  | { readonly schemaVersion: typeof WORLD_PACK_MANIFESTATION_SCHEMA_VERSION; readonly mode: 'enabled' }

export const WORLD_PACK_COGNITION_SCHEMA_VERSION_V2 = 'worldpack-cognition/v2' as const
export const WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2 = 'worldpack-characters/v2' as const
export const WORLD_PACK_SCENES_SCHEMA_VERSION_V2 = 'worldpack-scenes/v2' as const
export const WORLD_PACK_MEMORY_SCHEMA_VERSION_V2 = 'worldpack-memory/v2' as const
export const WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2 = 'worldpack-documents/v2' as const

export const WORLD_PACK_CONTROLLER_CLASSES_V2 = Object.freeze(['manual', 'scripted'] as const)
export type WorldPackControllerClassV2 = typeof WORLD_PACK_CONTROLLER_CLASSES_V2[number]
export const WORLD_PACK_CHARACTER_LIFECYCLES_V2 = Object.freeze(['active', 'incapacitated', 'dead', 'departed'] as const)
export type WorldPackCharacterLifecycleV2 = typeof WORLD_PACK_CHARACTER_LIFECYCLES_V2[number]
export const WORLD_PACK_SCENE_LIFECYCLES_V2 = Object.freeze(['created', 'active', 'closed'] as const)
export type WorldPackSceneLifecycleV2 = typeof WORLD_PACK_SCENE_LIFECYCLES_V2[number]
export const WORLD_PACK_MEMORY_PROFILES_V2 = Object.freeze(['compact', 'standard', 'deep'] as const)
export type WorldPackMemoryProfileV2 = typeof WORLD_PACK_MEMORY_PROFILES_V2[number]
export const WORLD_PACK_DOCUMENT_USAGES_V2 = Object.freeze(['world_context', 'portrayal', 'memory_seed', 'author_note'] as const)
export type WorldPackDocumentUsageV2 = typeof WORLD_PACK_DOCUMENT_USAGES_V2[number]
export const WORLD_PACK_DOCUMENT_AUDIENCES_V2 = Object.freeze(['public', 'director_visible', 'character_private', 'author_only'] as const)
export type WorldPackDocumentAudienceV2 = typeof WORLD_PACK_DOCUMENT_AUDIENCES_V2[number]
export const WORLD_PACK_INITIAL_OBSERVATION_EPISTEMIC_KINDS_V2 = Object.freeze([
  'direct_observation', 'observed_action', 'reported_speech', 'subjective_inference', 'self_intention',
] as const)
export type WorldPackInitialObservationEpistemicKindV2 = typeof WORLD_PACK_INITIAL_OBSERVATION_EPISTEMIC_KINDS_V2[number]

export interface WorldPackPortrayalTermSourceV2 extends WorldJsonObject {
  readonly key: string
  readonly text: string
}
export interface WorldPackPortrayalSourceV2 extends WorldJsonObject {
  readonly summary: string
  readonly speakingStyle: string
  readonly backgroundTextRef: string | null
  readonly drives: readonly WorldPackPortrayalTermSourceV2[]
  readonly principles: readonly WorldPackPortrayalTermSourceV2[]
}
export interface WorldPackCharacterSourceV2 extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly displayName: string
  readonly controllerClass: WorldPackControllerClassV2
  readonly pronouns: string
  readonly initialLocationId: string | null
  readonly lifecycle: WorldPackCharacterLifecycleV2
  readonly portrayal: WorldPackPortrayalSourceV2 | null
}
export interface WorldPackCharactersSourceV2 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_CHARACTERS_SCHEMA_VERSION_V2
  readonly characters: readonly WorldPackCharacterSourceV2[]
}

export interface WorldPackInitialObservationSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly content: WorldJsonValue
  readonly epistemicKind: WorldPackInitialObservationEpistemicKindV2
  readonly saliencePermille: number
}

export interface WorldPackCognitionBasisSource extends WorldJsonObject {
  readonly basisKeys: readonly string[]
}
export interface WorldPackClaimSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly proposition: WorldJsonValue
  readonly stance: ClaimStance
  readonly confidencePermille: number
  readonly saliencePermille: number
  readonly awareness: AwarenessLevel
  readonly status: 'active'
}
export interface WorldPackGoalObjectiveSourceV2 extends WorldJsonObject {
  readonly kind: GoalObjectiveKind
  readonly value: WorldJsonValue
}
export interface WorldPackGoalSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly objective: WorldPackGoalObjectiveSourceV2
  readonly priorityPermille: number
  readonly awareness: AwarenessLevel
  readonly status: GoalStatus
  readonly parentGoalKey: string | null
  readonly targetKeys: readonly string[]
  readonly blockerKeys: readonly string[]
}
export interface WorldPackRelationshipSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly target: CharacterId
  readonly type: RelationshipType
  readonly facet: string
  readonly intensityPermille: number
  readonly confidencePermille: number
  readonly awareness: AwarenessLevel
  readonly status: RelationshipStatus
}
export interface WorldPackAffectSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly type: AffectType
  readonly intensityPermille: number
  readonly cause: WorldJsonValue
  readonly targetKey: string | null
  readonly awareness: AwarenessLevel
  readonly expressionMode: AffectExpressionMode
  readonly duration: AffectDuration
  readonly status: AffectStatus
}
export interface WorldPackTensionPoleSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly tendency: TensionPoleTendency
  readonly impulseText: string
  readonly strengthPermille: number
  readonly awareness: AwarenessLevel
}
export interface WorldPackInnerTensionSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly title: string
  readonly pressurePermille: number
  readonly awareness: AwarenessLevel
  readonly status: TensionStatus
  readonly poles: readonly WorldPackTensionPoleSourceV2[]
}
export interface WorldPackCommitmentSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly content: WorldJsonValue
  readonly origin: CommitmentOrigin
  readonly saliencePermille: number
  readonly awareness: Exclude<AwarenessLevel, 'unrecognized'>
  readonly status: CommitmentStatus
}
export interface WorldPackOpenLoopSourceV2 extends WorldPackCognitionBasisSource {
  readonly key: string
  readonly kind: OpenLoopKind
  readonly summary: string
  readonly saliencePermille: number
  readonly status: OpenLoopStatus
}
export interface WorldPackCharacterCognitionSourceV2 extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly observations: readonly WorldPackInitialObservationSourceV2[]
  readonly claims: readonly WorldPackClaimSourceV2[]
  readonly goals: readonly WorldPackGoalSourceV2[]
  readonly relationships: readonly WorldPackRelationshipSourceV2[]
  readonly affects: readonly WorldPackAffectSourceV2[]
  readonly innerTensions: readonly WorldPackInnerTensionSourceV2[]
  readonly commitments: readonly WorldPackCommitmentSourceV2[]
  readonly openLoops: readonly WorldPackOpenLoopSourceV2[]
}
export interface WorldPackCognitionSourceV2 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_COGNITION_SCHEMA_VERSION_V2
  readonly characters: readonly WorldPackCharacterCognitionSourceV2[]
}

export interface WorldPackSceneSourceV2 extends WorldJsonObject {
  readonly sceneId: string
  readonly lifecycle: WorldPackSceneLifecycleV2
  readonly locationId: string | null
  readonly participantIds: readonly CharacterId[]
}
export interface WorldPackScenesSourceV2 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_SCENES_SCHEMA_VERSION_V2
  readonly scenes: readonly WorldPackSceneSourceV2[]
}
export interface WorldPackCharacterMemorySourceV2 extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly profile: WorldPackMemoryProfileV2
  readonly attentionTopics: readonly string[]
}
export interface WorldPackMemorySourceV2 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_MEMORY_SCHEMA_VERSION_V2
  readonly characters: readonly WorldPackCharacterMemorySourceV2[]
}
export interface WorldPackDocumentSourceV2 extends WorldJsonObject {
  readonly documentId: string
  readonly contentRef: string
  readonly usage: WorldPackDocumentUsageV2
  readonly audience: WorldPackDocumentAudienceV2
  readonly characterIds: readonly CharacterId[]
}
export interface WorldPackDocumentsSourceV2 extends WorldJsonObject {
  readonly schemaVersion: typeof WORLD_PACK_DOCUMENTS_SCHEMA_VERSION_V2
  readonly documents: readonly WorldPackDocumentSourceV2[]
}

export interface WorldPackInitialFactSource extends WorldJsonObject {
  readonly factId: string
  readonly proposition: WorldJsonValue
  readonly initialAudience: readonly CharacterId[]
}
export interface WorldPackWorldSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-world/v1'
  readonly title: string
  readonly description: string
  readonly timeMode: 'TURN_DRIVEN'
  readonly roundQueueLimit: number
  readonly coreProfiles: WorldPackCoreProfiles
  readonly initialFacts: readonly WorldPackInitialFactSource[]
}

export interface WorldPackLocationSource extends WorldJsonObject {
  readonly locationId: string
  readonly name: string
}
export interface WorldPackLocationsSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-locations/v1'
  readonly locations: readonly WorldPackLocationSource[]
}

export interface WorldPackEntitySource extends WorldJsonObject {
  readonly entityId: string
  readonly locationId: string
  readonly kind: string
}
export interface WorldPackEntitiesSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-entities/v1'
  readonly entities: readonly WorldPackEntitySource[]
}

export interface WorldPackPortrayalSource extends WorldJsonObject {
  readonly summary: string
  readonly speakingStyle: string
  readonly backgroundTextRef: string | null
}
export interface WorldPackInitialObservationSource extends WorldJsonObject {
  readonly observationId: string
  readonly value: WorldJsonValue
}
export interface WorldPackInitialClaimSource extends WorldJsonObject {
  readonly claimId: string
  readonly value: WorldJsonValue
}
export interface WorldPackInitialGoalSource extends WorldJsonObject {
  readonly goalId: string
  readonly value: WorldJsonValue
  readonly priorityPermille: number
  readonly visibility: 'private' | 'public'
}
export interface WorldPackCharacterSource extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly displayName: string
  readonly pronouns: string
  readonly initialLocationId: string
  readonly lifecycle: 'active' | 'incapacitated' | 'dead' | 'departed'
  readonly portrayal: WorldPackPortrayalSource
  readonly initialObservations: readonly WorldPackInitialObservationSource[]
  readonly initialClaims: readonly WorldPackInitialClaimSource[]
  readonly initialGoals: readonly WorldPackInitialGoalSource[]
}
export interface WorldPackCharactersSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-characters/v1'
  readonly characters: readonly WorldPackCharacterSource[]
}

export interface WorldPackSceneSource extends WorldJsonObject {
  readonly sceneId: string
  readonly participantIds: readonly CharacterId[]
}
export interface WorldPackScenesSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-scenes/v1'
  readonly scenes: readonly [WorldPackSceneSource]
}

export interface WorldPackPlayerSlotSource extends WorldJsonObject {
  readonly slotId: WorldPackSlotId
  readonly characterId: CharacterId
  readonly controlMode: 'manual'
}
export interface WorldPackPlayerSlotsSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-player-slots/v1'
  readonly playerSlots: readonly [WorldPackPlayerSlotSource]
}

export interface WorldPackPresentationSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-presentation/v1'
  readonly locale: 'en' | 'zh-CN'
  readonly style: 'plain'
}

export interface WorldPackAcceptanceAssertion extends WorldJsonObject {
  readonly assertionId: string
  readonly assertionType: string
  readonly parameters: WorldJsonValue
}
export interface WorldPackAssertionsSource extends WorldJsonObject {
  readonly schemaVersion: 'worldpack-assertions/v1'
  readonly assertions: readonly WorldPackAcceptanceAssertion[]
}

export interface WorldPackMarkdownContent extends WorldJsonObject {
  readonly path: string
  readonly text: string
  readonly contentHash: WorldHash
}
export interface WorldPackCompiledContent extends WorldJsonObject {
  readonly world: WorldPackWorldSource
  readonly locations: readonly WorldPackLocationSource[]
  readonly entities: readonly WorldPackEntitySource[]
  readonly characters: readonly WorldPackCharacterSource[]
  readonly scenes: readonly WorldPackSceneSource[]
  readonly playerSlots: readonly WorldPackPlayerSlotSource[]
  readonly presentation: WorldPackPresentationSource
  readonly markdown: readonly WorldPackMarkdownContent[]
}
export interface WorldPackAssetLock extends WorldJsonObject {
  readonly path: string
  readonly contentHash: WorldHash
  readonly size: number
}
export interface WorldPackPluginLock extends WorldJsonObject {
  readonly kind: 'rulebook' | 'scene-decision' | 'agent-context' | 'presentation'
  readonly id: string
  readonly version: string
  readonly pluginHash: WorldHash
}
export interface WorldPackCompilerIdentity extends WorldJsonObject {
  readonly id: typeof WORLD_PACK_COMPILER_ID
  readonly version: typeof WORLD_PACK_COMPILER_VERSION
  readonly contractVersion: typeof WORLD_PACK_COMPILER_CONTRACT_VERSION
  readonly canonicalJsonVersion: 'world-json/v1'
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE
}
export interface CompiledWorldPack extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly compiler: WorldPackCompilerIdentity
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly content: WorldPackCompiledContent
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

export interface WorldPackCompilerIdentityV2 extends WorldJsonObject {
  readonly id: typeof WORLD_PACK_COMPILER_ID
  readonly version: typeof WORLD_PACK_COMPILER_VERSION_V2
  readonly contractVersion: typeof WORLD_PACK_COMPILER_CONTRACT_VERSION_V2
  readonly canonicalJsonVersion: 'world-json/v1'
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE_V2
}
export interface WorldPackCompiledContentV2 extends WorldJsonObject {
  readonly world: WorldPackWorldSource
  readonly locations: readonly WorldPackLocationSource[]
  readonly entities: readonly WorldPackEntitySource[]
  readonly characters: readonly WorldPackCharacterSourceV2[]
  readonly scenes: readonly WorldPackSceneSourceV2[]
  readonly playerSlots: readonly WorldPackPlayerSlotSource[]
  readonly cognition: readonly WorldPackCharacterCognitionSourceV2[]
  readonly memory: readonly WorldPackCharacterMemorySourceV2[]
  readonly documents: readonly WorldPackDocumentSourceV2[]
  readonly presentation: WorldPackPresentationSource
  readonly markdown: readonly WorldPackMarkdownContent[]
}
export interface CompiledWorldPackV2 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V2
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly compiler: WorldPackCompilerIdentityV2
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly vocabularyLocks: readonly VocabularyLock[]
  readonly registryLocks: readonly Phase8RegistryLock[]
  readonly content: WorldPackCompiledContentV2
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

export interface WorldPackCompilerIdentityV3 extends WorldJsonObject {
  readonly id: typeof WORLD_PACK_COMPILER_ID
  readonly version: typeof WORLD_PACK_COMPILER_VERSION_V3
  readonly contractVersion: typeof WORLD_PACK_COMPILER_CONTRACT_VERSION_V3
  readonly canonicalJsonVersion: 'world-json/v1'
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE_V2
}

export interface WorldPackCompilerIdentityV4 extends WorldJsonObject {
  readonly id: typeof WORLD_PACK_COMPILER_ID
  readonly version: typeof WORLD_PACK_COMPILER_VERSION_V4
  readonly contractVersion: typeof WORLD_PACK_COMPILER_CONTRACT_VERSION_V4
  readonly canonicalJsonVersion: 'world-json/v1'
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE_V2
}

export interface WorldPackCompilerIdentityV5 extends WorldJsonObject {
  readonly id: typeof WORLD_PACK_COMPILER_ID
  readonly version: typeof WORLD_PACK_COMPILER_VERSION_V5
  readonly contractVersion: typeof WORLD_PACK_COMPILER_CONTRACT_VERSION_V5
  readonly canonicalJsonVersion: 'world-json/v1'
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE_V2
}

/** V5 content carries the entity and character shapes that can declare interaction bindings. */
export interface WorldPackCompiledContentV5 extends WorldPackCompiledContentV2 {
  readonly entities: readonly WorldPackEntitySourceV2[]
  readonly characters: readonly WorldPackCharacterSourceV3[]
}

export interface WorldPackCompileOptionsV5 {
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE_V2
  /** Trusted package descriptions installed by the Host; the world only selects among them. */
  readonly interactionPackages: readonly InteractionPackageDescription[]
}

export interface CompiledWorldPackV5 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V5
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly compiler: WorldPackCompilerIdentityV5
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly vocabularyLocks: readonly VocabularyLock[]
  readonly registryLocks: readonly Phase8RegistryLock[]
  readonly reaction: WorldPackReactionSource
  readonly manifestation: WorldPackManifestationSource
  readonly interactions: InteractionCatalogV3
  readonly content: WorldPackCompiledContentV5
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

export interface CompiledWorldPackV3 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V3
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly compiler: WorldPackCompilerIdentityV3
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly vocabularyLocks: readonly VocabularyLock[]
  readonly registryLocks: readonly Phase8RegistryLock[]
  readonly reaction: WorldPackReactionSource
  readonly content: WorldPackCompiledContentV2
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

export interface CompiledWorldPackV4 extends WorldJsonObject {
  readonly compiledSchemaVersion: typeof WORLD_PACK_COMPILED_SCHEMA_VERSION_V4
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly compiler: WorldPackCompilerIdentityV4
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly vocabularyLocks: readonly VocabularyLock[]
  readonly registryLocks: readonly Phase8RegistryLock[]
  readonly reaction: WorldPackReactionSource
  readonly manifestation: WorldPackManifestationSource
  readonly content: WorldPackCompiledContentV2
  readonly assets: readonly WorldPackAssetLock[]
  readonly acceptanceAssertions: readonly WorldPackAcceptanceAssertion[]
}

export interface WorldPackReactionInspection extends WorldJsonObject {
  readonly mode: 'disabled' | 'responsive'
  readonly profile: 'responsive/v1' | null
  readonly maximumWaves: 3
  readonly maximumNpcCalls: 8
  readonly maximumCallsPerCharacter: 2
  readonly maximumActionsPerCall: 1
  readonly maximumNpcSpeechesPerPlayerInput: 8
  readonly deadlineMs: 30_000
}

export interface WorldPackRuntimeOptions {
  readonly actionGroups?: 'bounded/v1'
  readonly interactionCatalog?: WorldJsonValue
  readonly address: WorldAddress
  readonly principalId: string
  readonly sessionId: SessionId
}

export interface WorldPackInspection extends WorldJsonObject {
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly title: string
  readonly characterCount: number
  readonly locationCount: number
  readonly entityCount: number
  readonly assertionCount: number
  readonly pluginLocks: readonly WorldPackPluginLock[]
  readonly reaction?: WorldPackReactionInspection
  readonly manifestation?: WorldPackManifestationSource
}

export interface WorldPackTestReport extends WorldJsonObject {
  readonly status: 'compiled'
  readonly assertionsExecuted: 0
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly manifestHash: WorldHash
  readonly genesisHash: WorldHash
  readonly assertionPlanHash: WorldHash
  readonly assertionIds: readonly string[]
}
