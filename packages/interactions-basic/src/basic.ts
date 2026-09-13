import {
  deterministicId, hashWorldJson,
  type InteractionDefinitionImplementation, type InteractionDefinitionSpec,
  type InteractionDerivedResolverImplementation, type InteractionLifecycleHandlerImplementation,
  type InteractionEffectImplementation, type InteractionExecutionContext, type InteractionImplementationLock,
  type InteractionPackageImplementation, type InteractionPerformanceImplementation, type InteractionRef,
  type InteractionRole, type InteractionRuleImplementation, type WorldEventDraft, type WorldJsonObject,
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

/** Relation state is Host-supplied under a `relation` target; the definition never invents it. */
function relation(context: InteractionExecutionContext): WorldJsonObject {
  const target = context.roles.contact!
  return context.host.targets.find(entry => entry.ref.kind === 'relation' && entry.ref.id === target.id)!.state
}

function participant(context: InteractionExecutionContext, name: string): string | null {
  const value = relation(context)[name]
  return typeof value === 'string' ? value : null
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
  // Only a Host-proven manual player may establish contact; the authority travels in the context and
  // is never read from the request arguments.
  rule('base:player-immediate', context => context.host.authority.sourceRole === 'player'
    && context.host.authority.adjudicationMode === 'manual_player_immediate' ? null : 'HOLD_HAND_REQUIRES_MANUAL_PLAYER_IMMEDIATE'),
  rule('contact:active', context => relation(context).active === true ? null : 'CONTACT_NOT_ACTIVE'),
  rule('contact:participant', context => {
    const actorId = context.roles.actor!.id
    return actorId === participant(context, 'initiatorId') || actorId === participant(context, 'targetId')
      ? null : 'NOT_CONTACT_PARTICIPANT'
  }),
  // Self contact is already impossible structurally: the target role declares distinctFrom actor, so
  // the alias check rejects it before any rule runs and this rule never needs to repeat that.
  rule('contact:unpaired', context => {
    const partner = context.roles.target!.id
    const actorId = context.roles.actor!.id
    // hold-hand has no contact role of its own, so the pair check reads every relation the Host put
    // in the snapshot rather than a single named one.
    const paired = context.host.targets.some(entry => entry.ref.kind === 'relation' && entry.state.active === true
      && ((entry.state.initiatorId === actorId && entry.state.targetId === partner)
        || (entry.state.initiatorId === partner && entry.state.targetId === actorId)))
    return paired ? 'CONTACT_ALREADY_ACTIVE' : null
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

/**
 * Relation identity is derived from the World, the source Action, the definition lock and the pair,
 * so a replay of the same Action mints the same relation instead of a second one.
 */
function contact(context: InteractionExecutionContext, kind: 'started' | 'ended'): WorldEventDraft {
  const actorId = context.roles.actor!.id
  if (kind === 'ended') {
    // Releasing addresses the relation itself, so its identity already exists and is never re-derived.
    return { eventType: 'character.relation-ended', eventVersion: 1, data: {
      relationId: context.roles.contact!.id, endedByCharacterId: actorId, reason: 'released',
    } }
  }
  const partner = context.roles.target!.id
  return { eventType: 'character.relation-started', eventVersion: 1, data: {
    relationId: deterministicId('relation', {
      version: 'character-relation/v1', address: context.host.address, sourceActionId: context.host.actionId,
      relationKind: 'hand_hold', initiatorId: actorId, targetId: partner,
    }),
    relationKind: 'hand_hold', initiatorId: actorId, targetId: partner,
    interactionId: context.definition.id, sourceActionId: context.host.actionId,
  } }
}

function contactEffect(id: string, kind: 'started' | 'ended'): InteractionEffectImplementation {
  return { lock: implementation(id), eventTypes: [ref(kind === 'started' ? 'character.relation-started' : 'character.relation-ended')],
    build: context => [contact(context, kind)],
    validate: (context, events) => {
      if (events.length !== 1) throw new TypeError('contact requires one event')
      const event = events[0]!
      // Compared by canonical hash: the runtime hands the effect its frozen copy, whose key order is
      // canonical, so a structural comparison here would fail for the wrong reason.
      if (hashWorldJson('contact-event', event as unknown as WorldJsonObject)
        !== hashWorldJson('contact-event', contact(context, kind) as unknown as WorldJsonObject)) {
        throw new TypeError('contact event does not match the resolved participants')
      }
      const actorId = context.roles.actor!.id
      if (kind === 'started' && actorId === context.roles.target!.id) throw new TypeError('contact start cannot target the actor')
      if (kind === 'ended' && actorId !== participant(context, 'initiatorId') && actorId !== participant(context, 'targetId')) {
        throw new TypeError('contact end requires a participant')
      }
    },
  }
}

const resolvers: readonly InteractionDerivedResolverImplementation[] = [
  { lock: implementation('contact:initiator'), resolve: context => participant(context, 'initiatorId') === null
    ? null : { kind: 'character', id: participant(context, 'initiatorId')! } },
  { lock: implementation('contact:target'), resolve: context => participant(context, 'targetId') === null
    ? null : { kind: 'character', id: participant(context, 'targetId')! } },
]

type Lifecycle = Parameters<InteractionLifecycleHandlerImplementation['build']>[0]

function participantState(context: Lifecycle, id: unknown): WorldJsonObject | undefined {
  return typeof id === 'string'
    ? context.host.targets.find(entry => entry.ref.kind === 'character' && entry.ref.id === id)?.state
    : undefined
}

/** Out of reach means either participant is gone, inactive, or no longer sharing a place and scene. */
function outOfReach(context: Lifecycle, state: WorldJsonObject): boolean {
  const initiator = participantState(context, state.initiatorId)
  const target = participantState(context, state.targetId)
  if (initiator === undefined || target === undefined) return true
  if (initiator.lifecycle !== 'active' || target.lifecycle !== 'active') return true
  const scenes = Array.isArray(initiator.sceneIds) ? initiator.sceneIds : []
  const others = Array.isArray(target.sceneIds) ? target.sceneIds : []
  return initiator.locationId !== target.locationId || !others.some(scene => scenes.includes(scene))
}

/**
 * The step the Host runs after a move. Contact ends once its two participants are no longer in each
 * other's reach; the generic runtime never learns what contact means, it only enforces phase order,
 * event closure and the fold budget, and this handler reads the relation generically rather than by
 * relation kind.
 */
const endOnMove: InteractionLifecycleHandlerImplementation = {
  lock: implementation('contact:end-on-move'),
  phase: 'relation-end',
  eventTypes: [ref('character.relation-ended')],
  build: context => context.host.targets
    .filter(entry => entry.ref.kind === 'relation' && entry.state.active === true && outOfReach(context, entry.state))
    .map(entry => ({
      eventType: 'character.relation-ended', eventVersion: 1,
      data: {
        relationId: entry.ref.id,
        endedByCharacterId: entry.state.initiatorId as string,
        reason: participantState(context, entry.state.initiatorId)?.lifecycle === 'active'
          && participantState(context, entry.state.targetId)?.lifecycle === 'active'
          ? 'participant_moved' : 'participant_unavailable',
      },
    })),
}

const lifecycle: readonly InteractionLifecycleHandlerImplementation[] = [endOnMove]

const effects: readonly InteractionEffectImplementation[] = [
  effect('base:take-effect', context => ({ holderId: context.roles.actor!.id, locationId: null })),
  effect('base:drop-effect', context => ({ holderId: null, locationId: state(context, 'actor').locationId as string })),
  effect('base:give-effect', context => ({ holderId: context.roles.recipient!.id, locationId: null })),
  contactEffect('contact:start-effect', 'started'),
  contactEffect('contact:end-effect', 'ended'),
]

const actor: InteractionRole = { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] }
const item: InteractionRole = { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] }
const recipient: InteractionRole = { name: 'recipient', kind: 'character', source: { kind: 'argument', field: 'recipientId' }, distinctFrom: ['actor'] }

/**
 * The first batch declares no manifestation at all. take/drop/give are state transfers, so a cue
 * attached to one of them would claim a self-expression the definition never sanctioned; the empty
 * policy is what makes such a request a proposal failure instead of a silently ignored field.
 */
const noPerformance: InteractionPerformanceImplementation = {
  lock: implementation('base:no-performance'),
  policy: { version: 'interaction-performance/v1', accepted: [] },
}

function definition(id: string, preconditions: readonly string[], effectId: string, recipientRole: boolean): InteractionDefinitionImplementation {
  const spec: InteractionDefinitionSpec = { versionTag: 'interaction-definition/v1', id, version: 1,
    participantRoles: recipientRole ? [actor, item, recipient] : [actor, item],
    argumentSchema: { fields: recipientRole ? [{ name: 'recipientId', type: 'string', maxBytes: 1024, values: [] }] : [] },
    bindingConfigSchema: { fields: [] }, authorityPolicyRef: ref('base:actor-active'), preconditions: preconditions.map(ref),
    spatialRequirementRefs: [ref('space:co-location'), ref('space:scene-intersection')],
    effectBuilderRef: ref(effectId), effectCapabilityRefs: [ref(effectId)], dependencyRefs: [],
    performancePolicyRef: ref('base:no-performance'), lifecycleRefs: [], limits: { maximumEvents: 1 },
  }
  return { spec, implementationHash: implementation(id).implementationHash }
}

const targetRole: InteractionRole = { name: 'target', kind: 'character', source: { kind: 'primaryTarget' }, distinctFrom: ['actor'] }
const contactRole: InteractionRole = { name: 'contact', kind: 'relation', source: { kind: 'primaryTarget' }, distinctFrom: [] }
// Either side may release, so neither derived participant is distinct from the actor; the constraint
// that matters is that a relation never names the same character twice.
const initiatorRole: InteractionRole = { name: 'initiator', kind: 'character', source: { kind: 'derived', resolver: ref('contact:initiator') }, distinctFrom: ['target'] }
const contactTargetRole: InteractionRole = { name: 'target', kind: 'character', source: { kind: 'derived', resolver: ref('contact:target') }, distinctFrom: ['initiator'] }

/**
 * hold-hand establishes contact only under a Host-proven manual player; end-contact lets either
 * participant release it. Neither asks the model whether the other side agreed, because a contact
 * event never means consent - it means the relation exists and either side may end it.
 */
function contactDefinition(id: string, roles: readonly InteractionRole[], preconditions: readonly string[],
  spatial: readonly string[], effectId: string, authority: string,
  lifecycleRefs: readonly InteractionRef[] = []): InteractionDefinitionImplementation {
  const spec: InteractionDefinitionSpec = { versionTag: 'interaction-definition/v1', id, version: 1,
    participantRoles: roles, argumentSchema: { fields: [] }, bindingConfigSchema: { fields: [] },
    authorityPolicyRef: ref(authority), preconditions: preconditions.map(ref), spatialRequirementRefs: spatial.map(ref),
    effectBuilderRef: ref(effectId), effectCapabilityRefs: [ref(effectId)], dependencyRefs: [],
    performancePolicyRef: ref('base:no-performance'), lifecycleRefs, limits: { maximumEvents: 1 },
  }
  return { spec, implementationHash: implementation(id).implementationHash }
}

/** I1 object slice plus the I3 contact slice, through the same contract. */
export function createBasicInteractionPackage(): InteractionPackageImplementation {
  const contents = { rules, effects, resolvers, lifecycle, performances: [noPerformance], definitions: [
    definition('base:take', ['base:item-unheld'], 'base:take-effect', false),
    definition('base:drop', ['base:item-held'], 'base:drop-effect', false),
    definition('base:give', ['base:item-held', 'base:recipient-active'], 'base:give-effect', true),
    contactDefinition('base:hold-hand', [actor, targetRole],
      ['base:actor-active', 'space:co-location', 'space:scene-intersection', 'contact:unpaired'],
      [], 'contact:start-effect', 'base:player-immediate'),
    contactDefinition('base:end-contact', [actor, contactRole, initiatorRole, contactTargetRole],
      ['contact:active', 'contact:participant'],
      [], 'contact:end-effect', 'base:actor-active', [ref('contact:end-on-move')]),
  ] }
  return { lock: { ref: ref('package:interactions-basic'), dependencies: [], implementationHash: interactionPackageHash(contents) }, ...contents }
}
