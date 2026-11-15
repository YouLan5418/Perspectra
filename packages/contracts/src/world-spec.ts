import type { VocabularyLock } from './cognition.ts'
import type { CharacterId, SessionId } from './ids.ts'
import type { InteractionCatalogV3 } from './interaction-definition.ts'
import type { WorldAddress, WorldEventDraft } from './protocol.ts'
import type { ReactionPolicyV1 } from './reaction-policy.ts'
import type { RegistryDefinition } from './registry.ts'
import type { RuntimeRegistryLock } from './runtime-registries.ts'
import type { WorldHash, WorldJsonObject, WorldJsonValue } from './world-json.ts'

export interface LocationSpec extends WorldJsonObject {
  readonly locationId: string
  readonly name: string
}
/** `name` is an author-supplied player-facing label for Entities. It never selects a definition or changes state. */
export interface EntitySpec extends WorldJsonObject {
  readonly entityId: string
  readonly locationId: string
  readonly kind: string
  readonly name?: string
}
export interface CharacterSpec extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly name: string
  readonly locationId: string | null
}
export interface PlayerBindingSpec extends WorldJsonObject {
  readonly principalId: string
  readonly characterId: CharacterId
  readonly sessionId: SessionId
}
export interface PluginSpec extends WorldJsonObject {
  readonly pluginId: string
  readonly version: string
}
export interface SceneSpec extends WorldJsonObject {
  readonly sceneId: string
  readonly participantIds: readonly CharacterId[]
}
export interface GoalSpec extends WorldJsonObject {
  readonly goalId: string
  readonly characterId: CharacterId
  readonly value: WorldJsonValue
}
export interface ClaimSpec extends WorldJsonObject {
  readonly claimId: string
  readonly characterId: CharacterId
  readonly value: WorldJsonValue
}
export interface ObservationSpec extends WorldJsonObject {
  readonly observationId: string
  readonly observerId: CharacterId
  readonly value: WorldJsonValue
}
export interface WorldMetadata extends WorldJsonObject {
  readonly title: string
  readonly description: string
}
export interface RuntimePolicy extends WorldJsonObject {
  readonly npcInitialAvailability: 'provisioning' | 'ready'
  readonly playerInitialAvailability: 'ready'
}
export interface FrozenRegistry extends WorldJsonObject {
  readonly definitions: readonly RegistryDefinition[]
  readonly registryHash: WorldHash
}
export interface ManifestRegistries extends WorldJsonObject {
  readonly events: FrozenRegistry
  readonly actions: FrozenRegistry
  readonly projections: FrozenRegistry
  readonly rules: FrozenRegistry
}

export interface CompiledWorldManifest extends WorldJsonObject {
  readonly schemaVersion: 10
  readonly address: WorldAddress
  readonly specHash: WorldHash
  readonly genesisPlanHash: WorldHash
  readonly canonicalVersion: 'world-json/v1'
  readonly hashVersion: 'sha256/v1'
  readonly metadata: WorldMetadata
  readonly timeMode: 'TURN_DRIVEN'
  readonly roundQueueLimit: number
  readonly runtimePolicy: RuntimePolicy
  readonly rulebook: { readonly rulebookId: 'builtin:speak-move'; readonly version: 2 }
  readonly registries: ManifestRegistries
  readonly locations: readonly LocationSpec[]
  readonly entities: readonly EntitySpec[]
  readonly characters: readonly CharacterSpec[]
  readonly scenes: readonly SceneSpec[]
  readonly goals: readonly GoalSpec[]
  readonly claims: readonly ClaimSpec[]
  readonly observations: readonly ObservationSpec[]
  readonly playerBindings: readonly PlayerBindingSpec[]
  readonly plugins: readonly PluginSpec[]
  readonly contentPack?: ContentPackManifestBindingV2
}

export interface ContentPackCompilerIdentity extends WorldJsonObject {
  readonly id: string
  readonly version: string
  readonly contractVersion: string
  readonly canonicalJsonVersion: string
  readonly limitsProfile: string
}

export interface ContentPackPluginLock extends WorldJsonObject {
  readonly kind: string
  readonly id: string
  readonly version: string
  readonly pluginHash: WorldHash
}

export interface ContentPackRuntimeCapabilities extends WorldJsonObject {
  readonly publicSpeechObservationVersion: 1
}

export interface ContentPackRuntimeCapabilitiesV2 extends ContentPackRuntimeCapabilities {
  readonly cognitionProjectionVersion: 1
  readonly sceneDecisionVersion: 2
  readonly cognitiveMemoryVersion: 2
  readonly agentContextVersion: 2
}

export interface ContentPackManifestBindingV2 extends WorldJsonObject {
  readonly schemaVersion: 2
  readonly packId: string
  readonly packVersion: string
  readonly packHash: WorldHash
  readonly compiler: ContentPackCompilerIdentity
  readonly pluginLocks: readonly ContentPackPluginLock[]
  readonly vocabularyLocks: readonly VocabularyLock[]
  readonly registryLocks: readonly RuntimeRegistryLock[]
  readonly runtimeCapabilities: ContentPackRuntimeCapabilitiesV2
  readonly presentation: WorldJsonValue
  readonly initialFacts: readonly WorldJsonValue[]
  readonly memory: readonly WorldJsonValue[]
  readonly documents: readonly WorldJsonValue[]
  readonly markdown: readonly WorldJsonValue[]
}

export interface ContentPackCharacterSpecV2 extends CharacterSpec {
  readonly controllerClass: 'manual' | 'scripted' | 'rule' | 'noop'
  readonly pronouns: string
  readonly lifecycle: 'active' | 'incapacitated' | 'dead' | 'departed'
  readonly portrayal: WorldJsonValue | null
}

export interface SceneSpecV2 extends SceneSpec {
  readonly lifecycle: 'created' | 'active' | 'closed'
  readonly locationId: string | null
}

export type ManifestationPolicyV1 =
  | { readonly version: 'manifestation-policy/v1'; readonly mode: 'disabled' }
  | { readonly version: 'manifestation-policy/v1'; readonly mode: 'enabled' }

export type PlayerInputPolicyV1 = { readonly version: 'legacy-speech/v1' } | { readonly version: 'player-intent/v1' }

/**
 * V10 replaces the closed interaction catalog with the frozen package selection. The catalog names
 * the packages, definition locks and bindings the Host must resolve before it may write, so a v10
 * world cannot be activated against a runtime that does not carry those exact implementations.
 *
 * The relation vocabulary is unchanged from v9. What changes is who owns the semantics: the new path
 * derives every ending from the lifecycle handlers the selected definitions declare, so `move`
 * carries no relation knowledge of its own.
 */
export interface CompiledWorldManifestV10 extends CompiledWorldManifest {
  readonly schemaVersion: 10
  readonly characters: readonly ContentPackCharacterSpecV2[]
  readonly scenes: readonly SceneSpecV2[]
  readonly contentPack: ContentPackManifestBindingV2
  readonly reactionPolicy: ReactionPolicyV1
  readonly manifestationPolicy: ManifestationPolicyV1
  readonly interactionCatalog: InteractionCatalogV3
  readonly actionGroupPolicy: { readonly version: 'bounded-action-group/v2' }
  readonly playerInputPolicy?: PlayerInputPolicyV1
}

export interface CompiledWorldSpec {
  readonly manifest: CompiledWorldManifestV10
  readonly manifestHash: WorldHash
  readonly genesisEvents: readonly WorldEventDraft[]
  readonly genesisHash: WorldHash
}
