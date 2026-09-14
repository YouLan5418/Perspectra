import {
  ACTION_GROUP_CUES, INTERACTION_LIFECYCLE_PHASES, compareWorldText, hashWorldJson, validateResolutionAuthority, worldAddressKey,
  type ActionGroupCue,
  type InteractionAdjudication, type InteractionBindingV3, type InteractionCharacterView,
  type InteractionDefinitionImplementation,
  type InteractionDefinitionSpec, type InteractionEffectImplementation, type InteractionExecutionContext,
  type InteractionHostContext, type InteractionImplementationLock, type InteractionPackageImplementation,
  type InteractionDerivedResolverImplementation, type InteractionLifecycleHandlerImplementation,
  type InteractionPerformance, type InteractionPerformanceImplementation, type InteractionPerformancePolicyV1,
  type InteractionRef, type InteractionRequestV2, type InteractionRuleImplementation,
  type InteractionTargetRef, type InteractionViewContext, type InteractionViewOption,
  type InteractionWorldSelection, type WorldEventDraft, type WorldHash, type WorldJsonObject, type WorldJsonValue,
} from '@harness-world/contracts'
import { immutable, integer, key, list, object, parameterSchema, parameters, reference, target, targetKey, text } from './validation.ts'

function hash(value: unknown): WorldHash {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError('invalid implementation hash')
  return value as WorldHash
}

function refs(value: unknown, maximum: number): readonly InteractionRef[] {
  const parsed = list(value, maximum).map(reference)
  if (new Set(parsed.map(key)).size !== parsed.length) throw new TypeError('duplicate reference')
  return parsed
}

function lock(value: InteractionImplementationLock): InteractionImplementationLock {
  object(value, ['ref', 'implementationHash', 'dependencies'])
  return immutable({ ref: reference(value.ref), implementationHash: hash(value.implementationHash), dependencies: refs(value.dependencies, 64) })
}

/**
 * The policy narrows the already frozen eight-cue vocabulary; it never extends it. An interact step
 * cannot carry a voice or gait cue, because those belong to speak and move by the frozen table, so
 * declaring one is an install error rather than a runtime rejection.
 */
function performancePolicy(value: unknown): InteractionPerformancePolicyV1 {
  const root = object(value, ['version', 'accepted'])
  if (root.version !== 'interaction-performance/v1') throw new TypeError('unsupported performance policy')
  const seen = new Set<string>()
  for (const input of list(root.accepted, 8)) {
    const row = object(input, ['cue', 'placement', 'requiresRole'])
    const cue = text(row.cue)
    if (seen.has(cue)) throw new TypeError('duplicate performance cue')
    seen.add(cue)
    if (!Object.hasOwn(ACTION_GROUP_CUES, cue)) throw new TypeError('unknown performance cue')
    if (ACTION_GROUP_CUES[cue as ActionGroupCue].actionType !== null) throw new TypeError('interaction performance cannot bind a voice or gait cue')
    if (row.placement !== 'independent' && row.placement !== 'onSuccess' && row.placement !== 'both') throw new TypeError('invalid performance placement')
    if (row.requiresRole !== null) text(row.requiresRole)
  }
  return immutable(value as InteractionPerformancePolicyV1)
}

/**
 * Narrow a submitted manifestation to what the policy accepted. A cue outside the policy, or in a
 * placement the policy does not allow, fails the whole proposal rather than being dropped: silently
 * discarding a performance would tell the world something happened that did not.
 */
export function resolvePerformance(policy: InteractionPerformancePolicyV1, value: unknown): InteractionPerformance {
  const root = object(value, ['independent', 'onSuccess'])
  const accepted = new Map(policy.accepted.map(entry => [entry.cue, entry]))
  const read = (input: unknown, placement: 'independent' | 'onSuccess'): readonly ActionGroupCue[] => list(input, 8).map(text).map(code => {
    const entry = accepted.get(code as ActionGroupCue)
    if (entry === undefined) throw new TypeError('cue is outside the definition performance policy')
    if (entry.placement !== 'both' && entry.placement !== placement) throw new TypeError('cue placement is not allowed here')
    return code as ActionGroupCue
  })
  const independent = read(root.independent, 'independent')
  const onSuccess = read(root.onSuccess, 'onSuccess')
  // Each list is judged on its own first. Collapsing the cross-list restatement before this would
  // hide a repeat inside one list, which the frozen schema marks uniqueItems and therefore refuses.
  if (new Set(independent).size !== independent.length) throw new TypeError('duplicate performance cue')
  if (new Set(onSuccess).size !== onSuccess.length) throw new TypeError('duplicate performance cue')
  // A cue in both lists is one restatement of the same self-expression, read exactly the way the
  // frozen step normalization reads it, so it plays once instead of failing the step.
  const alwaysOn = new Set(independent)
  const distinctOnSuccess = onSuccess.filter(cue => !alwaysOn.has(cue))
  return immutable(independent.length === 0 && distinctOnSuccess.length === 0
    ? { independent: [], onSuccess: [] }
    : { independent, onSuccess: distinctOnSuccess })
}

/** Fold budget from the frozen interaction-limits/v1 profile: exceeding it fails the whole group. */
const MAXIMUM_LIFECYCLE_CALLS = 256
/**
 * Cumulative event budget from the same profile: one action's events including everything the fold
 * adds. The per-handler bound alone is not a bound on the group, so this is checked as the fold grows.
 */
