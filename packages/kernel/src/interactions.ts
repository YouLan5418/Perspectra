import {
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  resolutionAuthority,
  validateResolutionAuthority,
  type RulebookResolutionAuthorityV1,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentCharacterLifecycle,
  currentEntityState,
  currentLocation,
  rejectRulebookResolution,
  worldJsonObject,
  type RulebookEvent,
  type RulebookResolution,
} from './rulebook.ts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface InteractionDefinitionV1 extends WorldJsonObject {
  readonly interactionId: string
  readonly label: string
  readonly operation: 'take' | 'drop' | 'give'
}

export interface InteractionCatalogV1 extends WorldJsonObject {
  readonly version: 'object-interactions/v1'
  readonly definitions: readonly InteractionDefinitionV1[]
  readonly bindings: readonly { readonly entityId: string; readonly interactionIds: readonly string[] }[]
}

export interface EntityInteractionDefinitionV2 extends WorldJsonObject {
  readonly interactionId: string
  readonly label: string
  readonly targetKind: 'entity'
  readonly operation: 'take' | 'drop' | 'give'
  readonly initiationPolicy: {
    readonly manualPlayer: 'standard'
    readonly autonomousCharacter: 'standard'
  }
}

export interface CharacterInteractionDefinitionV2 extends WorldJsonObject {
  readonly interactionId: string
  readonly label: string
  readonly targetKind: 'character'
  readonly operation: 'hold_hand'
  readonly initiationPolicy: {
    readonly manualPlayer: 'commit_then_react'
    readonly autonomousCharacter: 'forbidden'
  }
}

export type InteractionDefinitionV2 = EntityInteractionDefinitionV2 | CharacterInteractionDefinitionV2

export interface InteractionCatalogV2 extends WorldJsonObject {
  readonly version: 'interaction-catalog/v2'
  readonly definitions: readonly InteractionDefinitionV2[]
  readonly bindings: readonly { readonly targetId: string; readonly interactionIds: readonly string[] }[]
}

export type InteractionCatalog = InteractionCatalogV1 | InteractionCatalogV2

export interface InteractionCatalogTargets {
  readonly entityIds: readonly string[]
  readonly characterIds: readonly string[]
  readonly manualCharacterIds: readonly string[]
}

export interface InteractionResolutionContext {
  readonly actionId: string
  readonly resolutionAuthority: RulebookResolutionAuthorityV1
}

export interface CharacterRelationState extends WorldJsonObject {
  readonly relationId: string
  readonly relationKind: 'hand_hold'
  readonly initiatorId: string
  readonly targetId: string
  readonly interactionId: string
  readonly sourceActionId: string
  readonly active: boolean
}

function exact(object: WorldJsonObject, keys: readonly string[]): boolean {
  return Object.keys(object).sort(compareWorldText).join(',') === [...keys].sort(compareWorldText).join(',')
}

function text(input: WorldJsonValue | undefined): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 128 && input.trim() === input
}

function parseCatalogV1(root: WorldJsonObject, entityIds: readonly string[]): InteractionCatalogV1 {
  if (!exact(root, ['version', 'definitions', 'bindings']) || root.version !== 'object-interactions/v1'
    || !Array.isArray(root.definitions) || !Array.isArray(root.bindings)
    || root.definitions.length > 128 || root.bindings.length > 4096) throw new TypeError('invalid interaction catalog')
  const definitions = root.definitions.map(entry => {
    const definition = worldJsonObject(entry)
    if (definition === undefined || !exact(definition, ['interactionId', 'label', 'operation'])
      || !text(definition.interactionId) || !text(definition.label)
      || !['take', 'drop', 'give'].includes(definition.operation as string)) throw new TypeError('invalid interaction definition')
    if (definition.interactionId.startsWith('core:') && definition.interactionId !== `core:${definition.operation}`) {
      throw new TypeError('reserved core interaction identity')
    }
    return definition as InteractionDefinitionV1
  }).sort((a, b) => compareWorldText(a.interactionId, b.interactionId))
  const ids = new Set(definitions.map(value => value.interactionId))
  if (ids.size !== definitions.length) throw new TypeError('duplicate interaction definition')
  const bindings = root.bindings.map(entry => {
    const binding = worldJsonObject(entry)
    if (binding === undefined || !exact(binding, ['entityId', 'interactionIds'])
      || !text(binding.entityId) || !entityIds.includes(binding.entityId)
      || !Array.isArray(binding.interactionIds) || binding.interactionIds.some(id => typeof id !== 'string' || !ids.has(id))
      || new Set(binding.interactionIds).size !== binding.interactionIds.length) throw new TypeError('invalid interaction binding')
    return { entityId: binding.entityId, interactionIds: [...binding.interactionIds as string[]].sort(compareWorldText) }
  }).sort((a, b) => compareWorldText(a.entityId, b.entityId))
  if (new Set(bindings.map(value => value.entityId)).size !== bindings.length) throw new TypeError('duplicate interaction binding')
  return { version: 'object-interactions/v1', definitions, bindings }
}

