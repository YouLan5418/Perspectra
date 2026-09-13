import { describe, expect, it } from 'vitest'
import { Ajv } from 'ajv'
import {
  brandId, createInteractionArgumentSchema, createInteractionRequestSchema, hashWorldJson,
  type CharacterId, type InteractionBindingV3, type InteractionDefinitionImplementation,
  type InteractionDefinitionSpec, type InteractionEffectImplementation, type InteractionImplementationLock,
  type InteractionHostContext, type InteractionPackageImplementation, type InteractionParameterSchema,
  type InteractionPerformanceImplementation, type InteractionRef,
  type InteractionRole, type InteractionRuleImplementation, type InteractionViewContext,
  type WorldAddress, type WorldEventDraft, type WorldJsonObject,
} from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { InteractionRegistry, interactionPackageHash, type FrozenInteractionWorld } from './registry.ts'
import { parameters } from './validation.ts'

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

/** The shared fixtures declare no manifestation; the performance tests build their own policy. */
const noPerformance: InteractionPerformanceImplementation = {
  lock: implementation('fixture:no-performance'),
  policy: { version: 'interaction-performance/v1', accepted: [] },
}

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
    dependencyRefs: [], performancePolicyRef: ref('fixture:no-performance'), lifecycleRefs: [], limits: { maximumEvents: 1 },
  }
  return { spec, implementationHash: implementation(id).implementationHash }
}

