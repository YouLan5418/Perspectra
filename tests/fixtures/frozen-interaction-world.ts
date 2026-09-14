import {
  hashWorldJson, type InteractionBindingV3, type InteractionCatalogV3,
  type InteractionPackageImplementation, type ReactionProfileId, type WorldJsonObject,
} from '@harness-world/contracts'
import {
  characterInteractionManifestRegistries,
  type CompiledWorldManifestV10,
  type CompiledWorldSpec,
} from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { characterInteractionWorld } from './character-interaction-world.ts'

/** The trusted package the Host installs. A world selects from it; it can never add to it. */
export const basicInteractionPackage: InteractionPackageImplementation = createBasicInteractionPackage()

const ref = (id: string): { readonly id: string; readonly version: number } => ({ id, version: 1 })

/**
 * A v10 Manifest over the v9 fixture content, with a selection that covers all five first-batch
 * definitions including the release, which only became bindable once a relation target could name a
 * class (ADR-0095).
 */
export function frozenInteractionWorld(profile?: ReactionProfileId): CompiledWorldSpec {
  const base = characterInteractionWorld(profile)
  const entityBindings: InteractionBindingV3[] = ['entity:cup', 'entity:other'].flatMap(entityId =>
    ['base:take', 'base:drop', 'base:give'].map(id => ({
      bindingId: `binding:${entityId}:${id}`, targetRef: { kind: 'entity' as const, id: entityId },
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
      { bindingId: 'binding:character:npc:base:hold-hand', targetRef: { kind: 'character' as const, id: 'character:npc' },
        definitionRef: ref('base:hold-hand'), config: {} },
      // Releasing names the class the holding established, never an instance.
      { bindingId: 'binding:release', targetRef: { kind: 'relation' as const, id: 'base:hold-hand' },
        definitionRef: ref('base:end-contact'), config: {} },
    ].sort((left, right) => (left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0)),
  }
  const manifest = {
    ...base.manifest,
    schemaVersion: 10 as const,
    interactionCatalog: catalog,
    actionGroupPolicy: { version: 'bounded-action-group/v2' as const },
    registries: characterInteractionManifestRegistries(),
  } as unknown as CompiledWorldManifestV10
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...event.data as WorldJsonObject, manifestHash } }
    : event)
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
