import type {
  BrandedId,
  CharacterId,
  SessionId,
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

export interface WorldPackCompileOptions {
  readonly limitsProfile: typeof WORLD_PACK_LIMITS_PROFILE
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

export interface WorldPackSourceManifest extends WorldJsonObject {
  readonly sourceSchemaVersion: typeof WORLD_PACK_SOURCE_SCHEMA_VERSION
  readonly packId: WorldPackId
  readonly packVersion: string
  readonly worldFile: string
  readonly characterFiles: readonly string[]
  readonly locationFiles: readonly string[]
  readonly sceneFiles: readonly string[]
  readonly playerSlotFiles: readonly string[]
  readonly presentationFiles: readonly string[]
  readonly markdownFiles: readonly string[]
  readonly assetFiles: readonly string[]
  readonly assertionFiles: readonly string[]
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

export interface WorldPackRuntimeOptions {
  readonly address: WorldAddress
  readonly principalId: string
  readonly sessionId: SessionId
}
