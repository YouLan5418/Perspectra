import { expect, it } from 'vitest'
import { brandId, hashWorldJson, resolutionAuthority, type InteractionHostContext, type InteractionPackageImplementation, type InteractionWorldSelection } from '@harness-world/contracts'
import { InteractionRegistry, interactionPackageHash } from '@harness-world/interaction-runtime'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { currentEntityState, type RulebookEvent } from '@harness-world/kernel'
import { interactionWorld } from './fixtures/interaction-world.ts'
import { immutable, integer, key, list, object, parameterSchema, parameters, reference, target, text } from '../packages/interaction-runtime/src/validation.ts'

const address = { tenantId: brandId('tenant:i1', 'TenantId'), worldId: brandId('world:i1', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
const digest = hashWorldJson('i1', null)
const ref = (id: string) => ({ id, version: 1 })
const entity = { kind: 'entity' as const, id: 'entity:cup' }
const character = (id: string) => ({ kind: 'character' as const, id })
function host(): InteractionHostContext {
  return { address, manifestHash: digest, asOfWorldSeq: 0, candidatePrefixHash: digest, actionId: 'action:i1', actorId: brandId('character:npc', 'CharacterId'), authority: resolutionAuthority('agent', 'standard'),
    targets: [
      { ref: character('character:npc'), state: { lifecycle: 'active', locationId: 'location:room', sceneIds: ['scene:room'] } },
      { ref: character('character:player'), state: { lifecycle: 'active', locationId: 'location:room', sceneIds: ['scene:room'] } },
      { ref: entity, state: { holderId: null, locationId: 'location:room', kind: 'cup' } },
    ], authorizedTargets: [entity, character('character:player')] }
}
function selection(pack = createBasicInteractionPackage()): InteractionWorldSelection {
  return { address, packages: [pack.lock], definitions: pack.definitions.map(def => ({ ref: ref(def.spec.id), definitionHash: hashWorldJson('interaction-definition/v1', def.spec), implementationHash: def.implementationHash })),
    // Only definitions whose primary target is an entity can bind to the item this fixture owns.
    bindings: pack.definitions
      .filter(def => def.spec.participantRoles.some(role => role.source.kind === 'primaryTarget' && role.kind === 'entity'))
      .map(def => ({ bindingId: `binding:${def.spec.id}`, targetRef: entity, definitionRef: ref(def.spec.id), config: {} })) }
}
function request(id = 'base:take', args = {}) { return { targetRef: entity, bindingId: `binding:${id}`, definitionRef: ref(id), arguments: args } }
function setup(pack = createBasicInteractionPackage(), selected = selection(pack)) {
  const registry = new InteractionRegistry(); registry.install(pack)
  return registry.freeze(selected)
}
function relock(pack: InteractionPackageImplementation): InteractionPackageImplementation {
  return { ...pack, lock: { ...pack.lock, implementationHash: interactionPackageHash(pack) } }
}
function changeHost(role: string, patch: Record<string, unknown>) {
  const value = host()
  return { ...value, targets: value.targets.map(entry => entry.ref.id === role ? { ...entry, state: { ...entry.state, ...patch } } : entry) } as InteractionHostContext
}

it('executes take/give/drop/take via declared rules and effects, then folds real existing entity events', () => {
  const runtime = setup()
  const base = interactionWorld()
  const events: RulebookEvent[] = [...base.genesisEvents]
  const traces = []
  for (const [id, actorId, args] of [
    ['base:take', 'character:npc', {}], ['base:give', 'character:npc', { recipientId: 'character:player' }],
    ['base:drop', 'character:player', {}], ['base:take', 'character:npc', {}],
  ] as const) {
    const input = host()
    const snapshot = { ...input, actorId: brandId(actorId, 'CharacterId'), actionId: `action:${events.length}`,
      authorizedTargets: [entity, character('character:player'), character('character:npc')],
      candidatePrefixHash: hashWorldJson('prefix', events as never), asOfWorldSeq: events.length,
      targets: input.targets.map(entry => entry.ref.kind === 'entity' ? { ...entry, state: currentEntityState(events, entity.id)! } : entry) }
    const output = runtime.resolve(snapshot, request(id, args))
    expect(output.status).toBe('accepted')
    expect(output.trace[0]?.rule.id).toBe('base:actor-active')
    expect(output.events).toHaveLength(1)
    expect(Object.isFrozen(output.events)).toBe(true)
    expect(runtime.resolve(snapshot, request(id, args))).toEqual(output)
    traces.push(output.ruleTraceHash); events.push(...output.events)
  }
  expect(currentEntityState(events, entity.id)?.holderId).toBe('character:npc')
  expect(new Set(traces).size).toBe(4)
  const stale = { ...host(), targets: host().targets.map(entry => entry.ref.kind === 'entity' ? { ...entry, state: currentEntityState(events, entity.id)! } : entry) }
  expect(runtime.resolve(stale, request()).reason).toBe('ITEM_NOT_AVAILABLE')
})

it('requires every participant, immutable inputs and current prefix, while disabled definitions cannot run', () => {
  const runtime = setup()
  const holding = changeHost(entity.id, { holderId: 'character:npc', locationId: null })
  expect(runtime.resolve({ ...holding, authorizedTargets: [entity] }, request('base:give', { recipientId: 'character:player' })).reason).toBe('PARTICIPANT_NOT_AUTHORIZED')
  expect(runtime.resolve({ ...holding, authorizedTargets: [entity, character('character:npc')] }, request('base:give', { recipientId: 'character:npc' })).reason).toBe('PARTICIPANT_ALIAS_FORBIDDEN')
  expect(runtime.resolve({ ...host(), targets: [], authorizedTargets: [] }, request()).reason).toBe('PARTICIPANT_NOT_AUTHORIZED')
  expect(() => runtime.resolve({ ...host(), authorizedTargets: [entity, entity] }, request())).toThrow('authorization set')
  expect(() => runtime.resolve({ ...host(), authorizedTargets: [character('missing')] }, request())).toThrow('authorization set')
  for (const state of [null, [], 1]) expect(() => runtime.resolve({ ...host(), targets: [{ ref: entity, state }] } as any, request())).toThrow('snapshot state')
  const taken = runtime.resolve(host(), request())
  expect(runtime.resolve({ ...host(), candidatePrefixHash: hashWorldJson('other', null) }, request()).ruleTraceHash).not.toBe(taken.ruleTraceHash)
  expect(() => runtime.resolve({ ...host(), address: { ...address, branchId: brandId('branch:other', 'BranchId') } }, request())).toThrow('WorldAddress')
  expect(() => runtime.resolve({ ...host(), targets: [...host().targets, host().targets[0]!] }, request())).toThrow('duplicate snapshot')
  for (const value of [null, {}, { ...request(), extra: true }, { ...request(), bindingId: 'missing' }, { ...request(), targetRef: character('character:player') }, { ...request(), definitionRef: ref('base:drop') }, { ...request(), arguments: { actorId: 'other' } }]) expect(() => runtime.resolve(host(), value)).toThrow()
  const p = createBasicInteractionPackage(); const s = selection(p)
  expect(setup(p, { ...s, definitions: [...s.definitions].reverse(), bindings: [...s.bindings].reverse() }).definitionSetHash).toBe(runtime.definitionSetHash)
  expect(interactionPackageHash({ ...p, rules: [...p.rules].reverse(), effects: [...p.effects].reverse(), resolvers: [...p.resolvers].reverse(), lifecycle: [...p.lifecycle].reverse(), performances: [...p.performances].reverse(), definitions: [...p.definitions].reverse() })).toBe(p.lock.implementationHash)
  const disabled = setup(p, { ...s, definitions: [], bindings: [] })
  expect(() => disabled.resolve(host(), request())).toThrow('enabled binding')
  const mutable = structuredClone(s)
  const frozen = setup(p, mutable)
  ;(mutable.bindings as any[]).length = 0
  expect(frozen.resolve(host(), request()).status).toBe('accepted')
})

it('runs an independently registered state-domain fixture only when its package and definition are selected', () => {
  const base = createBasicInteractionPackage()
  const effectRef = ref('fixture:mark-effect')
  const definition = { ...base.definitions[0]!, spec: { ...base.definitions[0]!.spec, id: 'fixture:mark',
    effectBuilderRef: effectRef, effectCapabilityRefs: [effectRef], preconditions: [] } }
  const fixture = relock({ lock: { ref: ref('package:fixture'), implementationHash: digest, dependencies: [base.lock.ref] }, rules: [], resolvers: [], lifecycle: [], performances: [], reactionEvidence: [], definitions: [definition], effects: [{
    lock: { ref: effectRef, implementationHash: digest, dependencies: [] }, eventTypes: [ref('fixture.marked')],
    build: ctx => [{ eventType: 'fixture.marked', eventVersion: 1, data: { entityId: ctx.roles.item!.id, marked: true } }],
    validate: (ctx, events) => expect(events).toEqual([{ eventType: 'fixture.marked', eventVersion: 1, data: { entityId: ctx.roles.item!.id, marked: true } }]),
  }] })
  const registry = new InteractionRegistry(); registry.install(base); registry.install(fixture)
  const chosen = selection(fixture)
  expect(() => registry.freeze(chosen)).toThrow('capability missing')
  const selected = { ...chosen, packages: [fixture.lock, base.lock] }
  const enabled = registry.freeze(selected)
  expect(enabled.definitionSetHash).toBe(registry.freeze({ ...selected, packages: [...selected.packages].reverse() }).definitionSetHash)
  expect(enabled.resolve(host(), request('fixture:mark')).events[0]?.eventType).toBe('fixture.marked')
  expect(() => registry.freeze(selection(base)).resolve(host(), request('fixture:mark'))).toThrow('enabled binding')
})

it('rejects unregistered, duplicate, drifted and cyclic dependencies before execution', () => {
  const pack = createBasicInteractionPackage(); const selected = selection(pack)
  const registry = new InteractionRegistry(); registry.install(pack)
  expect(() => registry.install(pack)).toThrow('duplicate')
  for (const input of [
    { ...selected, packages: [{ ...pack.lock, ref: ref('missing') }] },
    { ...selected, packages: [{ ...pack.lock, implementationHash: digest }] },
    { ...selected, packages: [pack.lock, pack.lock] },
    { ...selected, definitions: [...selected.definitions, selected.definitions[0]!] },
    { ...selected, definitions: [{ ...selected.definitions[0]!, definitionHash: digest }] },
    { ...selected, definitions: [{ ...selected.definitions[0]!, implementationHash: digest }] },
    { ...selected, definitions: [], bindings: selected.bindings },
    { ...selected, bindings: [...selected.bindings, selected.bindings[0]!] },
    { ...selected, bindings: [{ ...selected.bindings[0]!, targetRef: character('character:npc') }] },
  ]) expect(() => registry.freeze(input)).toThrow()
  expect(() => new InteractionRegistry().install({ ...pack, lock: { ...pack.lock, implementationHash: digest } })).toThrow('component lock drift')
  const cyclic = relock({ ...pack, rules: pack.rules.map((r, i) => i === 0 ? { ...r, lock: { ...r.lock, dependencies: [r.lock.ref] } } : r) })
  expect(() => setup(cyclic)).toThrow('cycle')
  const missing = relock({ ...pack, lock: { ...pack.lock, dependencies: [ref('missing:package')] } })
  expect(() => setup(missing)).toThrow('dependency not enabled')
  const noSpace = relock({ ...pack, rules: pack.rules.filter(rule => !rule.lock.ref.id.startsWith('space:')) })
  expect(() => setup(noSpace)).toThrow('spatial capability missing')
  const noEffect = relock({ ...pack, effects: [] })
  expect(() => setup(noEffect)).toThrow('effect capability missing')
  const wrongDependency = relock({ ...pack, definitions: pack.definitions.map((d, i) => i === 0 ? { ...d, spec: { ...d.spec, dependencyRefs: [ref('missing:def')] } } : d) })
  expect(() => setup(wrongDependency)).toThrow('dependency not enabled')
})

it('validates closed definition metadata and installs atomically after a rejected package', () => {
  const base = createBasicInteractionPackage()
  const first = base.definitions[0]!
  const primary = first.spec.participantRoles[1]!
  const invalidSpecs = [
    { ...first.spec, extra: 1 }, { ...first.spec, versionTag: 'bad' }, { ...first.spec, version: 0 },
    { ...first.spec, participantRoles: [] }, { ...first.spec, participantRoles: [primary] },
    { ...first.spec, participantRoles: [...first.spec.participantRoles, primary] },
    ...[{ name: '__proto__' }, { name: 'other', source: { kind: 'hostActor' } }, { source: { kind: 'derived' } },
      { source: { kind: 'argument', field: 'missing' } }, { distinctFrom: ['missing'] }, { distinctFrom: ['item'] }, { distinctFrom: ['actor', 'actor'] }]
      .map(patch => ({ ...first.spec, participantRoles: [first.spec.participantRoles[0], { ...primary, ...patch }] })),
    { ...first.spec, preconditions: [ref('base:item-unheld'), ref('base:item-unheld')] },
    { ...first.spec, effectCapabilityRefs: [] }, { ...first.spec, limits: { maximumEvents: 17 } },
  ]
  for (const spec of invalidSpecs) {
    const registry = new InteractionRegistry()
    expect(() => registry.install(relock({ ...base, definitions: [{ ...first, spec: spec as any }] }))).toThrow()
    registry.install(base)
    expect(registry.freeze(selection(base)).resolve(host(), request()).status).toBe('accepted')
  }
  for (const patched of [
    { ...base, rules: [{ ...base.rules[0], check: null }] },
    { ...base, effects: [{ ...base.effects[0], build: null }] },
    { ...base, effects: [{ ...base.effects[0], validate: null }] },
    { ...base, effects: [{ ...base.effects[0], eventTypes: [ref('character.moved')] }] },
    { ...base, definitions: [{ ...first, implementationHash: 'bad' }] },
  ]) expect(() => new InteractionRegistry().install(patched as any)).toThrow()
})

it('enforces effect closure, budget and pure input contracts without partial events', () => {
  const pack = createBasicInteractionPackage()
  const effect = pack.effects[0]!
  for (const build of [() => [], () => Array(2).fill({ eventType: 'entity.transferred', eventVersion: 1, data: {} }),
    () => [{ eventType: 'character.moved', eventVersion: 1, data: {} }],
    () => [{ eventType: 'entity.transferred', eventVersion: 2, data: {} }],
    () => [{ eventType: 'entity.transferred', eventVersion: 1, data: {} }],
    (ctx: any) => { ctx.roles.actor.id = 'forged'; return [] },
  ]) {
    const bad = relock({ ...pack, effects: [{ ...effect, build }, ...pack.effects.slice(1)] })
    expect(() => setup(bad).resolve(host(), request())).toThrow()
  }
  for (const reason of ['accepted', '', undefined]) {
    const bad = relock({ ...pack, rules: pack.rules.map((r, i) => i === 0 ? { ...r, check: () => reason as any } : r) })
    expect(() => setup(bad).resolve(host(), request())).toThrow()
  }
  const ctx = { host: host(), definition: pack.definitions[0]!.spec, binding: selection(pack).bindings[0]!, arguments: {}, roles: { actor: character('character:npc'), item: entity } }
  const valid = effect.build(ctx)
  expect(() => effect.validate(ctx, [...valid, ...valid])).toThrow('one event')
  for (const patch of [{ entityId: 'entity:other' }, { characterId: 'character:player' }, { interactionId: 'fake' },
    { fromHolderId: 'character:player' }, { fromLocationId: 'elsewhere' }, { toHolderId: 'character:player' }, { toLocationId: 'elsewhere' }, { extra: true }]) {
    expect(() => effect.validate(ctx, [{ ...valid[0]!, data: { ...valid[0]!.data as any, ...patch } }])).toThrow('invariant')
  }
  const fields = Array.from({ length: 5 }, (_, i) => ({ name: `field${i}`, type: 'string' as const, maxBytes: 1024, values: [] }))
  const configured = relock({ ...pack, definitions: pack.definitions.map((def, i) => i === 0 ? { ...def, spec: { ...def.spec, bindingConfigSchema: { fields } } } : def) })
  const chosen = selection(configured)
  const config = Object.fromEntries(fields.map(field => [field.name, 'x'.repeat(1024)]))
  expect(() => setup(configured, { ...chosen, bindings: [{ ...chosen.bindings[0]!, config }] })).toThrow('config exceeds budget')
})

it('keeps actor, possession, spatial and recipient rules in the basic package', () => {
  const runtime = setup()
  for (const [who, patch, reason] of [
    ['character:npc', { lifecycle: 'dead' }, 'ACTOR_CANNOT_ACT'],
    ['character:npc', { locationId: null }, 'LOCATION_UNAVAILABLE'],
    ['character:npc', { sceneIds: null }, 'SCENE_UNAVAILABLE'],
    ['character:npc', { sceneIds: [] }, 'NO_SHARED_SCENE'],
    [entity.id, { locationId: 'elsewhere' }, 'NOT_CO_LOCATED'],
  ] as const) expect(runtime.resolve(changeHost(who, patch), request()).reason).toBe(reason)
  expect(runtime.resolve({ ...host(), authority: resolutionAuthority('director', 'standard') }, request()).reason).toBe('ACTOR_CANNOT_ACT')
  expect(runtime.resolve(host(), request('base:drop')).reason).toBe('ITEM_NOT_HELD')
  for (const patch of [{ lifecycle: 'dead' }, { sceneIds: null }, { sceneIds: ['other'] }]) {
    const changed = changeHost('character:player', patch)
    const input = { ...changed, targets: changed.targets.map(entry => entry.ref.kind === 'entity' ? { ...entry, state: { ...entry.state, holderId: 'character:npc', locationId: null } } : entry) }
    expect(runtime.resolve(input, request('base:give', { recipientId: 'character:player' })).status).toBe('rejected')
  }
})

it('uses one strict bounded parameter contract, preserves Unicode, and rejects extra authority', () => {
  const schema = parameterSchema({ fields: [
    { name: 'flag', type: 'boolean' }, { name: 'amount', type: 'integer', minimum: -1, maximum: 2 },
    { name: 'word', type: 'string', maxBytes: 3, values: ['中', 'a'] }, { name: 'free', type: 'string', maxBytes: 4, values: [] },
  ] })
  const value = { flag: false, amount: 0, word: '中', free: '😀' }
  expect(parameters(schema, value)).toEqual(value)
  for (const patch of [{ flag: 0 }, { amount: 3 }, { amount: -0 }, { word: 'b' }, { word: '中文' }, { free: 1 }, { free: '😀a' }, { free: '\ud800' }]) expect(() => parameters(schema, { ...value, ...patch })).toThrow()
  for (const input of [null, [], {}, { fields: Array(9).fill({ name: 'x', type: 'boolean' }) },
    ...[null, { name: 'x', type: 'unsupported' }, { name: 'actorId', type: 'boolean' },
      { name: 'x', type: 'integer', minimum: 1, maximum: 0 }, { name: 'x', type: 'string', maxBytes: 0, values: [] },
      { name: 'x', type: 'string', maxBytes: 1, values: ['a', 'a'] }, { name: 'x', type: 'string', maxBytes: 1, values: [1] },
      { name: 'x', type: 'string', maxBytes: 1, values: ['中'] }].map(field => ({ fields: [field] })),
    { fields: [{ name: 'x', type: 'boolean' }, { name: 'x', type: 'boolean' }] },
  ]) expect(() => parameterSchema(input)).toThrow()
  expect(() => text(1)).toThrow(); expect(() => text(' ')).toThrow()
  expect(() => integer(1.1, 0, 2)).toThrow(); expect(() => list({}, 8)).toThrow()
  expect(() => object([], [])).toThrow(); expect(() => reference({ id: 'x', version: 1, extra: true })).toThrow()
  expect(key(ref('a@b'))).toBe('a@b@1')
  expect(() => target({ id: 'x', kind: 'unknown' })).toThrow()
  expect(immutable({ value: null })).toEqual({ value: null })
})
