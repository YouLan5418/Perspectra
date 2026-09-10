import { canonicalizeWorldJson, compareWorldText, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { currentCharacterLifecycle, currentEntityState, currentLocation, rejectRulebookResolution, worldJsonObject, type RulebookEvent, type RulebookResolution } from './rulebook.ts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface InteractionDefinition extends WorldJsonObject {
  readonly interactionId: string
  readonly label: string
  readonly operation: 'take' | 'drop' | 'give'
}

/** Author-defined identities bind to closed, deterministic possession operations. */
export interface InteractionCatalog extends WorldJsonObject {
  readonly version: 'object-interactions/v1'
  readonly definitions: readonly InteractionDefinition[]
  readonly bindings: readonly { readonly entityId: string; readonly interactionIds: readonly string[] }[]
}

export function manifestUsesInteractions(manifest: CompiledWorldManifest): boolean {
  return manifest.schemaVersion === 8
}

export function parseInteractionCatalog(value: WorldJsonValue, entityIds: readonly string[]): InteractionCatalog {
  canonicalizeWorldJson(value)
  const root = worldJsonObject(value)
  const exact = (object: WorldJsonObject, keys: readonly string[]): boolean => Object.keys(object).sort(compareWorldText).join(',') === [...keys].sort(compareWorldText).join(',')
  const text = (input: WorldJsonValue | undefined): input is string => typeof input === 'string' && input.length > 0 && input.length <= 128 && input.trim() === input
  if (root === undefined || !exact(root, ['version', 'definitions', 'bindings']) || root.version !== 'object-interactions/v1'
    || !Array.isArray(root.definitions) || !Array.isArray(root.bindings) || root.definitions.length > 128 || root.bindings.length > 4096) throw new TypeError('invalid interaction catalog')
  const definitions = root.definitions.map(entry => {
    const definition = worldJsonObject(entry)
    if (definition === undefined || !exact(definition, ['interactionId', 'label', 'operation']) || !text(definition.interactionId) || !text(definition.label)
      || !['take', 'drop', 'give'].includes(definition.operation as string)) throw new TypeError('invalid interaction definition')
    if (definition.interactionId.startsWith('core:') && definition.interactionId !== `core:${definition.operation}`) throw new TypeError('reserved core interaction identity')
    return definition as InteractionDefinition
  }).sort((a, b) => compareWorldText(a.interactionId, b.interactionId))
  const ids = new Set(definitions.map(value => value.interactionId))
  if (ids.size !== definitions.length) throw new TypeError('duplicate interaction definition')
  const bindings = root.bindings.map(entry => {
    const binding = worldJsonObject(entry)
    if (binding === undefined || !exact(binding, ['entityId', 'interactionIds']) || !text(binding.entityId) || !entityIds.includes(binding.entityId)
      || !Array.isArray(binding.interactionIds) || binding.interactionIds.some(id => typeof id !== 'string' || !ids.has(id))
      || new Set(binding.interactionIds).size !== binding.interactionIds.length) throw new TypeError('invalid interaction binding')
    return { entityId: binding.entityId, interactionIds: [...binding.interactionIds as string[]].sort(compareWorldText) }
  }).sort((a, b) => compareWorldText(a.entityId, b.entityId))
  if (new Set(bindings.map(value => value.entityId)).size !== bindings.length) throw new TypeError('duplicate interaction binding')
  return { version: 'object-interactions/v1', definitions, bindings }
}

export function resolveInteraction(manifest: CompiledWorldManifest, events: readonly RulebookEvent[], actorId: string, input: WorldJsonValue): RulebookResolution {
  const reject = (reason: string): RulebookResolution => ({ ...rejectRulebookResolution(actorId, 'interact', reason), observationScope: { scope: 'self' } })
  const parameters = worldJsonObject(input)
  if (parameters === undefined || Object.keys(parameters).sort(compareWorldText).join(',') !== 'arguments,interactionId,targetId'
    || typeof parameters.targetId !== 'string' || typeof parameters.interactionId !== 'string') return reject('INVALID_INTERACTION_PARAMETERS')
  const catalog = manifest.interactionCatalog as InteractionCatalog
  const binding = catalog.bindings.find(value => value.entityId === parameters.targetId)
  const definition = catalog.definitions.find(value => value.interactionId === parameters.interactionId)
  if (binding === undefined || definition === undefined || !binding.interactionIds.includes(definition.interactionId)) return reject('INTERACTION_NOT_BOUND')
  const args = worldJsonObject(parameters.arguments!)
  if (args === undefined || Object.keys(args).sort(compareWorldText).join(',') !== (definition.operation === 'give' ? 'recipientId' : '')) return reject('INVALID_INTERACTION_ARGUMENTS')
  const entity = currentEntityState(events, binding.entityId)
  const location = currentLocation(events, actorId)
  if (entity === undefined || location === undefined || (definition.operation === 'take'
    ? entity.holderId !== null || entity.locationId !== location : entity.holderId !== actorId)) return reject('ITEM_NOT_AVAILABLE')
  let holderId: string | null = definition.operation === 'take' ? actorId : null
  if (definition.operation === 'give') {
    const recipient = args.recipientId
    if (typeof recipient !== 'string' || recipient === actorId || !manifest.characters.some(value => value.characterId === recipient)
      || currentCharacterLifecycle(events, recipient) !== 'active' || currentLocation(events, recipient) !== location) return reject('RECIPIENT_NOT_AVAILABLE')
    holderId = recipient
  }
  return {
    status: 'accepted', observationScope: { scope: 'scene_public' },
    events: [{ eventType: 'entity.transferred', eventVersion: 1, data: {
      entityId: entity.entityId, characterId: actorId, interactionId: definition.interactionId,
      fromLocationId: entity.locationId, fromHolderId: entity.holderId,
      toLocationId: holderId === null ? location : null, toHolderId: holderId,
    } }],
  }
}

/** Only expose local unheld objects and the actor's own inventory, never another inventory. */
export function availableInteractions(manifest: CompiledWorldManifest, events: readonly RulebookEvent[], actorId: string): readonly WorldJsonObject[] {
  const catalog = manifest.interactionCatalog as InteractionCatalog
  const choices: WorldJsonObject[] = []
  if (currentCharacterLifecycle(events, actorId) !== 'active') return choices
  for (const binding of catalog.bindings) {
    const entity = currentEntityState(events, binding.entityId)
    if (entity === undefined || !(entity.holderId === actorId || (entity.holderId === null && entity.locationId === currentLocation(events, actorId)))) continue
    for (const interactionId of binding.interactionIds) {
      const definition = catalog.definitions.find(value => value.interactionId === interactionId)!
      const argumentsList = definition.operation === 'give'
        ? manifest.characters.map(value => ({ recipientId: value.characterId } as WorldJsonObject)) : [{}]
      for (const args of argumentsList) {
        const parameters = { targetId: binding.entityId, interactionId, arguments: args }
        if (resolveInteraction(manifest, events, actorId, parameters).status === 'accepted') choices.push({ ...parameters, label: definition.label })
      }
    }
  }
  return choices.sort((a, b) => compareWorldText(JSON.stringify(a), JSON.stringify(b)))
}
