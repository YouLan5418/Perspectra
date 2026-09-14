import { describe, expect, it } from 'vitest'
import {
  brandId, hashWorldJson,
  type CharacterId, type InteractionDefinitionSpec, type InteractionEffectImplementation,
  type InteractionImplementationLock, type InteractionLifecycleHandlerImplementation,
  type InteractionPackageImplementation, type InteractionRef, type InteractionRuleImplementation,
  type InteractionWorldSelection, type WorldAddress, type WorldEventDraft, type WorldJsonObject,
} from '@harness-world/contracts'
import { InteractionRegistry, interactionPackageHash, type FrozenInteractionWorld } from './registry.ts'

const address: WorldAddress = {
  tenantId: brandId('tenant:lifecycle', 'TenantId'),
  worldId: brandId('world:lifecycle', 'WorldId'),
  branchId: brandId('branch:main', 'BranchId'),
}
const actor: CharacterId = brandId('character:player', 'CharacterId')
const manifestHash = hashWorldJson('lifecycle/manifest/v1', {})
const prefixHash = hashWorldJson('lifecycle/prefix/v1', {})
const ref = (id: string): InteractionRef => ({ id, version: 1 })

const actorRole = { name: 'actor', kind: 'character' as const, source: { kind: 'hostActor' as const }, distinctFrom: [] }
const itemRole = { name: 'item', kind: 'entity' as const, source: { kind: 'primaryTarget' as const }, distinctFrom: [] }

const accept: InteractionRuleImplementation = { lock: lock('fixture:accept'), check: () => null }

function lock(id: string): InteractionImplementationLock {
  return { ref: ref(id), dependencies: [], implementationHash: hashWorldJson('fixture-release/v1', { id }) }
}

const base: InteractionEffectImplementation = {
  lock: lock('fixture:base-effect'), eventTypes: [ref('fixture.base')],
  build: (): readonly WorldEventDraft[] => [{ eventType: 'fixture.base', eventVersion: 1, data: { order: 0 } }],
  validate: () => {},
}

function handler(id: string, phase: InteractionLifecycleHandlerImplementation['phase'],
  dependencies: readonly string[], order: number, eventType = id): InteractionLifecycleHandlerImplementation {
  return { lock: { ref: ref(id), dependencies: dependencies.map(ref), implementationHash: hashWorldJson('fixture-release/v1', { id }) },
    phase, consumes: [], eventTypes: [ref(eventType)],
    build: (): readonly WorldEventDraft[] => [{ eventType, eventVersion: 1, data: { order } }] }
}

function spec(lifecycleRefs: readonly string[], id = 'fixture:fold'): InteractionDefinitionSpec {
  return {
    versionTag: 'interaction-definition/v1', id, version: 1,
    participantRoles: [actorRole, itemRole], argumentSchema: { fields: [] }, bindingConfigSchema: { fields: [] },
    authorityPolicyRef: ref('fixture:accept'), preconditions: [ref('fixture:accept')], spatialRequirementRefs: [],
    effectBuilderRef: ref('fixture:base-effect'), effectCapabilityRefs: [ref('fixture:base-effect')], dependencyRefs: [],
    performancePolicyRef: ref('fixture:no-performance'), lifecycleRefs: lifecycleRefs.map(ref), limits: { maximumEvents: 4 },
  }
}

function packageOf(lifecycle: readonly InteractionLifecycleHandlerImplementation[], id = 'package:lifecycle',
  referenced = lifecycle.map(entry => entry.lock.ref.id), definitionId = id === 'package:lifecycle' ? 'fixture:fold' : id,
  maximumEvents = 4): InteractionPackageImplementation {
  // Component identities are world-wide, so every package suffixes its shared pieces with its own id.
  const names = { rule: `fixture:accept:${id}`, effect: `fixture:base-effect:${id}`, policy: `fixture:no-performance:${id}` }
  const contents = {
    rules: [{ ...accept, lock: lock(names.rule) }],
    effects: [{ ...base, lock: lock(names.effect), eventTypes: [ref(`fixture.base:${id}`)],
      build: (): readonly WorldEventDraft[] => [{ eventType: `fixture.base:${id}`, eventVersion: 1, data: { order: 0 } }] }],
    resolvers: [], lifecycle,
    performances: [{ lock: lock(names.policy), policy: { version: 'interaction-performance/v1' as const, accepted: [] } }],
    definitions: [{ spec: { ...spec(referenced, definitionId), limits: { maximumEvents },
      authorityPolicyRef: ref(names.rule), preconditions: [ref(names.rule)],
      effectBuilderRef: ref(names.effect), effectCapabilityRefs: [ref(names.effect)],
      performancePolicyRef: ref(names.policy) }, implementationHash: hashWorldJson('fixture-impl/v1', { id }) }],
  }
  return { lock: { ref: ref(id), dependencies: [], implementationHash: interactionPackageHash(contents) }, ...contents }
}

