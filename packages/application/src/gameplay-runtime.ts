import { gameplayPresentation } from './gameplay-presentation.ts'
import Ajv, { type ValidateFunction } from 'ajv'
import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import {
  brandId,
  knownStatusView,
  type BusinessRejection,
  type ActionAffordance,
  canonicalizeWorldJson,
  type CharacterId,
  type StatusChange,
  type StatusEventData,
  type StatusTruth,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  resolveSupportedDataVersions,
  type GameplayComputation,
  type GameplayDefinition,
  type GameplayEffect,
  type HostServices,
  type OperationDefinition,
  type OperationResolution,
  type DiceRoll,
  type ActivityHooks,
} from '@harness-world/plugin-sdk'
import {
  callPluginSync,
  createPluginCallContext,
  invalidPluginResult,
  isPluginFault,
  type PluginFaultError,
  type WorldInstanceScope,
} from '@harness-world/runtime-cordis'
import {
  currentLocation,
  type CompiledWorldManifest,
  type RulebookEvent,
  type RulebookResolution,
  type RulebookResolver,
} from '@harness-world/kernel'
import { StatusState, statusObject, statusExact, statusData } from './status-state.ts'
import { statusPlaceView } from './world-view.ts'
import { ActivityStateRules, activityProgress, parseActivityAutoStart } from './activity-state.ts'
import {
  activityUpdatedEvent,
  suspendedActivity,
  resumedActivity,
  abandonedActivity,
  escapedActivity,
  activityNoteObservations,
} from './activity-lifecycle.ts'
import { assertPhysicalEffects, itemIsReachable, adjudicateItemChanges, ruledItemChanges } from './item-effects.ts'
import { parseActivityOperationResult, checkActivityExpression } from './activity-projection.ts'
import {
  admitStatusOperation,
  parseStatusOffers,
  parseStatusOperationResult,
  statusObservationScope,
} from './status-operations.ts'
import { compileOperationContract, GameplayContractError } from './gameplay-contract.ts'
import type { WorldExecutionEngine } from './execution-engine.ts'
import type { WorldRoundEffects, WorldRoundSnapshot } from './world-round-execution.ts'

type RuntimeOperation = OperationDefinition<WorldJsonObject, WorldJsonObject, WorldJsonValue>
type RuntimeDefinition = GameplayDefinition<
  WorldJsonObject,
  readonly RuntimeOperation[],
  WorldJsonObject,
  WorldJsonValue,
  readonly RuntimeOperation[]
>
type Identity = { readonly id: string }
interface Module {
  readonly definition: RuntimeDefinition
  readonly config: WorldJsonObject
  readonly state: StatusState
  readonly keys: ReadonlySet<string>
}
interface Operation {
  readonly module: Module
  readonly definition: RuntimeOperation
  readonly contract: ReturnType<typeof compileOperationContract<WorldJsonObject, WorldJsonObject, WorldJsonValue>>
}
interface Proposal {
  readonly module: Module
  readonly effect: GameplayEffect
}
interface Computation {
  readonly actorId: CharacterId
  readonly events: readonly RulebookEvent[]
  readonly operationId: string
  readonly actionId: string
  readonly recipients: readonly string[]
  readonly provenance: WeakMap<object, Proposal>
  readonly activityKey?: string
  readonly targetId?: string
  presentation?: { description: string; scope: NonNullable<RulebookResolution['observationScope']> }
  readonly resolveSpeech?: (parameters: WorldJsonObject) => readonly WorldEventDraft[]
}

export interface GameplayRuntimeOptions {
  readonly scope: WorldInstanceScope
  readonly manifest: CompiledWorldManifest
  readonly engine: WorldExecutionEngine
  readonly availableServices: readonly (keyof HostServices)[]
  readonly projectWorld?: (events: readonly RulebookEvent[], actorId: string) => WorldJsonObject
  /** Full actor-authorized status for a shared status provider; authored state projections remain owned. */
  readonly projectKnownStatus?: (events: readonly RulebookEvent[], actorId: string) => WorldJsonObject
  readonly rollDice?: (expression: string) => DiceRoll
  /** Application-owned access; no author callback receives either capability. */
  readonly read: () => Promise<WorldRoundSnapshot>
  readonly execute: (
    owner: string,
    actorId: string | undefined,
    work: (snapshot: WorldRoundSnapshot) => WorldRoundEffects | undefined,
  ) => Promise<{ readonly afterSeq: number } | undefined>
}

function copy<T>(value: T): T {
  canonicalizeWorldJson(value as WorldJsonValue)
  return structuredClone(value)
}
function readonlyData<T>(value: T): T {
  const cloned = copy(value)
  const freeze = (part: unknown): void => {
    if (part && typeof part === 'object') {
      for (const child of Object.values(part)) freeze(child)
      Object.freeze(part)
    }
  }
  freeze(cloned)
  return cloned
}
function stableId(value: string): void {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9.:-]{0,159}$/u.test(value))
    throw new TypeError('GAMEPLAY_ID_INVALID: expected a stable identifier')
}
function statusEvents(events: readonly RulebookEvent[], module: Module): RulebookEvent[] {
  return events
    .filter(event => event.eventType === 'status.updated')
    .map(event => {
      const data = statusData(event)
      return {
        ...event,
        data: {
          ...data,
          changes: data.changes.filter(change => module.keys.has(change.key)),
          reveals: data.reveals.filter(reveal => module.keys.has(reveal.key)),
        } as unknown as WorldJsonObject,
      }
    })
}

/** Core-owned registration, projections and synchronous adjudication. It never evaluates script text. */
export class GameplayRuntime {
  readonly #modules = new Map<string, Module>()
  readonly #operations = new Map<string, Operation>()
  readonly #methods = new Map<object, Operation>()
  readonly #activityValidators = new Map<string, ValidateFunction<WorldJsonValue>>()
  readonly #coreOperations: ReadonlySet<string>
  readonly #context
  readonly #disposers: (() => void)[] = []
  #sealed = false
  #initialized = false
  #closed = false
  readonly #completed = new WeakSet<object>()