function parsePolicy(definition: WorldJsonObject): InteractionDefinitionV2['initiationPolicy'] {
  const policy = worldJsonObject(definition.initiationPolicy!)
  if (policy === undefined || !exact(policy, ['manualPlayer', 'autonomousCharacter'])) {
    throw new TypeError('invalid interaction initiation policy')
  }
  if (definition.targetKind === 'entity') {
    if (policy.manualPlayer !== 'standard' || policy.autonomousCharacter !== 'standard') {
      throw new TypeError('entity interaction policy is fixed')
    }
    return policy as EntityInteractionDefinitionV2['initiationPolicy']
  }
  if (policy.manualPlayer !== 'commit_then_react' || policy.autonomousCharacter !== 'forbidden') {
    throw new TypeError('hold_hand interaction policy is fixed')
  }
  return policy as CharacterInteractionDefinitionV2['initiationPolicy']
}

function parseCatalogV2(root: WorldJsonObject, targets: InteractionCatalogTargets): InteractionCatalogV2 {
  if (!exact(root, ['version', 'definitions', 'bindings']) || root.version !== 'interaction-catalog/v2'
    || !Array.isArray(root.definitions) || !Array.isArray(root.bindings)
    || root.definitions.length > 128 || root.bindings.length > 4096) throw new TypeError('invalid interaction catalog')
  const definitions = root.definitions.map(entry => {
    const definition = worldJsonObject(entry)
    if (definition === undefined || !exact(definition, ['interactionId', 'label', 'targetKind', 'operation', 'initiationPolicy'])
      || !text(definition.interactionId) || !text(definition.label)
      || (definition.targetKind !== 'entity' && definition.targetKind !== 'character')) {
      throw new TypeError('invalid interaction definition')
    }
    const operation = definition.operation
    if ((definition.targetKind === 'entity' && operation !== 'take' && operation !== 'drop' && operation !== 'give')
      || (definition.targetKind === 'character' && operation !== 'hold_hand')) {
      throw new TypeError('interaction operation does not match targetKind')
    }
    const expectedCoreId = operation === 'hold_hand' ? 'core:hold-hand' : `core:${String(operation)}`
    if (definition.interactionId.startsWith('core:') && definition.interactionId !== expectedCoreId) {
      throw new TypeError('reserved core interaction identity')
    }
    const initiationPolicy = parsePolicy(definition)
    return { ...definition, initiationPolicy } as InteractionDefinitionV2
  }).sort((a, b) => compareWorldText(a.interactionId, b.interactionId))
  const definitionsById = new Map(definitions.map(value => [value.interactionId, value]))
  if (definitionsById.size !== definitions.length) throw new TypeError('duplicate interaction definition')
  const entityIds = new Set(targets.entityIds)
  const characterIds = new Set(targets.characterIds)
  const manualCharacterIds = new Set(targets.manualCharacterIds)
  if ([...entityIds].some(id => characterIds.has(id))) throw new TypeError('interaction target identity is ambiguous')
  const bindings = root.bindings.map(entry => {
    const binding = worldJsonObject(entry)
    if (binding === undefined || !exact(binding, ['targetId', 'interactionIds']) || !text(binding.targetId)
      || !Array.isArray(binding.interactionIds) || binding.interactionIds.some(id => typeof id !== 'string' || !definitionsById.has(id))
      || new Set(binding.interactionIds).size !== binding.interactionIds.length) throw new TypeError('invalid interaction binding')
    const targetKind = entityIds.has(binding.targetId) ? 'entity' : characterIds.has(binding.targetId) ? 'character' : undefined
    if (targetKind === undefined || (targetKind === 'character' && manualCharacterIds.has(binding.targetId))) {
      throw new TypeError('interaction binding references an unavailable target')
    }
    if ((binding.interactionIds as string[]).some(id => definitionsById.get(id)!.targetKind !== targetKind)) {
      throw new TypeError('interaction binding targetKind is inconsistent')
    }
    return { targetId: binding.targetId, interactionIds: [...binding.interactionIds as string[]].sort(compareWorldText) }
  }).sort((a, b) => compareWorldText(a.targetId, b.targetId))
  if (new Set(bindings.map(value => value.targetId)).size !== bindings.length) throw new TypeError('duplicate interaction binding')
  return { version: 'interaction-catalog/v2', definitions, bindings }
}

