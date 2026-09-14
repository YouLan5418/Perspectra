import { describe, expect, it } from 'vitest'
import {
  brandId, hashWorldJson,
  type CharacterId, type InteractionDefinitionImplementation, type InteractionDefinitionSpec,
  type InteractionEffectImplementation, type InteractionHostContext, type InteractionImplementationLock,
  type InteractionLifecycleHandlerImplementation, type InteractionObservationPolicyImplementation,
  type InteractionParameterSchema, type InteractionPerformanceImplementation, type InteractionReactionEvidenceImplementation,
  type InteractionRef, type InteractionRole, type InteractionRuleImplementation, type WorldAddress,
} from '@harness-world/contracts'
import { InteractionRegistry, interactionPackageHash } from '@harness-world/interaction-runtime'
import { parseWorldPackInteractionsSource } from '@harness-world/world-pack'

/**
 * The frozen `interaction-limits/v1` numbers, each one met and then exceeded. A limit is evidence only in
 * pairs: content at the bound has to work, and the next unit has to fail deterministically - a list
 * trimmed in silence would pass a one-sided case while losing what an author declared.
 *
 * The world-pack cases are the author's boundary (the compiler refuses), and the runtime cases are the
 * Host's (install or freeze refuses). Nothing here goes through a world or a database: a limit is a
 * property of the frozen contract, so it is cheapest and sharpest to test where it is enforced.
 */
