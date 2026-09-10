import { hashWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import { interactionManifestRegistries, parseInteractionCatalog, type CompiledWorldSpec } from '@harness-world/kernel'
import { actionGroupWorld } from './action-group-world.ts'

export function interactionWorld(responsive = false): CompiledWorldSpec {
  const base = actionGroupWorld(responsive)
  const entities = ['cup', 'other'].map(id => ({ entityId: `entity:${id}`, kind: 'cup', locationId: 'location:room' }))
  const interactionCatalog = parseInteractionCatalog({ version: 'object-interactions/v1',
    definitions: ['take', 'drop', 'give'].map(operation => ({ interactionId: `core:${operation}`, label: operation, operation })),
    bindings: entities.map(entity => ({ entityId: entity.entityId, interactionIds: ['core:take', 'core:drop', 'core:give'] })),
  }, entities.map(value => value.entityId))
  const manifest = { ...base.manifest, schemaVersion: 8 as const, entities, interactionCatalog, registries: interactionManifestRegistries() }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = [...base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...event.data as WorldJsonObject, manifestHash } } : event),
  ...entities.map(data => ({ eventType: 'entity.upsert', eventVersion: 1, data }))]
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

export function interactionOutput(operation = 'take', actorId = 'character:npc', targetId = 'entity:cup', args: WorldJsonObject = {}) {
  return { schemaVersion: 5 as const, decision: 'act' as const, actions: [
    { actionId: 'z:interact', actorId, actionType: 'interact', actionVersion: 1,
      parameters: { targetId, interactionId: `core:${operation}`, arguments: args } },
    { actionId: 'a:speak', actorId, actionType: 'speak', actionVersion: 1, parameters: { text: 'done' } },
  ] }
}
