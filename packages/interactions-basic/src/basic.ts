import {
  hashWorldJson, type InteractionDefinitionImplementation, type InteractionDefinitionSpec,
  type InteractionEffectImplementation, type InteractionExecutionContext, type InteractionImplementationLock,
  type InteractionPackageImplementation, type InteractionRef, type InteractionRole,
  type InteractionRuleImplementation, type WorldEventDraft, type WorldJsonObject,
} from '@harness-world/contracts'
import { interactionPackageHash } from '@harness-world/interaction-runtime'

const ref = (id: string): InteractionRef => ({ id, version: 1 })
const implementation = (id: string): InteractionImplementationLock => ({ ref: ref(id), dependencies: [],
  implementationHash: hashWorldJson('basic-interaction-release/v1', { id, revision: 1 }) })

/** Host derives target state from an Event prefix; domain rules read only bound roles. */
function state(context: InteractionExecutionContext, role: string): WorldJsonObject {
  const target = context.roles[role]!
  return context.host.targets.find(entry => entry.ref.kind === target.kind && entry.ref.id === target.id)!.state
}

function rule(id: string, check: InteractionRuleImplementation['check']): InteractionRuleImplementation {
  return { lock: implementation(id), check }
}

const rules: readonly InteractionRuleImplementation[] = [
  rule('base:actor-active', context => context.host.authority.sourceRole !== 'director' && state(context, 'actor').lifecycle === 'active' ? null : 'ACTOR_CANNOT_ACT'),
  rule('base:item-unheld', context => state(context, 'item').holderId === null && typeof state(context, 'item').locationId === 'string' ? null : 'ITEM_NOT_AVAILABLE'),
  rule('base:item-held', context => state(context, 'item').holderId === context.roles.actor!.id ? null : 'ITEM_NOT_HELD'),
  rule('base:recipient-active', context => state(context, 'recipient').lifecycle === 'active' ? null : 'RECIPIENT_NOT_AVAILABLE'),
  rule('space:co-location', context => {
    const location = state(context, 'actor').locationId
    if (typeof location !== 'string') return 'LOCATION_UNAVAILABLE'
    for (const [name, target] of Object.entries(context.roles)) {
      const value = state(context, name)
      if (target.kind === 'entity' && value.holderId === context.roles.actor!.id) continue
      if (value.locationId !== location) return 'NOT_CO_LOCATED'
    }
    return null
  }),
  rule('space:scene-intersection', context => {
    const actorScenes = state(context, 'actor').sceneIds
    if (!Array.isArray(actorScenes)) return 'SCENE_UNAVAILABLE'
    for (const [name, target] of Object.entries(context.roles)) {
      if (target.kind !== 'character') continue
      const scenes = state(context, name).sceneIds
      if (!Array.isArray(scenes) || !scenes.some(scene => actorScenes.includes(scene))) return 'NO_SHARED_SCENE'
    }
    return null
  }),
]

type Destination = { readonly holderId: string | null; readonly locationId: string | null }
function transfer(context: InteractionExecutionContext, destination: Destination): WorldEventDraft {
  const item = state(context, 'item')
  return { eventType: 'entity.transferred', eventVersion: 1, data: {
    entityId: context.roles.item!.id, characterId: context.roles.actor!.id, interactionId: context.definition.id,
    fromHolderId: item.holderId!, fromLocationId: item.locationId!, toHolderId: destination.holderId, toLocationId: destination.locationId,
  } }
}

function effect(id: string, destination: (context: InteractionExecutionContext) => Destination): InteractionEffectImplementation {
  return { lock: implementation(id), eventTypes: [ref('entity.transferred')],
    build: context => [transfer(context, destination(context))],
    validate: (context, events) => {
      if (events.length !== 1) throw new TypeError('transfer requires one event')
      const event = events[0]!
      const data = event.data as WorldJsonObject
      const expected = destination(context)
      const item = state(context, 'item')
      if (event.eventType !== 'entity.transferred' || event.eventVersion !== 1 || data === null || typeof data !== 'object'
        || Object.keys(data).sort().join(',') !== 'characterId,entityId,fromHolderId,fromLocationId,interactionId,toHolderId,toLocationId'
        || data.entityId !== context.roles.item!.id || data.characterId !== context.roles.actor!.id || data.interactionId !== context.definition.id
        || data.fromHolderId !== item.holderId || data.fromLocationId !== item.locationId
        || data.toHolderId !== expected.holderId || data.toLocationId !== expected.locationId
        || (data.toHolderId === null) === (data.toLocationId === null)
        || (data.toHolderId !== null && typeof data.toHolderId !== 'string')
        || (data.toLocationId !== null && typeof data.toLocationId !== 'string')) throw new TypeError('transfer prefix or destination invariant failed')
    },
  }
}

const effects: readonly InteractionEffectImplementation[] = [
  effect('base:take-effect', context => ({ holderId: context.roles.actor!.id, locationId: null })),
  effect('base:drop-effect', context => ({ holderId: null, locationId: state(context, 'actor').locationId as string })),
  effect('base:give-effect', context => ({ holderId: context.roles.recipient!.id, locationId: null })),
]

const actor: InteractionRole = { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] }
const item: InteractionRole = { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] }
const recipient: InteractionRole = { name: 'recipient', kind: 'character', source: { kind: 'argument', field: 'recipientId' }, distinctFrom: ['actor'] }

function definition(id: string, preconditions: readonly string[], effectId: string, recipientRole: boolean): InteractionDefinitionImplementation {
  const spec: InteractionDefinitionSpec = { versionTag: 'interaction-definition/v1', id, version: 1,
    participantRoles: recipientRole ? [actor, item, recipient] : [actor, item],
    argumentSchema: { fields: recipientRole ? [{ name: 'recipientId', type: 'string', maxBytes: 1024, values: [] }] : [] },
    bindingConfigSchema: { fields: [] }, authorityPolicyRef: ref('base:actor-active'), preconditions: preconditions.map(ref),
    spatialRequirementRefs: [ref('space:co-location'), ref('space:scene-intersection')],
    effectBuilderRef: ref(effectId), effectCapabilityRefs: [ref(effectId)], dependencyRefs: [], limits: { maximumEvents: 1 },
  }
  return { spec, implementationHash: implementation(id).implementationHash }
}

/** I1 object slice. Contact definitions join in I3, through this same contract. */
export function createBasicInteractionPackage(): InteractionPackageImplementation {
  const contents = { rules, effects, definitions: [
    definition('base:take', ['base:item-unheld'], 'base:take-effect', false),
    definition('base:drop', ['base:item-held'], 'base:drop-effect', false),
    definition('base:give', ['base:item-held', 'base:recipient-active'], 'base:give-effect', true),
  ] }
  return { lock: { ref: ref('package:interactions-basic'), dependencies: [], implementationHash: interactionPackageHash(contents) }, ...contents }
}