  constructor(private readonly options: GameplayRuntimeOptions) {
    this.#context = createPluginCallContext(options.scope)
    const catalog =
      options.manifest.interactionCatalog === undefined ? {} : statusObject(options.manifest.interactionCatalog)
    const interactions = Array.isArray(catalog.definitions)
      ? catalog.definitions.map(definition => String(statusObject(statusObject(definition).ref).id))
      : []
    this.#coreOperations = new Set([
      'move',
      'speak',
      'interact',
      'activity:start',
      'activity:suspend',
      'activity:resume',
      'activity:abandon',
      'activity:escape',
      ...interactions,
    ])
  }
  #active(): void {
    this.options.scope.assertActive()
    if (this.#closed) throw new Error('gameplay runtime is closed')
  }
  #world(events: readonly RulebookEvent[], actorId: CharacterId, known = false): WorldJsonObject {
    const world = this.options.projectWorld?.(events, actorId) ?? {
      locationId: currentLocation(events, actorId) ?? null,
    }
    if (known && world.characters) {
      const present = new Set([actorId, ...(Array.isArray(world.characterIds) ? (world.characterIds as string[]) : [])])
      return {
        ...world,
        characters: Object.fromEntries(
          Object.entries(statusObject(world.characters)).filter(([id]) => present.has(id)),
        ) as WorldJsonObject,
      }
    }
    return world
  }
  ownsActivity(key: string): boolean {
    return [...this.#modules.values()].some(module =>
      module.definition.activities?.some(activity => activity.key === key),
    )
  }
  /** Host lifecycle adapters use the same atomic single-layer derivation as public engine calls. */
  deriveActivityControl(
    events: readonly RulebookEvent[],
    actorId: CharacterId,
    operation: string,
    actionId: string,
    main: readonly WorldEventDraft[],
  ): WorldEventDraft[] {
    this.#ready()
    if (operation === 'escape') return []
    if (!['start', 'suspend', 'resume', 'abandon'].includes(operation))
      throw new TypeError('invalid lifecycle operation')
    return this.#derive(
      {
        actorId,
        events,
        operationId: 'activity:' + operation,
        actionId,
        recipients: this.#scene(events, actorId),
        provenance: new WeakMap(),
        ...this.#activityScope(events, actorId),
      },
      main,
      null,
    )
  }
  ownsOperation(id: string): boolean {
    return this.#operations.has(id)
  }
  admitActivityControl(
    events: readonly RulebookEvent[],
    actorId: string,
    operation: string,
    activityKey: string,
  ): void {
    this.#ready()
    if (operation === 'escape') return
    const rejected = this.#restrict(events, brandId(actorId, 'CharacterId'), 'activity:' + operation, { activityKey })
    if (rejected) throw new TypeError(rejected.message)
  }
  /** Projection/lifecycle adapters invoke the same registered definition and plugin boundary. */
  activityHooks(key: string): ActivityHooks {
    const { module, definition } = this.#activity(key)
    const behavior = definition.behavior
    if (!behavior) throw new TypeError('GAMEPLAY_ACTIVITY_BEHAVIOR_MISSING')
    const wrap = <T>(name: string, work: () => T) => this.#call(module, 'activity.' + name, work)
    const owned = (truth: StatusTruth | null) =>
      truth === null
        ? null
        : {
            public: Object.fromEntries(Object.entries(truth.public).filter(([key]) => module.keys.has(key))),
            characters: Object.fromEntries(
              Object.entries(truth.characters).map(([id, value]) => [
                id,
                Object.fromEntries(Object.entries(value).filter(([key]) => module.keys.has(key))),
              ]),
            ),
          }
    return {
      ...behavior,
      initialize: (input, random) =>
        wrap('initialize', () =>
          behavior.initialize(
            {
              ...copy(input),
              ...(input.truth
                ? { truth: owned(input.truth as unknown as StatusTruth) as unknown as WorldJsonValue }
                : {}),
            },
            random,
          ),
        ),
      policy: (state, actor) => wrap('policy', () => behavior.policy(copy(state), actor)),
      resolve: () => {
        throw new Error('registered activity operations require GameplayRuntime.adjudicate')
      },
      onPublished: () => null,
      schedule: state => wrap('schedule', () => behavior.schedule(copy(state))),
      onOutcome: (result, state) => wrap('onOutcome', () => behavior.onOutcome(copy(result), copy(state))),
      ...(behavior.simulate
        ? {
            simulate: (request: Parameters<NonNullable<ActivityHooks['simulate']>>[0]) =>
              wrap('simulate', () => behavior.simulate!(copy(request))),
          }
        : {}),
      ...(behavior.autoStart
        ? {
            autoStart: (truth, world, previous) =>
              wrap('autoStart', () => behavior.autoStart!(owned(copy(truth)), copy(world), copy(previous))),
          }
        : {}),
      ...(behavior.resume
        ? { resume: (state, world) => wrap('resume', () => behavior.resume!(copy(state), copy(world))) }
        : {}),
    }
  }
  #call<T>(module: Module, operation: string, work: () => T): T {
    this.#active()
    return callPluginSync(this.#context, module.definition.id, operation, () => {
      const result = work()
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof Reflect.get(result, 'then') === 'function'
      ) {
        // Native adjudication is synchronous. Observe a rejected async result without accepting it.
        void Promise.resolve(result).catch(() => {})
        throw invalidPluginResult(this.#context, module.definition.id, operation)
      }
      return result
    })
  }

  register<
    TState extends WorldJsonObject,
    const TOperations extends readonly Identity[],
    TConfig extends WorldJsonObject,
    TOutcome extends WorldJsonValue,
    const TMethods extends readonly Identity[] = readonly [],
  >(
    definition: GameplayDefinition<TState, TOperations, TConfig, TOutcome, TMethods>,
    config: TConfig,
    context: Context = this.options.scope.context,
  ): () => void {
    this.#active()
    if (this.#sealed) throw new Error('gameplay assembly has completed')
    const filter: unknown = Reflect.get(this.options.scope.context, Context.filter)
    if (typeof filter !== 'function' || !filter(context) || context.fiber.uid === null)
      throw new TypeError('registration context belongs to another world instance')
    stableId(definition.id)
    resolveSupportedDataVersions(definition, definition.id)
    if (this.#modules.has(definition.id)) throw new TypeError('GAMEPLAY_DUPLICATE_MODULE: ' + definition.id)
    const ajv = new Ajv({ strict: true, coerceTypes: false, removeAdditional: false })
    if (!ajv.compile(definition.configSchema)(config)) throw new TypeError('GAMEPLAY_CONFIG_INVALID: ' + definition.id)
    if (definition.requiredServices.some(service => !this.options.availableServices.includes(service)))
      throw new TypeError('GAMEPLAY_SERVICE_MISSING: ' + definition.id)
    // Heterogeneous callbacks are erased only at this checked registration boundary. Author tuples remain typed.
    const raw = definition as unknown as RuntimeDefinition
    const data: RuntimeDefinition = {
      ...raw,
      states: copy(raw.states ?? []),
      activities: (raw.activities ?? []).map(activity => ({
        ...activity,
        operations: copy(activity.operations),
        resultSchema: copy(activity.resultSchema),
        ...(activity.behavior
          ? {
              behavior: {
                ...activity.behavior,
                definition: copy(activity.behavior.definition),
                ...(activity.behavior.phases ? { phases: copy(activity.behavior.phases) } : {}),
              },
            }
          : {}),
      })),
      ...(raw.physicalEffects ? { physicalEffects: copy(raw.physicalEffects) } : {}),
      ...(raw.statusPolicy
        ? {
            statusPolicy: {
              ...raw.statusPolicy,
              characterIds: copy(raw.statusPolicy.characterIds),
              operations: copy(raw.statusPolicy.operations),
            },
          }
        : {}),
      operations: raw.operations.map(operation => ({
        ...operation,
        argumentSchema: copy(operation.argumentSchema),
        resultSchema: copy(operation.resultSchema),
        ...(operation.npc ? { npc: { ...operation.npc } } : {}),
        ...(operation.status ? { status: copy(operation.status) } : {}),
      })),
      methods: raw.methods ?? [],
      restrictions: (raw.restrictions ?? []).map(rule => ({ ...rule, operations: copy(rule.operations) })),
      wakeupSources: (raw.wakeupSources ?? []).map(source => ({ id: source.id, nominate: source.nominate })),
    }
    const module: Module = {
      definition: data,
      config: copy(config),
      state: new StatusState(
        { statuses: data.states, operations: data.statusPolicy?.operations ?? [] },
        this.options.manifest.characters.map(row => row.characterId),
        this.options.manifest.entities,
        this.options.manifest.locations.map(row => row.locationId),
      ),
      keys: new Set(data.states!.map(state => state.key)),
    }
    if (module.keys.size && !data.initializeState) throw new TypeError('GAMEPLAY_INITIALIZER_MISSING: ' + data.id)
    const priorKeys = new Set([...this.#modules.values()].flatMap(value => [...value.keys]))
    if (
      data.statusPolicy?.characterIds.some(id => !this.options.manifest.characters.some(row => row.characterId === id))
    )
      throw new TypeError('GAMEPLAY_STATUS_ACTOR_MISSING')
    for (const operation of data.operations)
      if (operation.status && !module.state.operations.some(value => value.id === operation.status!.operationId))
        throw new TypeError('GAMEPLAY_STATUS_OPERATION_MISSING')
    if ([...module.keys].some(key => priorKeys.has(key))) throw new TypeError('GAMEPLAY_DUPLICATE_STATE')
    const oldActivities = new Set(
      [...this.#modules.values()].flatMap(value => (value.definition.activities ?? []).map(activity => activity.key)),
    )
    const activityKeys = (data.activities ?? []).map(activity => activity.key)
    if (new Set(activityKeys).size !== activityKeys.length || activityKeys.some(key => oldActivities.has(key)))
      throw new TypeError('GAMEPLAY_DUPLICATE_ACTIVITY')
    const activityValidators = (data.activities ?? []).map(
      activity => [activity.key, ajv.compile<WorldJsonValue>(activity.resultSchema)] as const,
    )
    const oldRules = new Set(
      [...this.#modules.values()].flatMap(value => (value.definition.restrictions ?? []).map(rule => rule.id)),
    )
    const rules = (data.restrictions ?? []).map(rule => rule.id)
    if (new Set(rules).size !== rules.length || rules.some(id => oldRules.has(id)))
      throw new TypeError('GAMEPLAY_DUPLICATE_RESTRICTION')
    for (const rule of data.restrictions ?? []) stableId(rule.id)
    const existingWakeups = new Set(this.options.engine.wakeupSources().map(source => source.id))
    const wakeupIds = (data.wakeupSources ?? []).map(source => source.id)
    for (const source of data.wakeupSources ?? []) {
      stableId(source.id)
      if (typeof source.nominate !== 'function') throw new TypeError('GAMEPLAY_WAKEUP_INVALID: ' + source.id)
    }
    if (new Set(wakeupIds).size !== wakeupIds.length || wakeupIds.some(id => existingWakeups.has(id)))
      throw new TypeError('GAMEPLAY_DUPLICATE_WAKEUP_SOURCE')
    const ids = [...data.operations, ...(data.methods ?? [])].map(operation => operation.id)
    if (ids.some(id => typeof id !== 'string' || !/[.:]/u.test(id)))
      throw new TypeError('GAMEPLAY_OPERATION_ID_INVALID: expected a namespace')
    if (
      new Set(ids).size !== ids.length ||
      ids.some(id => this.#coreOperations.has(id)) ||
      ids.some(
        id => this.#operations.has(id) || [...this.#methods.values()].some(method => method.definition.id === id),
      )
    )
      throw new TypeError('GAMEPLAY_DUPLICATE_OPERATION')
    const operations = data.operations.map(operation => {
      stableId(operation.id)
      return { module, definition: operation, contract: compileOperationContract(operation) }
    })
    const methods = (raw.methods ?? []).map(operation => {
      stableId(operation.id)
      return [
        operation,
        { module, definition: { ...operation }, contract: compileOperationContract(operation) },
      ] as const
    })
    const issues = this.#call(
      module,
      'validateConfig',
      () =>
        data.validateConfig?.({
          config: readonlyData(module.config),
          entities: [
            ...this.options.manifest.characters.map(row => ({ id: row.characterId, kind: 'character' })),
            ...this.options.manifest.locations.map(row => ({ id: row.locationId, kind: 'location' })),
            ...this.options.manifest.entities.map(row => ({ id: row.entityId, kind: 'entity' })),
          ],
        }) ?? [],
    )
    if (!Array.isArray(issues) || issues.length) throw new TypeError('GAMEPLAY_CONFIG_REJECTED: ' + data.id)
    this.#modules.set(data.id, module)
    for (const [key, validate] of activityValidators) this.#activityValidators.set(key, validate)
    for (const operation of operations) this.#operations.set(operation.definition.id, operation)
    for (const [reference, method] of methods) this.#methods.set(reference, method)
    const unhook = data.onCycleEnd
      ? this.options.engine.registerCoreCycleEndHook({
          pluginId: data.id,
          hookId: 'gameplay',
          resolve: (snapshot, cycleId) => {
            this.#ready()
            // The engine may already have captured its hook list before this registration was revoked.
            if (this.#modules.get(data.id) !== module) return undefined
            const owned = this.#truth(module, snapshot.events)
            const effects = this.#call(module, 'onCycleEnd', () =>
              data.onCycleEnd!({
                cycleId,
                state: readonlyData(owned),
                activities: readonlyData(this.#ownedActivities(module, snapshot.events)),
                actors: readonlyData(
                  Object.fromEntries(
                    this.options.manifest.characters.map(row => [
                      row.characterId,
                      this.#project(module, snapshot.events, row.characterId),
                    ]),
                  ),
                ),
              }),
            )
            const computation: Computation = {
              actorId: this.#player(),
              events: snapshot.events,
              operationId: 'cycle:end',
              actionId: cycleId,
              recipients: this.options.manifest.characters.map(row => row.characterId),
              provenance: new WeakMap(),
            }
            const events = this.#effects(this.#proposals(module, effects, computation), computation, true)
            this.#invariants([...snapshot.events, ...events])
            return events.length
              ? { events, authority: { source: 'gameplay-cycle', pluginId: data.id, cycleId } }
              : undefined
          },
        })
      : () => {}
    const unwakeups = (data.wakeupSources ?? []).map(source =>
      this.options.engine.registerWakeupSource({
        id: source.id,
        nominate: input => {
          this.#ready()
          if (this.#modules.get(data.id) !== module) return []
          return this.#call(module, 'wakeup:' + source.id, () => source.nominate(readonlyData(input)))
        },
      }),
    )
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      unhook()
      for (const unwakeup of unwakeups) unwakeup()
      this.#modules.delete(data.id)
      for (const key of activityKeys) this.#activityValidators.delete(key)
      for (const operation of operations) this.#operations.delete(operation.definition.id)
      for (const [reference] of methods) this.#methods.delete(reference)
    }
    this.#disposers.push(dispose)
    context.effect(() => dispose)
    return dispose
  }

  #player(): CharacterId {
    const player = this.options.manifest.playerBindings[0]?.characterId
    if (!player) throw new TypeError('GAMEPLAY_PLAYER_BINDING_MISSING')
    return player
  }
  #truth(module: Module, events: readonly RulebookEvent[]): StatusTruth {
    const truth = module.state.truth(statusEvents(events, module))
    for (const character of this.options.manifest.characters) truth.characters[character.characterId] ??= {}
    return truth
  }
  #ownedActivities(module: Module, events: readonly RulebookEvent[]) {
    const keys = new Set((module.definition.activities ?? []).map(definition => definition.key))
    return Object.fromEntries([...activityProgress(events)].filter(([key]) => keys.has(key)))
  }
  #project(module: Module, events: readonly RulebookEvent[], actorId: CharacterId, known = false): WorldJsonObject {
    let truth = this.#truth(module, events)
    if (known) {
      truth = { public: {}, characters: { [actorId]: {} } }
      for (const entry of module.state.known(statusEvents(events, module), actorId)) {
        if (entry.holderId === null) truth.public[entry.key] = entry.value
        else (truth.characters[entry.holderId] ??= {})[entry.key] = entry.value
      }
    }
    return this.#call(module, 'projectState', () =>
      copy(
        module.definition.projectState
          ? module.definition.projectState({ actorId, state: readonlyData(truth) })
          : { ...truth.public, ...truth.characters[actorId] },
      ),
    )
  }
  #scene(events: readonly RulebookEvent[], actorId: CharacterId): string[] {
    const location = currentLocation(events, actorId)
    return this.options.manifest.characters
      .filter(
        row =>
          row.characterId === actorId ||
          (location !== undefined && currentLocation(events, row.characterId) === location),
      )
      .map(row => row.characterId)
  }
  #invariants(events: readonly RulebookEvent[]): void {
    for (const module of this.#modules.values())
      this.#call(module, 'validateState', () =>
        module.definition.validateState?.(
          readonlyData(this.#truth(module, events)),
          readonlyData(this.#ownedActivities(module, events)),
        ),
      )
  }
  validateCandidate(events: readonly RulebookEvent[]): void {
    this.#active()
    for (const module of this.#modules.values()) {
      module.state.validateSnapshot(statusEvents(events, module))
      for (const activity of module.definition.activities ?? []) {
        if (activity.behavior)
          new ActivityStateRules(
            activity.behavior.definition,
            this.#player(),
            activity.key,
            activity.behavior.phases,
          ).state(events)
      }
    }
    this.#invariants(events)
  }

  async initialize(): Promise<void> {
    this.#active()
    const knownOperations = new Set([...this.#coreOperations, ...this.#operations.keys()])
    for (const module of this.#modules.values()) {
      for (const rule of module.definition.restrictions ?? [])
        if (rule.operations.some(id => !knownOperations.has(id)))
          throw new TypeError('GAMEPLAY_RESTRICTION_TARGET_MISSING: ' + rule.id)
      for (const operation of [...module.definition.operations, ...(module.definition.methods ?? [])])
        if (operation.activity) {
          const binding = this.#activity(operation.activity.key)
          if (
            binding.module !== module ||
            !binding.definition.operations.some(item => item.id === operation.activity!.operationId)
          )
            throw new TypeError('GAMEPLAY_ACTIVITY_OPERATION_OWNER_MISMATCH')
        }
    }
    this.#sealed = true
    await this.options.execute('gameplay-initial:' + randomUUID(), undefined, snapshot => {
      const events: WorldEventDraft[] = []
      for (const module of this.#modules.values()) {
        if (!module.keys.size) continue
        const truth = this.#truth(module, snapshot.events)
        const existing =
          Object.keys(truth.public).length +
          Object.values(truth.characters).reduce((sum, own) => sum + Object.keys(own).length, 0)
        const expected = module.state.statuses.reduce(
          (sum, status) => sum + (status.owner === 'public' ? 1 : this.options.manifest.characters.length),
          0,
        )
        if (existing && existing !== expected)
          throw new TypeError('GAMEPLAY_STATE_INCOMPLETE: committed values cannot be reinitialized')
        if (!existing)
          events.push(
            this.#call(module, 'initializeState', () =>
              module.state.initialEvent(
                module.definition.initializeState!({
                  playerId: this.#player(),
                  characterIds: this.options.manifest.characters.map(row => row.characterId),
                  config: readonlyData(module.config),
                }),
              ),
            ),
          )
      }
      for (const module of this.#modules.values())
        this.#call(module, 'validateRecoveredState', () =>
          module.state.validateSnapshot(statusEvents([...snapshot.events, ...events], module)),
        )
      this.#invariants([...snapshot.events, ...events])
      this.validateCandidate([...snapshot.events, ...events])
      return events.length ? { events, authority: { source: 'native-gameplay-initial' } } : undefined
    })
    this.#initialized = true
  }

  #ready(): void {
    this.#active()
    if (!this.#initialized) throw new Error('gameplay initialization has not completed')
  }
  #principal(principalId: string): CharacterId {
    this.#ready()
    const player = this.options.manifest.playerBindings.find(
      binding => binding.principalId === principalId,
    )?.characterId
    if (!player) throw new TypeError('principal is not bound to this world')
    return player
  }
  #activity(key: string) {
    for (const module of this.#modules.values()) {
      const definition = module.definition.activities?.find(activity => activity.key === key)
      if (definition) return { module, definition }
    }
    throw new TypeError('GAMEPLAY_ACTIVITY_MISSING: ' + key)
  }
  #activityAdmission(operation: Operation, events: readonly RulebookEvent[], actorId: CharacterId): string | undefined {
    const binding = operation.definition.activity
    if (!binding) return undefined
    const { definition } = this.#activity(binding.key)
    const declared = definition.operations.find(item => item.id === binding.operationId)
    if (!declared) throw new TypeError('GAMEPLAY_ACTIVITY_OPERATION_MISSING')
    const state = activityProgress(events).get(binding.key)
    if (
      !state?.game.active ||
      !state.participants.includes(actorId) ||
      (declared.requiresTurn && state.game.turn !== actorId)
    )
      return '尚未轮到你或操作未被允许'
    if (definition.behavior) {
      const rules = new ActivityStateRules(
        definition.behavior.definition,
        this.#player(),
        binding.key,
        definition.behavior.phases,
      )
      const policy = rules.policy(
        this.#call(this.#activity(binding.key).module, 'activity.policy', () =>
          definition.behavior!.policy(rules.scoped(state, actorId), actorId),
        ),
      )
      if (!policy.operations.includes(binding.operationId)) return '尚未轮到你或操作未被允许'
    }
    return undefined
  }
  #statusAdmission(
    operation: Operation,
    events: readonly RulebookEvent[],
    actorId: CharacterId,
    parameters: WorldJsonObject,
    targetId?: string,
  ): string | undefined {
    const binding = operation.definition.status
    if (!binding) return undefined
    const { module } = operation
    const policy = module.definition.statusPolicy
    if (!policy?.characterIds.includes(actorId)) return '你不能进行这个操作，什么都没有发生。'
    const known = readonlyData({
      ...(this.options.projectKnownStatus?.(events, actorId) ??
        knownStatusView(module.state.known(statusEvents(events, module), actorId), actorId)),
    })
    const world = readonlyData(
      statusPlaceView(
        events,
        actorId,
        this.options.manifest.entities.map(row => row.entityId),
      ),
    )
    const admission = admitStatusOperation({
      operations: module.state.operations,
      operationId: binding.operationId,
      targetId,
      parameters,
      actorId,
      playerId: this.#player(),
      activityKey: this.#activityScope(events, actorId).activityKey,
      characterIds: this.options.manifest.characters.map(row => row.characterId),
      validArguments: (id, args) => module.state.validArguments(id, args),
      offers: () =>
        this.#call(module, 'status.policy', () =>
          parseStatusOffers(policy.policy(known, actorId, world), module.state.operations),
        ),
      sceneIds: () => this.#scene(events, actorId),
      isReachable: (entityId, sceneIds) => itemIsReachable(events, actorId, entityId, sceneIds),
    })
    return 'rejected' in admission ? admission.rejected : undefined
  }

  #binding(operation: Operation, events: readonly RulebookEvent[]): string {
    const activity = operation.definition.activity
    if (!activity) return 'gameplay'
    const state = activityProgress(events).get(activity.key)
    return JSON.stringify([activity.key, state?.id, state?.revision])
  }

  #offers(
    operation: Operation,
    events: readonly RulebookEvent[],
    actorId: CharacterId,
    candidates: readonly ActionAffordance[],
  ) {
    const offers = this.#call(
      operation.module,
      'offer:' + operation.definition.id,
      () =>
        operation.definition.offer?.({
          actorId,
          state: readonlyData(this.#project(operation.module, events, actorId, true)),
          candidates: readonlyData(candidates),
          locationId: currentLocation(events, actorId) ?? null,
        }) ?? [],
    )
    return this.#call(operation.module, 'validateOffers:' + operation.definition.id, () => {
      if (!Array.isArray(offers)) throw new TypeError('GAMEPLAY_OFFERS_INVALID')
      return offers.map(offer => {
        if (
          typeof offer.label !== 'string' ||
          (offer.targetId !== undefined && (typeof offer.targetId !== 'string' || !offer.targetId))
        )
          throw new TypeError('GAMEPLAY_OFFER_INVALID')
        const targetRef =
          offer.targetId === undefined
            ? { kind: 'character', id: actorId }
            : {
                kind: this.options.manifest.characters.some(row => row.characterId === offer.targetId)
                  ? 'character'
                  : this.options.manifest.locations.some(row => row.locationId === offer.targetId)
                    ? 'location'
                    : 'entity',
                id: offer.targetId,
              }
        return { label: offer.label, targetRef, parameters: operation.contract.parseOfferParameters(offer.parameters) }
      })
    })
  }

  async executePlayer(
    principalId: string,
    operationId: string,
    parameters: unknown,
    targetId?: string,
  ): Promise<Pick<RulebookResolution, 'status' | 'reason' | 'rejection'>> {
    const actorId = this.#principal(principalId),
      actionId = 'gameplay-action:' + randomUUID()
    let resolution: RulebookResolution | undefined
    await this.options.execute(actionId, actorId, snapshot => {
      resolution = this.adjudicate(snapshot.events, actorId, operationId, parameters, actionId, targetId)
      if (resolution.status === 'rejected') return undefined
      return {
        events: [
          ...resolution.events,
          {
            eventType: 'action.resolved',
            eventVersion: 1,
            data: { actorId, actionId, actionType: 'interact', accepted: true, sourceRole: 'player' },
          },
        ],
        authority: { actorId, operationId, source: 'native-gameplay' },
        allowedMovers: resolution.events
          .filter(event => event.eventType === 'character.moved')
          .map(event => String(statusObject(event.data).characterId)),
      }
    })
    return {
      status: resolution!.status,
      ...(resolution!.reason ? { reason: resolution!.reason } : {}),
      ...(resolution!.rejection ? { rejection: resolution!.rejection } : {}),
    }
  }

  #reject(rejection: BusinessRejection): RulebookResolution {
    return {
      status: 'rejected',
      events: [],
      reason: 'plugin:' + rejection.message,
      rejection: copy(rejection),
      observationScope: { scope: 'self' },
    }
  }

  async startActivity(
    principalId: string,
    key: string,
    participantIds: readonly CharacterId[],
  ): Promise<Pick<RulebookResolution, 'status' | 'reason' | 'rejection'>> {
    const actorId = this.#principal(principalId),
      actionId = 'gameplay-activity:' + randomUUID()
    const { module, definition } = this.#activity(key)
    let rejection: BusinessRejection | undefined
    await this.options.execute(actionId, actorId, snapshot => {
      rejection = this.#restrict(snapshot.events, actorId, 'activity:start', { activityKey: key, participantIds })
      if (rejection) return undefined
      const scene = this.#scene(snapshot.events, actorId)
      if (
        new Set(participantIds).size !== participantIds.length ||
        participantIds.includes(actorId) ||
        participantIds.length > 8 ||
        participantIds.some(id => !scene.includes(id))
      )
        throw new TypeError('GAMEPLAY_ACTIVITY_PARTICIPANTS_INVALID')
      if ([...activityProgress(snapshot.events).values()].some(state => state.game.active))
        throw new TypeError('GAMEPLAY_ACTIVITY_ALREADY_ACTIVE')
      if (activityProgress(snapshot.events).get(key)?.suspendedTurn !== undefined)
        throw new TypeError('GAMEPLAY_ACTIVITY_SUSPENDED: resume or abandon progress first')
      const randomValues: number[] = []
      const world = readonlyData(this.#world(snapshot.events, actorId))
      const truth = readonlyData(this.#truth(module, snapshot.events))
      const previousState = activityProgress(snapshot.events).get(key)
      const previous =
        previousState && definition.behavior
          ? new ActivityStateRules(
              definition.behavior.definition,
              this.#player(),
              key,
              definition.behavior.phases,
            ).scoped(previousState, actorId)
          : null
      if (definition.behavior?.autoStart) {
        const rules = new ActivityStateRules(
          definition.behavior.definition,
          this.#player(),
          key,
          definition.behavior.phases,
        )
        const candidate = this.#call(module, 'activity.autoStart', () =>
          parseActivityAutoStart(definition.behavior!.autoStart!(truth, world, previous), rules.participantSelection),
        )
        if (candidate?.met === false) {
          rejection = { code: 'GAMEPLAY_ACTIVITY_START_UNAVAILABLE', message: '这场活动的开始条件尚未满足' }
          return undefined
        }
      }
      let active = true
      const state = this.#call(module, 'initializeActivity', () => {
        try {
          return copy(
            definition.initialize({
              playerId: actorId,
              participantIds: copy(participantIds),
              activityId: 'activity:' + randomUUID(),
              world,
              truth,
              previous,
              random: () => {
                if (!active) throw new Error('activity random capability has ended')
                const value = Math.random()
                randomValues.push(value)
                return value
              },
            }),
          )
        } finally {
          active = false
        }
      })
      if (JSON.stringify(state.participants) !== JSON.stringify([actorId, ...participantIds]))
        throw new TypeError('GAMEPLAY_ACTIVITY_INITIAL_PARTICIPANTS_CHANGED')
      const computation: Computation = {
        actorId,
        events: snapshot.events,
        operationId: 'activity:start',
        actionId,
        recipients: scene,
        provenance: new WeakMap(),
      }
      const events = this.#effects(
        [
          {
            module,
            effect: { kind: 'activity', activityKey: key, state, description: definition.opening ?? definition.title },
          },
        ],
        computation,
      )
      const derived = this.#derive(computation, events, null)
      return {
        events: [...events, ...derived],
        authority: {
          actorId,
          activityKey: key,
          source: 'native-activity-start',
          randomValues: randomValues.map(value => value.toString()),
        },
      }
    })
    return rejection ? this.#reject(rejection) : { status: 'accepted' }
  }

  async controlActivity(
    principalId: string,
    key: string,
    operation: 'suspend' | 'resume' | 'abandon' | 'escape',
  ): Promise<Pick<RulebookResolution, 'status' | 'reason' | 'rejection'>> {
    const actorId = this.#principal(principalId),
      actionId = 'gameplay-activity:' + randomUUID()
    const { module, definition } = this.#activity(key)
    let rejection: BusinessRejection | undefined
    await this.options.execute(actionId, actorId, snapshot => {
      if (operation !== 'escape') {
        rejection = this.#restrict(snapshot.events, actorId, 'activity:' + operation, { activityKey: key })
        if (rejection) return undefined
      }
      const previous = activityProgress(snapshot.events).get(key)
      if (!previous?.participants.includes(actorId)) throw new TypeError('GAMEPLAY_ACTIVITY_CONTROL_UNAVAILABLE')
      const state =
        operation === 'resume'
          ? resumedActivity(previous)
          : operation === 'abandon'
            ? abandonedActivity(previous)
            : operation === 'escape'
              ? escapedActivity(previous)
              : previous.game.active
                ? suspendedActivity(previous)
                : undefined
      if (!state) throw new TypeError('GAMEPLAY_ACTIVITY_NOT_ACTIVE')
      if (operation === 'resume') {
        if ([...activityProgress(snapshot.events).values()].some(value => value.game.active))
          throw new TypeError('GAMEPLAY_ACTIVITY_ALREADY_ACTIVE')
        const world = readonlyData(this.#world(snapshot.events, actorId))
        if (definition.behavior?.resume) {
          const rules = new ActivityStateRules(
            definition.behavior.definition,
            this.#player(),
            key,
            definition.behavior.phases,
          )
          const result = this.#call(module, 'activity.resume', () =>
            definition.behavior!.resume!(rules.scoped(state, actorId), world),
          )
          if (result !== null) {
            const value = statusObject(result)
            statusExact(value, ['rejectReason'])
            if (
              typeof value.rejectReason !== 'string' ||
              !value.rejectReason.trim() ||
              value.rejectReason.length > 2000
            )
              throw new TypeError('GAMEPLAY_ACTIVITY_RESUME_RESULT_INVALID')
            rejection = { code: 'GAMEPLAY_ACTIVITY_RESUME_REJECTED', message: value.rejectReason }
            return undefined
          }
        } else if (state.participants.slice(1).some(id => !this.#scene(snapshot.events, actorId).includes(id)))
          throw new TypeError('恢复活动需要与参与者在同一场景')
      }
      const computation: Computation = {
        actorId,
        events: snapshot.events,
        operationId: 'activity:' + operation,
        actionId,
        recipients: this.#scene(snapshot.events, actorId),
        provenance: new WeakMap(),
      }
      const events = this.#effects(
        [{ module, effect: { kind: 'activity', activityKey: key, state, description: '活动状态已更新。' } }],
        computation,
      )
      // Forced escape remains unconditional; ordinary lifecycle actions share the single derivation layer.
      const derived = operation === 'escape' ? [] : this.#derive(computation, events, null)
      return {
        events: [...events, ...derived],
        authority: { actorId, source: 'native-activity-control', operation },
      }
    })
    return rejection ? this.#reject(rejection) : { status: 'accepted' }
  }

  async playerView(principalId: string, onFault?: (fault: PluginFaultError) => void) {
    const playerId = this.#principal(principalId),
      snapshot = await this.options.read()
    this.#ready()
    return [...this.#modules.values()].map(module => {
      try {
        const view = this.#call(module, 'playerView', () => {
          const projected = gameplayPresentation(
            module.definition.playerView?.({
              playerId,
              state: readonlyData(this.#project(module, snapshot.events, playerId, true)),
            }) ?? {},
          )
          for (const control of projected.controls ?? []) {
            const operation = this.#operations.get(control.operation.id)
            if (
              operation?.module !== module ||
              !Object.hasOwn(operation.definition.argumentSchema.properties ?? {}, control.operation.argument)
            )
              throw new TypeError('GAMEPLAY_CONTROL_OPERATION_INVALID')
          }
          return projected
        })
        return { moduleId: module.definition.id, view }
      } catch (error) {
        if (!onFault || !isPluginFault(error)) throw error
        onFault(error)
        return { moduleId: module.definition.id, view: {} }
      }
    })
  }

  /** Author and default decision adapters consume only this actor's already-authorized gameplay material. */
  projectContext(events: readonly RulebookEvent[], actorId: CharacterId, context: WorldJsonObject): WorldJsonObject {
    this.#ready()
    if (!this.options.manifest.characters.some(character => character.characterId === actorId))
      throw new TypeError('GAMEPLAY_CONTEXT_ACTOR_MISSING')
    const modules = [...this.#modules.values()].map(module => ({
      moduleId: module.definition.id,
      known: module.state.known(statusEvents(events, module), actorId),
    }))
    const active = [...activityProgress(events)].find(
      ([key, state]) =>
        state.game.active &&
        state.participants.includes(actorId) &&
        [...this.#modules.values()].some(module =>
          module.definition.activities?.some(definition => definition.key === key),
        ),
    )
    let activity: WorldJsonObject | undefined
    if (active) {
      const [key, state] = active,
        { definition } = this.#activity(key)
      const rules = new ActivityStateRules(
        definition.behavior?.definition ?? {
          title: definition.title,
          npcIds: state.participants.slice(1),
          operations: definition.operations,
        },
        this.#player(),
        key,
        definition.behavior?.phases,
      )
      activity = rules.scoped(state, actorId)
    }
    return copy({ ...context, gameplay: modules as unknown as WorldJsonValue, ...(activity ? { activity } : {}) })
  }

  #restrict(
    events: readonly RulebookEvent[],
    actorId: CharacterId,
    operationId: string,
    parameters: WorldJsonObject,
    known = false,
  ) {
    const rules = [...this.#modules.values()]
      .flatMap(module => (module.definition.restrictions ?? []).map(rule => ({ module, rule })))
      .filter(
        ({ rule }) =>
          rule.operations.includes(operationId) ||
          (!['move', 'speak'].includes(operationId) && rule.operations.includes('interact')),
      )
      .sort((a, b) => a.rule.id.localeCompare(b.rule.id, 'en'))
    for (const { module, rule } of rules) {
      if (known && rule.showBlocked) continue
      const state = readonlyData(this.#project(module, events, actorId, known))
      const world = readonlyData(this.#world(events, actorId, known))
      const rejection = this.#call(module, 'restriction:' + rule.id, () => {
        const result = rule.check({
          actorId,
          operationId,
          parameters: readonlyData(parameters),
          state,
          world,
        })
        if (result !== undefined && (!result || typeof result.code !== 'string' || typeof result.message !== 'string'))
          throw new TypeError('GAMEPLAY_RESTRICTION_RESULT_INVALID')
        return result === undefined ? undefined : copy(result)
      })
      if (rejection !== undefined) {
        return rejection
      }
    }
    return undefined
  }
  #proposals(module: Module, effects: readonly GameplayEffect[], computation: Computation): Proposal[] {
    return this.#call(module, 'acceptEffects', () => {
      if (!Array.isArray(effects)) throw new TypeError('GAMEPLAY_EFFECTS_INVALID: expected an array')
      return effects.map(effect => computation.provenance.get(effect) ?? { module, effect: copy(effect) })
    })
  }
  #compute(computation: Computation): GameplayComputation {
    let open = true
    const call: GameplayComputation = <
      TParams extends WorldJsonObject,
      TState extends WorldJsonObject,
      TOutcome extends WorldJsonValue,
    >(
      reference: OperationDefinition<TParams, TState, TOutcome>,
      parameters: TParams,
    ): OperationResolution<TOutcome> => {
      this.#active()
      if (!open) throw new Error('gameplay computation has ended')
      const operation = this.#methods.get(reference)
      if (!operation) throw new TypeError('GAMEPLAY_METHOD_NOT_REGISTERED')
      const activityRejection = this.#activityAdmission(operation, computation.events, computation.actorId)
      if (activityRejection)
        return {
          status: 'rejected',
          rejection: { code: 'GAMEPLAY_ACTIVITY_NOT_AVAILABLE', message: activityRejection },
        }
      const resolution = this.#resolve(operation, parameters, computation)
      if (resolution.status === 'rejected') return resolution
      return {
        ...resolution,
        // The registered reference and its compiled result Schema establish this erased generic link.
        outcome: resolution.outcome as TOutcome,
        effects: this.#proposals(operation.module, resolution.effects, computation).map(proposal => {
          const effect = readonlyData(proposal.effect)
          computation.provenance.set(effect, { module: proposal.module, effect })
          return effect
        }),
      }
    }
    // The caller explicitly expires this capability immediately after the synchronous callback.
    return Object.assign(call, {
      close: () => {
        open = false
      },
    })
  }
  #resolve(operation: Operation, parameters: unknown, computation: Computation): OperationResolution<WorldJsonValue> {
    const { module, definition } = operation
    const activityKey = definition.activity?.key
    const activity = activityKey ? activityProgress(computation.events).get(activityKey) : undefined
    const state = readonlyData(this.#project(module, computation.events, computation.actorId))
    const world = readonlyData(this.#world(computation.events, computation.actorId))
    const truth = readonlyData(this.#truth(module, computation.events))
    const compute = this.#compute(computation)
    let capabilityActive = true
    try {
      return this.#call(module, 'resolve:' + definition.id, () => {
        const result = definition.resolve({
          actorId: computation.actorId,
          parameters: operation.contract.parseParameters(parameters),
          state,
          locationId: currentLocation(computation.events, computation.actorId) ?? null,
          compute,
          world,
          truth,
          ...(computation.targetId === undefined ? {} : { targetId: computation.targetId }),
          ...(this.options.rollDice
            ? {
                rollDice: (expression: string) => {
                  if (!capabilityActive) throw new TypeError('GAMEPLAY_DICE_CALL_ENDED')
                  this.#active()
                  return this.options.rollDice!(expression)
                },
              }
            : {}),
          ...(activity ? { activity: readonlyData(activity) } : {}),
        })
        if (result?.status === 'rejected') {
          if (
            !result.rejection ||
            typeof result.rejection.code !== 'string' ||
            typeof result.rejection.message !== 'string'
          )
            throw new TypeError('GAMEPLAY_REJECTION_INVALID')
          return { status: 'rejected', rejection: copy(result.rejection) }
        }
        if (result?.status !== 'accepted' || !Array.isArray(result.effects))
          throw new TypeError('GAMEPLAY_OPERATION_RESULT_INVALID')
        return { status: 'accepted', outcome: operation.contract.parseOutcome(result.outcome), effects: result.effects }
      })
    } finally {
      capabilityActive = false
      ;(compute as GameplayComputation & { close(): void }).close()
    }
  }

  #effects(proposals: readonly Proposal[], computation: Computation, cycle = false): WorldEventDraft[] {
    const events: WorldEventDraft[] = []
    const allowedMovers = new Set<string>([computation.actorId])
    const statuses = new Map<
      Module,
      {
        changes: StatusChange[]
        reveals: import('@harness-world/contracts').StatusReveal[]
        description?: string
        activityKey?: string
        revealRequests?: { observerId: string; holderId: string | null; key: string }[]
      }
    >()
    const queueStatus = (module: Module, data: StatusEventData) => {
      const group = statuses.get(module) ?? { changes: [], reveals: [] }
      group.changes.push(...data.changes)
      group.revealRequests ??= []
      group.revealRequests.push(...data.reveals.map(({ observerId, holderId, key }) => ({ observerId, holderId, key })))
      if (data.description !== undefined) group.description = data.description
      if (data.source.kind === 'activity') group.activityKey = data.source.activityKey
      statuses.set(module, group)
    }
    const activities = new Set<string>()
    for (const { module, effect } of proposals)
      this.#call(module, 'validateEffect', () => {
        if (effect.kind === 'status-result') {
          if (cycle) throw new TypeError('GAMEPLAY_OPERATION_RESULT_OUTSIDE_OPERATION')
          const result = parseStatusOperationResult(effect.result)
          if ('rejected' in result) throw new TypeError('rejections must be returned by the Handler')
          const data: StatusEventData = {
            source: {
              kind: 'operation',
              operation: computation.operationId,
              actorId: computation.actorId,
            },
            changes: result.changes as StatusChange[],
            reveals: module.state.reveals(
              statusEvents(computation.events, module),
              result.changes as StatusChange[],
              result.reveals,
              computation.actorId,
            ),
            description: result.description,
          }
          module.state.validate(statusEvents(computation.events, module), data, computation.recipients)
          queueStatus(module, data)
          if (result.items !== undefined)
            events.push(
              ...adjudicateItemChanges({
                events: computation.events,
                actorId: computation.actorId,
                interactionId: computation.actionId,
                sceneIds: this.#scene(computation.events, computation.actorId),
                entityIds: this.options.manifest.entities.map(row => row.entityId),
                value: result.items,
              }),
            )
          computation.presentation = {
            description: result.description,
            scope: statusObservationScope(
              result.audience,
              computation.actorId,
              this.#scene(computation.events, computation.actorId),
            ),
          }
        } else if (effect.kind === 'activity-result') {
          const activity = module.definition.activities?.find(value => value.key === effect.activityKey)
          if (!activity?.behavior || cycle) throw new TypeError('GAMEPLAY_ACTIVITY_EFFECT_NOT_OWNED')
          if (activities.has(activity.key)) throw new TypeError('GAMEPLAY_ACTIVITY_EFFECT_NOT_OWNED_OR_CONFLICTING')
          activities.add(activity.key)
          const state = activityProgress(computation.events).get(effect.activityKey)
          if (!state) throw new TypeError('GAMEPLAY_ACTIVITY_MISSING')
          const rules = new ActivityStateRules(
            activity.behavior.definition,
            this.#player(),
            activity.key,
            activity.behavior.phases,
          )
          const result = parseActivityOperationResult(effect.result, rules, state)
          if ('rejected' in result) throw new TypeError('rejections must be returned by the Handler')
          events.push(
            activityUpdatedEvent({
              key: activity.key,
              state: result.next,
              description: result.description,
              actorId: computation.actorId,
              actionId: computation.actionId,
              operation: computation.operationId.split(':').at(-1)!,
            }),
          )
          if (result.status !== undefined)
            queueStatus(
              module,
              statusData(
                module.state.activityEvent(
                  statusEvents(computation.events, module),
                  activity.key,
                  computation.actorId,
                  result.status,
                  this.#scene(computation.events, computation.actorId),
                ),
              ),
            )
          for (const move of result.moves ?? []) {
            if (!module.definition.physicalEffects?.characters.includes(move.characterId))
              throw new TypeError('GAMEPLAY_MOVER_NOT_DECLARED')
            allowedMovers.add(move.characterId)
            const fromLocationId = currentLocation(computation.events, move.characterId) ?? null
            if (fromLocationId !== move.locationId)
              events.push({
                eventType: 'character.moved',
                eventVersion: 1,
                data: { characterId: move.characterId, fromLocationId, toLocationId: move.locationId },
              })
          }
          if (result.items !== undefined) {
            for (const item of result.items)
              if (!module.definition.physicalEffects?.entities.includes(String(statusObject(item).entityId)))
                throw new TypeError('GAMEPLAY_ITEM_NOT_DECLARED')
            events.push(
              ...ruledItemChanges({
                manifest: this.options.manifest,
                events: [...computation.events, ...events],
                actorId: computation.actorId,
                interactionId: computation.actionId,
                value: result.items,
              }),
            )
          }
          if (result.privateNotes)
            events.push(
              ...activityNoteObservations({
                state: result.next,
                notes: result.privateNotes,
                actorId: computation.actorId,
                actionId: computation.actionId,
                operation: computation.operationId.split(':').at(-1)!,
              }),
            )
          if (result.playerExpression !== undefined) {
            if (computation.actorId !== this.#player() || !computation.resolveSpeech)
              throw new TypeError('GAMEPLAY_PLAYER_EXPRESSION_REQUIRES_CORE_RESOLUTION')
            const expression = statusObject(result.playerExpression),
              field = Object.hasOwn(expression, 'narration') ? 'narration' : 'text'
            statusExact(expression, [field])
            if (
              typeof expression[field] !== 'string' ||
              !String(expression[field]).trim() ||
              String(expression[field]).length > 2000
            )
              throw new TypeError('GAMEPLAY_PLAYER_EXPRESSION_INVALID')
            const policy = rules.policy(
              this.#call(module, 'activity.policy', () =>
                activity.behavior!.policy(rules.scoped(state, computation.actorId), computation.actorId),
              ),
            )
            checkActivityExpression(
              policy,
              field === 'text' ? { speech: expression[field]! } : { narration: expression[field]! },
            )
            events.push(
              ...computation.resolveSpeech({
                text: field === 'text' ? expression[field]! : '',
                ...(field === 'narration' ? { narration: expression[field]! } : {}),
                scope: 'scene_public',
              }),
            )
          }
          computation.presentation = {
            description: result.description,
            scope: {
              scope: 'direct',
              recipientIds: result.audience === 'self' ? [computation.actorId] : state.participants,
            },
          }
        } else if (effect.kind === 'status') {
          if (!Array.isArray(effect.changes) || !Array.isArray(effect.reveals))
            throw new TypeError('GAMEPLAY_STATE_EFFECT_INVALID')
          const group = statuses.get(module) ?? { changes: [], reveals: [] }
          for (const change of effect.changes) {
            statusExact(statusObject(change), ['holderId', 'key', 'value'])
            if (!module.keys.has(change.key)) throw new TypeError('GAMEPLAY_STATE_WRITE_NOT_OWNED')
            group.changes.push(copy(change))
          }
          for (const reveal of effect.reveals) {
            if (!module.keys.has(reveal.key)) throw new TypeError('GAMEPLAY_STATE_REVEAL_NOT_OWNED')
            if (cycle && reveal.observerId !== reveal.holderId) throw new TypeError('GAMEPLAY_CYCLE_REVEAL_NOT_OWNED')
            group.reveals.push(copy(reveal))
          }
          statuses.set(module, group)
        } else if (effect.kind === 'activity') {
          const definition = module.definition.activities?.find(activity => activity.key === effect.activityKey)
          if (!definition || activities.has(definition.key))
            throw new TypeError('GAMEPLAY_ACTIVITY_EFFECT_NOT_OWNED_OR_CONFLICTING')
          activities.add(definition.key)
          const state = copy(effect.state)
          const previous = activityProgress(computation.events).get(definition.key)
          if (
            !Array.isArray(state.participants) ||
            state.participants[0] !== this.#player() ||
            state.participants.some(id => !this.options.manifest.characters.some(row => row.characterId === id))
          )
            throw new TypeError('GAMEPLAY_ACTIVITY_PARTICIPANTS_INVALID')
          if (previous?.id === state.id) {
            if (
              state.revision !== previous.revision + 1 ||
              JSON.stringify(state.participants) !== JSON.stringify(previous.participants)
            )
              throw new TypeError('GAMEPLAY_ACTIVITY_REVISION_OR_PARTICIPANTS_STALE')
          } else if (state.revision !== 1 || previous?.game.active)
            throw new TypeError('GAMEPLAY_ACTIVITY_INITIAL_REVISION_INVALID')
          const rules = new ActivityStateRules(
            definition.behavior?.definition ?? {
              title: definition.title,
              npcIds: state.participants.slice(1),
              operations: definition.operations,
              ...(definition.opening ? { opening: definition.opening } : {}),
            },
            this.#player(),
            definition.key,
            definition.behavior?.phases,
          )
          let event = activityUpdatedEvent({
            key: definition.key,
            state,
            description: effect.description,
            actorId: computation.actorId,
            actionId: computation.actionId,
            operation: computation.operationId,
          })
          if (cycle) {
            const { actorId: _actorId, ...data } = statusObject(event.data)
            event = {
              ...event,
              data: { ...data, source: { kind: 'cycle', cycleId: computation.actionId } } as WorldJsonObject,
            }
          }
          rules.state([...computation.events, event])
          activityProgress([...computation.events, ...events, event])
          events.push(event)
        } else if (effect.kind === 'event') {
          const event = copy(effect.event)
          if (event.eventVersion !== 1) throw new TypeError('GAMEPLAY_EVENT_VERSION_INVALID')
          const data = statusObject(event.data)
          if (event.eventType === 'observation.upsert') {
            const value = statusObject(data.value),
              observerId = String(value.observerId)
            if (!computation.recipients.includes(observerId))
              throw new TypeError('GAMEPLAY_OBSERVATION_AUDIENCE_INVALID')
            const { actorId: _actorId, ...content } = copy(statusObject(value.content))
            events.push({
              eventType: event.eventType,
              eventVersion: 1,
              data: {
                id: computation.actionId + ':' + module.definition.id + ':' + randomUUID(),
                value: {
                  observerId,
                  content: {
                    ...content,
                    ...(cycle
                      ? { source: { kind: 'cycle', cycleId: computation.actionId } }
                      : { actorId: computation.actorId }),
                    status: 'accepted',
                  },
                },
              } as WorldJsonObject,
            })
          } else {
            if (
              cycle ||
              !['character.moved', 'entity.transferred', 'entity.taken', 'entity.upsert'].includes(event.eventType)
            )
              throw new TypeError('GAMEPLAY_EVENT_NOT_ALLOWED')
            if (event.eventType !== 'entity.upsert' && data.characterId !== computation.actorId) {
              if (
                event.eventType !== 'character.moved' ||
                !module.definition.physicalEffects?.characters.includes(String(data.characterId))
              )
                throw new TypeError('GAMEPLAY_PHYSICAL_ACTOR_MISMATCH')
              allowedMovers.add(String(data.characterId))
            }
            if (
              typeof data.entityId === 'string' &&
              !itemIsReachable(
                computation.events,
                computation.actorId,
                data.entityId,
                this.#scene(computation.events, computation.actorId),
              )
            )
              throw new TypeError('GAMEPLAY_ITEM_NOT_REACHABLE')
            assertPhysicalEffects({
              manifest: this.options.manifest,
              events: computation.events,
              drafts: [...events, event],
              actorId: computation.actorId,
              allowedMovers: [...allowedMovers],
            })
            events.push(event)
          }
        } else throw new TypeError('GAMEPLAY_EFFECT_KIND_UNKNOWN')
      })
    for (const [module, group] of statuses)
      this.#call(module, 'validateStateEffects', () => {
        const byAddress = new Map<string, StatusChange[]>()
        for (const change of group.changes) {
          const key = JSON.stringify([change.holderId, change.key])
          const same = byAddress.get(key) ?? []
          same.push(change)
          byAddress.set(key, same)
        }
        const truth = this.#truth(module, computation.events)
        const conflict = [...byAddress.values()].some(same => same.length > 1)
        if (conflict && !module.definition.combineChanges)
          throw new TypeError('GAMEPLAY_STATE_CONFLICT: owner merge is required')
        const changes = conflict
          ? copy(
              module.definition.combineChanges!({ state: readonlyData(truth), changes: readonlyData(group.changes) }),
            )
          : group.changes
        if (
          !Array.isArray(changes) ||
          changes.some(change => !module.keys.has(change.key)) ||
          new Set(changes.map(change => JSON.stringify([change.holderId, change.key]))).size !== changes.length
        )
          throw new TypeError('GAMEPLAY_OWNER_MERGE_INVALID')
        const requests = [
          ...new Map(
            (group.revealRequests ?? []).map(value => [
              JSON.stringify([value.observerId, value.holderId, value.key]),
              value,
            ]),
          ).values(),
        ]
        const reveals = [
          ...group.reveals,
          ...(group.revealRequests
            ? module.state.reveals(statusEvents(computation.events, module), changes, requests, computation.actorId)
            : []),
        ]
        if (!cycle)
          for (const change of changes) {
            if (
              change.holderId === computation.actorId &&
              !reveals.some(
                reveal =>
                  reveal.observerId === computation.actorId &&
                  reveal.holderId === change.holderId &&
                  reveal.key === change.key,
              )
            )
              reveals.push({ ...change, observerId: computation.actorId })
          }
        const data: StatusEventData = {
          source: cycle
            ? { kind: 'cycle', cycleId: computation.actionId }
            : {
                kind: 'operation',
                operation: computation.operationId,
                actorId: computation.actorId,
                ...(computation.activityKey ? { activityKey: computation.activityKey } : {}),
              },
          changes,
          reveals,
          ...(group.description === undefined ? {} : { description: group.description }),
        }
        if (group.activityKey !== undefined && !cycle)
          data.source = { kind: 'activity', activityKey: group.activityKey, actorId: computation.actorId }
        module.state.validate(statusEvents(computation.events, module), data, computation.recipients)
        events.push({ eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject })
      })
    activityProgress([...computation.events, ...events])
    assertPhysicalEffects({
      manifest: this.options.manifest,
      events: computation.events,
      drafts: events,
      actorId: computation.actorId,
      allowedMovers: [...allowedMovers],
    })
    return events
  }

  adjudicate(
    events: readonly RulebookEvent[],
    actorId: CharacterId,
    operationId: string,
    parameters: unknown,
    actionId: string = randomUUID(),
    targetId?: string,
    resolveSpeech?: Computation['resolveSpeech'],
  ): RulebookResolution {
    return this.#adjudicate(events, actorId, operationId, parameters, actionId, undefined, targetId, resolveSpeech)
  }

  #adjudicate(
    events: readonly RulebookEvent[],
    actorId: CharacterId,
    operationId: string,
    parameters: unknown,
    actionId: string = randomUUID(),
    verifyTarget?: () => boolean,
    targetId?: string,
    resolveSpeech?: Computation['resolveSpeech'],
  ): RulebookResolution {
    this.#ready()
    this.#sealed = true
    const operation = this.#operations.get(operationId)
    if (!operation) throw new TypeError('GAMEPLAY_OPERATION_NOT_REGISTERED')
    if (!this.options.manifest.characters.some(character => character.characterId === actorId))
      throw new TypeError('GAMEPLAY_ACTOR_NOT_BOUND')
    const activityRejection = this.#activityAdmission(operation, events, actorId)
    if (activityRejection) return this.#reject({ code: 'GAMEPLAY_ACTIVITY_NOT_AVAILABLE', message: activityRejection })
    if (!operation.definition.activity) {
      for (const module of this.#modules.values())
        for (const definition of module.definition.activities ?? []) {
          const state = activityProgress(events).get(definition.key)
          if (!state?.game.active || !state.participants.includes(actorId) || !definition.behavior) continue
          const rules = new ActivityStateRules(
            definition.behavior.definition,
            this.#player(),
            definition.key,
            definition.behavior.phases,
          )
          const policy = rules.policy(
            this.#call(module, 'activity.policy', () =>
              definition.behavior!.policy(rules.scoped(state, actorId), actorId),
            ),
          )
          if (!policy.interactions.includes(operationId))
            return this.#reject({ code: 'GAMEPLAY_ACTIVITY_PERMISSION', message: '活动期间禁止此交互' })
        }
    }
    const params = operation.contract.parseParameters(parameters)
    if (verifyTarget && !verifyTarget())
      return this.#reject({ code: 'GAMEPLAY_OPERATION_TARGET_UNAVAILABLE', message: '当前目标不可执行该操作。' })
    const statusRejection = this.#statusAdmission(operation, events, actorId, params, targetId)
    if (statusRejection) return this.#reject({ code: 'GAMEPLAY_STATUS_NOT_AVAILABLE', message: statusRejection })
    const rejection = this.#restrict(events, actorId, operationId, params)
    if (rejection) return this.#reject(rejection)
    const participants = operation.definition.activity
      ? activityProgress(events).get(operation.definition.activity.key)!.participants
      : []
    const computation: Computation = {
      actorId,
      events,
      operationId,
      actionId,
      recipients: [...new Set([...this.#scene(events, actorId), ...participants])],
      provenance: new WeakMap(),
      ...this.#activityScope(events, actorId),
      ...(targetId === undefined ? {} : { targetId }),
      ...(resolveSpeech ? { resolveSpeech } : {}),
    }
    const resolution = this.#resolve(operation, params, computation)
    if (resolution.status === 'rejected') return this.#reject(resolution.rejection)
    const main = this.#effects(this.#proposals(operation.module, resolution.effects, computation), computation)
    const after = this.#derive(computation, main, resolution.outcome)
    const textEvents: WorldEventDraft[] = []
    for (const recipient of computation.presentation ? [] : computation.recipients) {
      let text =
        recipient === actorId ? '这次操作已完成。' : '目击了一次' + (operation.definition.ui?.label ?? '操作') + '。'
      const npc = operation.definition.npc
      if (npc) {
        try {
          const input = {
            actorId,
            recipientId: brandId(recipient, 'CharacterId'),
            outcome: readonlyData(resolution.outcome),
          }
          const projection = npc.projectResult
            ? this.#call(operation.module, 'projectResult', () => npc.projectResult!(input))
            : recipient === actorId
              ? resolution.outcome
              : undefined
          if (projection !== undefined)
            text = this.#call(operation.module, 'formatResult', () => {
              const result = npc.formatResult({ ...input, outcome: operation.contract.parseOutcome(projection) })
              if (typeof result !== 'string' || result.length > 2000)
                throw new TypeError('GAMEPLAY_RESULT_TEXT_INVALID')
              return result
            })
        } catch {
          /* Presentation is optional; call boundary already retained a safe plugin diagnostic. */
        }
      } else if (operation.definition.activity) {
        const { key } = operation.definition.activity,
          { definition } = this.#activity(key)
        const state = activityProgress(events).get(key)!
        const recipientId = brandId(recipient, 'CharacterId')
        try {
          const input = {
            activityId: state.id,
            operationId,
            actorId,
            recipientId,
            outcome: readonlyData(resolution.outcome),
          }
          const projected = definition.projectResult
            ? this.#call(operation.module, 'activity.projectResult', () => definition.projectResult!(input))
            : recipient === actorId
              ? resolution.outcome
              : undefined
          if (projected !== undefined)
            text = this.#call(operation.module, 'activity.formatResult', () => {
              const outcome = copy(projected)
              if (!this.#activityValidators.get(key)!(outcome))
                throw new TypeError('activity result projection failed its Schema')
              const value = definition.formatResult({ activityId: state.id, actorId, recipientId, outcome })
              if (typeof value !== 'string' || value.length > 2000) throw new TypeError('invalid activity result text')
              return value
            })
        } catch {
          /* Optional presentation failure already has a safe diagnostic. */
        }
      }
      textEvents.push({
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: actionId + ':gameplay:' + recipient,
          value: {
            observerId: recipient,
            content: { status: 'accepted', actorId, operationId, resultDescription: text },
          },
        },
      })
    }
    return {
      status: 'accepted',
      events: [...main, ...after, ...textEvents],
      observationScope: computation.presentation?.scope ?? { scope: 'scene_public' },
      ...(computation.presentation ? { description: computation.presentation.description } : {}),
    }
  }

  #baseOffers(base: RulebookResolver, context: Parameters<RulebookResolver['affordances']>[0]) {
    const actorId = brandId(String(context.characterId), 'CharacterId')
    return base.affordances(context).flatMap(offer => {
      if (offer.actionType === 'move' && offer.destinations)
        return [
          {
            ...offer,
            destinations: offer.destinations.filter(
              destination =>
                !this.#restrict(context.events, actorId, 'move', { locationId: destination.locationId }, true),
            ),
          },
        ]
      if (offer.actionType === 'interact')
        return [
          {
            ...offer,
            interactions: (offer.interactions ?? []).filter(
              option =>
                !this.#restrict(
                  context.events,
                  actorId,
                  String(statusObject(option.definitionRef).id),
                  statusObject(option.arguments ?? {}) as WorldJsonObject,
                  true,
                ),
            ),
          },
        ]
      return this.#restrict(context.events, actorId, offer.actionType, {}, true) ? [] : [offer]
    })
  }

  resolver(base: RulebookResolver): RulebookResolver {
    return {
      affordances: context => {
        this.#ready()
        const actorId = brandId(String(context.characterId), 'CharacterId')
        const baseOffers = this.#baseOffers(base, context)
        const choices: WorldJsonObject[] = []
        for (const operation of this.#operations.values()) {
          if (this.#activityAdmission(operation, context.events, actorId)) continue
          const offers = this.#offers(operation, context.events, actorId, baseOffers)
          for (const offer of offers) {
            const parameters = operation.contract.parseOfferParameters(offer.parameters) as WorldJsonObject
            const pendingInput = Object.keys(operation.definition.argumentSchema.properties ?? {}).some(
              key => !Object.hasOwn(parameters, key),
            )
            if (!pendingInput && this.#restrict(context.events, actorId, operation.definition.id, parameters, true))
              continue
            choices.push({
              label: offer.label,
              targetRef: offer.targetRef,
              bindingId: this.#binding(operation, context.events),
              definitionRef: { id: operation.definition.id, version: 1 },
              arguments: parameters,
              argumentSchema: copy(operation.definition.argumentSchema) as WorldJsonObject,
              ...(operation.definition.ui ? { ui: copy(operation.definition.ui) as unknown as WorldJsonObject } : {}),
              ...(operation.definition.npc ? { whenToUse: operation.definition.npc.whenToUse } : {}),
            })
          }
        }
        const interact = baseOffers.find(offer => offer.actionType === 'interact')
        return [
          ...baseOffers.filter(offer => offer.actionType !== 'interact'),
          ...(choices.length || interact
            ? [
                {
                  ...(interact ?? { actionType: 'interact', actionVersion: 2 }),
                  interactions: [...(interact?.interactions ?? []), ...choices],
                },
              ]
            : []),
        ]
      },
      resolve: context => {
        this.#ready()
        const parameters = statusObject(context.action.parameters)
        const reference =
          parameters.definitionRef !== undefined && parameters.definitionRef !== null
            ? statusObject(parameters.definitionRef)
            : undefined
        const operationId =
          context.action.actionType === 'interact' && typeof reference?.id === 'string'
            ? reference.id
            : context.action.actionType
        const actorId = brandId(String(context.characterId), 'CharacterId')
        // Existing Host controls translate their envelope into the registered Handler. No legacy Handler is called.
        const active = [...activityProgress(context.events)].find(
          ([, state]) => state.game.active && state.participants.includes(actorId),
        )
        const alias =
          operationId.startsWith('activity:') && active
            ? 'activity:' + active[0] + ':' + operationId.slice(9)
            : operationId
        if (
          context.action.actionType === 'interact' &&
          this.#operations.has(alias) &&
          (parameters.bindingId === 'status' || (active && parameters.bindingId === active[1].id))
        ) {
          const target = statusObject(parameters.targetRef),
            args = statusObject(parameters.arguments)
          if (
            reference?.version !== 1 ||
            (target.kind !== 'entity' && !(target.kind === 'character' && target.id === actorId))
          )
            return this.#reject({ code: 'GAMEPLAY_OPERATION_BINDING_INVALID', message: '当前操作绑定无效或已过期。' })
          const { activityId, revision, ...activityArgs } = args
          if (
            alias.startsWith('activity:') &&
            (!active || activityId !== active[1].id || revision !== active[1].revision)
          )
            return this.#reject({ code: 'GAMEPLAY_ACTIVITY_NOT_AVAILABLE', message: '活动请求已失效，请刷新。' })
          const resolveSpeech = (speech: WorldJsonObject) => {
            const actionId = (context.actionId ?? randomUUID()) + ':scripted-player'
            const result = base.resolve({ ...context, actionId, action: { actionType: 'speak', parameters: speech } })
            if (result.status !== 'accepted') throw new TypeError('GAMEPLAY_PLAYER_EXPRESSION_REJECTED')
            const said = result.events.find(event => event.eventType === 'character.speak')
            return [
              ...result.events,
              ...(said
                ? this.#scene(context.events, actorId).map(observerId => ({
                    eventType: 'observation.upsert',
                    eventVersion: 1,
                    data: {
                      id: actionId + ':' + observerId,
                      value: {
                        observerId,
                        content: { actorId, actionType: 'speak', status: 'accepted', speech: said.data },
                      },
                    } as WorldJsonObject,
                  }))
                : []),
            ]
          }
          const result = this.#adjudicate(
            context.events,
            actorId,
            alias,
            alias.startsWith('activity:') ? activityArgs : args,
            context.actionId,
            undefined,
            target.kind === 'entity' ? String(target.id) : undefined,
            resolveSpeech,
          )
          this.#completed.add(result)
          return result
        }
        if (this.#operations.has(operationId)) {
          const operation = this.#operations.get(operationId)!
          const rawTarget = parameters.targetRef
          const validTarget =
            rawTarget !== null &&
            typeof rawTarget === 'object' &&
            !Array.isArray(rawTarget) &&
            Object.keys(rawTarget).length === 2 &&
            typeof (rawTarget as { kind?: unknown }).kind === 'string' &&
            Boolean((rawTarget as { kind: string }).kind) &&
            typeof (rawTarget as { id?: unknown }).id === 'string' &&
            Boolean((rawTarget as { id: string }).id)
          if (
            !validTarget ||
            parameters.bindingId !== this.#binding(operation, context.events) ||
            reference?.version !== 1
          )
            return this.#reject({ code: 'GAMEPLAY_OPERATION_BINDING_INVALID', message: '当前操作绑定无效或已过期。' })
          const target = rawTarget as { readonly kind: string; readonly id: string }
          let parsedArguments: WorldJsonObject
          try {
            parsedArguments = operation.contract.parseParameters(parameters.arguments)
          } catch (error) {
            if (error instanceof GameplayContractError && error.code === 'GAMEPLAY_ARGUMENTS_INVALID')
              return this.#reject({ code: 'GAMEPLAY_ARGUMENTS_INVALID', message: '操作参数不符合声明结构。' })
            throw error
          }
          return this.#adjudicate(
            context.events,
            actorId,
            operationId,
            parsedArguments,
            context.actionId,
            () =>
              operation.definition.offer
                ? this.#offers(operation, context.events, actorId, this.#baseOffers(base, context)).some(
                    offer =>
                      offer.targetRef.kind === target.kind &&
                      offer.targetRef.id === target.id &&
                      Object.entries(offer.parameters).every(
                        ([key, value]) =>
                          parsedArguments[key] !== undefined &&
                          String(canonicalizeWorldJson(parsedArguments[key])) ===
                            String(canonicalizeWorldJson(value as WorldJsonValue)),
                      ),
                  )
                : target.kind === 'character' && target.id === actorId,
            target.id,
          )
        }
        const rejection = this.#restrict(context.events, actorId, operationId, parameters as WorldJsonObject)
        if (rejection) return this.#reject(rejection)
        const result = base.resolve(context)
        if (this.#completed.has(result)) return result
        if (result.status !== 'accepted') return result
        const computation: Computation = {
          actorId,
          events: context.events,
          operationId,
          actionId: context.actionId ?? randomUUID(),
          recipients: this.#scene(context.events, actorId),
          provenance: new WeakMap(),
          ...this.#activityScope(context.events, actorId),
        }
        const main = [...result.events]
        if (context.action.actionType === 'speak' && active) {
          for (const module of this.#modules.values()) {
            const activity = module.definition.activities?.find(value => value.key === active[0])
            if (!activity?.behavior?.onPublished) continue
            const game = this.#call(module, 'activity.onPublished', () =>
              activity.behavior!.onPublished!(
                copy(active[1]),
                actorId,
                main.find(event => event.eventType === 'character.speak')?.data ?? null,
              ),
            )
            if (game !== null) {
              const rules = new ActivityStateRules(
                activity.behavior.definition,
                this.#player(),
                activity.key,
                activity.behavior.phases,
              )
              const next = {
                ...active[1],
                revision: active[1].revision + 1,
                game: rules.game(game, active[1].participants),
              }
              main.push(
                activityUpdatedEvent({
                  key: activity.key,
                  state: next,
                  description: '',
                  actorId,
                  actionId: computation.actionId,
                  operation: 'published',
                }),
              )
            }
          }
        }
        const completed = { ...result, events: [...main, ...this.#derive(computation, main, null)] }
        this.#completed.add(completed)
        return completed
      },
    }
  }

  #derive(computation: Computation, main: readonly WorldEventDraft[], outcome: WorldJsonValue): WorldEventDraft[] {
    const candidate = [...computation.events, ...main]
    const derived: Proposal[] = []
    for (const module of [...this.#modules.values()].sort((a, b) =>
      a.definition.id.localeCompare(b.definition.id, 'en'),
    )) {
      if (!module.definition.afterAction) continue
      const before = readonlyData(this.#project(module, computation.events, computation.actorId))
      const candidateState = readonlyData(this.#project(module, candidate, computation.actorId))
      const beforeActivities = readonlyData(this.#ownedActivities(module, computation.events))
      const candidateActivities = readonlyData(this.#ownedActivities(module, candidate))
      const beforeWorld = readonlyData(this.#world(computation.events, computation.actorId))
      const candidateWorld = readonlyData(this.#world(candidate, computation.actorId))
      const compute = this.#compute({ ...computation, events: candidate })
      try {
        derived.push(
          ...this.#call(module, 'afterAction', () =>
            this.#proposals(
              module,
              module.definition.afterAction!({
                operationId: computation.operationId,
                actorId: computation.actorId,
                outcome: readonlyData(outcome),
                before,
                candidate: candidateState,
                beforeActivities,
                candidateActivities,
                beforeWorld,
                candidateWorld,
                compute,
              }),
              computation,
            ),
          ),
        )
      } finally {
        ;(compute as GameplayComputation & { close(): void }).close()
      }
    }
    const after = this.#effects(derived, { ...computation, events: candidate })
    this.validateCandidate([...candidate, ...after])
    return after
  }

  #activityScope(events: readonly RulebookEvent[], actorId: CharacterId): { readonly activityKey?: string } {
    const active = [...activityProgress(events)].find(
      ([, state]) => state.game.active && state.participants.includes(actorId),
    )
    return active ? { activityKey: active[0] } : {}
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const dispose of this.#disposers.splice(0).reverse()) dispose()
  }
}