export function parseInteractionCatalog(
  value: WorldJsonValue,
  targets: readonly string[] | InteractionCatalogTargets,
): InteractionCatalog {
  canonicalizeWorldJson(value)
  const root = worldJsonObject(value)
  if (root === undefined) throw new TypeError('invalid interaction catalog')
  const targetDescriptor = Array.isArray(targets) ? undefined : targets as InteractionCatalogTargets
  if (root.version === 'object-interactions/v1') {
    const entityIds = targetDescriptor === undefined ? targets as readonly string[] : targetDescriptor.entityIds
    return parseCatalogV1(root, entityIds)
  }
  if (root.version === 'interaction-catalog/v2' && targetDescriptor !== undefined) return parseCatalogV2(root, targetDescriptor)
  throw new TypeError('invalid interaction catalog')
}

function relationData(event: RulebookEvent, path: string): WorldJsonObject {
  const data = worldJsonObject(event.data)
  if (data === undefined) throw new TypeError(`${path} data must be an object`)
  return data
}

/** Rebuild current hand-hold state from the exact Event prefix; malformed transitions fail closed. */
export function currentCharacterRelations(events: readonly RulebookEvent[]): readonly CharacterRelationState[] {
  const relations = new Map<string, CharacterRelationState>()
  for (const [index, event] of events.entries()) {
    if (event.eventType === 'character.relation-started') {
      const data = relationData(event, `events[${index}]`)
      if (!exact(data, ['relationId', 'relationKind', 'initiatorId', 'targetId', 'interactionId', 'sourceActionId'])
        || event.eventVersion !== 1 || !text(data.relationId) || !data.relationId.startsWith('relation:')
        || data.relationKind !== 'hand_hold' || !text(data.initiatorId) || !text(data.targetId)
        || data.initiatorId === data.targetId || !text(data.interactionId) || !text(data.sourceActionId)
        || relations.has(data.relationId)) throw new TypeError('character relation start prefix is malformed')
      const duplicatePair = [...relations.values()].some(relation => relation.active
        && ((relation.initiatorId === data.initiatorId && relation.targetId === data.targetId)
          || (relation.initiatorId === data.targetId && relation.targetId === data.initiatorId)))
      if (duplicatePair) throw new TypeError('character relation prefix contains a duplicate active pair')
      relations.set(data.relationId, {
        relationId: data.relationId,
        relationKind: 'hand_hold',
        initiatorId: data.initiatorId,
        targetId: data.targetId,
        interactionId: data.interactionId,
        sourceActionId: data.sourceActionId,
        active: true,
      })
    }
    if (event.eventType === 'character.relation-ended') {
      const data = relationData(event, `events[${index}]`)
      if (!exact(data, ['relationId', 'endedByCharacterId', 'reason']) || event.eventVersion !== 1
        || !text(data.relationId) || !text(data.endedByCharacterId)
        || (data.reason !== 'released' && data.reason !== 'participant_moved' && data.reason !== 'participant_unavailable')) {
        throw new TypeError('character relation end prefix is malformed')
      }
      const relation = relations.get(data.relationId)
      if (relation === undefined || !relation.active
        || (data.endedByCharacterId !== relation.initiatorId && data.endedByCharacterId !== relation.targetId)) {
        throw new TypeError('character relation end violates the relation prefix')
      }
      relations.set(data.relationId, { ...relation, active: false })
    }
  }
  return [...relations.values()].sort((left, right) => compareWorldText(left.relationId, right.relationId))
}