function bundle() {
  const definitions = [definition('fixture:use', false, false), definition('fixture:give', true, false), definition('fixture:guarded', false, true)]
  const contents = { rules: [publicRule, hiddenRule], effects: [transfer], resolvers: [], lifecycle: [], performances: [noPerformance], definitions }
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
  const contents = { rules: [publicRule], effects: [transfer], resolvers: [], lifecycle: [], performances: [noPerformance], definitions: [{ spec, implementationHash: implementation(spec.id).implementationHash }] }
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

/** The adjudication-side counterpart of `context()`: same snapshot, one exact action. */
function host(): InteractionHostContext {
  return {
    address, manifestHash, asOfWorldSeq: 4, candidatePrefixHash: prefixHash,
    actionId: 'action:perform', actorId: actor,
    authority: { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'standard' },
    targets: [
      { ref: { kind: 'character', id: actor }, state: states.character(actor) },
      { ref: { kind: 'entity', id: 'entity:cup' }, state: states.entity('entity:cup') },
    ],
    authorizedTargets: [{ kind: 'entity', id: 'entity:cup' }],
  }
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

describe('model schema and host validation share one source', () => {
  const configured: InteractionDefinitionSpec = {
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
    dependencyRefs: [], performancePolicyRef: ref('fixture:no-performance'), lifecycleRefs: [], limits: { maximumEvents: 1 },
  }

  it('accepts every offered option and rejects a mismatched triple', () => {
    const view = instantiate().view(context())
    const validate = new Ajv({ strict: false }).compile(createInteractionRequestSchema(view))
    for (const option of view.options) {
      expect(validate(option), JSON.stringify(option)).toBe(true)
    }
    const first = view.options[0]!
    const other = view.options.find(option => option.bindingId !== first.bindingId)!
    // A right target with someone else's binding and definition is a cartesian mix, not an option.
    expect(validate({ ...first, bindingId: other.bindingId, definitionRef: other.definitionRef })).toBe(false)
    expect(validate({ ...first, targetRef: { kind: 'entity', id: 'entity:door' } })).toBe(false)
    expect(validate({ ...first, arguments: { ...first.arguments, extra: true } })).toBe(false)
    expect(validate({ targetRef: first.targetRef, bindingId: first.bindingId })).toBe(false)
  })

  it('rejects an argument value outside the domain the view offered', () => {
    const view = instantiate().view(context())
    const give = view.options.find(option => option.definitionRef.id === 'fixture:give')!
    const validate = new Ajv({ strict: false }).compile(createInteractionRequestSchema(view))
    expect(validate(give)).toBe(true)
    expect(validate({ ...give, arguments: { recipientId: 'character:mallory' } })).toBe(false)
    expect(validate({ ...give, arguments: {} })).toBe(false)
  })

  it('accepts nothing when the character has nothing to attempt', () => {
    const view = instantiate().view(context({ authorizedTargets: [] }))
    expect(view.options).toEqual([])
    const validate = new Ajv({ strict: false }).compile(createInteractionRequestSchema(view))
    expect(validate({ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:cup-use', definitionRef: ref('fixture:use'), arguments: {} })).toBe(false)
  })

  it('keeps every host-accepted argument set schema-valid across the field sweep', () => {
    const validate = new Ajv({ strict: false }).compile(createInteractionArgumentSchema(configured.argumentSchema))
    const candidates: readonly unknown[] = [
      { tone: 'soft', strict: true, attempts: 1 },
      { tone: 'firm', strict: false, attempts: 3 },
      { tone: 'loud', strict: true, attempts: 1 },
      { tone: 'soft', strict: 'yes', attempts: 1 },
      { tone: 'soft', strict: true, attempts: 0 },
      { tone: 'soft', strict: true, attempts: 4 },
      { tone: 'soft', strict: true, attempts: 1.5 },
      { tone: 'soft', strict: true },
      { tone: 'soft', strict: true, attempts: 1, extra: 1 },
      {},
    ]
    let accepted = 0
    for (const candidate of candidates) {
      let hostAccepts = true
      try { parameters(configured.argumentSchema, candidate) } catch { hostAccepts = false }
      if (hostAccepts) accepted++
      expect(hostAccepts && !validate(candidate), JSON.stringify(candidate)).toBe(false)
    }
    // The sweep is only evidence if it actually exercises both sides.
    expect(accepted).toBe(2)
    expect(validate({ tone: 'soft', strict: true, attempts: 1 })).toBe(true)
  })

  it('treats a free string as a byte bound, which is the safe direction', () => {
    const free: InteractionParameterSchema = { fields: [{ name: 'label', type: 'string', maxBytes: 4, values: [] }] }
    const validate = new Ajv({ strict: false }).compile(createInteractionArgumentSchema(free))
    // Four Chinese characters are twelve UTF-8 bytes, so the host rejects what the schema allows.
    expect(validate({ label: '中文中文' })).toBe(true)
    expect(() => parameters(free, { label: '中文中文' })).toThrow(/parameter/u)
    // The direction that must always hold: nothing the host accepts is schema-invalid.
    expect(validate({ label: 'ab' })).toBe(true)
    expect(() => parameters(free, { label: 'abcd' })).not.toThrow()
  })
})

describe('interaction performance contract', () => {
  const performRequest = (performance?: unknown) => ({
    targetRef: { kind: 'entity', id: 'entity:cup' },
    bindingId: 'binding:perform',
    definitionRef: ref('fixture:perform'),
    arguments: {},
    ...(performance === undefined ? {} : { performance }),
  })

  function performing(
    accepted: readonly { readonly cue: string; readonly placement: string; readonly requiresRole: string | null }[],
  ): FrozenInteractionWorld {
    const spec: InteractionDefinitionSpec = {
      ...definition('fixture:perform', false, false).spec,
      performancePolicyRef: ref('fixture:performance'),
    }
    const policy: InteractionPerformanceImplementation = {
      lock: implementation('fixture:performance'),
      policy: { version: 'interaction-performance/v1', accepted: accepted as never },
    }
    const contents = {
      rules: [publicRule], effects: [transfer], resolvers: [], lifecycle: [], performances: [policy],
      definitions: [{ spec, implementationHash: implementation(spec.id).implementationHash }],
    }
    const lock: InteractionImplementationLock = { ref: ref('package:perform'), dependencies: [], implementationHash: interactionPackageHash(contents) }
    const registry = new InteractionRegistry()
    registry.install({ lock, ...contents })
    return registry.freeze({
      address, packages: [lock],
      definitions: [{ ref: ref(spec.id), definitionHash: hashWorldJson('interaction-definition/v1', spec), implementationHash: implementation(spec.id).implementationHash }],
      bindings: [{ bindingId: 'binding:perform', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref(spec.id), config: {} }],
    })
  }

  const universal = { cue: 'smile', placement: 'both', requiresRole: null } as const

  /** Same builder as `performing`, but for a definition whose arguments carry their own contract. */
  function argumentWorld(spec: InteractionDefinitionSpec, packageId: string): FrozenInteractionWorld {
    const contents = {
      rules: [publicRule], effects: [transfer], resolvers: [], lifecycle: [], performances: [noPerformance],
      definitions: [{ spec, implementationHash: implementation(spec.id).implementationHash }],
    }
    const lock: InteractionImplementationLock = { ref: ref(packageId), dependencies: [], implementationHash: interactionPackageHash(contents) }
    const registry = new InteractionRegistry()
    registry.install({ lock, ...contents })
    return registry.freeze({
      address, packages: [lock],
      definitions: [{ ref: ref(spec.id), definitionHash: hashWorldJson('interaction-definition/v1', spec), implementationHash: implementation(spec.id).implementationHash }],
      bindings: [{ bindingId: `binding:${spec.id}`, targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref(spec.id), config: {} }],
    })
  }

  it('accepts a declared cue and echoes it without adding an event', () => {
    const world = performing([universal])
    const plain = world.resolve(host(), performRequest())
    const withCue = world.resolve(host(), performRequest({ independent: ['smile'], onSuccess: [] }))
    expect(withCue.events).toEqual(plain.events)
    expect(plain.performance).toBeNull()
    expect(withCue.performance).toEqual({ independent: ['smile'], onSuccess: [] })
    expect(withCue.ruleTraceHash).not.toBe(plain.ruleTraceHash)
  })

  it('fails the whole proposal instead of dropping a cue the definition never sanctioned', () => {
    const strict = performing([{ ...universal, placement: 'independent' }])
    expect(() => strict.resolve(host(), performRequest({ independent: ['smile'], onSuccess: [] }))).not.toThrow()
    expect(() => strict.resolve(host(), performRequest({ independent: [], onSuccess: ['smile'] }))).toThrow(/placement/u)
    expect(() => strict.resolve(host(), performRequest({ independent: ['frown'], onSuccess: [] }))).toThrow(/outside the definition performance policy/u)
    const noPolicy = performing([])
    expect(() => noPolicy.resolve(host(), performRequest({ independent: ['smile'], onSuccess: [] }))).toThrow(/outside the definition performance policy/u)
    expect(noPolicy.resolve(host(), performRequest()).performance).toBeNull()
  })

  it('reads a cue repeated across both lists as one restatement, as the frozen step rule does', () => {
    const world = performing([universal])
    const collapsed = world.resolve(host(), performRequest({ independent: ['smile'], onSuccess: ['smile'] }))
    const once = world.resolve(host(), performRequest({ independent: ['smile'], onSuccess: [] }))
    expect(collapsed.performance).toEqual(once.performance)
    expect(() => world.resolve(host(), performRequest({ independent: ['smile', 'smile'], onSuccess: [] }))).toThrow(/duplicate performance cue/u)
    expect(world.resolve(host(), performRequest({ independent: [], onSuccess: [] })).performance).toEqual({ independent: [], onSuccess: [] })
  })

  it('refuses to bind a voice or gait cue to an interaction step', () => {
    for (const cue of ['quiet_voice', 'slow_walk', 'trembling_voice']) {
      expect(() => performing([{ ...universal, cue }])).toThrow(/voice or gait/u)
    }
    expect(() => performing([{ ...universal, cue: 'not_a_cue' }])).toThrow(/unknown performance cue/u)
    expect(() => performing([{ ...universal, cue: 'wink' }])).toThrow(/unknown performance cue/u)
    expect(() => performing([universal, universal])).toThrow(/duplicate performance cue/u)
    expect(() => performing([{ ...universal, placement: 'sometimes' }])).toThrow(/invalid performance placement/u)
  })

  it('refuses a cue that would describe a role the definition never declares', () => {
    expect(() => performing([{ cue: 'smile', placement: 'both', requiresRole: 'bystander' }])).toThrow(/undeclared role/u)
    expect(() => performing([{ cue: 'smile', placement: 'both', requiresRole: 'item' }])).not.toThrow()
  })

  it('binds the policy into the package lock and refuses an unknown policy version', () => {
    const base = createBasicInteractionPackage()
    const declared = [{ cue: 'smile' as const, placement: 'both' as const, requiresRole: null }]
    const altered = { ...base, performances: [
      { ...base.performances[0]!, policy: { version: 'interaction-performance/v1' as const, accepted: declared } },
      { ...base.performances[0]!, lock: implementation('fixture:second-policy') },
    ] }
    expect(interactionPackageHash(altered)).not.toBe(base.lock.implementationHash)
    // The component list is hashed by identity order, so a reordering must not move the lock.
    expect(interactionPackageHash(altered)).toBe(interactionPackageHash({ ...altered, performances: [...altered.performances].reverse() }))
    // A policy from a future version is refused outright rather than partly understood.
    expect(() => new InteractionRegistry().install({
      ...base, performances: [{ ...base.performances[0]!, policy: { version: 'interaction-performance/v2', accepted: [] } as never }],
    })).toThrow(/unsupported performance policy/u)
  })

  it('declares the accepted manifestation instead of forbidding the field', () => {
    const view = performing([universal]).view(context())
    const validate = new Ajv({ strict: false }).compile(createInteractionRequestSchema(view))
    const option = view.options.find(entry => entry.definitionRef.id === 'fixture:perform')!
    expect(validate({ ...option, performance: { independent: ['smile'], onSuccess: [] } })).toBe(true)
    expect(validate({ ...option, performance: { independent: ['frown'], onSuccess: [] } })).toBe(false)
    expect(validate({ ...option, performance: { independent: [], onSuccess: ['smile'] } })).toBe(true)
    expect(validate(option)).toBe(true)
    expect(validate({ ...option, performance: { independent: ['smile', 'smile'], onSuccess: [] } })).toBe(false)
    // A placement-restricted cue appears only in the list it was declared for.
    const restricted = performing([{ cue: 'smile', placement: 'independent', requiresRole: null }]).view(context())
    const narrow = new Ajv({ strict: false }).compile(createInteractionRequestSchema(restricted))
    const narrowOption = restricted.options[0]!
    expect(narrow({ ...narrowOption, performance: { independent: ['smile'], onSuccess: [] } })).toBe(true)
    expect(narrow({ ...narrowOption, performance: { independent: [], onSuccess: ['smile'] } })).toBe(false)
    expect(narrow({ ...narrowOption, performance: { independent: [], onSuccess: [] } })).toBe(true)
    // A definition that accepts no cue still accepts the empty pair, exactly as the Host does.
    const plain = instantiate().view(context()).options[0]!
    const none = new Ajv({ strict: false }).compile(createInteractionRequestSchema(instantiate().view(context())))
    expect(none({ ...plain, performance: { independent: [], onSuccess: [] } })).toBe(true)
    expect(none({ ...plain, performance: { independent: ['smile'], onSuccess: [] } })).toBe(false)
  })

  it('offers only recipients the definition argument contract itself allows', () => {
    const constrained: InteractionDefinitionSpec = {
      ...definition('fixture:give', true, false).spec,
      argumentSchema: { fields: [{ name: 'recipientId', type: 'string', maxBytes: 1024, values: ['character:bob'] }] },
    }
    const view = argumentWorld(constrained, 'package:constrained').view(context())
    const offers = view.options.filter(entry => entry.definitionRef.id === 'fixture:give')
    // alice is authorized and co-located, but the field only ever names bob.
    expect(offers.map(entry => entry.arguments.recipientId)).toEqual(['character:bob'])
    const validate = new Ajv({ strict: false }).compile(createInteractionRequestSchema(view))
    expect(validate({ ...offers[0]!, arguments: { recipientId: 'character:alice' } })).toBe(false)
    expect(offers.every(entry => validate(entry))).toBe(true)
  })

  it('keeps independent expression when the action fails and cancels only onSuccess', () => {
    const world = performing([universal, { cue: 'nod', placement: 'both', requiresRole: null }])
    const submitted = { independent: ['smile'], onSuccess: ['nod'] }
    const accepted = world.resolve(host(), performRequest(submitted))
    expect(accepted.status).toBe('accepted')
    expect(accepted.performance).toEqual(submitted)
    // The same attempt against a prefix where the item is unavailable fails the action, but the
    // character still visibly smiled while trying; only the success-bound cue is cancelled.
    const rejected = world.resolve({ ...host(), authorizedTargets: [] },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:perform', definitionRef: ref('fixture:perform'), arguments: {}, performance: submitted })
    expect(rejected.status).toBe('rejected')
    expect(rejected.performance).toEqual({ independent: ['smile'], onSuccess: [] })
    expect(rejected.events).toEqual([])
    const withheld = world.resolve({ ...host(), authorizedTargets: [] },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:perform', definitionRef: ref('fixture:perform'), arguments: {}, performance: { independent: [], onSuccess: ['nod'] } })
    expect(withheld.performance).toBeNull()
  })

  it('refuses a repeat inside one list before collapsing the cross-list restatement', () => {
    const world = performing([universal])
    expect(() => world.resolve(host(), performRequest({ independent: ['smile'], onSuccess: ['smile', 'smile'] }))).toThrow(/duplicate performance cue/u)
    expect(() => world.resolve(host(), performRequest({ independent: ['smile', 'smile'], onSuccess: [] }))).toThrow(/duplicate performance cue/u)
    expect(world.resolve(host(), performRequest({ independent: ['smile'], onSuccess: ['smile'] })).performance)
      .toEqual({ independent: ['smile'], onSuccess: [] })
  })

  it('refuses to enable a definition whose performance policy is not selected', () => {
    const base = createBasicInteractionPackage()
    const orphan: InteractionDefinitionSpec = {
      ...base.definitions[0]!.spec, id: 'fixture:orphan', performancePolicyRef: ref('missing:policy'),
    }
    const contents = { rules: base.rules, effects: base.effects, resolvers: base.resolvers, lifecycle: base.lifecycle, performances: base.performances, definitions: [{ spec: orphan, implementationHash: base.definitions[0]!.implementationHash }] }
    const lock: InteractionImplementationLock = { ref: ref('package:orphan'), dependencies: [], implementationHash: interactionPackageHash(contents) }
    const registry = new InteractionRegistry()
    registry.install({ lock, ...contents })
    expect(() => registry.freeze({
      address, packages: [lock],
      definitions: [{ ref: ref(orphan.id), definitionHash: hashWorldJson('interaction-definition/v1', orphan), implementationHash: base.definitions[0]!.implementationHash }],
      bindings: [{ bindingId: 'binding:orphan', targetRef: { kind: 'entity', id: 'entity:cup' }, definitionRef: ref(orphan.id), config: {} }],
    })).toThrow(/performance policy missing/u)
  })
})

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
    const contents = { rules: [publicRule], effects: [transfer], resolvers: [], lifecycle: [], performances: [noPerformance], definitions: [{ spec, implementationHash: implementation('fixture:freeform').implementationHash }] }
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
      dependencyRefs: [], performancePolicyRef: ref('fixture:no-performance'), lifecycleRefs: [], limits: { maximumEvents: 1 },
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
      dependencyRefs: [], performancePolicyRef: ref('fixture:no-performance'), lifecycleRefs: [], limits: { maximumEvents: 1 },
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