const MAXIMUM_TOTAL_LIFECYCLE_EVENTS = 64
/** A world fold runs without a definition, so it uses the per-action event scale from the profile. */
const MAXIMUM_LIFECYCLE_EVENTS = 16
/** Per-character public option budget, from the frozen interaction-limits/v1 profile. */
const MAXIMUM_VIEW_OPTIONS = 128
/** Per-binding argument combination budget, from the same profile. */
const MAXIMUM_ARGUMENT_COMBINATIONS = 64

/** The frozen fold order: phase first, then exact handler id to break ties inside a phase. */
function compareLifecycleHandlers(left: InteractionLifecycleHandlerImplementation, right: InteractionLifecycleHandlerImplementation): number {
  return INTERACTION_LIFECYCLE_PHASES.indexOf(left.phase) - INTERACTION_LIFECYCLE_PHASES.indexOf(right.phase)
    || compareWorldText(key(left.lock.ref), key(right.lock.ref))
}

function compareTargets(left: InteractionTargetRef, right: InteractionTargetRef): number {
  return compareWorldText(left.kind, right.kind) || compareWorldText(left.id, right.id)
}

/**
 * Whether a request addresses the target its binding was declared for.
 *
 * An entity or character binding names its target directly. A relation binding names the *class* its
 * id identifies - the definition whose instances it may address - so the request names an instance
 * and the instance carries the class it belongs to. That class is a fact the Host already put in the
 * snapshot, so this cannot be decided from the request alone, and a forged instance id carries no
 * class at all.
 */
function addressesBinding(binding: InteractionBindingV3, targetRef: InteractionTargetRef, host: InteractionHostContext): boolean {
  if (binding.targetRef.kind !== 'relation') return targetKey(binding.targetRef) === targetKey(targetRef)
  if (targetRef.kind !== 'relation') return false
  const entry = host.targets.find(value => value.ref.kind === 'relation' && value.ref.id === targetRef.id)
  return entry !== undefined && (entry.state as WorldJsonObject).interactionId === binding.targetRef.id
}

/** The refs a binding can currently address: itself, or every authorized instance of its class. */
function bindingTargets(
  binding: InteractionBindingV3,
  host: InteractionHostContext,
  authorized: ReadonlySet<string>,
): readonly InteractionTargetRef[] {
  if (binding.targetRef.kind !== 'relation') {
    return authorized.has(targetKey(binding.targetRef)) ? [binding.targetRef] : []
  }
  return host.targets
    .filter(entry => entry.ref.kind === 'relation' && authorized.has(targetKey(entry.ref))
      && (entry.state as WorldJsonObject).interactionId === binding.targetRef.id)
    .map(entry => entry.ref)
    .sort(compareTargets)
}

/** Stable order: definition identity, then target, then binding, then canonical argument bytes. */
function compareViewOptions(left: InteractionViewOption, right: InteractionViewOption): number {
  return compareWorldText(`${left.definitionRef.id}@${left.definitionRef.version}`, `${right.definitionRef.id}@${right.definitionRef.version}`)
    || compareWorldText(targetKey(left.targetRef), targetKey(right.targetRef))
    || compareWorldText(left.bindingId, right.bindingId)
    || compareWorldText(JSON.stringify(left.arguments), JSON.stringify(right.arguments))
}

/** Validate the candidate snapshot and the authorization set the same way adjudication does. */
function snapshot(host: InteractionHostContext): { readonly targets: ReadonlySet<string>; readonly authorized: ReadonlySet<string> } {
  const targets = new Set<string>()
  for (const entry of list(host.targets, 4096)) {
    const row = object(entry, ['ref', 'state'])
    const id = targetKey(target(row.ref))
    if (row.state === null || typeof row.state !== 'object' || Array.isArray(row.state)) throw new TypeError('snapshot state must be an object')
    if (targets.has(id)) throw new TypeError('duplicate snapshot target')
    targets.add(id)
  }
  const keys = list(host.authorizedTargets, 4096).map(value => targetKey(target(value)))
  const authorized = new Set(keys)
  if (authorized.size !== keys.length || keys.some(id => !targets.has(id))) throw new TypeError('invalid target authorization set')
  return { targets, authorized }
}

/**
 * Every argument combination this definition can present, as exact field values. A string field
 * that names an argument role takes its domain from the targets the Host authorized for that role,
 * never from a free string; a field with a declared enum takes its own values. Combinations are
 * produced jointly so the adapter cannot offer a cartesian product the plan would reject anyway.
 */
function argumentCombinations(
  def: InteractionDefinitionSpec,
  authorized: readonly InteractionTargetRef[],
): readonly WorldJsonObject[] {
  const domains: { readonly name: string; readonly values: readonly WorldJsonValue[] }[] = []
  let combinations = 1
  for (const field of def.argumentSchema.fields) {
    let values: readonly WorldJsonValue[]
    const role = def.participantRoles.find(entry => entry.source.kind === 'argument' && entry.source.field === field.name)
    if (field.type === 'string' && role !== undefined) {
      // A role is not a licence to exceed the field's own contract: the declared enum and the byte
      // bound still apply, so the view can never offer a value the request validator would refuse.
      values = authorized.filter(ref => ref.kind === role.kind).map(ref => ref.id)
        .filter(id => (field.values.length === 0 || field.values.includes(id)) && Buffer.byteLength(id, 'utf8') <= field.maxBytes)
    } else if (field.type === 'string') {
      if (field.values.length === 0) throw new TypeError('argument field has no enumerable domain')
      values = field.values
    } else if (field.type === 'boolean') {
      values = [false, true]
    } else {
      const size = field.maximum - field.minimum + 1
      if (size > MAXIMUM_ARGUMENT_COMBINATIONS) throw new TypeError('argument domain exceeds the binding budget')
      values = Array.from({ length: size }, (_, index) => field.minimum + index)
    }
    combinations *= values.length
    if (combinations > MAXIMUM_ARGUMENT_COMBINATIONS) throw new TypeError('argument domain exceeds the binding budget')
    domains.push({ name: field.name, values })
  }
  let rows: WorldJsonObject[] = [{}]
  for (const domain of domains) {
    rows = rows.flatMap(row => domain.values.map(value => ({ ...row, [domain.name]: value }) as WorldJsonObject))
  }
  return rows.map(row => immutable(row))
}