export interface SceneState {
  readonly sceneId: string
  readonly lifecycle: 'created' | 'active' | 'closed'
  readonly participantIds: readonly string[]
}

/**
 * The frozen Scene facts of one Event prefix. It is shared by the closed catalog path and the frozen
 * interaction path, because both read the same Scene vocabulary and neither owns it.
 */
export function currentSceneStates(events: readonly RulebookEvent[]): readonly SceneState[] {
  return currentScenes(events)
}

function currentScenes(events: readonly RulebookEvent[]): readonly SceneState[] {
  const scenes = new Map<string, SceneState>()
  for (const event of events) {
    if (event.eventType === 'scene.upsert') {
      const data = worldJsonObject(event.data)
      const value = data?.value === undefined ? undefined : worldJsonObject(data.value)
      if (typeof data?.sceneId !== 'string' || value === undefined
        || (value.lifecycle !== 'created' && value.lifecycle !== 'active' && value.lifecycle !== 'closed')
        || !Array.isArray(value.participantIds) || value.participantIds.some(id => typeof id !== 'string')
        || new Set(value.participantIds).size !== value.participantIds.length || scenes.has(data.sceneId)) {
        throw new TypeError('scene prefix is malformed')
      }
      scenes.set(data.sceneId, { sceneId: data.sceneId, lifecycle: value.lifecycle, participantIds: value.participantIds as string[] })
      continue
    }
    if (!event.eventType.startsWith('scene.')) continue
    if (event.eventType === 'scene.remove') throw new TypeError('scene.remove is not valid in a Manifest v9 prefix')
    const data = worldJsonObject(event.data)
    if (typeof data?.sceneId !== 'string') throw new TypeError('scene prefix is malformed')
    if (event.eventType === 'scene.created') {
      if (scenes.has(data.sceneId)) throw new TypeError('scene prefix is malformed')
      scenes.set(data.sceneId, { sceneId: data.sceneId, lifecycle: 'created', participantIds: [] })
      continue
    }
    const scene = scenes.get(data.sceneId)
    if (scene === undefined) throw new TypeError('scene prefix is malformed')
    if (event.eventType === 'scene.activated') {
      if (scene.lifecycle !== 'created') throw new TypeError('scene prefix is malformed')
      scenes.set(data.sceneId, { ...scene, lifecycle: 'active' })
      continue
    }
    if (event.eventType === 'scene.closed') {
      if (scene.lifecycle !== 'active') throw new TypeError('scene prefix is malformed')
      scenes.set(data.sceneId, { ...scene, lifecycle: 'closed' })
      continue
    }
    if (event.eventType !== 'scene.member_joined' && event.eventType !== 'scene.member_left') continue
    if (scene.lifecycle === 'closed' || typeof data.characterId !== 'string') throw new TypeError('scene prefix is malformed')
    const members = new Set(scene.participantIds)
    if (event.eventType === 'scene.member_joined' ? members.has(data.characterId) : !members.has(data.characterId)) {
      throw new TypeError('scene membership prefix is malformed')
    }
    if (event.eventType === 'scene.member_joined') members.add(data.characterId)
    else members.delete(data.characterId)
    scenes.set(data.sceneId, { ...scene, participantIds: [...members].sort(compareWorldText) })
  }
  return [...scenes.values()]
}

function sharesActiveScene(events: readonly RulebookEvent[], actorId: string, targetId: string): boolean {
  return currentScenes(events).some(scene => scene.lifecycle === 'active'
    && scene.participantIds.includes(actorId) && scene.participantIds.includes(targetId))
}

function relationEnd(relationId: string, characterId: string, reason: 'released' | 'participant_moved' | 'participant_unavailable'): WorldEventDraft {
  return {
    eventType: 'character.relation-ended', eventVersion: 1,
    data: { relationId, endedByCharacterId: characterId, reason },
  }
}

