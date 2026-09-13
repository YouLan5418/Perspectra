import { describe, expect, it } from 'vitest'
import {
  brandId, hashWorldJson,
  type CharacterId, type InteractionBindingV3, type InteractionHostContext, type InteractionImplementationLock,
  type InteractionRef, type InteractionWorldSelection, type RulebookResolutionAuthorityV1,
  type WorldAddress, type WorldJsonObject,
} from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { InteractionRegistry, interactionPackageHash, type FrozenInteractionWorld } from './registry.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant:contact', 'TenantId'),
  worldId: brandId('world:contact', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const actor: CharacterId = brandId('character:player', 'CharacterId')
const manifestHash = hashWorldJson('contact/manifest/v1', {})
const prefixHash = hashWorldJson('contact/prefix/v1', {})

const ref = (id: string): InteractionRef => ({ id, version: 1 })
const alice = { kind: 'character', id: 'character:alice' } as const
const shared = { kind: 'relation', id: 'relation:held' } as const

const playerImmediate: RulebookResolutionAuthorityV1 = {
  version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'manual_player_immediate',
}
const agentStandard: RulebookResolutionAuthorityV1 = {
  version: 'resolution-authority/v1', sourceRole: 'agent', adjudicationMode: 'standard',
}

const pack = createBasicInteractionPackage()

function selection(lock: InteractionImplementationLock = pack.lock): InteractionWorldSelection {
  const bindings: InteractionBindingV3[] = [
    ...(['base:take', 'base:drop', 'base:give'] as const).map(id => ({
      bindingId: `binding:cup-${id}`, targetRef: { kind: 'entity' as const, id: 'entity:cup' }, definitionRef: ref(id), config: {},
    })),
    { bindingId: 'binding:alice-hold', targetRef: alice, definitionRef: ref('base:hold-hand'), config: {} },
    { bindingId: 'binding:held-release', targetRef: shared, definitionRef: ref('base:end-contact'), config: {} },
  ]
  return {
    address, packages: [lock],
    definitions: pack.definitions.map(def => ({
      ref: { id: def.spec.id, version: def.spec.version },
      definitionHash: hashWorldJson('interaction-definition/v1', def.spec),
      implementationHash: def.implementationHash,
    })),
    bindings,
  }
}

const character = (id: string, locationId = 'location:hall'): WorldJsonObject =>
  ({ id, lifecycle: 'active', locationId, sceneIds: ['scene:hall'] })

/** The pair relation is inactive by default, which is the only state hold-hand can start from. */
function host(relationActive = false, over: Partial<InteractionHostContext> = {}): InteractionHostContext {
  const targets = over.targets ?? [
    { ref: { kind: 'character' as const, id: actor }, state: character(actor) },
    { ref: alice, state: character('character:alice') },
    { ref: { kind: 'entity' as const, id: 'entity:cup' }, state: { holderId: null, locationId: 'location:hall' } },
    { ref: shared, state: { relationKind: 'hand_hold', initiatorId: actor, targetId: 'character:alice', active: relationActive } },
  ]
  const authorizedTargets = over.authorizedTargets ?? [
    alice, { kind: 'entity', id: 'entity:cup' }, shared,
  ]
  return {
    address, manifestHash, asOfWorldSeq: 3, candidatePrefixHash: prefixHash,
    actionId: 'action:contact', actorId: actor, authority: playerImmediate,
    targets, authorizedTargets, ...over,
  }
}

function runtime(): FrozenInteractionWorld {
  const registry = new InteractionRegistry()
  registry.install(pack)
  return registry.freeze(selection())
}

const request = (id: string, targetRef: unknown, bindingId: string, args: WorldJsonObject = {}) =>
  ({ targetRef, bindingId, definitionRef: ref(id), arguments: args })

describe('contact relation domain', () => {
  it('establishes a releaseable relation whose identity replays instead of duplicating', () => {
    const held = runtime()
    const first = held.resolve(host(), request('base:hold-hand', alice, 'binding:alice-hold'))
    expect(first.status).toBe('accepted')
    expect(first.events).toHaveLength(1)
    expect(first.events[0]!.eventType).toBe('character.relation-started')
    expect(first.events[0]!.data).toMatchObject({
      relationKind: 'hand_hold', initiatorId: actor, targetId: 'character:alice', interactionId: 'base:hold-hand',
    })
    // Same address, Action and pair: the relation identity is derived, so a replay mints the same one.
    expect(held.resolve(host(), request('base:hold-hand', alice, 'binding:alice-hold')).events).toEqual(first.events)
    const other = held.resolve(host(false, { actionId: 'action:contact-2' }), request('base:hold-hand', alice, 'binding:alice-hold'))
    expect(other.events[0]!.data).not.toEqual(first.events[0]!.data)
  })

  it('requires a Host-proven manual player to establish contact and lets either side release it', () => {
    const held = runtime()
    expect(held.resolve(host(false, { authority: agentStandard }), request('base:hold-hand', alice, 'binding:alice-hold')).reason)
      .toBe('HOLD_HAND_REQUIRES_MANUAL_PLAYER_IMMEDIATE')
    // The authority travels in the context; a request cannot claim it.
    expect(held.resolve(host(false, { authority: agentStandard }), request('base:hold-hand', alice, 'binding:alice-hold')).events).toEqual([])
    const released = held.resolve(host(true), request('base:end-contact', shared, 'binding:held-release'))
    expect(released.status).toBe('accepted')
    expect(released.events[0]!.eventType).toBe('character.relation-ended')
    expect(released.events[0]!.data).toEqual({ relationId: 'relation:held', endedByCharacterId: actor, reason: 'released' })
  })

  it('refuses a self pair, an already paired pair and an absent partner', () => {
    const held = runtime()
    // The actor is the target here, which is the one pair a contact definition must never accept.
    const selfPair = host(false, { actorId: brandId('character:alice', 'CharacterId') })
    // Rejected structurally, before any rule: the target role is distinct from the actor.
    expect(held.resolve(selfPair, request('base:hold-hand', alice, 'binding:alice-hold')).reason)
      .toBe('PARTICIPANT_ALIAS_FORBIDDEN')
    // Once the snapshot carries an active pair, a second start on the same pair is refused - and it
    // does not matter which side of the pair the snapshot recorded as the initiator.
    expect(held.resolve(host(true), request('base:hold-hand', alice, 'binding:alice-hold')).reason).toBe('CONTACT_ALREADY_ACTIVE')
    const reversed = host(false, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: alice, state: character('character:alice') },
        { ref: shared, state: { relationKind: 'hand_hold', initiatorId: 'character:alice', targetId: actor, active: true } },
      ],
      authorizedTargets: [alice, shared],
    })
    expect(held.resolve(reversed, request('base:hold-hand', alice, 'binding:alice-hold')).reason).toBe('CONTACT_ALREADY_ACTIVE')
    expect(held.resolve(host(), request('base:end-contact', shared, 'binding:held-release')).reason).toBe('CONTACT_NOT_ACTIVE')
  })

  it('refuses contact across locations or scenes and from a non participant', () => {
    const held = runtime()
    const apart = host(false, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: alice, state: character('character:alice', 'location:elsewhere') },
        { ref: shared, state: { relationKind: 'hand_hold', initiatorId: actor, targetId: 'character:alice', active: true } },
      ],
      authorizedTargets: [alice, shared],
    })
    expect(held.resolve(apart, request('base:hold-hand', alice, 'binding:alice-hold')).reason).toBe('NOT_CO_LOCATED')
    const bob = { kind: 'character', id: 'character:bob' } as const
    const stranger = host(true, {
      actorId: brandId('character:bob', 'CharacterId'),
      targets: [...host(true).targets, { ref: bob, state: character('character:bob') }],
      authorizedTargets: [...host(true).authorizedTargets, bob],
    })
    expect(held.resolve(stranger, request('base:end-contact', shared, 'binding:held-release')).reason).toBe('NOT_CONTACT_PARTICIPANT')
  })

  it('binds the relation participants as derived roles without the request naming them', () => {
    const held = runtime()
    const released = held.resolve(host(true), request('base:end-contact', shared, 'binding:held-release'))
    // The proof is structural: the request carries no initiator or target, yet both rules that read
    // them ran and the event names the relation the snapshot carried.
    expect(released.trace.map(entry => entry.rule.id)).toEqual(['base:actor-active', 'contact:active', 'contact:participant'])
    expect(released.trace.every(entry => entry.reason === null)).toBe(true)
  })

  it('refuses to bind a derivation the snapshot cannot satisfy', () => {
    const held = runtime()
    const broken = host(true, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: shared, state: { relationKind: 'hand_hold', active: true } },
      ],
      authorizedTargets: [shared],
    })
    expect(held.resolve(broken, request('base:end-contact', shared, 'binding:held-release')).reason).toBe('PARTICIPANT_NOT_AUTHORIZED')
  })

  it('offers contact only to the authority the definition names', () => {
    const view = runtime().view({
      address, manifestHash, asOfWorldSeq: 3, characterId: actor, candidatePrefixHash: prefixHash,
      authority: playerImmediate, viewPolicyHash: hashWorldJson('contact/view-policy/v1', {}),
      targets: host().targets, authorizedTargets: host().authorizedTargets,
    })
    // The cup is also co-located and unheld, so take is offered alongside hold-hand.
    expect(view.options.map(option => option.definitionRef.id)).toEqual(['base:hold-hand', 'base:take'])
    const asAgent = runtime().view({
      address, manifestHash, asOfWorldSeq: 3, characterId: actor, candidatePrefixHash: prefixHash,
      authority: agentStandard, viewPolicyHash: hashWorldJson('contact/view-policy/v1', {}),
      targets: host().targets, authorizedTargets: host().authorizedTargets,
    })
    // The agent authority cannot establish contact, and the pair is not active, so nothing is offered.
    expect(asAgent.options.map(option => option.definitionRef.id)).toEqual(['base:take'])
  })

  it('checks the contact effect against the resolved participants', () => {
    // The plan already makes a malformed contact impossible, so the effect's own guard is exercised
    // directly: it is the last line for a caller that hands it something else.
    const effects = pack.effects
    const context = {
      host: host(false), definition: pack.definitions.find(def => def.spec.id === 'base:hold-hand')!.spec,
      binding: { bindingId: 'binding:alice-hold', targetRef: alice, definitionRef: ref('base:hold-hand'), config: {} },
      arguments: {}, roles: { actor: { kind: 'character' as const, id: actor }, target: alice },
    }
    for (const [id, expected] of [['contact:start-effect', /requires one event/u], ['contact:end-effect', /requires one event/u]] as const) {
      const effect = effects.find(entry => entry.lock.ref.id === id)!
      expect(() => effect.validate(context, [])).toThrow(expected)
      if (id === 'contact:end-effect') continue
      expect(() => effect.validate(context, [{ eventType: 'character.relation-started', eventVersion: 1, data: {} }] as never))
        .toThrow(/does not match the resolved participants/u)
    }
    const start = effects.find(entry => entry.lock.ref.id === 'contact:start-effect')!
    const selfContext = { ...context, roles: { actor: { kind: 'character' as const, id: actor }, target: { kind: 'character' as const, id: actor } } }
    expect(() => start.validate(selfContext, start.build(selfContext))).toThrow(/cannot target the actor/u)
    const end = effects.find(entry => entry.lock.ref.id === 'contact:end-effect')!
    const stranger = { ...context, roles: { actor: { kind: 'character' as const, id: 'character:bob' }, contact: shared, initiator: alice, target: alice } }
    expect(() => end.validate(stranger, end.build(stranger))).toThrow(/requires a participant/u)
  })

  it('treats an unrelated or inactive relation as no pair at all', () => {
    const held = runtime()
    const unrelated = host(false, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: alice, state: character('character:alice') },
        { ref: { kind: 'relation', id: 'relation:other' },
          state: { relationKind: 'hand_hold', initiatorId: 'character:carol', targetId: 'character:dave', active: true } },
      ],
      authorizedTargets: [alice, { kind: 'relation', id: 'relation:other' }],
    })
    // carol and dave are paired, not the actor and alice, so the actor may still reach out.
    expect(held.resolve(unrelated, request('base:hold-hand', alice, 'binding:alice-hold')).status).toBe('accepted')
    const withoutRelation = host(false, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: alice, state: character('character:alice') },
      ],
      authorizedTargets: [alice],
    })
    expect(held.resolve(withoutRelation, request('base:hold-hand', alice, 'binding:alice-hold')).status).toBe('accepted')
  })

  it('refuses a role source, a resolver and a derivation the package cannot support', () => {
    const registry = new InteractionRegistry()
    const base = pack
    const bogus = { ...base.definitions[0]!, spec: { ...base.definitions[0]!.spec, participantRoles: [
      { name: 'actor', kind: 'character' as const, source: { kind: 'hostActor' as const }, distinctFrom: [] },
      { name: 'item', kind: 'entity' as const, source: { kind: 'elsewhere' as never }, distinctFrom: [] },
    ] } }
    expect(() => new InteractionRegistry().install({ ...base, definitions: [bogus] })).toThrow(/unsupported role source/u)
    expect(() => new InteractionRegistry().install({ ...base, resolvers: [{ lock: base.resolvers[0]!.lock, resolve: null as never }] }))
      .toThrow(/derived resolver implementation missing/u)
    // A definition whose derivation is not installed cannot be enabled.
    registry.install(pack)
    expect(() => registry.freeze(selection())).not.toThrow()
    expect(() => new InteractionRegistry().freeze(selection())).toThrow(/package missing/u)
    const orphan = { ...base, lock: { ...base.lock, implementationHash: hashWorldJson('orphan/v1', {}) } }
    expect(() => new InteractionRegistry().install(orphan)).toThrow(/lock drift/u)
    // A package that honestly declares no resolver installs fine, but its contact definition cannot
    // then be enabled: the derivation has nothing to resolve against.
    const bare = { ...base, resolvers: [] as typeof base.resolvers }
    const relocked = { ...bare, lock: { ...base.lock, implementationHash: interactionPackageHash(bare) } }
    const bareRegistry = new InteractionRegistry()
    bareRegistry.install(relocked)
    expect(() => bareRegistry.freeze(selection(relocked.lock))).toThrow(/derived resolver missing/u)
  })

  it('refuses a derivation that resolves outside the candidate snapshot', () => {
    const held = runtime()
    const outside = host(true, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: shared, state: { relationKind: 'hand_hold', initiatorId: 'character:ghost', targetId: 'character:alice', active: true } },
      ],
      authorizedTargets: [shared],
    })
    expect(held.resolve(outside, request('base:end-contact', shared, 'binding:held-release')).reason).toBe('PARTICIPANT_NOT_AUTHORIZED')
    const incomplete = host(true, {
      targets: [
        { ref: { kind: 'character', id: actor }, state: character(actor) },
        { ref: shared, state: { relationKind: 'hand_hold', initiatorId: actor, active: true } },
      ],
      authorizedTargets: [shared],
    })
    expect(held.resolve(incomplete, request('base:end-contact', shared, 'binding:held-release')).reason).toBe('PARTICIPANT_NOT_AUTHORIZED')
  })

  it('refuses to enable a contact definition whose derived resolver is not installed', () => {
    const registry = new InteractionRegistry()
    const stripped = { ...pack, resolvers: [], lock: { ...pack.lock } as InteractionImplementationLock }
    stripped.lock = { ...stripped.lock, implementationHash: pack.lock.implementationHash }
    expect(() => registry.install(stripped)).toThrow(/package component lock drift/u)
    registry.install(pack)
    const held = registry.freeze(selection())
    expect(held.resolve(host(true), request('base:end-contact', shared, 'binding:held-release')).status).toBe('accepted')
  })
})
