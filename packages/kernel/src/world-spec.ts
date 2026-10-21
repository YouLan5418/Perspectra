import {
  canonicalizeWorldJson,
  jsonArrayAt,
  jsonHashAt,
  jsonKeysAt,
  jsonObjectAt,
  jsonTextAt,
  jsonUniqueAt,
  compareWorldText,
  hashWorldJson,
  RUNTIME_REGISTRY_LOCKS,
  BASIC_VOCABULARY_LOCKS,
  type CharacterId,
  type InteractionBindingV3,
  type InteractionCatalogV3,
  type InteractionImplementationLock,
  type InteractionRef,
  type InteractionTargetRef,
  type RuntimeRegistryLock,
  type ReactionPolicyV1,
  type SessionId,
  type VocabularyLock,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'

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
export interface RegistryDefinition extends WorldJsonObject {
  readonly name: string
  readonly version: number
  readonly schemaHash: WorldHash
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
  readonly rulebook: { readonly rulebookId: 'builtin:speak-move'; readonly version: 1 | 2 | 3 | 4 }
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

/** Reject untrusted non-v10 manifests before the frozen interaction runtime uses them. */
export function manifestUsesFrozenInteractions(manifest: CompiledWorldManifest): manifest is CompiledWorldManifestV10 {
  return manifest.schemaVersion === 10
}

export interface CompiledWorldSpec {
  readonly manifest: CompiledWorldManifestV10
  readonly manifestHash: WorldHash
  readonly genesisEvents: readonly WorldEventDraft[]
  readonly genesisHash: WorldHash
}

/** Validate a stored Manifest before opening its runtime view. */
export function runtimeManifestFromStored(value: WorldJsonValue): CompiledWorldManifestV10 {
  canonicalizeWorldJson(value)
  const root = jsonObjectAt(value, 'StoredWorldManifest')
  if (root.schemaVersion !== 10) throw new TypeError('stored Manifest schemaVersion is unsupported')
  const policy = jsonObjectAt(root.actionGroupPolicy, 'actionGroupPolicy')
  jsonKeysAt(policy, 'actionGroupPolicy', ['version'])
  if (policy.version !== 'bounded-action-group/v2') throw new TypeError('unsupported action group policy')
  if (jsonObjectAt(root.manifestationPolicy, 'manifestationPolicy').mode !== 'enabled') {
    throw new TypeError('action groups require manifestation enabled')
  }
  parseStoredInteractionSelection(root)
  if (Object.hasOwn(root, 'playerInputPolicy')) parsePlayerInputPolicy(root.playerInputPolicy)
  const runtimePolicy = jsonObjectAt(root.runtimePolicy, 'StoredWorldManifest.runtimePolicy')
  jsonKeysAt(runtimePolicy, 'StoredWorldManifest.runtimePolicy', [
    'npcInitialAvailability',
    'playerInitialAvailability',
  ])
  if (runtimePolicy.npcInitialAvailability !== 'provisioning' && runtimePolicy.npcInitialAvailability !== 'ready') {
    throw new TypeError('stored Manifest npcInitialAvailability is invalid')
  }
  if (runtimePolicy.playerInitialAvailability !== 'ready')
    throw new TypeError('stored Manifest playerInitialAvailability is invalid')
  jsonArrayAt(root.locations, 'StoredWorldManifest.locations')
  jsonArrayAt(root.characters, 'StoredWorldManifest.characters')
  jsonArrayAt(root.playerBindings, 'StoredWorldManifest.playerBindings')
  {
    const contentPack = jsonObjectAt(root.contentPack, 'StoredWorldManifest.contentPack')
    jsonKeysAt(contentPack, 'StoredWorldManifest.contentPack', [
      'schemaVersion',
      'packId',
      'packVersion',
      'packHash',
      'compiler',
      'pluginLocks',
      'vocabularyLocks',
      'registryLocks',
      'runtimeCapabilities',
      'presentation',
      'initialFacts',
      'memory',
      'documents',
      'markdown',
    ])
    if (contentPack.schemaVersion !== 2) throw new TypeError('stored Manifest contentPack schemaVersion is unsupported')
    jsonTextAt(contentPack.packId, 'StoredWorldManifest.contentPack.packId')
    jsonTextAt(contentPack.packVersion, 'StoredWorldManifest.contentPack.packVersion')
    jsonHashAt(contentPack.packHash, 'StoredWorldManifest.contentPack.packHash')
    const compiler = jsonObjectAt(contentPack.compiler, 'StoredWorldManifest.contentPack.compiler')
    jsonKeysAt(compiler, 'StoredWorldManifest.contentPack.compiler', [
      'id',
      'version',
      'contractVersion',
      'canonicalJsonVersion',
      'limitsProfile',
    ])
    for (const field of ['id', 'version', 'contractVersion', 'canonicalJsonVersion', 'limitsProfile'] as const) {
      jsonTextAt(compiler[field], `StoredWorldManifest.contentPack.compiler.${field}`)
    }
    if (compiler.canonicalJsonVersion !== 'world-json/v1')
      throw new TypeError('stored Manifest contentPack compiler canonicalJsonVersion is unsupported')
    const locks = jsonArrayAt(contentPack.pluginLocks, 'StoredWorldManifest.contentPack.pluginLocks').map(
      (value, index) => {
        const path = `StoredWorldManifest.contentPack.pluginLocks[${index}]`
        const lock = jsonObjectAt(value, path)
        jsonKeysAt(lock, path, ['kind', 'id', 'version', 'pluginHash'])
        return {
          kind: jsonTextAt(lock.kind, `${path}.kind`),
          id: jsonTextAt(lock.id, `${path}.id`),
          version: jsonTextAt(lock.version, `${path}.version`),
          pluginHash: jsonHashAt(lock.pluginHash, `${path}.pluginHash`),
        }
      },
    )
    jsonUniqueAt(
      locks.map(lock => lock.kind),
      'StoredWorldManifest.contentPack.pluginLocks',
    )
    const capabilities = jsonObjectAt(
      contentPack.runtimeCapabilities,
      'StoredWorldManifest.contentPack.runtimeCapabilities',
    )
    jsonKeysAt(capabilities, 'StoredWorldManifest.contentPack.runtimeCapabilities', [
      'publicSpeechObservationVersion',
      'cognitionProjectionVersion',
      'sceneDecisionVersion',
      'cognitiveMemoryVersion',
      'agentContextVersion',
    ])
    if (capabilities.publicSpeechObservationVersion !== 1)
      throw new TypeError('stored Manifest publicSpeechObservationVersion is unsupported')
    if (
      capabilities.cognitionProjectionVersion !== 1 ||
      capabilities.sceneDecisionVersion !== 2 ||
      capabilities.cognitiveMemoryVersion !== 2 ||
      capabilities.agentContextVersion !== 2
    ) {
      throw new TypeError('stored Manifest Phase 8 runtime capability is unsupported')
    }
    const presentation = jsonObjectAt(contentPack.presentation, 'StoredWorldManifest.contentPack.presentation')
    jsonKeysAt(presentation, 'StoredWorldManifest.contentPack.presentation', ['schemaVersion', 'locale', 'style'])
    if (presentation.schemaVersion !== 'worldpack-presentation/v1')
      throw new TypeError('stored Manifest presentation schemaVersion is unsupported')
    if (presentation.locale !== 'en' && presentation.locale !== 'zh-CN')
      throw new TypeError('stored Manifest presentation locale is unsupported')
    if (presentation.style !== 'plain') throw new TypeError('stored Manifest presentation style is unsupported')
    const facts = jsonArrayAt(contentPack.initialFacts, 'StoredWorldManifest.contentPack.initialFacts')
    const factIds = facts.map((value, index) => {
      const path = `StoredWorldManifest.contentPack.initialFacts[${index}]`
      const fact = jsonObjectAt(value, path)
      jsonKeysAt(fact, path, ['factId', 'proposition', 'initialAudience'])
      const audience = jsonArrayAt(fact.initialAudience, `${path}.initialAudience`).map((entry, audienceIndex) =>
        jsonTextAt(entry, `${path}.initialAudience[${audienceIndex}]`),
      )
      jsonUniqueAt(audience, `${path}.initialAudience`)
      return jsonTextAt(fact.factId, `${path}.factId`)
    })
    jsonUniqueAt(factIds, 'StoredWorldManifest.contentPack.initialFacts')
    exactLockedArray(
      contentPack.vocabularyLocks,
      BASIC_VOCABULARY_LOCKS,
      'StoredWorldManifest.contentPack.vocabularyLocks',
    )
    exactLockedArray(contentPack.registryLocks, RUNTIME_REGISTRY_LOCKS, 'StoredWorldManifest.contentPack.registryLocks')
    jsonArrayAt(contentPack.memory, 'StoredWorldManifest.contentPack.memory')
    jsonArrayAt(contentPack.documents, 'StoredWorldManifest.contentPack.documents')
    jsonArrayAt(contentPack.markdown, 'StoredWorldManifest.contentPack.markdown')
  }
  parseReactionPolicy(root.reactionPolicy)
  parseManifestationPolicy(root.manifestationPolicy)
  return value as CompiledWorldManifestV10
}

/** Definition and package identity is an id plus a positive integer version, never a label. */
function referenceAt(value: unknown, path: string): InteractionRef {
  const row = jsonObjectAt(value, path)
  jsonKeysAt(row, path, ['id', 'version'])
  const version = row.version
  if (!Number.isSafeInteger(version) || (version as number) < 1)
    throw new TypeError(`${path}.version must be a positive safe integer`)
  return { id: jsonTextAt(row.id, `${path}.id`), version: version as number }
}

function implementationLockAt(value: unknown, path: string): InteractionImplementationLock {
  const row = jsonObjectAt(value, path)
  jsonKeysAt(row, path, ['ref', 'implementationHash', 'dependencies'])
  const dependencies = jsonArrayAt(row.dependencies, `${path}.dependencies`).map((entry, index) =>
    referenceAt(entry, `${path}.dependencies[${index}]`),
  )
  jsonUniqueAt(
    dependencies.map(entry => `${entry.id}@${entry.version}`),
    `${path}.dependencies`,
  )
  return {
    ref: referenceAt(row.ref, `${path}.ref`),
    implementationHash: jsonHashAt(row.implementationHash, `${path}.implementationHash`),
    dependencies,
  }
}

const MAXIMUM_STORED_INTERACTION_PACKAGES = 32
const MAXIMUM_STORED_INTERACTION_DEFINITIONS = 128
const MAXIMUM_STORED_INTERACTION_BINDINGS = 4096

/**
 * The v10 stored Manifest carries the frozen world selection the Host has to resolve before it may
 * write. Every reference is re-read here rather than trusted: a stored Manifest is bytes, and this
 * view is what decides whether the world opens at all. A binding target that the world does not
 * declare is refused, which is also what keeps a static Manifest from naming a relation instance it
 * could not have derived.
 */
function parseStoredInteractionSelection(root: Record<string, unknown>): void {
  const path = 'StoredWorldManifest.interactionCatalog'
  const catalog = jsonObjectAt(root.interactionCatalog, path)
  jsonKeysAt(catalog, path, ['version', 'packages', 'definitions', 'bindings'])
  if (catalog.version !== 'interaction-catalog/v3') throw new TypeError('Manifest v10 requires interaction-catalog/v3')
  const packages = jsonArrayAt(catalog.packages, `${path}.packages`).map((entry, index) =>
    implementationLockAt(entry, `${path}.packages[${index}]`),
  )
  if (packages.length === 0 || packages.length > MAXIMUM_STORED_INTERACTION_PACKAGES)
    throw new TypeError(`${path}.packages is outside the frozen selection budget`)
  jsonUniqueAt(
    packages.map(entry => `${entry.ref.id}@${entry.ref.version}`),
    `${path}.packages`,
  )
  const definitions = jsonArrayAt(catalog.definitions, `${path}.definitions`).map((entry, index) => {
    const at = `${path}.definitions[${index}]`
    const row = jsonObjectAt(entry, at)
    jsonKeysAt(row, at, ['ref', 'definitionHash', 'implementationHash'])
    return {
      ref: referenceAt(row.ref, `${at}.ref`),
      definitionHash: jsonHashAt(row.definitionHash, `${at}.definitionHash`),
      implementationHash: jsonHashAt(row.implementationHash, `${at}.implementationHash`),
    }
  })
  if (definitions.length > MAXIMUM_STORED_INTERACTION_DEFINITIONS)
    throw new TypeError(`${path}.definitions is outside the frozen selection budget`)
  jsonUniqueAt(
    definitions.map(entry => `${entry.ref.id}@${entry.ref.version}`),
    `${path}.definitions`,
  )
  const enabled = new Set(definitions.map(entry => `${entry.ref.id}@${entry.ref.version}`))
  const enabledIds = new Set(definitions.map(entry => entry.ref.id))
  const entityIds = new Set(
    jsonArrayAt(root.entities, 'StoredWorldManifest.entities').map(value =>
      jsonTextAt(jsonObjectAt(value, 'StoredWorldManifest.entity').entityId, 'StoredWorldManifest.entity.entityId'),
    ),
  )
  const characterIds = new Set(
    jsonArrayAt(root.characters, 'StoredWorldManifest.characters').map(value =>
      jsonTextAt(
        jsonObjectAt(value, 'StoredWorldManifest.character').characterId,
        'StoredWorldManifest.character.characterId',
      ),
    ),
  )
  const bindings = jsonArrayAt(catalog.bindings, `${path}.bindings`).map((entry, index): InteractionBindingV3 => {
    const at = `${path}.bindings[${index}]`
    const row = jsonObjectAt(entry, at)
    jsonKeysAt(row, at, ['bindingId', 'targetRef', 'definitionRef', 'config'])
    const targetRow = jsonObjectAt(row.targetRef, `${at}.targetRef`)
    jsonKeysAt(targetRow, `${at}.targetRef`, ['kind', 'id'])
    if (targetRow.kind !== 'entity' && targetRow.kind !== 'character' && targetRow.kind !== 'relation') {
      throw new TypeError(`${at}.targetRef.kind is unknown`)
    }
    const targetRef: InteractionTargetRef = { kind: targetRow.kind, id: jsonTextAt(targetRow.id, `${at}.targetRef.id`) }
    const definitionRef = referenceAt(row.definitionRef, `${at}.definitionRef`)
    if (!enabled.has(`${definitionRef.id}@${definitionRef.version}`))
      throw new TypeError(`${at} references a definition the world did not enable`)
    if (targetRef.kind === 'relation') {
      // The id names the relation class - a definition this world enabled - not an instance, which a
      // static Manifest could never enumerate.
      if (!enabledIds.has(targetRef.id))
        throw new TypeError(`${at} names relation class ${targetRef.id}, which the world did not enable`)
    } else {
      const declared = targetRef.kind === 'entity' ? entityIds : characterIds
      if (!declared.has(targetRef.id)) throw new TypeError(`${at} names an unknown ${targetRef.kind} target`)
    }
    const config = jsonObjectAt(row.config, `${at}.config`)
    canonicalizeWorldJson(config as WorldJsonValue)
    return {
      bindingId: jsonTextAt(row.bindingId, `${at}.bindingId`),
      targetRef,
      definitionRef,
      config: config as WorldJsonObject,
    }
  })
  if (bindings.length > MAXIMUM_STORED_INTERACTION_BINDINGS)
    throw new TypeError(`${path}.bindings is outside the frozen selection budget`)
  jsonUniqueAt(
    bindings.map(entry => entry.bindingId),
    `${path}.bindings`,
  )
}

function parsePlayerInputPolicy(value: unknown): PlayerInputPolicyV1 {
  const policy = jsonObjectAt(value, 'StoredWorldManifest.playerInputPolicy')
  jsonKeysAt(policy, 'StoredWorldManifest.playerInputPolicy', ['version'])
  if (policy.version !== 'legacy-speech/v1' && policy.version !== 'player-intent/v1') {
    throw new TypeError('stored Manifest playerInputPolicy version is unsupported')
  }
  return policy as PlayerInputPolicyV1
}

function parseManifestationPolicy(value: unknown): ManifestationPolicyV1 {
  const policy = jsonObjectAt(value, 'StoredWorldManifest.manifestationPolicy')
  jsonKeysAt(policy, 'StoredWorldManifest.manifestationPolicy', ['version', 'mode'])
  if (policy.version !== 'manifestation-policy/v1')
    throw new TypeError('stored Manifest manifestationPolicy version is unsupported')
  if (policy.mode !== 'disabled' && policy.mode !== 'enabled')
    throw new TypeError('stored Manifest manifestationPolicy mode is unsupported')
  return policy as ManifestationPolicyV1
}

function parseReactionPolicy(value: unknown): ReactionPolicyV1 {
  const policy = jsonObjectAt(value, 'StoredWorldManifest.reactionPolicy')
  if (policy.mode === 'disabled') {
    jsonKeysAt(policy, 'StoredWorldManifest.reactionPolicy', ['version', 'mode'])
    if (policy.version !== 'reaction-policy/v1')
      throw new TypeError('stored Manifest reactionPolicy version is unsupported')
    return policy as ReactionPolicyV1
  }
  if (policy.mode === 'responsive') {
    jsonKeysAt(policy, 'StoredWorldManifest.reactionPolicy', ['version', 'mode', 'profile'])
    if (policy.version !== 'reaction-policy/v1')
      throw new TypeError('stored Manifest reactionPolicy version is unsupported')
    if (policy.profile !== 'responsive/v1' && policy.profile !== 'responsive/v2')
      throw new TypeError('stored Manifest reactionPolicy profile is unsupported')
    return policy as ReactionPolicyV1
  }
  throw new TypeError('stored Manifest reactionPolicy mode is unsupported')
}

export function runtimeManifestFromStoredRecord(
  record: { readonly manifest: WorldJsonValue } | undefined,
): CompiledWorldManifestV10 {
  if (record === undefined) throw new Error('branch runtime has no stored Manifest')
  return runtimeManifestFromStored(record.manifest)
}

function exactLockedArray(value: unknown, expected: WorldJsonValue, path: string): void {
  const actual = jsonArrayAt(value, path)
  if (!canonicalBytesEqual(actual as WorldJsonValue, expected))
    throw new TypeError(`${path} does not match the installed Phase 8 registry`)
}

function canonicalBytesEqual(left: WorldJsonValue, right: WorldJsonValue): boolean {
  const leftBytes = canonicalizeWorldJson(left)
  const rightBytes = canonicalizeWorldJson(right)
  return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index])
}

