import {
  compareWorldText, hashWorldJson, validateResolutionAuthority, worldAddressKey,
  type InteractionAdjudication, type InteractionBindingV3, type InteractionDefinitionImplementation,
  type InteractionDefinitionSpec, type InteractionEffectImplementation, type InteractionExecutionContext,
  type InteractionHostContext, type InteractionImplementationLock, type InteractionPackageImplementation,
  type InteractionRef, type InteractionRequestV2, type InteractionRuleImplementation, type InteractionTargetRef,
  type InteractionWorldSelection, type WorldHash,
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

function definition(value: InteractionDefinitionSpec): InteractionDefinitionSpec {
  object(value, ['versionTag', 'id', 'version', 'participantRoles', 'argumentSchema', 'bindingConfigSchema', 'authorityPolicyRef', 'preconditions', 'spatialRequirementRefs', 'effectBuilderRef', 'effectCapabilityRefs', 'dependencyRefs', 'limits'])
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
    const source = role.source as { kind: string; field?: string }
    if (source?.kind === 'hostActor') {
      object(source, ['kind']); actors++
      if (name !== 'actor' || role.kind !== 'character') throw new TypeError('actor role must bind Host character')
    } else if (source?.kind === 'primaryTarget') { object(source, ['kind']); primary++ }
    else if (source?.kind === 'argument') {
      object(source, ['kind', 'field'])
      if (!value.argumentSchema.fields.some(field => field.name === source.field && field.type === 'string')) throw new TypeError('role argument must name a string field')
    } else throw new TypeError('unsupported role source in I1')
    const distinct = list(role.distinctFrom, 8).map(text)
    if (new Set(distinct).size !== distinct.length || distinct.includes(name)) throw new TypeError('invalid distinct roles')
  }
  if (actors !== 1 || primary !== 1) throw new TypeError('one actor and primary target required')
  for (const role of value.participantRoles) if (role.distinctFrom.some(name => !names.has(name))) throw new TypeError('unknown distinct role')
  reference(value.authorityPolicyRef); reference(value.effectBuilderRef)
  refs(value.preconditions, 16); refs(value.spatialRequirementRefs, 16); refs(value.effectCapabilityRefs, 16); refs(value.dependencyRefs, 64)
  if (!value.effectCapabilityRefs.some(ref => key(ref) === key(value.effectBuilderRef))) throw new TypeError('effect capability missing')
  object(value.limits, ['maximumEvents']); integer(value.limits.maximumEvents, 1, 16)
  return immutable(value)
}

function definitionDependencies(spec: InteractionDefinitionSpec): readonly InteractionRef[] {
  return [spec.authorityPolicyRef, ...spec.preconditions, ...spec.spatialRequirementRefs, spec.effectBuilderRef, ...spec.effectCapabilityRefs, ...spec.dependencyRefs]
}