const address: WorldAddress = {
  tenantId: brandId('tenant:capacity', 'TenantId'),
  worldId: brandId('world:capacity', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const actor: CharacterId = brandId('character:player', 'CharacterId')
const prefixHash = hashWorldJson('capacity/prefix/v1', {})

const ref = (id: string): InteractionRef => ({ id, version: 1 })
const impl = (id: string): InteractionImplementationLock =>
  ({ ref: ref(id), dependencies: [], implementationHash: hashWorldJson('capacity-release/v1', { id }) })

const actorRole: InteractionRole = { name: 'actor', kind: 'character', source: { kind: 'hostActor' }, distinctFrom: [] }
const itemRole: InteractionRole = { name: 'item', kind: 'entity', source: { kind: 'primaryTarget' }, distinctFrom: [] }

const accept: InteractionRuleImplementation = { lock: impl('capacity:accept'), check: () => null }
const transfer: InteractionEffectImplementation = {
  lock: impl('capacity:effect'), eventTypes: [ref('entity.transferred')],
  build: () => [{ eventType: 'entity.transferred', eventVersion: 1, data: {} }],
  validate: () => {},
}
const noPerformance: InteractionPerformanceImplementation =
  { lock: impl('capacity:no-performance'), policy: { version: 'interaction-performance/v1', accepted: [] } }
const noDirect: InteractionReactionEvidenceImplementation =
  { lock: impl('capacity:no-direct'), policy: { version: 'interaction-reaction-evidence/v1', directRoles: [] } }
const publicOutcome: InteractionObservationPolicyImplementation = {
  lock: impl('capacity:public-outcome'),
  policy: { version: 'interaction-observation-policy/v1', onAccepted: 'scene_public', onRejected: 'self' },
}

const fields = (count: number, field: (index: number) => InteractionParameterSchema['fields'][number]) =>
  ({ fields: Array.from({ length: count }, (_, index) => field(index)) })
const namedRefs = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ref(`${prefix}-${index}`))
const rulesFor = (prefix: string, count: number): InteractionRuleImplementation[] =>
  Array.from({ length: count }, (_, index) => ({ lock: impl(`${prefix}-${index}`), check: () => null }))
const handlersFor = (count: number): InteractionLifecycleHandlerImplementation[] =>
  Array.from({ length: count }, (_, index) => ({ lock: impl(`capacity:handler-${index}`), phase: 'observation' as const,
    consumes: [], eventTypes: [ref(`capacity.handler-${index}`)], build: () => [] }))

function definition(id: string, over: Partial<InteractionDefinitionSpec> = {},
  effect: InteractionEffectImplementation = transfer): InteractionDefinitionImplementation {
  const spec: InteractionDefinitionSpec = {
    versionTag: 'interaction-definition/v1', id, version: 1,
    participantRoles: [actorRole, itemRole], argumentSchema: { fields: [] }, bindingConfigSchema: { fields: [] },
    authorityPolicyRef: ref('capacity:accept'), preconditions: [ref('capacity:accept')], spatialRequirementRefs: [],
    effectBuilderRef: ref('capacity:effect'), effectCapabilityRefs: [ref('capacity:effect')], dependencyRefs: [],
    performancePolicyRef: ref('capacity:no-performance'), reactionEvidencePolicyRef: ref('capacity:no-direct'),
    observationPolicyRef: ref('capacity:public-outcome'), lifecycleRefs: [], limits: { maximumEvents: 1 },
    ...over,
  }
  return { spec, implementationHash: impl(id).implementationHash }
}

/** Install a package holding exactly these definitions and their components, or refuse at install. */
function installed(definitions: readonly InteractionDefinitionImplementation[], over: {
  readonly rules?: readonly InteractionRuleImplementation[]
  readonly lifecycle?: readonly InteractionLifecycleHandlerImplementation[]
  readonly effects?: readonly InteractionEffectImplementation[]
} = {}): { readonly registry: InteractionRegistry; readonly lock: InteractionImplementationLock } {
  const contents = {
    rules: [...(over.rules ?? []), accept], effects: over.effects ?? [transfer], resolvers: [],
    lifecycle: over.lifecycle ?? [], performances: [noPerformance], reactionEvidence: [noDirect],
    observation: [publicOutcome], definitions,
  }
  const lock: InteractionImplementationLock =
    { ref: ref('package:capacity'), dependencies: [], implementationHash: interactionPackageHash(contents) }
  const registry = new InteractionRegistry()
  registry.install({ lock, ...contents })
  return { registry, lock }
}

function install(definitions: readonly InteractionDefinitionImplementation[], over: Parameters<typeof installed>[1] = {}) {
  return installed(definitions, over).registry
}

/** The Host's read-only input for one character's view, which is where the option budget is spent. */
function viewContext() {
  const action = host('action:capacity-view')
  return { address: action.address, manifestHash: action.manifestHash, asOfWorldSeq: action.asOfWorldSeq,
    characterId: actor, authority: action.authority, candidatePrefixHash: action.candidatePrefixHash,
    targets: action.targets, authorizedTargets: action.authorizedTargets,
    viewPolicyHash: hashWorldJson('capacity/view-policy/v1', {}) }
}

function host(actionId: string): InteractionHostContext {
  return {
    address, manifestHash: hashWorldJson('capacity/manifest/v1', {}), asOfWorldSeq: 4, candidatePrefixHash: prefixHash,
    actionId, actorId: actor,
    authority: { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'standard' },
    targets: [
      { ref: { kind: 'character', id: actor }, state: { lifecycleState: 'active', locationId: 'location:room', sceneIds: ['scene:room'] } },
      { ref: { kind: 'entity', id: 'entity:cup' }, state: { holderId: null, locationId: 'location:room' } },
    ],
    authorizedTargets: [{ kind: 'entity', id: 'entity:cup' }],
  }
}

/** Resolve one action against a definition whose declaration and effect builder disagree or not. */
function resolveWith(effect: InteractionEffectImplementation, maximumEvents: number): () => unknown {
  const target = definition('capacity:events', { limits: { maximumEvents } }, effect)
  const { registry, lock } = installed([target], { effects: [effect] })
  const world = registry.freeze({ address, packages: [lock], definitions: [
    { ref: ref(target.spec.id), definitionHash: hashWorldJson('interaction-definition/v1', target.spec), implementationHash: target.implementationHash },
  ], bindings: [{ bindingId: 'binding:capacity-events', targetRef: { kind: 'entity', id: 'entity:cup' },
    definitionRef: ref(target.spec.id), config: {} }] })
  return () => world.resolve(host('action:capacity-events'), { targetRef: { kind: 'entity', id: 'entity:cup' },
    bindingId: 'binding:capacity-events', definitionRef: ref(target.spec.id), arguments: {} })
}

describe('the frozen limits, met and exceeded', () => {
  it('takes 32 selected packages and refuses 33', () => {
    const source = (count: number) => ({ schemaVersion: 'worldpack-interactions/v1',
      packages: Array.from({ length: count }, (_, index) => ({ id: `package:p${index}`, version: 1 })),
      definitions: [{ id: 'base:take', version: 1 }], relationBindings: [] })
    expect(parseWorldPackInteractionsSource(source(32)).packages).toHaveLength(32)
    expect(() => parseWorldPackInteractionsSource(source(33))).toThrow(/at most 32 packages/u)
  })

  it('takes 128 selected definitions and refuses 129', () => {
    const source = (count: number) => ({ schemaVersion: 'worldpack-interactions/v1', packages: [{ id: 'package:p0', version: 1 }],
      definitions: Array.from({ length: count }, (_, index) => ({ id: `base:d${index}`, version: 1 })), relationBindings: [] })
    expect(parseWorldPackInteractionsSource(source(128)).definitions).toHaveLength(128)
    expect(() => parseWorldPackInteractionsSource(source(129))).toThrow(/at most 128 definitions/u)
  })

  it('takes 4096 relation bindings and refuses 4097', () => {
    const source = (count: number) => ({ schemaVersion: 'worldpack-interactions/v1', packages: [{ id: 'package:p0', version: 1 }],
      definitions: [{ id: 'base:take', version: 1 }],
      relationBindings: Array.from({ length: count }, (_, index) => ({ bindingId: `binding:r${index}`,
        relationClass: 'base:hold-hand', definition: { id: 'base:take', version: 1 }, config: {} })) })
    expect(parseWorldPackInteractionsSource(source(4096)).relationBindings).toHaveLength(4096)
    expect(() => parseWorldPackInteractionsSource(source(4097))).toThrow(/at most 4096 relation bindings/u)
  })

  it('takes a 4096-byte config and refuses one byte more', () => {
    // `{"note":""}` is the 11-byte envelope, so 4085 characters of text reach the bound exactly.
    const source = (bytes: number) => ({ schemaVersion: 'worldpack-interactions/v1', packages: [{ id: 'package:p0', version: 1 }],
      definitions: [{ id: 'base:take', version: 1 }],
      relationBindings: [{ bindingId: 'binding:r0', relationClass: 'base:hold-hand',
        definition: { id: 'base:take', version: 1 }, config: { note: 'x'.repeat(bytes) } }] })
    expect(parseWorldPackInteractionsSource(source(4085)).relationBindings).toHaveLength(1)
    expect(() => parseWorldPackInteractionsSource(source(4086))).toThrow(/at most 4096 bytes/u)
  })

  it('takes 8 participant roles and refuses 9', () => {
    // Exactly one actor and one primary target are required, so the extra slots come from arguments:
    // what is under test is how many slots a definition may declare, not where they are sourced.
    const roles = (count: number) => [actorRole, itemRole,
      ...Array.from({ length: count - 2 }, (_, index): InteractionRole =>
        ({ name: `extra${index}`, kind: 'character', source: { kind: 'argument', field: `f${index}` }, distinctFrom: [] }))]
    const schema = (count: number) => fields(Math.max(0, count - 2),
      index => ({ name: `f${index}`, type: 'string', maxBytes: 1024, values: [] }))
    expect(() => install([definition('capacity:roles-8', { participantRoles: roles(8), argumentSchema: schema(8) })])).not.toThrow()
    expect(() => install([definition('capacity:roles-9', { participantRoles: roles(9), argumentSchema: schema(9) })]))
      .toThrow(/array outside limits/u)
  })

  it('takes 8 argument fields and refuses 9', () => {
    const schema = (count: number) => fields(count, index => ({ name: `f${index}`, type: 'string', maxBytes: 1024, values: [] }))
    expect(() => install([definition('capacity:args-8', { argumentSchema: schema(8) })])).not.toThrow()
    expect(() => install([definition('capacity:args-9', { argumentSchema: schema(9) })])).toThrow(/array outside limits/u)
  })

  it('takes 8 config fields and refuses 9', () => {
    const schema = (count: number) => fields(count, index => ({ name: `c${index}`, type: 'string', maxBytes: 1024, values: [] }))
    expect(() => install([definition('capacity:config-8', { bindingConfigSchema: schema(8) })])).not.toThrow()
    expect(() => install([definition('capacity:config-9', { bindingConfigSchema: schema(9) })])).toThrow(/array outside limits/u)
  })

  it('takes 16 preconditions and refuses 17', () => {
    const sixteen = [...namedRefs('capacity:precondition', 15), ref('capacity:accept')]
    expect(() => install([definition('capacity:pre-16', { preconditions: sixteen })],
      { rules: rulesFor('capacity:precondition', 15) })).not.toThrow()
    expect(() => install([definition('capacity:pre-17', { preconditions: [...sixteen, ref('capacity:precondition-15')] })],
      { rules: rulesFor('capacity:precondition', 15) })).toThrow(/array outside limits/u)
  })

  it('takes 64 dependency references and refuses 65', () => {
    expect(() => install([definition('capacity:dep-64', { dependencyRefs: namedRefs('capacity:dependency', 64) })],
      { rules: rulesFor('capacity:dependency', 64) })).not.toThrow()
    expect(() => install([definition('capacity:dep-65', { dependencyRefs: namedRefs('capacity:dependency', 65) })],
      { rules: rulesFor('capacity:dependency', 65) })).toThrow(/array outside limits/u)
  })

  it('takes 16 lifecycle handlers on one definition and refuses 17', () => {
    const lifetimes = (count: number) => namedRefs('capacity:handler', count)
    expect(() => install([definition('capacity:handlers-16', { lifecycleRefs: lifetimes(16) })],
      { lifecycle: handlersFor(17) })).not.toThrow()
    expect(() => install([definition('capacity:handlers-17', { lifecycleRefs: lifetimes(17) })],
      { lifecycle: handlersFor(17) })).toThrow(/array outside limits/u)
  })

  it('takes 64 argument combinations on one binding and refuses 65', () => {
    // Each field stays inside its own domain; it is the product of the two that is under test, because
    // that is what a caller has to enumerate before offering an option.
    const domain = (left: number, right: number) => fields(2, index => ({ name: index === 0 ? 'left' : 'right',
      type: 'string', maxBytes: 1024,
      values: Array.from({ length: index === 0 ? left : right }, (_, value) => `entity:e${index}-${value}`) }))
    // The schema is fine either way - each field sits inside its own domain - so the budget is spent
    // where the combinations are enumerated: building the view.
    const worldWith = (left: number, right: number) => {
      const target = definition('capacity:domain', { argumentSchema: domain(left, right) })
      const { registry, lock } = installed([target])
      return registry.freeze({ address, packages: [lock], definitions: [
        { ref: ref(target.spec.id), definitionHash: hashWorldJson('interaction-definition/v1', target.spec), implementationHash: target.implementationHash },
      ], bindings: [{ bindingId: 'binding:capacity-domain', targetRef: { kind: 'entity', id: 'entity:cup' },
        definitionRef: ref(target.spec.id), config: {} }] })
    }
    expect(worldWith(8, 8).view(viewContext()).options.length).toBeLessThanOrEqual(64)
    expect(() => worldWith(9, 8).view(viewContext()))
      .toThrow(/argument domain exceeds the binding budget/u)
  })

  it('lets a fold add 64 events in total and refuses the step that would pass it', () => {
    // Each step stays inside the definition's own bound; it is the running total the profile caps, and a
    // fold that stopped at its own step budget would still hand back a candidate set nobody authorized.
    const step = (index: number, events: number): InteractionLifecycleHandlerImplementation =>
      ({ lock: impl(`capacity:fold-${index}`), phase: 'observation', consumes: [],
        eventTypes: [ref('entity.transferred')],
        build: () => Array.from({ length: events }, () => ({ eventType: 'entity.transferred', eventVersion: 1, data: {} })) })
    const resolveFold = (steps: number): unknown => {
      const effect: InteractionEffectImplementation = { ...transfer, build: () =>
        Array.from({ length: 16 }, () => ({ eventType: 'entity.transferred', eventVersion: 1, data: {} })) }
      const refs = namedRefs('capacity:fold', steps)
      const target = definition('capacity:fold', { limits: { maximumEvents: 16 }, lifecycleRefs: refs }, effect)
      const { registry, lock } = installed([target],
        { effects: [effect], lifecycle: Array.from({ length: steps }, (_, index) => step(index, 16)) })
      const world = registry.freeze({ address, packages: [lock], definitions: [
        { ref: ref(target.spec.id), definitionHash: hashWorldJson('interaction-definition/v1', target.spec), implementationHash: target.implementationHash },
      ], bindings: [{ bindingId: 'binding:capacity-fold', targetRef: { kind: 'entity', id: 'entity:cup' },
        definitionRef: ref(target.spec.id), config: {} }] })
      return world.resolve(host('action:capacity-fold'), { targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:capacity-fold', definitionRef: ref(target.spec.id), arguments: {} })
    }
    // Sixteen from the effect and sixteen from each of three steps is the total, exactly.
    expect((resolveFold(3) as { readonly events: readonly unknown[] }).events).toHaveLength(64)
    expect(() => resolveFold(4)).toThrow(/total event budget/u)
  })

  it('takes a world fold plan of 256 steps and refuses the step that would pass it', () => {
    // The world's own plan is the union of every enabled definition's handlers, so crossing 256 needs more
    // than one package: a package holds 64 handlers, and a definition may name 16 of them. Four packages of
    // 64 is the bound exactly, and a fifth handler is one step past it.
    const packageOf = (index: number) => {
      // Component identities are world-wide, so each package suffixes its own pieces: two packages that
      // both registered `capacity:accept` would be a duplicate registration, not a bigger plan.
      const own = (name: string) => `capacity:p${index}-${name}`
      const rule: InteractionRuleImplementation = { lock: impl(own('accept')), check: () => null }
      const effect: InteractionEffectImplementation = { ...transfer, lock: impl(own('effect')) }
      const ids = Array.from({ length: 64 }, (_, step) => own(`h${step}`))
      const lifecycle: InteractionLifecycleHandlerImplementation[] = ids.map(id =>
        ({ lock: impl(id), phase: 'observation', consumes: [], eventTypes: [ref(`capacity.${id}`)], build: () => [] }))
      const definitions = Array.from({ length: 4 }, (_, chunk) => definition(own(`d${chunk}`), {
        lifecycleRefs: ids.slice(chunk * 16, chunk * 16 + 16).map(ref),
        authorityPolicyRef: ref(own('accept')), effectBuilderRef: ref(own('effect')),
        effectCapabilityRefs: [ref(own('effect'))], preconditions: [ref(own('accept'))],
        performancePolicyRef: ref(own('no-performance')), reactionEvidencePolicyRef: ref(own('no-direct')),
        observationPolicyRef: ref(own('public-outcome')),
      }))
      const contents = { rules: [rule], effects: [effect], resolvers: [], lifecycle,
        performances: [{ lock: impl(own('no-performance')), policy: noPerformance.policy }],
        reactionEvidence: [{ lock: impl(own('no-direct')), policy: noDirect.policy }],
        observation: [{ lock: impl(own('public-outcome')), policy: publicOutcome.policy }], definitions }
      const lock: InteractionImplementationLock = { ref: ref(`package:capacity-plan-${index}`),
        dependencies: [], implementationHash: interactionPackageHash(contents) }
      return { lock, ...contents, definitions }
    }
    const worldOf = (packages: number) => {
      const built = Array.from({ length: packages }, (_, index) => packageOf(index))
      const registry = new InteractionRegistry()
      for (const pkg of built) registry.install(pkg)
      const definitions = built.flatMap(pkg => pkg.definitions)
      return registry.freeze({ address, packages: built.map(pkg => pkg.lock),
        definitions: definitions.map(def => ({ ref: { id: def.spec.id, version: def.spec.version },
          definitionHash: hashWorldJson('interaction-definition/v1', def.spec), implementationHash: def.implementationHash })),
        bindings: definitions.map(def => ({ bindingId: `binding:${def.spec.id}`,
          targetRef: { kind: 'entity' as const, id: 'entity:cup' }, definitionRef: { id: def.spec.id, version: def.spec.version }, config: {} })) })
    }
    expect(worldOf(4).fold(host('action:capacity-plan'), [])).toEqual([])
    expect(() => worldOf(5).fold(host('action:capacity-plan'), [])).toThrow(/lifecycle fold exceeds the budget/u)
  })

  it('builds 16 effect events and refuses 17 under the same declaration', () => {
    const sixteen: InteractionEffectImplementation = { ...transfer, build: () =>
      Array.from({ length: 16 }, () => ({ eventType: 'entity.transferred', eventVersion: 1, data: {} })) }
    const seventeen: InteractionEffectImplementation = { ...transfer, build: () =>
      Array.from({ length: 17 }, () => ({ eventType: 'entity.transferred', eventVersion: 1, data: {} })) }
    expect(resolveWith(sixteen, 16)()).toMatchObject({ status: 'accepted' })
    expect(resolveWith(seventeen, 16)).toThrow(/event closure|limit|budget|16/u)
  })
})