/** Public relationship semantics omit the opaque release locator and source Action identity. */
export function characterRelationObservations(
  prefix: readonly RulebookEvent[],
  resolved: readonly RulebookEvent[],
): readonly WorldJsonObject[] {
  const relations = currentCharacterRelations([...prefix, ...resolved])
  return resolved.filter(event => event.eventType === 'character.relation-started' || event.eventType === 'character.relation-ended')
    .map(event => {
      const data = worldJsonObject(event.data)!
      const relation = relations.find(value => value.relationId === data.relationId)!
      return {
        relationKind: relation.relationKind,
        initiatorId: relation.initiatorId,
        targetId: relation.targetId,
        status: event.eventType === 'character.relation-started' ? 'started' : 'ended',
        ...(event.eventType === 'character.relation-ended' ? { reason: data.reason! } : {}),
      }
    })
}

function resolveCatalogV1(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
  parameters: WorldJsonObject,
  catalog: InteractionCatalogV1,
): RulebookResolution {
  const reject = (reason: string): RulebookResolution => ({ ...rejectRulebookResolution(actorId, 'interact', reason), observationScope: { scope: 'self' } })
  const binding = catalog.bindings.find(value => value.entityId === parameters.targetId)
  const definition = catalog.definitions.find(value => value.interactionId === parameters.interactionId)
  if (binding === undefined || definition === undefined || !binding.interactionIds.includes(definition.interactionId)) return reject('INTERACTION_NOT_BOUND')
  return resolveEntityInteraction(manifest, events, actorId, parameters, definition)
}

