import { describe, expect, it } from 'vitest'
import {
  brandId, hashWorldJson,
  type CharacterId, type InteractionBindingV3, type InteractionDefinitionImplementation,
  type InteractionDefinitionSpec, type InteractionEffectImplementation, type InteractionImplementationLock,
  type InteractionPackageImplementation, type InteractionRef, type InteractionRole,
  type InteractionRuleImplementation, type InteractionViewContext,
  type WorldAddress, type WorldEventDraft, type WorldJsonObject,
} from '@harness-world/contracts'
import { InteractionRegistry, interactionPackageHash, type FrozenInteractionWorld } from './registry.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant:view', 'TenantId'),
  worldId: brandId('world:view', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const manifestHash = hashWorldJson('fixture/manifest/v1', {})
const prefixHash = hashWorldJson('fixture/prefix/v1', {})
const viewPolicyHash = hashWorldJson('fixture/view-policy/v1', {})
const actor: CharacterId = brandId('character:player', 'CharacterId')

const ref = (id: string): InteractionRef => ({ id, version: 1 })

/** Counts effect calls so a test can prove enumeration never reaches an effect builder. */
const effectCalls = { build: 0, validate: 0 }

function implementation(id: string): InteractionImplementationLock {
  return { ref: ref(id), dependencies: [], implementationHash: hashWorldJson('fixture-release/v1', { id }) }
}

const actorRole: InteractionRole = { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] }
const itemRole: InteractionRole = { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] }
const recipientRole: InteractionRole = { name: 'recipient', kind: 'character', source: { kind: 'argument', field: 'recipientId' }, distinctFrom: ['actor'] }

const publicRule: InteractionRuleImplementation = { lock: implementation('fixture:public'), check: () => null }
const hiddenRule: InteractionRuleImplementation = {
  lock: implementation('fixture:hidden'),
  check: context => context.binding.config.blocked === true ? 'BLOCKED' : null,
}
const transfer: InteractionEffectImplementation = {
  lock: implementation('fixture:effect'),
  eventTypes: [ref('fixture.transferred')],
  build: (): readonly WorldEventDraft[] => { effectCalls.build++; return [{ eventType: 'fixture.transferred', eventVersion: 1, data: {} }] },
  validate: (): void => { effectCalls.validate++ },
}

function definition(id: string, withRecipient: boolean, blocked: boolean): InteractionDefinitionImplementation {
  const spec: InteractionDefinitionSpec = {
    versionTag: 'interaction-definition/v1', id, version: 1,
    participantRoles: withRecipient ? [actorRole, itemRole, recipientRole] : [actorRole, itemRole],
    argumentSchema: { fields: withRecipient ? [{ name: 'recipientId', type: 'string', maxBytes: 1024, values: [] }] : [] },
    bindingConfigSchema: { fields: blocked ? [{ name: 'blocked', type: 'boolean' }] : [] },
    authorityPolicyRef: ref('fixture:public'), preconditions: [...(blocked ? [ref('fixture:hidden')] : []), ref('fixture:public')],
    spatialRequirementRefs: [], effectBuilderRef: ref('fixture:effect'), effectCapabilityRefs: [ref('fixture:effect')],
    dependencyRefs: [], limits: { maximumEvents: 1 },
  }
  return { spec, implementationHash: implementation(id).implementationHash }
}

function bundle() {
  const definitions = [definition('fixture:use', false, false), definition('fixture:give', true, false), definition('fixture:guarded', false, true)]
  const contents = { rules: [publicRule, hiddenRule], effects: [transfer], definitions }
  const lock: InteractionImplementationLock = {
    ref: ref('package:fixture'), dependencies: [], implementationHash: interactionPackageHash(contents),
  }
  return { lock, ...contents }
}

