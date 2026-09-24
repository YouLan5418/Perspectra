import {
  brandId, hashWorldJson, PHASE8_REGISTRY_LOCKS, PHASE8_VOCABULARY_LOCKS,
  type InteractionBindingV3, type InteractionCatalogV3,
  type InteractionPackageImplementation, type ReactionProfileId, type WorldAddress,
  type WorldEventDraft, type WorldJsonObject,
} from '@harness-world/contracts'
import {
  characterInteractionManifestRegistries,
  type CompiledWorldManifestV10,
  type CompiledWorldSpec,
} from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'

/** The trusted package the Host installs. A world selects from it; it can never add to it. */
export const basicInteractionPackage: InteractionPackageImplementation = createBasicInteractionPackage()

const ref = (id: string): { readonly id: string; readonly version: number } => ({ id, version: 1 })

/** A current v10 world for interaction tests, independent of retired WorldSpec compilers. */
export function frozenInteractionWorld(profile?: ReactionProfileId): CompiledWorldSpec {
  const address: WorldAddress = {
    tenantId: brandId('tenant:p8-crash', 'TenantId'),
    worldId: brandId('world:p8-crash', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
  const npc = brandId('character:npc', 'CharacterId')
  const player = brandId('character:player', 'CharacterId')
  const bob = brandId('character:bob', 'CharacterId')
  const characters = [
    { characterId: npc, name: 'NPC', locationId: 'location:room', lifecycle: 'active' as const,
      controllerClass: 'scripted' as const, pronouns: 'they', portrayal: null },
    { characterId: player, name: 'Player', locationId: 'location:room', lifecycle: 'active' as const,
      controllerClass: 'manual' as const, pronouns: 'they', portrayal: null },
    { characterId: bob, name: 'Bob', locationId: 'location:room', lifecycle: 'active' as const,
      controllerClass: 'scripted' as const, pronouns: 'they', portrayal: null },
  ]
  const locations = [
    { locationId: 'location:room', name: 'Room' },
    { locationId: 'location:next', name: 'Next' },
  ]
  const entities = ['cup', 'other'].map(id => ({
    entityId: `entity:${id}`, kind: 'cup', locationId: 'location:room',
  }))
  const entityBindings: InteractionBindingV3[] = entities.flatMap(entity =>
    ['base:take', 'base:drop', 'base:give'].map(id => ({
      bindingId: `binding:${entity.entityId}:${id}`,
      targetRef: { kind: 'entity' as const, id: entity.entityId },
      definitionRef: ref(id), config: {},
    })))
  const catalog: InteractionCatalogV3 = {
    version: 'interaction-catalog/v3',
    packages: [basicInteractionPackage.lock],
    definitions: basicInteractionPackage.definitions.map(definition => ({
      ref: { id: definition.spec.id, version: definition.spec.version },
      definitionHash: hashWorldJson('interaction-definition/v1', definition.spec),
      implementationHash: definition.implementationHash,
    })),
    bindings: [
      ...entityBindings,
      { bindingId: 'binding:character:npc:base:hold-hand', targetRef: { kind: 'character' as const, id: npc },
        definitionRef: ref('base:hold-hand'), config: {} },
      { bindingId: 'binding:release', targetRef: { kind: 'relation' as const, id: 'base:hold-hand' },
        definitionRef: ref('base:end-contact'), config: {} },
    ].sort((left, right) => left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0),
  }
  const specHash = hashWorldJson('v10-interaction-test-spec', { address, locations, entities, characters })
  const genesisPlanHash = hashWorldJson('v10-interaction-test-genesis', { address, locations, entities, characters })
  const manifest: CompiledWorldManifestV10 = {
    schemaVersion: 10, address,
    metadata: { title: 'Interaction fixture', description: '' },
    timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations, entities, characters,
    scenes: [{ sceneId: 'scene:room', lifecycle: 'active', locationId: 'location:room', participantIds: [npc, player] }],
    goals: [], claims: [], observations: [],
    playerBindings: [{ principalId: 'principal:player', characterId: player,
      sessionId: brandId('session:player', 'SessionId') }],
    plugins: [
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
      { pluginId: 'builtin:scene-decision', version: '2.0.0' },
    ],
    specHash, genesisPlanHash, canonicalVersion: 'world-json/v1', hashVersion: 'sha256/v1',
    registries: characterInteractionManifestRegistries(),
    contentPack: {
      schemaVersion: 2, packId: 'pack:interaction-fixture', packVersion: '1.0.0',
      packHash: hashWorldJson('pack:interaction-fixture', null),
      compiler: { id: 'test-compiler', version: '1.0.0', contractVersion: 'worldpack/v2',
        canonicalJsonVersion: 'world-json/v1', limitsProfile: 'worldpack-limits/v2' },
      pluginLocks: [], vocabularyLocks: PHASE8_VOCABULARY_LOCKS, registryLocks: PHASE8_REGISTRY_LOCKS,
      runtimeCapabilities: { publicSpeechObservationVersion: 1, cognitionProjectionVersion: 1,
        sceneDecisionVersion: 2, cognitiveMemoryVersion: 2, agentContextVersion: 2 },
      presentation: { schemaVersion: 'worldpack-presentation/v1', locale: 'en', style: 'plain' },
      initialFacts: [], memory: [], documents: [], markdown: [],
    },
    reactionPolicy: profile === undefined
      ? { version: 'reaction-policy/v1', mode: 'disabled' }
      : { version: 'reaction-policy/v1', mode: 'responsive', profile },
    manifestationPolicy: { version: 'manifestation-policy/v1', mode: 'enabled' },
    interactionCatalog: catalog,
    actionGroupPolicy: { version: 'bounded-action-group/v2' },
    playerInputPolicy: { version: 'legacy-speech/v1' },
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents: WorldEventDraft[] = [
    { eventType: 'world.created', eventVersion: 1, data: { specHash } },
    { eventType: 'world.manifest-locked', eventVersion: 1, data: { manifestHash, genesisPlanHash } },
    { eventType: 'location.upsert', eventVersion: 1, data: { locationId: 'location:room', name: 'Room' } },
    { eventType: 'character.created', eventVersion: 1,
      data: { characterId: npc, name: 'NPC', locationId: 'location:room', lifecycleState: 'active' } },
    { eventType: 'character.created', eventVersion: 1,
      data: { characterId: player, name: 'Player', locationId: 'location:room', lifecycleState: 'active' } },
    { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:room',
      value: { lifecycle: 'active', locationId: 'location:room', participantIds: [player, npc, bob] } } },
    { eventType: 'player.binding.upsert', eventVersion: 1,
      data: { principalId: 'principal:player', characterId: player, sessionId: 'session:player' } },
    { eventType: 'world.lifecycle-changed', eventVersion: 1, data: { lifecycleState: 'active' } },
    { eventType: 'character.created', eventVersion: 1,
      data: { ...characters[2], lifecycleState: 'active' } },
    ...entities.map(entity => ({ eventType: 'entity.upsert', eventVersion: 1, data: entity })),
  ]
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

/** A candidate prefix that puts both characters in one Location and Scene with an unheld item. */
export function frozenGenesisEvents(): readonly {
  readonly eventType: string
  readonly eventVersion: number
  readonly data: WorldJsonObject
}[] {
  return [
    { eventType: 'character.created', eventVersion: 1,
      data: { characterId: 'character:player', locationId: 'location:room', lifecycleState: 'active' } },
    { eventType: 'character.created', eventVersion: 1,
      data: { characterId: 'character:npc', locationId: 'location:room', lifecycleState: 'active' } },
    { eventType: 'entity.upsert', eventVersion: 1, data: { entityId: 'entity:cup', locationId: 'location:room', kind: 'cup' } },
    { eventType: 'entity.upsert', eventVersion: 1, data: { entityId: 'entity:other', locationId: 'location:room', kind: 'cup' } },
    { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:room',
      value: { lifecycle: 'active', locationId: 'location:room', participantIds: ['character:npc', 'character:player'] } } },
  ]
}

/** One active relation of the given class, as the Host would have recorded it. */
export function relationStarted(interactionId: string, relationId = 'relation:held'): {
  readonly eventType: string
  readonly eventVersion: number
  readonly data: WorldJsonObject
} {
  return { eventType: 'character.relation-started', eventVersion: 1, data: {
    relationId, relationKind: 'hand_hold', initiatorId: 'character:player', targetId: 'character:npc',
    interactionId, sourceActionId: 'action:hold',
  } }
}