function resolveEntityInteraction(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
  parameters: WorldJsonObject,
  definition: Pick<InteractionDefinitionV1, 'interactionId' | 'operation'>,
): RulebookResolution {
  const reject = (reason: string): RulebookResolution => ({ ...rejectRulebookResolution(actorId, 'interact', reason), observationScope: { scope: 'self' } })
  const args = worldJsonObject(parameters.arguments!)
  if (args === undefined || Object.keys(args).sort(compareWorldText).join(',') !== (definition.operation === 'give' ? 'recipientId' : '')) return reject('INVALID_INTERACTION_ARGUMENTS')
  const entity = currentEntityState(events, parameters.targetId as string)
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

function resolveCatalogV2(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
  parameters: WorldJsonObject,
  catalog: InteractionCatalogV2,
  context: InteractionResolutionContext,
): RulebookResolution {
  const reject = (reason: string): RulebookResolution => ({ ...rejectRulebookResolution(actorId, 'interact', reason), observationScope: { scope: 'self' } })
  const authority = validateResolutionAuthority(context.resolutionAuthority)
  if (!text(context.actionId)) throw new TypeError('interaction actionId is invalid')
  const args = worldJsonObject(parameters.arguments!)
  if (args === undefined) return reject('INVALID_INTERACTION_ARGUMENTS')
  if (parameters.interactionId === 'core:release-hand') {
    if (!exact(args, [])) return reject('INVALID_INTERACTION_ARGUMENTS')
    const relation = currentCharacterRelations(events).find(value => value.relationId === parameters.targetId)
    if (relation === undefined || !relation.active) return reject('HAND_HOLD_NOT_ACTIVE')
    if (actorId !== relation.initiatorId && actorId !== relation.targetId) return reject('NOT_RELATION_PARTICIPANT')
    return {
      status: 'accepted', observationScope: { scope: 'scene_public' },
      events: [relationEnd(relation.relationId, actorId, 'released')],
    }
  }
  const binding = catalog.bindings.find(value => value.targetId === parameters.targetId)
  const definition = catalog.definitions.find(value => value.interactionId === parameters.interactionId)
  if (binding === undefined || definition === undefined || !binding.interactionIds.includes(definition.interactionId)) return reject('INTERACTION_NOT_BOUND')
  if (definition.targetKind === 'entity') return resolveEntityInteraction(manifest, events, actorId, parameters, definition)
  if (!exact(args, [])) return reject('INVALID_INTERACTION_ARGUMENTS')
  if (authority.sourceRole !== 'player' || authority.adjudicationMode !== 'manual_player_immediate'
    || !manifest.playerBindings.some(value => value.characterId === actorId)) return reject('HOLD_HAND_REQUIRES_MANUAL_PLAYER_IMMEDIATE')
  const targetId = parameters.targetId as string
  if (actorId === targetId) return reject('SELF_RELATION_NOT_ALLOWED')
  if (currentCharacterLifecycle(events, targetId) !== 'active') return reject('TARGET_NOT_ACTIVE')
  const actorLocation = currentLocation(events, actorId)
  if (actorLocation === undefined || actorLocation !== currentLocation(events, targetId) || !sharesActiveScene(events, actorId, targetId)) {
    return reject('TARGET_NOT_INTERACTABLE')
  }
  const relations = currentCharacterRelations(events)
  if (relations.some(relation => relation.active
    && ((relation.initiatorId === actorId && relation.targetId === targetId)
      || (relation.initiatorId === targetId && relation.targetId === actorId)))) return reject('HAND_HOLD_ALREADY_ACTIVE')
  const relationKind = 'hand_hold' as const
  const relationId = deterministicId('relation', {
    version: 'character-relation/v1', address: manifest.address, sourceActionId: context.actionId,
    relationKind, initiatorId: actorId, targetId,
  })
  return {
    status: 'accepted', observationScope: { scope: 'scene_public' },
    events: [{ eventType: 'character.relation-started', eventVersion: 1, data: {
      relationId, relationKind, initiatorId: actorId, targetId,
      interactionId: definition.interactionId, sourceActionId: context.actionId,
    } }],
  }
}

export function resolveInteraction(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
  input: WorldJsonValue,
  context?: InteractionResolutionContext,
): RulebookResolution {
  const reject = (reason: string): RulebookResolution => ({ ...rejectRulebookResolution(actorId, 'interact', reason), observationScope: { scope: 'self' } })
  const parameters = worldJsonObject(input)
  if (parameters === undefined || Object.keys(parameters).sort(compareWorldText).join(',') !== 'arguments,interactionId,targetId'
    || typeof parameters.targetId !== 'string' || typeof parameters.interactionId !== 'string') return reject('INVALID_INTERACTION_PARAMETERS')
  const catalog = manifest.interactionCatalog as InteractionCatalog
  if (catalog.version === 'object-interactions/v1') return resolveCatalogV1(manifest, events, actorId, parameters, catalog)
  if (context === undefined) throw new TypeError('Manifest v9 interaction resolution requires Host authority and actionId')
  return resolveCatalogV2(manifest, events, actorId, parameters, catalog, context)
}

function availableAuthority(manifest: CompiledWorldManifest, actorId: string): RulebookResolutionAuthorityV1 {
  return manifest.playerBindings.some(value => value.characterId === actorId)
    ? resolutionAuthority('player', 'manual_player_immediate')
    : resolutionAuthority('agent', 'standard')
}

/** Only expose executable choices; active relation locators are enumerated only to their participants. */
export function availableInteractions(
  manifest: CompiledWorldManifest,
  events: readonly RulebookEvent[],
  actorId: string,
  authority: RulebookResolutionAuthorityV1 = availableAuthority(manifest, actorId),
): readonly WorldJsonObject[] {
  const catalog = manifest.interactionCatalog as InteractionCatalog
  const choices: WorldJsonObject[] = []
  if (currentCharacterLifecycle(events, actorId) !== 'active') return choices
  if (catalog.version === 'object-interactions/v1') {
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
  validateResolutionAuthority(authority)
  for (const binding of catalog.bindings) {
    for (const interactionId of binding.interactionIds) {
      const definition = catalog.definitions.find(value => value.interactionId === interactionId)!
      if (definition.targetKind === 'character'
        && (authority.sourceRole !== 'player' || authority.adjudicationMode !== 'manual_player_immediate')) continue
      const argumentsList = definition.operation === 'give'
        ? manifest.characters.map(value => ({ recipientId: value.characterId } as WorldJsonObject)) : [{}]
      for (const args of argumentsList) {
        const parameters = { targetId: binding.targetId, interactionId, arguments: args }
        if (resolveInteraction(manifest, events, actorId, parameters, {
          actionId: 'action:affordance-only', resolutionAuthority: authority,
        }).status === 'accepted') choices.push({ ...parameters, label: definition.label })
      }
    }
  }
  for (const relation of currentCharacterRelations(events)) {
    if (relation.active && (relation.initiatorId === actorId || relation.targetId === actorId)) {
      choices.push({ targetId: relation.relationId, interactionId: 'core:release-hand', arguments: {}, label: '松开对方的手' })
    }
  }
  return choices.sort((a, b) => compareWorldText(JSON.stringify(a), JSON.stringify(b)))
}