function instantiate(extraEntities: readonly string[] = []): FrozenInteractionWorld {
  const pkg: InteractionPackageImplementation = bundle()
  const registry = new InteractionRegistry()
  registry.install(pkg)
  const bindings: InteractionBindingV3[] = [
    { bindingId: 'binding:cup-use', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref('fixture:use'), config: {} },
    { bindingId: 'binding:cup-give', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref('fixture:give'), config: {} },
    { bindingId: 'binding:door-use', targetRef: { kind: 'entity', id: 'entity:door' }, definitionRef: ref('fixture:use'), config: {} },
    { bindingId: 'binding:cup-guarded', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref('fixture:guarded'), config: { blocked: true } },
    ...extraEntities.map(id => ({
      bindingId: `binding:${id}-use`, targetRef: { kind: 'entity' as const, id }, definitionRef: ref('fixture:use'), config: {},
    })),
  ]
  return registry.freeze({
    address,
    packages: [pkg.lock],
    definitions: pkg.definitions.map(entry => ({
      ref: { id: entry.spec.id, version: entry.spec.version },
      definitionHash: hashWorldJson('interaction-definition/v1', entry.spec),
      implementationHash: entry.implementationHash,
    })),
    bindings,
  })
}

const states = {
  character: (id: string): WorldJsonObject => ({ id, lifecycle: 'active', locationId: 'location:hall', sceneIds: ['scene:hall'] }),
  entity: (id: string): WorldJsonObject => ({ id, holderId: null, locationId: 'location:hall' }),
}

/** A world holding exactly one definition, for domain coverage that the shared bundle would blur. */
function single(spec: InteractionDefinitionSpec): FrozenInteractionWorld {
  const contents = { rules: [publicRule], effects: [transfer], definitions: [{ spec, implementationHash: implementation(spec.id).implementationHash }] }
  const lock: InteractionImplementationLock = { ref: ref('package:single'), dependencies: [], implementationHash: interactionPackageHash(contents) }
  const registry = new InteractionRegistry()
  registry.install({ lock, ...contents })
  return registry.freeze({
    address, packages: [lock],
    definitions: [{
      ref: { id: spec.id, version: spec.version },
      definitionHash: hashWorldJson('interaction-definition/v1', spec),
      implementationHash: implementation(spec.id).implementationHash,
    }],
    bindings: [{ bindingId: 'binding:single', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: { id: spec.id, version: spec.version }, config: {} }],
  })
}

function context(over: Partial<InteractionViewContext> = {}): InteractionViewContext {
  const targets = over.targets ?? [
    { ref: { kind: 'character' as const, id: actor }, state: states.character(actor) },
    { ref: { kind: 'character' as const, id: 'character:alice' }, state: states.character('character:alice') },
    { ref: { kind: 'character' as const, id: 'character:bob' }, state: states.character('character:bob') },
    { ref: { kind: 'entity' as const, id: 'entity:cup' }, state: states.entity('entity:cup') },
    { ref: { kind: 'entity' as const, id: 'entity:door' }, state: states.entity('entity:door') },
    { ref: { kind: 'entity' as const, id: 'entity:lamp' }, state: states.entity('entity:lamp') },
  ]
  const authorizedTargets = over.authorizedTargets ?? [
    { kind: 'character', id: 'character:alice' }, { kind: 'character', id: 'character:bob' },
    { kind: 'entity', id: 'entity:cup' }, { kind: 'entity', id: 'entity:door' },
  ]
  return {
    address, manifestHash, asOfWorldSeq: 4, characterId: actor, candidatePrefixHash: prefixHash,
    authority: { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'standard' },
    viewPolicyHash, targets, authorizedTargets, ...over,
  }
}