function definition(value: InteractionDefinitionSpec): InteractionDefinitionSpec {
  object(value, ['versionTag', 'id', 'version', 'participantRoles', 'argumentSchema', 'bindingConfigSchema', 'authorityPolicyRef', 'preconditions', 'spatialRequirementRefs', 'effectBuilderRef', 'effectCapabilityRefs', 'dependencyRefs', 'performancePolicyRef', 'lifecycleRefs', 'limits'])
  if (value.versionTag !== 'interaction-definition/v1') throw new TypeError('unsupported definition contract')
  reference({ id: value.id, version: value.version })
  parameterSchema(value.argumentSchema); parameterSchema(value.bindingConfigSchema)
  const names = new Set<string>()
  let actors = 0; let primary = 0
  for (const input of list(value.participantRoles, 8)) {
    const role = object(input, ['name', 'kind', 'source', 'distinctFrom'])
    const name = text(role.name)
    if (names.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new TypeError('duplicate or reserved role')
    names.add(name)
    target({ kind: role.kind, id: name })
    const source = role.source as { kind: string; field?: string; resolver?: InteractionRef }
    if (source?.kind === 'hostActor') {
      object(source, ['kind']); actors++
      if (name !== 'actor' || role.kind !== 'character') throw new TypeError('actor role must bind Host character')
    } else if (source?.kind === 'primaryTarget') { object(source, ['kind']); primary++ }
    else if (source?.kind === 'argument') {
      object(source, ['kind', 'field'])
      if (!value.argumentSchema.fields.some(field => field.name === source.field && field.type === 'string')) throw new TypeError('role argument must name a string field')
    } else if (source?.kind === 'derived') {
      object(source, ['kind', 'resolver']); reference(source.resolver)
    } else throw new TypeError('unsupported role source')
    const distinct = list(role.distinctFrom, 8).map(text)
    if (new Set(distinct).size !== distinct.length || distinct.includes(name)) throw new TypeError('invalid distinct roles')
  }
  if (actors !== 1 || primary !== 1) throw new TypeError('one actor and primary target required')
  for (const role of value.participantRoles) if (role.distinctFrom.some(name => !names.has(name))) throw new TypeError('unknown distinct role')
  reference(value.authorityPolicyRef); reference(value.effectBuilderRef); reference(value.performancePolicyRef)
  refs(value.preconditions, 16); refs(value.spatialRequirementRefs, 16); refs(value.effectCapabilityRefs, 16); refs(value.dependencyRefs, 64); refs(value.lifecycleRefs, 16)
  if (!value.effectCapabilityRefs.some(ref => key(ref) === key(value.effectBuilderRef))) throw new TypeError('effect capability missing')
  object(value.limits, ['maximumEvents']); integer(value.limits.maximumEvents, 1, 16)
  return immutable(value)
}

function definitionDependencies(spec: InteractionDefinitionSpec): readonly InteractionRef[] {
  return [spec.authorityPolicyRef, ...spec.preconditions, ...spec.spatialRequirementRefs, spec.effectBuilderRef,
    ...spec.effectCapabilityRefs, spec.performancePolicyRef,
    ...spec.participantRoles.flatMap(role => role.source.kind === 'derived' ? [role.source.resolver] : []),
    ...spec.lifecycleRefs, ...spec.dependencyRefs]
}

/** Published package contract binds every component lock and definition description. */
export function interactionPackageHash(input: Omit<InteractionPackageImplementation, 'lock'>): WorldHash {
  const ordered = <T>(values: readonly T[], id: (value: T) => string): T[] => [...values].sort((left, right) => compareWorldText(id(left), id(right)))
  return hashWorldJson('interaction-package-implementation/v1', {
    rules: ordered(input.rules, rule => key(rule.lock.ref)).map(rule => rule.lock),
    effects: ordered(input.effects, effect => key(effect.lock.ref)).map(effect => ({ lock: effect.lock, eventTypes: effect.eventTypes })),
    resolvers: ordered(input.resolvers, entry => key(entry.lock.ref)).map(entry => entry.lock),
    lifecycle: ordered(input.lifecycle, entry => key(entry.lock.ref)).map(entry => ({ lock: entry.lock, phase: entry.phase, consumes: entry.consumes, eventTypes: entry.eventTypes })),
    performances: ordered(input.performances, entry => key(entry.lock.ref)).map(entry => ({ lock: entry.lock, policy: entry.policy })),
    definitions: ordered(input.definitions, def => key({ id: def.spec.id, version: def.spec.version })).map(def => ({ spec: def.spec, implementationHash: def.implementationHash })),
  })
}

/** Install trusted implementations; World selection is a separate, immutable operation. */
export class InteractionRegistry {
  readonly #packages = new Map<string, InteractionPackageImplementation>()
  readonly #identities = new Set<string>()

  install(input: InteractionPackageImplementation): void {
    const packageLock = lock(input.lock)
    const rules = list(input.rules, 128).map(value => {
      const rule = value as InteractionRuleImplementation
      if (typeof rule.check !== 'function') throw new TypeError('rule implementation missing')
      return Object.freeze({ lock: lock(rule.lock), check: rule.check })
    })
    const effects = list(input.effects, 128).map(value => {
      const effect = value as InteractionEffectImplementation
      if (typeof effect.build !== 'function' || typeof effect.validate !== 'function') throw new TypeError('effect implementation missing')
      const eventTypes = refs(effect.eventTypes, 16)
      if (eventTypes.some(ref => ref.id === 'character.moved')) throw new TypeError('interaction cannot own movement')
      return Object.freeze({ lock: lock(effect.lock), eventTypes: immutable(eventTypes), build: effect.build, validate: effect.validate })
    })
    const resolvers = list(input.resolvers, 128).map(value => {
      const entry = value as InteractionDerivedResolverImplementation
      if (typeof entry.resolve !== 'function') throw new TypeError('derived resolver implementation missing')
      return Object.freeze({ lock: lock(entry.lock), resolve: entry.resolve })
    })
    const lifecycle = list(input.lifecycle, 64).map(value => {
      const entry = value as InteractionLifecycleHandlerImplementation
      if (typeof entry.build !== 'function') throw new TypeError('lifecycle handler implementation missing')
      if (!(INTERACTION_LIFECYCLE_PHASES as readonly string[]).includes(entry.phase)) throw new TypeError('unknown lifecycle phase')
      const consumes = refs(entry.consumes, 16)
      const eventTypes = refs(entry.eventTypes, 16)
      if (eventTypes.some(ref => ref.id === 'character.moved')) throw new TypeError('lifecycle cannot own movement')
      return Object.freeze({ lock: lock(entry.lock), phase: entry.phase, consumes: immutable(consumes), eventTypes: immutable(eventTypes), build: entry.build })
    })
    const performances = list(input.performances, 128).map(value => {
      const entry = value as InteractionPerformanceImplementation
      return Object.freeze({ lock: lock(entry.lock), policy: performancePolicy(entry.policy) })
    })
    const definitions = list(input.definitions, 128).map(value => {
      const def = value as InteractionDefinitionImplementation
      return Object.freeze({ spec: definition(def.spec), implementationHash: hash(def.implementationHash) })
    })
    if (packageLock.implementationHash !== interactionPackageHash({ rules, effects, resolvers, lifecycle, performances, definitions })) throw new TypeError('package component lock drift')
    const identities = [key(packageLock.ref), ...rules.map(value => key(value.lock.ref)), ...effects.map(value => key(value.lock.ref)),
      ...resolvers.map(value => key(value.lock.ref)), ...lifecycle.map(value => key(value.lock.ref)),
      ...performances.map(value => key(value.lock.ref)),
      ...definitions.map(value => key({ id: value.spec.id, version: value.spec.version }))]
    if (new Set(identities).size !== identities.length || identities.some(id => this.#identities.has(id))) throw new TypeError('duplicate registration')
    identities.forEach(id => this.#identities.add(id))
    this.#packages.set(key(packageLock.ref), Object.freeze({ lock: packageLock, rules, effects, resolvers, lifecycle, performances, definitions }))
  }

  freeze(input: InteractionWorldSelection): FrozenInteractionWorld {
    object(input, ['address', 'packages', 'definitions', 'bindings'])
    const selection = immutable(input)
    object(selection.address, ['tenantId', 'worldId', 'branchId'])
    worldAddressKey(selection.address)
    const rules = new Map<string, InteractionRuleImplementation>()
    const effects = new Map<string, InteractionEffectImplementation>()
    const handlers = new Map<string, InteractionLifecycleHandlerImplementation>()
    const resolvers = new Map<string, InteractionDerivedResolverImplementation>()
    const performances = new Map<string, InteractionPerformanceImplementation>()
    const definitions = new Map<string, InteractionDefinitionImplementation>()
    const nodes = new Map<string, readonly InteractionRef[]>()
    for (const requested of list(selection.packages, 32)) {
      const selected = lock(requested as InteractionImplementationLock)
      const installed = this.#packages.get(key(selected.ref))
      if (installed === undefined || hashWorldJson('lock', selected) !== hashWorldJson('lock', installed.lock)) throw new TypeError('package missing or lock drift')
      if (nodes.has(key(selected.ref))) throw new TypeError('duplicate package selection')
      nodes.set(key(selected.ref), selected.dependencies)
      for (const rule of installed.rules) { rules.set(key(rule.lock.ref), rule); nodes.set(key(rule.lock.ref), rule.lock.dependencies) }
      for (const effect of installed.effects) { effects.set(key(effect.lock.ref), effect); nodes.set(key(effect.lock.ref), effect.lock.dependencies) }
      for (const entry of installed.resolvers) { resolvers.set(key(entry.lock.ref), entry); nodes.set(key(entry.lock.ref), entry.lock.dependencies) }
      for (const entry of installed.lifecycle) { handlers.set(key(entry.lock.ref), entry); nodes.set(key(entry.lock.ref), entry.lock.dependencies) }
      for (const entry of installed.performances) { performances.set(key(entry.lock.ref), entry); nodes.set(key(entry.lock.ref), entry.lock.dependencies) }
      for (const def of installed.definitions) definitions.set(key({ id: def.spec.id, version: def.spec.version }), def)
    }
    const active = new Map<string, InteractionDefinitionImplementation>()
    for (const value of list(selection.definitions, 128)) {
      const selected = object(value, ['ref', 'definitionHash', 'implementationHash'])
      const id = key(reference(selected.ref))
      const found = definitions.get(id)
      if (found === undefined || hash(selected.definitionHash) !== hashWorldJson('interaction-definition/v1', found.spec) || hash(selected.implementationHash) !== found.implementationHash) throw new TypeError('definition missing or lock drift')
      if (active.has(id)) throw new TypeError('duplicate definition selection')
      for (const ref of [found.spec.authorityPolicyRef, ...found.spec.preconditions, ...found.spec.spatialRequirementRefs]) if (!rules.has(key(ref))) throw new TypeError('rule or spatial capability missing')
      for (const ref of found.spec.effectCapabilityRefs) if (!effects.has(key(ref))) throw new TypeError('effect capability missing')
      for (const role of found.spec.participantRoles) {
        if (role.source.kind === 'derived' && !resolvers.has(key(role.source.resolver))) throw new TypeError('derived resolver missing')
      }
      for (const ref of found.spec.lifecycleRefs) if (!handlers.has(key(ref))) throw new TypeError('lifecycle handler missing')
      const policy = performances.get(key(found.spec.performancePolicyRef))
      if (policy === undefined) throw new TypeError('performance policy missing')
      // A cue that names a role the definition does not declare could describe an object nobody
      // verified, which is exactly how a manifestation would smuggle in an unestablished fact.
      for (const entry of policy.policy.accepted) {
        if (entry.requiresRole !== null && !found.spec.participantRoles.some(role => role.name === entry.requiresRole)) {
          throw new TypeError('performance cue names an undeclared role')
        }
      }
      active.set(id, found); nodes.set(id, definitionDependencies(found.spec))
    }
    const done = new Set<string>(); const visiting = new Set<string>()
    const visit = (id: string): void => {
      if (done.has(id)) return
      if (visiting.has(id)) throw new TypeError('dependency cycle')
      const dependencies = nodes.get(id)
      if (dependencies === undefined) throw new TypeError('dependency not enabled')
      visiting.add(id); dependencies.forEach(ref => visit(key(ref))); visiting.delete(id); done.add(id)
    }
    nodes.forEach((_, id) => visit(id))
    // The frozen order is phase first, then exact handler id. A dependency that would have to run
    // later in that order makes the plan unachievable, so activation refuses it rather than letting
    // the fold run out of order at resolution time.
    const order = [...handlers.values()].sort(compareLifecycleHandlers).map(handler => key(handler.lock.ref))
    const position = new Map(order.map((id, index) => [id, index]))
    for (const id of order) {
      for (const dependency of handlers.get(id)!.lock.dependencies) {
        const other = position.get(key(dependency))
        if (other !== undefined && other > position.get(id)!) throw new TypeError(`lifecycle order is unachievable for ${id}`)
      }
    }
    const bindings = new Map<string, InteractionBindingV3>()
    for (const value of list(selection.bindings, 4096)) {
      const row = object(value, ['bindingId', 'targetRef', 'definitionRef', 'config'])
      const binding = value as InteractionBindingV3
      const def = active.get(key(reference(row.definitionRef)))
      if (def === undefined) throw new TypeError('binding definition not enabled')
      const targetRef = target(row.targetRef)
      if (!def.spec.participantRoles.some(role => role.source.kind === 'primaryTarget' && role.kind === targetRef.kind)) throw new TypeError('binding target kind mismatch')
      if (targetRef.kind === 'relation') {
        // The id names a class, not an instance: the definition whose relations this binding may
        // address. That definition has to be enabled, and it has to actually create relations, or the
        // binding could never address anything and would be a silent no-op in the option list.
        const creator = [...active.values()].find(entry => entry.spec.id === targetRef.id)
        if (creator === undefined) throw new TypeError('relation binding names a definition the world did not enable')
        const creatorEffect = effects.get(key(creator.spec.effectBuilderRef))
        if (creatorEffect === undefined || !creatorEffect.eventTypes.some(entry => entry.id === 'character.relation-started')) {
          throw new TypeError('relation binding names a definition that creates no relation')
        }
      }
      const id = text(row.bindingId)
      if (bindings.has(id)) throw new TypeError('duplicate binding')
      const config = parameters(def.spec.bindingConfigSchema, row.config)
      if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 4096) throw new TypeError('binding config exceeds budget')
      bindings.set(id, binding)
    }
    const canonicalSelection = immutable({ ...selection,
      packages: [...selection.packages].sort((a, b) => compareWorldText(key(a.ref), key(b.ref))),
      definitions: [...selection.definitions].sort((a, b) => compareWorldText(key(a.ref), key(b.ref))),
      bindings: [...selection.bindings].sort((a, b) => compareWorldText(a.bindingId, b.bindingId)),
    })
    return new FrozenInteractionWorld(canonicalSelection, active, bindings, rules, effects, resolvers, handlers, performances)
  }
}

/** No Store or Kernel dependency. Results remain candidates until the Host commits. */
export class FrozenInteractionWorld {
  readonly definitionSetHash: WorldHash

  readonly #worldLifecyclePlan: readonly InteractionLifecycleHandlerImplementation[]

  constructor(
    readonly selection: InteractionWorldSelection,
    private readonly definitions: ReadonlyMap<string, InteractionDefinitionImplementation>,
    private readonly bindings: ReadonlyMap<string, InteractionBindingV3>,
    private readonly rules: ReadonlyMap<string, InteractionRuleImplementation>,
    private readonly effects: ReadonlyMap<string, InteractionEffectImplementation>,
    private readonly resolvers: ReadonlyMap<string, InteractionDerivedResolverImplementation>,
    private readonly handlers: ReadonlyMap<string, InteractionLifecycleHandlerImplementation>,
    private readonly performances: ReadonlyMap<string, InteractionPerformanceImplementation>,
  ) {
    this.definitionSetHash = hashWorldJson('interaction-world-selection/v1', selection)
    // The world fold is the union of every enabled definition's handlers: the Host runs it after an
    // action that belongs to no definition, and each handler decides from the snapshot whether it
    // applies at all.
    this.#worldLifecyclePlan = this.#lifecyclePlan([...definitions.values()].flatMap(entry => entry.spec.lifecycleRefs))
  }

  resolve(inputHost: InteractionHostContext, input: unknown): InteractionAdjudication {
    const host = immutable(inputHost)
    object(host, ['address', 'manifestHash', 'asOfWorldSeq', 'candidatePrefixHash', 'actionId', 'actorId', 'authority', 'targets', 'authorizedTargets'])
    object(host.address, ['tenantId', 'worldId', 'branchId'])
    if (worldAddressKey(host.address) !== worldAddressKey(this.selection.address)) throw new TypeError('interaction WorldAddress mismatch')
    hash(host.manifestHash); hash(host.candidatePrefixHash); integer(host.asOfWorldSeq, 0, Number.MAX_SAFE_INTEGER)
    text(host.actionId); text(host.actorId); validateResolutionAuthority(host.authority)
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('expected closed object')
    const required = ['targetRef', 'bindingId', 'definitionRef', 'arguments']
    const root = object(input, Object.hasOwn(input, 'performance') ? [...required, 'performance'] : required)
    const request = immutable({
      targetRef: target(root.targetRef), bindingId: text(root.bindingId), definitionRef: reference(root.definitionRef),
      arguments: root.arguments, ...(root.performance === undefined ? {} : { performance: root.performance }),
    }) as InteractionRequestV2
    const binding = this.bindings.get(request.bindingId)
    if (binding === undefined || key(binding.definitionRef) !== key(request.definitionRef)) throw new TypeError('request does not match enabled binding')
    const { targets, authorized } = snapshot(host)
    if (!addressesBinding(binding, request.targetRef, host)) throw new TypeError('request does not match enabled binding')
    const def = this.definitions.get(key(binding.definitionRef))!.spec
    const args = parameters(def.argumentSchema, request.arguments)
    const policy = this.performances.get(key(def.performancePolicyRef))!.policy
    const performance = request.performance === undefined ? null : resolvePerformance(policy, request.performance)
    const roles: Record<string, InteractionTargetRef> = {}
    const trace: { rule: InteractionRef; reason: string | null }[] = []
    const finish = (reason: string, events: InteractionAdjudication['events'] = [], accepted: InteractionPerformance | null = null): InteractionAdjudication => {
      const resolvedRoleBindingsHash = hashWorldJson('interaction-role-bindings/v1', roles)
      const data = { status: reason === 'accepted' ? 'accepted' as const : 'rejected' as const, reason, events, definitionSetHash: this.definitionSetHash, resolvedRoleBindingsHash, trace, performance: accepted }
      return immutable({ ...data, ruleTraceHash: hashWorldJson('interaction-rule-trace/v1', { ...data, address: host.address, manifestHash: host.manifestHash, asOfWorldSeq: host.asOfWorldSeq, candidatePrefixHash: host.candidatePrefixHash, actionId: host.actionId, actorId: host.actorId, authority: host.authority, request }) })
    }
    const plan = this.#plan(host, def, binding, request.targetRef, args, targets, authorized, roles, trace)
    if (plan !== null) {
      // independent expression holds for the attempt itself, and the frozen step rule keeps it when
      // the action fails; only onSuccess is cancelled. Erasing both would deny what the character
      // visibly did while trying.
      return finish(plan, [], performance !== null && performance.independent.length > 0
        ? { independent: performance.independent, onSuccess: [] }
        : null)
    }
    const effect = this.effects.get(key(def.effectBuilderRef))!
    // The execution context deliberately excludes `performance`: a manifestation that reached an
    // effect builder could shape world state, and the whole point is that it cannot.
    const events = immutable(effect.build(immutable({ host, definition: def, binding, arguments: args, roles })))
    list(events, def.limits.maximumEvents)
    if (events.length === 0) throw new TypeError('effect produced no event')
    for (const event of events) {
      object(event, ['eventType', 'eventVersion', 'data'])
      if (!effect.eventTypes.some(ref => ref.id === event.eventType && ref.version === event.eventVersion)) throw new TypeError('effect exceeded event closure')
    }
    const resolved = immutable({ host, definition: def, binding, arguments: args, roles })
    effect.validate(resolved, events)
    // The fold runs only after the action's own candidate exists, and every step sees what the steps
    // before it produced. Each handler runs at most once per fold, so "once per handler, instance and
    // source event" holds by construction rather than by a visited set.
    return finish('accepted', this.#fold(host, this.#lifecyclePlan(def.lifecycleRefs), events, def.limits.maximumEvents), performance)
  }

  /**
   * Run the frozen phase plan over a candidate event set. Each handler runs at most once per fold,
   * which holds by construction because the plan is a set sorted once. A handler that adds nothing
   * leaves the candidates untouched rather than re-emitting them.
   */
  #fold(host: InteractionHostContext, plan: readonly InteractionLifecycleHandlerImplementation[],
    events: readonly WorldEventDraft[], maximumEvents: number): readonly WorldEventDraft[] {
    if (plan.length > MAXIMUM_LIFECYCLE_CALLS) throw new TypeError('lifecycle fold exceeds the budget')
    let folded = events
    for (const handler of plan) {
      // The handler sees only the instances its own definitions created. Everything that is not a
      // relation passes through: it may need the characters and items around them.
      // Compared by definition id: a relation instance records the id that created it, not a version,
      // and the instance can only exist because the Host already admitted that exact compiled definition.
      const consumed = new Set(handler.consumes.map(entry => reference(entry).id))
      const scoped = immutable({ ...host, targets: host.targets.filter(entry => entry.ref.kind !== 'relation'
        || (typeof entry.state.interactionId === 'string' && consumed.has(entry.state.interactionId))) })
      const added = immutable(handler.build(immutable({ host: scoped, events: folded })))
      list(added, maximumEvents)
      for (const event of added) {
        object(event, ['eventType', 'eventVersion', 'data'])
        if (!handler.eventTypes.some(ref => ref.id === event.eventType && ref.version === event.eventVersion)) {
          throw new TypeError(`lifecycle handler ${key(handler.lock.ref)} exceeded its event closure`)
        }
        if (event.eventType === 'character.relation-ended') {
          const data = event.data as WorldJsonObject
          const inside = scoped.targets.some(entry => entry.ref.kind === 'relation' && entry.ref.id === data.relationId)
          if (!inside) throw new TypeError(`lifecycle handler ${key(handler.lock.ref)} ended a relation outside its declared scope`)
        }
      }
      if (added.length > 0) {
        folded = immutable([...folded, ...added])
        // Each handler stayed inside its own bound, but the group is what the profile caps. A fold that
        // stopped at its own step budget would still hand back a candidate set nobody authorized.
        if (folded.length > MAXIMUM_TOTAL_LIFECYCLE_EVENTS) throw new TypeError('lifecycle fold exceeds the total event budget')
      }
    }
    return folded
  }

  /**
   * The handlers a set of references reaches, in the frozen order. Only handler dependencies join the
   * closure: a rule or effect a handler happens to share is not a fold step.
   */
  #lifecyclePlan(refs: readonly InteractionRef[]): readonly InteractionLifecycleHandlerImplementation[] {
    const selected = new Map<string, InteractionLifecycleHandlerImplementation>()
    const collect = (handler: InteractionLifecycleHandlerImplementation): void => {
      const id = key(handler.lock.ref)
      if (selected.has(id)) return
      selected.set(id, handler)
      for (const dependency of handler.lock.dependencies) {
        const next = this.handlers.get(key(dependency))
        if (next !== undefined) collect(next)
      }
    }
    for (const ref of refs) collect(this.handlers.get(key(ref))!)
    return [...selected.values()].sort(compareLifecycleHandlers)
  }

  /**
   * Whether a submitted argument object is well-formed for the definition a binding selects. The Host
   * asks this at its own request boundary, so a malformed proposal becomes a rejection there instead of
   * an exception from inside adjudication. It applies the same frozen schema `resolve` validates
   * against, and it touches no rule and no effect.
   */
  acceptsArguments(bindingId: string, value: unknown): boolean {
    const binding = this.bindings.get(bindingId)
    if (binding === undefined) return false
    const def = this.definitions.get(key(binding.definitionRef))!.spec
    try {
      parameters(def.argumentSchema, value)
      return true
    } catch { return false }
  }

  /**
   * Run the world's fold outside any interaction. A move is not an interaction, yet it ends relations
   * whose participants left each other's reach, so the Host runs this after such an action and hands
   * in the post-action snapshot.
   */
  fold(inputHost: InteractionHostContext, events: readonly WorldEventDraft[]): readonly WorldEventDraft[] {
    const host = immutable(inputHost)
    object(host, ['address', 'manifestHash', 'asOfWorldSeq', 'candidatePrefixHash', 'actionId', 'actorId', 'authority', 'targets', 'authorizedTargets'])
    object(host.address, ['tenantId', 'worldId', 'branchId'])
    if (worldAddressKey(host.address) !== worldAddressKey(this.selection.address)) throw new TypeError('interaction WorldAddress mismatch')
    hash(host.manifestHash); hash(host.candidatePrefixHash); integer(host.asOfWorldSeq, 0, Number.MAX_SAFE_INTEGER)
    text(host.actionId); text(host.actorId); validateResolutionAuthority(host.authority)
    snapshot(host)
    list(events, MAXIMUM_LIFECYCLE_EVENTS)
    return this.#fold(host, this.#worldLifecyclePlan, immutable(events), MAXIMUM_LIFECYCLE_EVENTS)
  }

  /**
   * Run the same rule plan the adjudication runs, without touching effects. It fills `roles` with
   * whatever it resolved and `trace` with the rule results, and returns the rejection reason or
   * null. Effects are never called: enumeration must not write state or mint relation identities.
   */
  #plan(
    host: InteractionHostContext,
    def: InteractionDefinitionSpec,
    binding: InteractionBindingV3,
    targetRef: InteractionTargetRef,
    args: WorldJsonObject,
    targets: ReadonlySet<string>,
    authorized: ReadonlySet<string>,
    roles: Record<string, InteractionTargetRef>,
    trace: { rule: InteractionRef; reason: string | null }[],
  ): string | null {
    for (const role of def.participantRoles) {
      if (role.source.kind === 'derived') continue
      const ref = role.source.kind === 'hostActor' ? { kind: role.kind, id: host.actorId }
        : role.source.kind === 'primaryTarget' ? targetRef : { kind: role.kind, id: text(args[role.source.field]) }
      roles[role.name] = ref
      if (!targets.has(targetKey(ref)) || (role.source.kind !== 'hostActor' && !authorized.has(targetKey(ref)))) return 'PARTICIPANT_NOT_AUTHORIZED'
    }
    // Derived roles come second, in declaration order, so a resolver sees only roles already bound
    // and the resolution stays deterministic without needing a cycle check.
    for (const role of def.participantRoles) {
      if (role.source.kind !== 'derived') continue
      const resolved = this.resolvers.get(key(role.source.resolver))!.resolve(
        immutable({ host, definition: def, binding, arguments: args, roles: { ...roles } }),
      )
      if (resolved === null) return 'PARTICIPANT_NOT_AUTHORIZED'
      const ref = target(resolved)
      roles[role.name] = ref
      // A derived role is a fact of a relation the Host already put in the snapshot, never a target
      // the request names, so the snapshot is the control here. Demanding authorization as well
      // would exclude the actor itself, which a Host never lists among the targets it authorizes.
      if (!targets.has(targetKey(ref))) return 'PARTICIPANT_NOT_AUTHORIZED'
    }
    for (const role of def.participantRoles) {
      if (role.distinctFrom.some(other => targetKey(roles[other]!) === targetKey(roles[role.name]!))) return 'PARTICIPANT_ALIAS_FORBIDDEN'
    }
    const context: InteractionExecutionContext = immutable({ host, definition: def, binding, arguments: args, roles })
    for (const ref of [def.authorityPolicyRef, ...def.spatialRequirementRefs, ...def.preconditions]) {
      const reason = this.rules.get(key(ref))!.check(context)
      if (reason !== null) { text(reason); if (reason === 'accepted') throw new TypeError('reserved rejection reason') }
      trace.push({ rule: ref, reason })
      if (reason !== null) return reason
    }
    return null
  }

  /**
   * One character's view. Visible characters, visible items and attemptable options are separate
   * sets; an option is listed only when the same public rule plan the adjudication uses accepts it.
   * The result is a proposal set, never an authorization: adjudication re-verifies the latest prefix.
   */
  view(input: InteractionViewContext): InteractionCharacterView {
    const context = immutable(input)
    object(context, ['address', 'manifestHash', 'asOfWorldSeq', 'characterId', 'authority', 'candidatePrefixHash', 'targets', 'authorizedTargets', 'viewPolicyHash'])
    object(context.address, ['tenantId', 'worldId', 'branchId'])
    if (worldAddressKey(context.address) !== worldAddressKey(this.selection.address)) throw new TypeError('interaction WorldAddress mismatch')
    hash(context.manifestHash); hash(context.candidatePrefixHash); hash(context.viewPolicyHash)
    integer(context.asOfWorldSeq, 0, Number.MAX_SAFE_INTEGER)
    text(context.characterId); validateResolutionAuthority(context.authority)
    const host: InteractionHostContext = immutable({
      address: context.address, manifestHash: context.manifestHash, asOfWorldSeq: context.asOfWorldSeq,
      candidatePrefixHash: context.candidatePrefixHash, actionId: 'action:affordance-only', actorId: context.characterId,
      authority: context.authority, targets: context.targets, authorizedTargets: context.authorizedTargets,
    })
    const { targets, authorized } = snapshot(host)
    const authorizedRefs = list(context.authorizedTargets, 4096).map(value => target(value))
    const characters: InteractionTargetRef[] = []
    const items: InteractionTargetRef[] = []
    for (const entry of list(context.targets, 4096)) {
      const row = object(entry, ['ref', 'state'])
      const ref = target(row.ref)
      if (ref.kind === 'character') characters.push(ref)
      if (ref.kind === 'entity') items.push(ref)
    }
    const candidates: InteractionViewOption[] = []
    for (const binding of this.bindings.values()) {
      const addressable = bindingTargets(binding, host, authorized)
      if (addressable.length === 0) continue
      const def = this.definitions.get(key(binding.definitionRef))!.spec
      for (const targetRef of addressable) {
        for (const args of argumentCombinations(def, authorizedRefs)) {
          const roles: Record<string, InteractionTargetRef> = {}
          if (this.#plan(host, def, binding, targetRef, args, targets, authorized, roles, []) !== null) continue
          candidates.push({ targetRef, bindingId: binding.bindingId, definitionRef: binding.definitionRef, arguments: args })
        }
      }
    }
    const ordered = [...candidates].sort(compareViewOptions)
    const options = ordered.slice(0, MAXIMUM_VIEW_OPTIONS)
    // The model has to be told what each offered definition accepts as a manifestation, otherwise
    // the generated schema would have to either omit the field or guess.
    const offered = new Map<string, InteractionRef>()
    for (const option of options) offered.set(key(option.definitionRef), option.definitionRef)
    const performances = [...offered.values()]
      .sort((left, right) => compareWorldText(key(left), key(right)))
      .map(definitionRef => ({
        definitionRef,
        accepted: this.performances.get(key(this.definitions.get(key(definitionRef))!.spec.performancePolicyRef))!.policy.accepted,
      }))
    const view: InteractionCharacterView = {
      version: 'interaction-view/v1',
      address: context.address,
      characterId: context.characterId,
      asOfWorldSeq: context.asOfWorldSeq,
      manifestHash: context.manifestHash,
      viewPolicyHash: context.viewPolicyHash,
      definitionSetHash: this.definitionSetHash,
      characters: characters.sort(compareTargets),
      items: items.sort(compareTargets),
      options,
      performances,
      candidateCount: ordered.length,
      selectedAffordanceHash: hashWorldJson('interaction-affordance/v1', {
        definitionSetHash: this.definitionSetHash, characterId: context.characterId,
        asOfWorldSeq: context.asOfWorldSeq, candidatePrefixHash: context.candidatePrefixHash,
        viewPolicyHash: context.viewPolicyHash, options,
      }),
    }
    return immutable(view)
  }
}