function world(lifecycle: readonly InteractionLifecycleHandlerImplementation[], referenced = lifecycle.map(entry => entry.lock.ref.id),
  maximumEvents = 4): FrozenInteractionWorld {
  const pack = packageOf(lifecycle, 'package:lifecycle', referenced, 'fixture:fold', maximumEvents)
  const registry = new InteractionRegistry()
  registry.install(pack)
  const selection: InteractionWorldSelection = {
    address, packages: [pack.lock],
    definitions: pack.definitions.map(def => ({
      ref: { id: def.spec.id, version: def.spec.version },
      definitionHash: hashWorldJson('interaction-definition/v1', def.spec), implementationHash: def.implementationHash,
    })),
    bindings: [{ bindingId: 'binding:fold', targetRef: { kind: 'entity' as const, id: 'entity:cup' }, definitionRef: ref('fixture:fold'), config: {} }],
  }
  return registry.freeze(selection)
}

function request(): unknown {
  return { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:fold', definitionRef: ref('fixture:fold'), arguments: {} }
}

function host() {
  return {
    address, manifestHash, asOfWorldSeq: 2, candidatePrefixHash: prefixHash, actionId: 'action:fold', actorId: actor,
    authority: { version: 'resolution-authority/v1' as const, sourceRole: 'agent' as const, adjudicationMode: 'standard' as const },
    targets: [
      { ref: { kind: 'character' as const, id: actor }, state: { lifecycle: 'active', locationId: 'location:hall', sceneIds: ['scene:hall'] } },
      { ref: { kind: 'entity' as const, id: 'entity:cup' }, state: { holderId: null, locationId: 'location:hall' } },
    ],
    authorizedTargets: [{ kind: 'entity' as const, id: 'entity:cup' }],
  }
}

const order = (events: readonly WorldEventDraft[]): number[] =>
  events.map(event => (event.data as WorldJsonObject).order as number)

describe('lifecycle fold', () => {
  it('runs the frozen phase order and appends each step after the ones it depends on', () => {
    const steps = [
      handler('fixture:observe', 'observation', [], 3),
      handler('fixture:settle', 'relation-end', ['fixture:normalize'], 2),
      handler('fixture:normalize', 'spatial', [], 1),
    ]
    // Declared out of order on purpose: the plan is derived, not the declaration order.
    expect(order(world(steps).resolve(host(), request()).events)).toEqual([0, 1, 2, 3])
  })

  it('breaks ties inside one phase by exact handler id', () => {
    const steps = [handler('fixture:zeta', 'relation-end', [], 2), handler('fixture:alpha', 'relation-end', [], 1)]
    expect(order(world(steps).resolve(host(), request()).events)).toEqual([0, 1, 2])
    const events = world(steps).resolve(host(), request()).events
    expect(events[1]!.eventType).toBe('fixture:alpha')
    expect(events[2]!.eventType).toBe('fixture:zeta')
  })

  it('pulls in a handler dependency that the definition did not name', () => {
    const steps = [handler('fixture:settle', 'relation-end', ['fixture:hidden'], 2), handler('fixture:hidden', 'spatial', [], 1)]
    const held = world(steps, ['fixture:settle'])
    // Only fixture:settle is referenced, but its dependency is a fold step too.
    expect(order(held.resolve(host(), request()).events)).toEqual([0, 1, 2])
  })

  it('skips a step with nothing to add and ignores a dependency that is not a fold step', () => {
    // The dependency names the package's rule, not another handler, so it is not a fold step; and a
    // step that adds nothing must leave the candidate events untouched rather than re-emitting them.
    const quiet: InteractionLifecycleHandlerImplementation = {
      ...handler('fixture:quiet', 'spatial', ['fixture:accept:package:lifecycle'], 1), build: () => [],
    }
    expect(order(world([quiet]).resolve(host(), request()).events)).toEqual([0])
  })

  it('refuses a fold order that cannot be achieved', () => {
    // A spatial handler that depends on an observation handler would have to run after a later phase.
    const reverse = [handler('fixture:early', 'spatial', ['fixture:late'], 1), handler('fixture:late', 'observation', [], 2)]
    expect(() => world(reverse)).toThrow(/unachievable/u)
    // Same phase, but the dependency sits after the dependent in id order.
    const samePhase = [handler('fixture:aaa', 'spatial', ['fixture:zzz'], 1), handler('fixture:zzz', 'spatial', [], 2)]
    expect(() => world(samePhase)).toThrow(/unachievable/u)
  })

  it('hands a handler only the instances its own definitions created, and refuses to end others', () => {
    const relation = { kind: 'relation' as const, id: 'relation:held' }
    const base = host()
    const together = {
      ...base,
      targets: [...base.targets, { ref: relation,
        state: { interactionId: 'base:hold-hand', initiatorId: actor, targetId: 'character:alice', active: true } }],
      authorizedTargets: [...base.authorizedTargets, relation],
    }
    const seen: string[] = []
    const sweep: InteractionLifecycleHandlerImplementation = {
      ...handler('fixture:sweep', 'relation-end', [], 1),
      consumes: [ref('fixture:mine')],
      eventTypes: [ref('character.relation-ended')],
      build: context => {
        for (const entry of context.host.targets) if (entry.ref.kind === 'relation') seen.push(entry.ref.id)
        return []
      },
    }
    world([sweep], ['fixture:sweep']).fold(together, [])
    // The relation belongs to a definition this handler did not declare, so it never sees it.
    expect(seen).toEqual([])
    // Declaring the right definition puts it in scope.
    world([{ ...sweep, consumes: [ref('base:hold-hand')] }], ['fixture:sweep']).fold(together, [])
    expect(seen).toEqual(['relation:held'])
    // Emitting an end for a relation the fold did not hand it is refused outright.
    const greedy: InteractionLifecycleHandlerImplementation = {
      ...sweep,
      eventTypes: [ref('character.relation-ended')],
      build: () => [{ eventType: 'character.relation-ended', eventVersion: 1,
        data: { relationId: 'relation:elsewhere', endedByCharacterId: actor, reason: 'released' } }],
    }
    expect(() => world([greedy], ['fixture:sweep']).fold(together, [])).toThrow(/outside its declared scope/u)
  })

  it('refuses a handler the definition references but the package does not provide', () => {
    const orphan = packageOf([], 'package:lifecycle', ['fixture:missing'])
    const registry = new InteractionRegistry()
    registry.install(orphan)
    const selection = { address, packages: [orphan.lock],
      definitions: [{ ref: ref('fixture:fold'), definitionHash: hashWorldJson('interaction-definition/v1', orphan.definitions[0]!.spec), implementationHash: orphan.definitions[0]!.implementationHash }],
      bindings: [{ bindingId: 'binding:fold', targetRef: { kind: 'entity' as const, id: 'entity:cup' }, definitionRef: ref('fixture:fold'), config: {} }] }
    expect(() => registry.freeze(selection)).toThrow(/lifecycle handler missing/u)
  })

  it('refuses a handler that reaches outside its declared event closure or its budget', () => {
    const outside: InteractionLifecycleHandlerImplementation = {
      lock: lock('fixture:outside'), phase: 'observation', consumes: [], eventTypes: [ref('fixture.allowed')],
      build: () => [{ eventType: 'fixture.other', eventVersion: 1, data: {} }],
    }
    expect(() => world([outside]).resolve(host(), request())).toThrow(/exceeded its event closure/u)
    const overBudget: InteractionLifecycleHandlerImplementation = {
      lock: lock('fixture:many'), phase: 'observation', consumes: [], eventTypes: [ref('fixture.many')],
      build: () => Array.from({ length: 5 }, () => ({ eventType: 'fixture.many', eventVersion: 1, data: {} })),
    }
    expect(() => world([overBudget]).resolve(host(), request())).toThrow(/array outside limits/u)
  })

  it('installs only known phases and refuses movement from a fold step', () => {
    const bad = { ...handler('fixture:bad', 'nowhere' as never, [], 1) }
    expect(() => new InteractionRegistry().install(packageOf([bad]))).toThrow(/unknown lifecycle phase/u)
    const mover = { ...handler('fixture:mover', 'spatial', [], 1), eventTypes: [ref('character.moved')] }
    expect(() => new InteractionRegistry().install(packageOf([mover]))).toThrow(/cannot own movement/u)
    expect(() => new InteractionRegistry().install({ ...packageOf([]), lifecycle: [{ ...handler('fixture:x', 'spatial', [], 1), build: null as never }] }))
      .toThrow(/lifecycle handler implementation missing/u)
  })

  it('fails the whole fold when the cumulative event budget is exceeded, not only each step', () => {
    // The per-handler bound and the group bound are different numbers in the profile. A step that stays
    // inside its own limit can still push the group past the frozen 64, and a fold that returned the
    // oversized candidate set would hand back events nobody authorized.
    const wide = (id: string, count: number): InteractionLifecycleHandlerImplementation => ({
      lock: lock(id), phase: 'observation', consumes: [], eventTypes: [ref(`fixture.${id}`)],
      build: () => Array.from({ length: count }, (_, index) => ({ eventType: `fixture.${id}`, eventVersion: 1, data: { index } })),
    })
    // The profile's own per-action ceiling is 16, so a step can never exceed that on its own.
    const atCeiling = [wide('fixture:w0', 16), wide('fixture:w1', 16), wide('fixture:w2', 16), wide('fixture:w3', 15)]
    // 63 from the steps plus the one the main effect produced is exactly the frozen ceiling of 64.
    expect(world(atCeiling, undefined, 16).resolve(host(), request()).events).toHaveLength(64)
    // One more step event crosses it, and the whole group fails rather than being truncated.
    expect(() => world([...atCeiling, wide('fixture:w4', 1)], undefined, 16).resolve(host(), request()))
      .toThrow(/total event budget/u)
  })

  it('fails the whole fold when the plan exceeds the frozen call budget', () => {
    // The budget only bites across packages: one package may hold 64 handlers, so a chain longer than
    // 256 needs several of them.
    const packages: InteractionPackageImplementation[] = []
    const chain: InteractionLifecycleHandlerImplementation[] = []
    // The definition names only the tail; the closure reaches the rest through dependencies, so the
    // 16-reference cap on a definition is not what this budget is for.
    for (let index = 0; index < 260; index++) {
      chain.push(handler(`fixture:step-${String(index).padStart(3, '0')}`, 'observation',
        index === 0 ? [] : [`fixture:step-${String(index - 1).padStart(3, '0')}`], index))
    }
    for (let chunk = 0; chunk < 5; chunk++) {
      packages.push(packageOf(chain.slice(chunk * 52, chunk * 52 + 52), `package:chain-${chunk}`,
        chunk === 0 ? ['fixture:step-259'] : [], chunk === 0 ? 'fixture:fold' : `fixture:chain-${chunk}`))
    }
    const registry = new InteractionRegistry()
    for (const pack of packages) registry.install(pack)
    const head = packages[0]!
    const selection: InteractionWorldSelection = {
      address, packages: packages.map(pack => pack.lock),
      definitions: [{ ref: ref('fixture:fold'),
        definitionHash: hashWorldJson('interaction-definition/v1', head.definitions[0]!.spec),
        implementationHash: head.definitions[0]!.implementationHash }],
      bindings: [{ bindingId: 'binding:fold', targetRef: { kind: 'entity' as const, id: 'entity:cup' }, definitionRef: ref('fixture:fold'), config: {} }],
    }
    const held = registry.freeze(selection)
    expect(() => held.resolve(host(), request())).toThrow(/exceeds the budget/u)
  })
})