describe('character interaction view', () => {
  it('lists visible characters, visible items and options as three separate sets', () => {
    const view = instantiate().view(context())
    expect(view.characters.map(ref => ref.id)).toEqual(['character:alice', 'character:bob', actor])
    // entity:lamp is visible but declares no binding, so it is listed with no option behind it.
    expect(view.items.map(ref => ref.id)).toEqual(['entity:cup', 'entity:door', 'entity:lamp'])
    expect(view.version).toBe('interaction-view/v1')
    expect(view.characterId).toBe(actor)
    expect(view.asOfWorldSeq).toBe(4)
    expect(view.viewPolicyHash).toBe(viewPolicyHash)
    expect(view.selectedAffordanceHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('enumerates a recipient role from authorized targets and never from a free string', () => {
    const view = instantiate().view(context())
    const give = view.options.filter(option => option.definitionRef.id === 'fixture:give')
    expect(give).toHaveLength(2)
    expect(give.map(option => option.arguments.recipientId)).toEqual(['character:alice', 'character:bob'])
    expect(give.every(option => option.bindingId === 'binding:cup-give')).toBe(true)
    // Every presented argument really is an authorized target of the role's kind.
    for (const option of give) {
      expect(['character:alice', 'character:bob']).toContain(option.arguments.recipientId)
    }
  })

  it('orders options deterministically and hashes the selected set', () => {
    const first = instantiate().view(context())
    const second = instantiate().view(context())
    expect(second.options).toEqual(first.options)
    expect(second.selectedAffordanceHash).toBe(first.selectedAffordanceHash)
    const keys = first.options.map(option => `${option.definitionRef.id}|${option.targetRef.id}|${option.bindingId}|${JSON.stringify(option.arguments)}`)
    expect(keys).toEqual([...keys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
    // A different prefix is a different view, so the affordance hash must move.
    const moved = instantiate().view(context({ asOfWorldSeq: 5, candidatePrefixHash: hashWorldJson('fixture/prefix/v1', { at: 5 }) }))
    expect(moved.selectedAffordanceHash).not.toBe(first.selectedAffordanceHash)
    // So must a different cropping policy.
    expect(instantiate().view(context({ viewPolicyHash: hashWorldJson('fixture/view-policy/v1', { v: 2 }) })).selectedAffordanceHash)
      .not.toBe(first.selectedAffordanceHash)
  })

  it('hides an option the plan rejects without exposing the rejection reason', () => {
    const view = instantiate().view(context())
    // binding:cup-guarded carries blocked=true, so fixture:hidden rejects it.
    expect(view.options.some(option => option.definitionRef.id === 'fixture:guarded')).toBe(false)
    expect(JSON.stringify(view)).not.toContain('BLOCKED')
  })

  it('never calls an effect builder while enumerating', () => {
    effectCalls.build = 0
    effectCalls.validate = 0
    const view = instantiate().view(context())
    expect(view.options.length).toBeGreaterThan(0)
    expect(effectCalls).toEqual({ build: 0, validate: 0 })
  })

  it('withholds a target that is visible but not authorized', () => {
    const view = instantiate().view(context({
      authorizedTargets: [{ kind: 'character', id: 'character:alice' }],
    }))
    expect(view.items.map(ref => ref.id)).toEqual(['entity:cup', 'entity:door', 'entity:lamp'])
    expect(view.options).toEqual([])
  })

  it('trims whole options to the per-character budget and reports the candidate count', () => {
    const extra = Array.from({ length: 140 }, (_, index) => `entity:bulk-${index}`)
    const view = instantiate(extra).view(context({
      targets: [
        { ref: { kind: 'character' as const, id: actor }, state: states.character(actor) },
        { ref: { kind: 'character' as const, id: 'character:alice' }, state: states.character('character:alice') },
        { ref: { kind: 'entity' as const, id: 'entity:cup' }, state: states.entity('entity:cup') },
        ...extra.map(id => ({ ref: { kind: 'entity' as const, id }, state: states.entity(id) })),
      ],
      authorizedTargets: [
        { kind: 'character', id: 'character:alice' },
        { kind: 'entity', id: 'entity:cup' },
        ...extra.map(id => ({ kind: 'entity' as const, id })),
      ],
    }))
    // cup-use + one give recipient + 140 bulk options, clipped to the frozen budget.
    expect(view.candidateCount).toBe(142)
    expect(view.options).toHaveLength(128)
    expect(view.items).toHaveLength(141)
  })

  it('fails closed on a definition whose arguments cannot be enumerated', () => {
    const spec: InteractionDefinitionSpec = {
      ...definition('fixture:freeform', true, false).spec,
      participantRoles: [actorRole, itemRole],
    }
    const contents = { rules: [publicRule], effects: [transfer], definitions: [{ spec, implementationHash: implementation('fixture:freeform').implementationHash }] }
    const lock: InteractionImplementationLock = { ref: ref('package:freeform'), dependencies: [], implementationHash: interactionPackageHash(contents) }
    const registry = new InteractionRegistry()
    registry.install({ lock, ...contents })
    const frozen = registry.freeze({
      address, packages: [lock],
      definitions: [{ ref: ref('fixture:freeform'), definitionHash: hashWorldJson('interaction-definition/v1', spec), implementationHash: implementation('fixture:freeform').implementationHash }],
      bindings: [{ bindingId: 'binding:freeform', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref('fixture:freeform'), config: {} }],
    })
    expect(() => frozen.view(context())).toThrow(/no enumerable domain/u)
  })

  it('fails closed when one binding exceeds the argument combination budget', () => {
    const targets = [{ ref: { kind: 'character' as const, id: actor }, state: states.character(actor) },
      { ref: { kind: 'entity' as const, id: 'entity:cup' }, state: states.entity('entity:cup') },
      ...Array.from({ length: 65 }, (_, index) => ({
        ref: { kind: 'character' as const, id: `character:c${index}` }, state: states.character(`character:c${index}`),
      }))]
    expect(() => instantiate().view(context({
      targets,
      authorizedTargets: [
        { kind: 'entity', id: 'entity:cup' },
        ...Array.from({ length: 65 }, (_, index) => ({ kind: 'character' as const, id: `character:c${index}` })),
      ],
    }))).toThrow(/exceeds the binding budget/u)
  })

  it('enumerates declared boolean, integer and enum domains jointly', () => {
    const spec: InteractionDefinitionSpec = {
      versionTag: 'interaction-definition/v1', id: 'fixture:configured', version: 1,
      participantRoles: [actorRole, itemRole],
      argumentSchema: { fields: [
        { name: 'tone', type: 'string', maxBytes: 16, values: ['soft', 'firm'] },
        { name: 'strict', type: 'boolean' },
        { name: 'attempts', type: 'integer', minimum: 1, maximum: 3 },
      ] },
      bindingConfigSchema: { fields: [] },
      authorityPolicyRef: ref('fixture:public'), preconditions: [ref('fixture:public')],
      spatialRequirementRefs: [], effectBuilderRef: ref('fixture:effect'), effectCapabilityRefs: [ref('fixture:effect')],
      dependencyRefs: [], limits: { maximumEvents: 1 },
    }
    const view = single(spec).view(context())
    expect(view.candidateCount).toBe(12)
    expect(new Set(view.options.map(option => option.arguments.tone))).toEqual(new Set(['soft', 'firm']))
    expect(new Set(view.options.map(option => option.arguments.strict))).toEqual(new Set([false, true]))
    expect(new Set(view.options.map(option => option.arguments.attempts))).toEqual(new Set([1, 2, 3]))
    // The free combination is still produced jointly, so ordering is total and stable.
    expect(instantiate().view(context()).options.length).toBeGreaterThan(0)
    const again = single(spec).view(context())
    expect(again.options).toEqual(view.options)
    expect(again.selectedAffordanceHash).toBe(view.selectedAffordanceHash)
  })

  it('fails closed when an integer domain exceeds the binding budget', () => {
    const spec: InteractionDefinitionSpec = {
      versionTag: 'interaction-definition/v1', id: 'fixture:wide', version: 1,
      participantRoles: [actorRole, itemRole],
      argumentSchema: { fields: [{ name: 'attempts', type: 'integer', minimum: 1, maximum: 100 }] },
      bindingConfigSchema: { fields: [] },
      authorityPolicyRef: ref('fixture:public'), preconditions: [ref('fixture:public')],
      spatialRequirementRefs: [], effectBuilderRef: ref('fixture:effect'), effectCapabilityRefs: [ref('fixture:effect')],
      dependencyRefs: [], limits: { maximumEvents: 1 },
    }
    expect(() => single(spec).view(context())).toThrow(/exceeds the binding budget/u)
  })

  it('rejects a view context that does not belong to this world or snapshot', () => {
    const world = instantiate()
    expect(() => world.view(context({ address: { ...address, worldId: brandId('world:other', 'WorldId') } })))
      .toThrow(/WorldAddress mismatch/u)
    expect(() => world.view(context({
      targets: [
        { ref: { kind: 'entity', id: 'entity:cup' }, state: states.entity('entity:cup') },
        { ref: { kind: 'entity', id: 'entity:cup' }, state: states.entity('entity:cup') },
      ],
    }))).toThrow(/duplicate snapshot target/u)
    expect(() => world.view(context({ authorizedTargets: [{ kind: 'entity', id: 'entity:ghost' }] })))
      .toThrow(/invalid target authorization set/u)
  })
})