/** Published package contract binds every component lock and definition description. */
export function interactionPackageHash(input: Omit<InteractionPackageImplementation, 'lock'>): WorldHash {
  const ordered = <T>(values: readonly T[], id: (value: T) => string): T[] => [...values].sort((left, right) => compareWorldText(id(left), id(right)))
  return hashWorldJson('interaction-package-implementation/v1', {
    rules: ordered(input.rules, rule => key(rule.lock.ref)).map(rule => rule.lock),
    effects: ordered(input.effects, effect => key(effect.lock.ref)).map(effect => ({ lock: effect.lock, eventTypes: effect.eventTypes })),
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
    const definitions = list(input.definitions, 128).map(value => {
      const def = value as InteractionDefinitionImplementation
      return Object.freeze({ spec: definition(def.spec), implementationHash: hash(def.implementationHash) })
    })
    if (packageLock.implementationHash !== interactionPackageHash({ rules, effects, definitions })) throw new TypeError('package component lock drift')
    const identities = [key(packageLock.ref), ...rules.map(value => key(value.lock.ref)), ...effects.map(value => key(value.lock.ref)), ...definitions.map(value => key({ id: value.spec.id, version: value.spec.version }))]
    if (new Set(identities).size !== identities.length || identities.some(id => this.#identities.has(id))) throw new TypeError('duplicate registration')
    identities.forEach(id => this.#identities.add(id))
    this.#packages.set(key(packageLock.ref), Object.freeze({ lock: packageLock, rules, effects, definitions }))
  }

  freeze(input: InteractionWorldSelection): FrozenInteractionWorld {
    object(input, ['address', 'packages', 'definitions', 'bindings'])
    const selection = immutable(input)
    object(selection.address, ['tenantId', 'worldId', 'branchId'])
    worldAddressKey(selection.address)
    const rules = new Map<string, InteractionRuleImplementation>()
    const effects = new Map<string, InteractionEffectImplementation>()
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
    const bindings = new Map<string, InteractionBindingV3>()
    for (const value of list(selection.bindings, 4096)) {
      const row = object(value, ['bindingId', 'targetRef', 'definitionRef', 'config'])
      const binding = value as InteractionBindingV3
      const def = active.get(key(reference(row.definitionRef)))
      if (def === undefined) throw new TypeError('binding definition not enabled')
      const targetRef = target(row.targetRef)
      if (!def.spec.participantRoles.some(role => role.source.kind === 'primaryTarget' && role.kind === targetRef.kind)) throw new TypeError('binding target kind mismatch')
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
    return new FrozenInteractionWorld(canonicalSelection, active, bindings, rules, effects)
  }
}

/** No Store or Kernel dependency. Results remain candidates until the Host commits. */
export class FrozenInteractionWorld {
  readonly definitionSetHash: WorldHash

  constructor(
    readonly selection: InteractionWorldSelection,
    private readonly definitions: ReadonlyMap<string, InteractionDefinitionImplementation>,
    private readonly bindings: ReadonlyMap<string, InteractionBindingV3>,
    private readonly rules: ReadonlyMap<string, InteractionRuleImplementation>,
    private readonly effects: ReadonlyMap<string, InteractionEffectImplementation>,
  ) { this.definitionSetHash = hashWorldJson('interaction-world-selection/v1', selection) }

  resolve(inputHost: InteractionHostContext, input: unknown): InteractionAdjudication {
    const host = immutable(inputHost)
    object(host, ['address', 'manifestHash', 'asOfWorldSeq', 'candidatePrefixHash', 'actionId', 'actorId', 'authority', 'targets', 'authorizedTargets'])
    object(host.address, ['tenantId', 'worldId', 'branchId'])
    if (worldAddressKey(host.address) !== worldAddressKey(this.selection.address)) throw new TypeError('interaction WorldAddress mismatch')
    hash(host.manifestHash); hash(host.candidatePrefixHash); integer(host.asOfWorldSeq, 0, Number.MAX_SAFE_INTEGER)
    text(host.actionId); text(host.actorId); validateResolutionAuthority(host.authority)
    const root = object(input, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
    const request = immutable({ targetRef: target(root.targetRef), bindingId: text(root.bindingId), definitionRef: reference(root.definitionRef), arguments: root.arguments }) as InteractionRequestV2
    const binding = this.bindings.get(request.bindingId)
    if (binding === undefined || targetKey(binding.targetRef) !== targetKey(request.targetRef) || key(binding.definitionRef) !== key(request.definitionRef)) throw new TypeError('request does not match enabled binding')
    const def = this.definitions.get(key(binding.definitionRef))!.spec
    const args = parameters(def.argumentSchema, request.arguments)
    const targets = new Set<string>()
    for (const entry of list(host.targets, 4096)) {
      const row = object(entry, ['ref', 'state'])
      const id = targetKey(target(row.ref))
      if (row.state === null || typeof row.state !== 'object' || Array.isArray(row.state)) throw new TypeError('snapshot state must be an object')
      if (targets.has(id)) throw new TypeError('duplicate snapshot target')
      targets.add(id)
    }
    const authorizationKeys = list(host.authorizedTargets, 4096).map(value => targetKey(target(value)))
    const authorized = new Set(authorizationKeys)
    if (authorized.size !== authorizationKeys.length || authorizationKeys.some(id => !targets.has(id))) throw new TypeError('invalid target authorization set')
    const roles: Record<string, InteractionTargetRef> = {}
    const trace: { rule: InteractionRef; reason: string | null }[] = []
    const finish = (reason: string, events: InteractionAdjudication['events'] = []): InteractionAdjudication => {
      const resolvedRoleBindingsHash = hashWorldJson('interaction-role-bindings/v1', roles)
      const data = { status: reason === 'accepted' ? 'accepted' as const : 'rejected' as const, reason, events, definitionSetHash: this.definitionSetHash, resolvedRoleBindingsHash, trace }
      return immutable({ ...data, ruleTraceHash: hashWorldJson('interaction-rule-trace/v1', { ...data, address: host.address, manifestHash: host.manifestHash, asOfWorldSeq: host.asOfWorldSeq, candidatePrefixHash: host.candidatePrefixHash, actionId: host.actionId, actorId: host.actorId, authority: host.authority, request }) })
    }
    for (const role of def.participantRoles) {
      const ref = role.source.kind === 'hostActor' ? { kind: role.kind, id: host.actorId }
        : role.source.kind === 'primaryTarget' ? request.targetRef : { kind: role.kind, id: text(args[role.source.field]) }
      roles[role.name] = ref
      if (!targets.has(targetKey(ref)) || (role.source.kind !== 'hostActor' && !authorized.has(targetKey(ref)))) return finish('PARTICIPANT_NOT_AUTHORIZED')
    }
    for (const role of def.participantRoles) if (role.distinctFrom.some(other => targetKey(roles[other]!) === targetKey(roles[role.name]!))) return finish('PARTICIPANT_ALIAS_FORBIDDEN')
    const context: InteractionExecutionContext = immutable({ host, definition: def, binding, arguments: args, roles })
    for (const ref of [def.authorityPolicyRef, ...def.spatialRequirementRefs, ...def.preconditions]) {
      const reason = this.rules.get(key(ref))!.check(context)
      if (reason !== null) { text(reason); if (reason === 'accepted') throw new TypeError('reserved rejection reason') }
      trace.push({ rule: ref, reason })
      if (reason !== null) return finish(reason)
    }
    const effect = this.effects.get(key(def.effectBuilderRef))!
    const events = immutable(effect.build(context))
    list(events, def.limits.maximumEvents)
    if (events.length === 0) throw new TypeError('effect produced no event')
    for (const event of events) {
      object(event, ['eventType', 'eventVersion', 'data'])
      if (!effect.eventTypes.some(ref => ref.id === event.eventType && ref.version === event.eventVersion)) throw new TypeError('effect exceeded event closure')
    }
    effect.validate(context, events)
    return finish('accepted', events)
  }
}