function definition(name: string): RegistryDefinition {
  return { name, version: 1, schemaHash: hashWorldJson('registry-definition-schema', { name, version: 1 }) }
}

function registry(kind: string, names: readonly string[]): FrozenRegistry {
  const definitions = [...names].sort(compareWorldText).map(name => definition(name))
  return { definitions, registryHash: hashWorldJson(`compiled-${kind}-registry`, definitions) }
}

/**
 * The frozen execution vocabulary every current Manifest locks. Each registry hash covers the sorted
 * names, so adding or removing a name changes the Manifest hash of newly compiled worlds; the grouping
 * below is only for reading and has no effect on the hash.
 */
export function characterInteractionManifestRegistries(): ManifestRegistries {
  return {
    events: registry('event', [
      // World, character, scene and knowledge records.
      'action.rejected',
      'action.resolved',
      'character.created',
      'character.lifecycle-changed',
      'character.moved',
      'character.speak',
      'claim.remove',
      'claim.upsert',
      'entity.upsert',
      'goal.remove',
      'goal.upsert',
      'location.upsert',
      'observation.remove',
      'observation.upsert',
      'player.binding.upsert',
      'round.participant-terminal',
      'scene.remove',
      'scene.upsert',
      'visibility.remove',
      'visibility.upsert',
      'world.created',
      'world.lifecycle-changed',
      'world.manifest-locked',
      'world.tick-advanced',
      'entity.taken',
      // Character cognition and Scene lifecycle.
      'affect-episode.upsert',
      'character-goal.upsert',
      'character.reflect',
      'commitment.upsert',
      'inner-tension.upsert',
      'open-loop.upsert',
      'relationship-attitude.upsert',
      'subjective-claim.upsert',
      'scene.activated',
      'scene.closed',
      'scene.created',
      'scene.member_joined',
      'scene.member_left',
      // Visible manifestation.
      'character.manifested',
      'character.visible-state-removed',
      'character.visible-state-upserted',
      // Frozen interactions, relations and creator activity state.
      'entity.transferred',
      'character.relation-ended',
      'character.relation-started',
      'activity.updated',
      'status.updated',
    ]),
    actions: registry('action', ['speak', 'move', 'interact']),
    projections: registry('projection', [
      'character',
      'claim',
      'goal',
      'observation',
      'scene',
      'visibility',
      'affect-episode',
      'character-goal',
      'commitment',
      'inner-tension',
      'open-loop',
      'relationship-attitude',
      'subjective-claim',
      'character-visible-state',
    ]),
    rules: registry('rule', ['builtin:speak-move/v2']),
  }
}
