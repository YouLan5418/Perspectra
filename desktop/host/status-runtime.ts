import { randomUUID } from 'node:crypto'
import {
  brandId,
  canonicalizeWorldJson,
  playerRoundNumber,
  knownStatusView,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
  type StatusEventData,
  type StatusChange,
} from '@harness-world/contracts'
import type { StatusInstance } from '@harness-world/plugin-sdk'
import {
  currentEntityState,
  currentLocation,
  rejectRulebookResolution,
  type ActionAffordance,
  type CompiledWorldManifest,
  type RulebookEvent,
  type RulebookResolution,
  type RulebookResolver,
  type RulebookResolutionContext,
} from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  StatusState,
  statusObject as object,
  statusExact as exact,
  statusData,
  admitStatusOperation,
  parseStatusOffers,
  parseStatusOperationResult,
  statusObservationScope,
  statusOperationChoices,
  type StatusOffers,
  characterExecutionResult,
  executeWorldRound,
  itemIsReachable,
  adjudicateItemChanges,
  actorWorldView,
  immediateActionDrafts,
  withSceneDecisions,
  type WorldRoundSnapshot,
} from '@harness-world/application'
import { activityProgress } from '@harness-world/application'
import { CAPABILITY_PENDING, type CapabilityOutcome } from '../host-capabilities.ts'
import type { ExternalStatusInput } from './pack-modules.ts'
const PREFIX = 'status:',
  REJECTED = 'STATUS_OPERATION_REJECTED'
const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
/** One status operation's outcome. A rejection names the actor's own mistake or the author's
 * `rejectReason`; it commits nothing and reveals no value. Author or host faults throw instead. */
export type Adjudication =
  | { status: 'rejected'; reason: string }
  | {
      status: 'accepted'
      /** The status event first, then any item changes the author asked for, in order. */
      events: WorldEventDraft[]
      description: string
      observationScope: NonNullable<RulebookResolution['observationScope']>
      /** The actor and the characters in its authorized scene: who a `scene` audience reaches. */
      sceneIds: readonly string[]
    }

/** Host adapter for state facts, authorized operation inputs and execution; never a script interpreter. */
export class StatusRuntime {
  externalActions:
    | {
        has(operation: string): boolean
        outcome(input: ExternalStatusInput): CapabilityOutcome | undefined
        committed(): void
        failed(): void
        execute<T>(
          input: ExternalStatusInput,
          context: RulebookResolutionContext,
          worldPath: string,
          address: WorldAddress,
          signal: AbortSignal | undefined,
          resolve: () => T,
        ): Promise<T>
      }
    | undefined

  readonly #mechanism: StatusInstance
  readonly #state: StatusState
  readonly #characterIds: readonly string[]
  readonly #entityNames: ReadonlyMap<string, string>
  readonly #policyErrors = new Map<string, string>()
  constructor(
    mechanism: StatusInstance,
    characterIds: readonly string[],
    entities: readonly { entityId: string; name?: string }[],
  ) {
    this.#mechanism = mechanism
    this.#characterIds = [...characterIds]
    this.#entityNames = new Map(entities.map(e => [e.entityId, e.name ?? e.entityId]))
    this.#state = new StatusState(mechanism.definition, characterIds, entities)
  }
  get statuses() {
    return this.#state.statuses
  }
  get operations() {
    return this.#state.operations
  }
  get hasRoundHook() {
    return this.#mechanism.hasRoundHook
  }
  get policyErrors() {
    return Object.fromEntries(this.#policyErrors)
  }
  get moduleDefinitions() {
    return this.#mechanism.moduleDefinitions
  }
  prepareModule(...args: Parameters<StatusInstance['prepareModule']>) {
    return this.#mechanism.prepareModule(...args)
  }
  truth(...args: Parameters<StatusState['truth']>) {
    return this.#state.truth(...args)
  }
  known(...args: Parameters<StatusState['known']>) {
    return this.#state.known(...args)
  }
  playerTruth(...args: Parameters<StatusState['playerTruth']>) {
    return this.#state.playerTruth(...args)
  }
  validate(...args: Parameters<StatusState['validate']>) {
    return this.#state.validate(...args)
  }
  initialEvent() {
    return this.#state.initialEvent(this.#mechanism.initialize(this.#characterIds))
  }
  /** The foreground activity's key when this actor takes part in it; status operations scoped to that
   * activity are offered and executed only then, and recorded with this key. */
  #activityKey(events: readonly RulebookEvent[], actorId: string): string | undefined {
    for (const [key, state] of activityProgress(events)) {
      if (state.game.active) return state.participants.includes(actorId) ? key : undefined
    }
    return undefined
  }

  #allowedOperations(events: readonly RulebookEvent[], actorId: string): StatusOffers {
    return this.#policy(knownStatusView(this.known(events, actorId), actorId), actorId, this.#place(events, actorId))
  }

  /** What the actor can see and lay hands on: its location, and every item it holds or that lies there, such as
   * a cooker a recipe needs. Never an item someone else holds, which the actor may not know about. */
  #place(events: readonly RulebookEvent[], actorId: string): WorldJsonObject {
    const locationId = currentLocation(events, actorId) ?? null
    const ids = [...this.#entityNames.keys()]
    return {
      locationId,
      items: ids.flatMap(id => {
        const item = currentEntityState(events, id)
        return item !== undefined && itemIsReachable(events, actorId, id, [])
          ? [{ entityId: id, kind: item.kind, holderId: item.holderId, locationId: item.locationId }]
          : []
      }),
    }
  }

  #policy(view: ReturnType<typeof knownStatusView>, actorId: string, place: WorldJsonObject): StatusOffers {
    return parseStatusOffers(
      this.#mechanism.policy(view as unknown as WorldJsonObject, actorId, place),
      this.operations,
    )
  }

  activityEvent(...args: Parameters<StatusState['activityEvent']>): WorldEventDraft {
    return this.#state.activityEvent(...args)
  }

  /** Host adjudication of one status operation on a commit prefix. NPC rulebook turns and player
   * operations share it; the caller commits the returned event, or nothing when this throws. */
  #adjudicate(input: {
    readonly worldPath: string
    readonly address: WorldAddress
    readonly playerId: string
    readonly manifest: CompiledWorldManifest
    readonly events: readonly RulebookEvent[]
    readonly asOfWorldSeq: number | undefined
    readonly actorId: string
    readonly operationId: string
    readonly parameters: unknown
    readonly targetId?: string
  }): Adjudication {
    const { events, actorId } = input
    let world: WorldJsonObject | undefined
    const declared = this.operations.find(o => o.id === input.operationId)
    const scopedActivity = declared?.activities ? this.#activityKey(events, actorId) : undefined
    const admission = admitStatusOperation({
      operations: this.operations,
      operationId: input.operationId,
      targetId: input.targetId,
      parameters: input.parameters,
      actorId,
      playerId: input.playerId,
      activityKey: scopedActivity,
      characterIds: this.#characterIds,
      validArguments: (id, parameters) => this.#state.validArguments(id, parameters),
      offers: () => this.#allowedOperations(events, actorId),
      sceneIds: () => {
        world = actorWorldView(input.worldPath, input.address, input.manifest, events, actorId, input.asOfWorldSeq)
        return [...new Set([actorId, ...(world.characterIds as string[])])]
      },
      isReachable: (id, present) => itemIsReachable(events, actorId, id, present),
    })
    if ('rejected' in admission) return { status: 'rejected', reason: admission.rejected }
    const { op, sceneIds } = admission
    const activityKey = scopedActivity
    const parameters = input.parameters as Record<string, unknown>
    const external = this.externalActions?.has(op.id)
      ? this.externalActions.outcome({
          operation: op.id,
          actorId,
          parameters: parameters as WorldJsonObject,
          asOfWorldSeq: input.asOfWorldSeq,
        })
      : undefined
    if (this.externalActions?.has(op.id) && !external) return { status: 'rejected', reason: CAPABILITY_PENDING }
    const result = parseStatusOperationResult(
      external?.completion === 'queued'
        ? {
            changes: [],
            reveals: [],
            description: '外部请求已排队，尚未确认执行；没有提交所请求的世界状态变化。',
            audience: 'self',
          }
        : this.#mechanism.resolve({
            truth: this.truth(events),
            actorId,
            operation: op.id,
            parameters: parameters as WorldJsonObject,
            world: world!,
            targetId: input.targetId ?? null,
            external: external?.data ?? null,
          }),
    )
    if ('rejected' in result) return { status: 'rejected', reason: result.rejected }
    const changes = result.changes as StatusChange[]
    const data: StatusEventData = {
      source: { kind: 'operation', operation: op.id, actorId, ...(activityKey ? { activityKey } : {}) },
      changes,
      reveals: this.#state.reveals(events, changes, result.reveals, actorId),
      description: result.description,
    }
    this.validate(events, data, sceneIds)
    const observationScope = statusObservationScope(result.audience, actorId, sceneIds)
    const items = Object.hasOwn(result, 'items')
      ? adjudicateItemChanges({
          events,
          actorId,
          interactionId: PREFIX + op.id,
          sceneIds,
          entityIds: [...this.#entityNames.keys()],
          value: result.items,
        })
      : []
    return {
      status: 'accepted',
      events: [{ eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }, ...items],
      description: result.description,
      observationScope,
      sceneIds,
    }
  }

  /** Adds the status operations this actor may currently perform to its affordances: the actors rule and
   * activity scoping with the participant check. A running activity's policy filter is applied by its caller. */
  withOperations(
    values: readonly ActionAffordance[],
    events: readonly RulebookEvent[],
    actor: string,
    playerId: string,
  ): ActionAffordance[] {
    const activityKey = this.#activityKey(events, actor)
    // Folding stored events stays outside the catch: corrupt history must surface, not read as a policy failure.
    const view = knownStatusView(this.known(events, actor), actor)
    let allowed: StatusOffers
    // A failing author policy only hides this actor's status operations; executing one still throws.
    try {
      allowed = this.#policy(view, actor, this.#place(events, actor))
      this.#policyErrors.delete(actor)
    } catch (cause) {
      this.#policyErrors.set(actor, cause instanceof Error ? cause.message : String(cause))
      return [...values]
    }
    const choices = statusOperationChoices({
      operations: this.operations,
      offers: allowed,
      activityKey,
      actorId: actor,
      playerId,
      isReachable: id => itemIsReachable(events, actor, id, []),
      entityName: id => this.#entityNames.get(id),
    })
    if (!choices.length) return [...values]
    // One interact entry: wire builders select a single affordance per action type.
    const interact = values.find(a => a.actionType === 'interact')
    const merged: ActionAffordance = {
      ...(interact ?? { actionType: 'interact', actionVersion: 2 }),
      interactions: [...(interact?.interactions ?? []), ...choices],
    }
    return [...values.filter(a => a.actionType !== 'interact'), merged]
  }

  /** Wraps a rulebook: offers this actor's status operations and adjudicates `status:` interactions. */
  resolver(base: RulebookResolver, worldPath: string, address: WorldAddress, playerId: string): RulebookResolver {
    return {
      affordances: context =>
        this.withOperations(base.affordances(context), context.events, String(context.characterId), playerId),
      resolve: context => {
        const p = record(context.action.parameters) ?? {},
          definition = record(p.definitionRef)
        if (typeof definition?.id !== 'string' || !definition.id.startsWith(PREFIX)) return base.resolve(context)
        if (context.action.actionType !== 'interact') throw new TypeError('状态操作必须使用 interact')
        exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
        exact(definition, ['id', 'version'])
        const actorId = String(context.characterId),
          target = object(p.targetRef, '状态操作目标')
        exact(target, ['kind', 'id'])
        if (
          p.bindingId !== 'status' ||
          definition.version !== 1 ||
          !(target.kind === 'entity'
            ? typeof target.id === 'string'
            : target.kind === 'character' && target.id === actorId)
        ) {
          throw new TypeError('状态操作绑定无效')
        }
        const result = this.#adjudicate({
          worldPath,
          address,
          playerId,
          manifest: context.manifest,
          events: context.events,
          asOfWorldSeq: context.asOfWorldSeq,
          actorId,
          operationId: definition.id.slice(PREFIX.length),
          parameters: p.arguments,
          ...(target.kind === 'entity' ? { targetId: target.id as string } : {}),
        })
        if (result.status === 'accepted')
          return { status: 'accepted', events: result.events, observationScope: result.observationScope }
        if (result.reason === CAPABILITY_PENDING) return { status: 'rejected', events: [], reason: CAPABILITY_PENDING }
        // The actor's own attempt failed: it learns why, and nothing about any status value.
        const rejected = rejectRulebookResolution(actorId, 'interact', REJECTED)
        return {
          ...rejected,
          events: rejected.events.map(e => ({ ...e, data: { ...object(e.data), description: result.reason } })),
          observationScope: { scope: 'direct', recipientIds: [actorId] },
        }
      },
    }
  }

  /** The actor-facing reason of this actor's latest status rejection, when `reason` is the status rejection code. */
  rejectionReason(
    events: readonly RulebookEvent[],
    actorId: string,
    reason: string | null | undefined,
  ): string | undefined {
    if (reason !== REJECTED) return undefined
    const latest = events.findLast(
      e =>
        e.eventType === 'action.rejected' &&
        record(e.data)?.characterId === actorId &&
        record(e.data)?.reason === REJECTED,
    )
    const description = latest === undefined ? undefined : object(latest.data).description
    return typeof description === 'string' ? description : undefined
  }

  /** Result text for `status:` operations only; anything else is left to the next handler. */
  executionResult = (
    input: Parameters<typeof characterExecutionResult>[0],
  ): ReturnType<typeof characterExecutionResult> | undefined => {
    const id = record(record(input.action.parameters)?.definitionRef)?.id
    if (typeof id !== 'string' || !id.startsWith(PREFIX)) return undefined
    if (input.status !== 'accepted') {
      const reason = this.rejectionReason(input.events, input.actorId, input.reason)
      if (reason === undefined) return characterExecutionResult(input)
      // The author says why; the host adds where the item still is, so a refused handover is not narrated as done.
      // Only what the actor sees anyway: in its own hands or where it stands.
      const target = record(record(input.action.parameters)?.targetRef)
      const item = target?.kind === 'entity' ? currentEntityState(input.events, String(target.id)) : undefined
      const name = item && (input.manifest.entities.find(e => e.entityId === item.entityId)?.name ?? item.entityId)
      const still =
        item?.holderId === input.actorId
          ? `${name}仍在你手里。`
          : item?.holderId === null && item.locationId === currentLocation(input.events, input.actorId)
            ? `${name}仍在原处。`
            : undefined
      if (still === undefined) return { status: input.status, description: reason }
      const sentence = /[。！？.!?]$/u.test(reason) ? reason : reason + '。'
      return { status: input.status, description: `${sentence}这次没有执行，${still}` }
    }
    const latest = input.events.findLast(e => {
      if (e.eventType !== 'status.updated') return false
      const source = statusData(e).source
      return (
        source.kind === 'operation' && source.actorId === input.actorId && source.operation === id.slice(PREFIX.length)
      )
    })
    const description = latest === undefined ? undefined : object(latest.data).description
    return typeof description === 'string' ? { status: 'accepted', description } : characterExecutionResult(input)
  }

  /** Adjudication returns effects; the core owns fencing, freshness and the atomic round. */
  async #commitRound(
    worldPath: string,
    address: WorldAddress,
    owner: string,
    build: (
      snapshot: WorldRoundSnapshot,
    ) =>
      | { events: WorldEventDraft[]; authority: WorldJsonObject }
      | undefined
      | Promise<{ events: WorldEventDraft[]; authority: WorldJsonObject } | undefined>,
    actorId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const store = new WorldStore(worldPath),
      leases = new WriterLeaseService(worldPath)
    try {
      const committed = await executeWorldRound({ store, leases, address, owner, actorId, signal }, build)
      if (committed) this.externalActions?.committed()
      return committed !== undefined
    } catch (error) {
      this.externalActions?.failed()
      throw error
    } finally {
      leases.close()
      store.close()
    }
  }

  /** Commits the initial values once, as their own round, when the world has no status event yet. */
  async ensureInitial(worldPath: string, address: WorldAddress, playerId: string): Promise<void> {
    await this.#commitRound(
      worldPath,
      address,
      'status-initial:' + randomUUID(),
      ({ events }) =>
        events.some(event => event.eventType === 'status.updated')
          ? undefined
          : {
              events: [this.initialEvent()],
              authority: { actorId: playerId, source: 'status-initial', status: 'accepted' },
            },
      playerId,
    )
  }

  /** The player's own status operation, adjudicated like an NPC's and committed as its own round with its
   * result observations. A rejection throws with the reason and commits nothing. Resolves to false when the
   * request was already committed, so a retry neither runs the operation nor ends another round. */
  apply(
    worldPath: string,
    address: WorldAddress,
    playerId: string,
    operation: string,
    parameters: WorldJsonObject,
    requestId: string,
    targetId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const owner = 'status:' + requestId,
      actionId = owner + ':action',
      request = { operation, parameters, ...(targetId === undefined ? {} : { targetId }) }
    return this.#commitRound(
      worldPath,
      address,
      owner,
      async ({ head, prior, events, manifest }) => {
        if (prior) {
          const same = (value: unknown) => Buffer.from(canonicalizeWorldJson(value as WorldJsonObject)).toString('utf8')
          if (same(prior.authority.request) !== same(request)) throw new TypeError('同一请求不能改变内容')
          return undefined
        }
        const input = {
          worldPath,
          address,
          playerId,
          manifest,
          events,
          asOfWorldSeq: head.headSeq,
          actorId: playerId,
          operationId: operation,
          parameters,
          ...(targetId === undefined ? {} : { targetId }),
        }
        let result = this.#adjudicate(input)
        if (result.status === 'rejected' && result.reason === CAPABILITY_PENDING) {
          const context: RulebookResolutionContext = {
            manifest,
            events,
            characterId: playerId,
            asOfWorldSeq: head.headSeq,
            action: {
              actionType: 'interact',
              parameters: {
                targetRef: { kind: 'character', id: playerId },
                bindingId: 'status',
                definitionRef: { id: PREFIX + operation, version: 1 },
                arguments: parameters,
              },
            },
          }
          result = await this.externalActions!.execute(
            { operation, actorId: playerId, parameters, asOfWorldSeq: head.headSeq },
            context,
            worldPath,
            address,
            signal,
            () => this.#adjudicate(input),
          )
        }
        if (result.status === 'rejected') throw new TypeError(result.reason)
        const accepted = result
        return {
          authority: { actorId: playerId, request, status: 'accepted' },
          events: withSceneDecisions(worldPath, scene =>
            immediateActionDrafts({
              scene,
              address,
              manifest,
              events,
              headSeq: head.headSeq,
              actorId: brandId(playerId, 'CharacterId'),
              actionId,
              action: { actionType: 'interact', parameters },
              result: { status: 'accepted', events: accepted.events, observationScope: accepted.observationScope },
              description: accepted.description,
            }),
          ),
        }
      },
      playerId,
      signal,
    )
  }

  /** Runs the optional `onRoundEnd` hook once after an accepted player input and commits its result as the
   * round's last status event. A failing hook commits nothing and is not retried; storage faults still throw.
   * A `pause` round has no input: it always records itself, marked, so it counts as the player's turn. */
  async endRound(
    worldPath: string,
    address: WorldAddress,
    turnStartSeq: number,
    pause = false,
  ): Promise<{ ok: boolean; error?: string }> {
    let error: string | undefined
    await this.#commitRound(worldPath, address, 'status-round:' + randomUUID(), ({ events }) => {
      const { round, turnCommits } = playerRoundNumber(events, turnStartSeq, pause)
      // Folding stored events stays outside the catch: corrupt history must surface, not read as a hook failure.
      const truth = this.truth(events)
      let data: StatusEventData | undefined
      try {
        data = this.#state.roundResult(events, this.#mechanism.endRound(truth, round), round)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      // A turn whose commits cannot be told apart later, such as a line said with an action, always records
      // its round (without changes when the hook gave none), so later counts start after it.
      if (data === undefined && turnCommits > 1) data = { source: { kind: 'round', round }, changes: [], reveals: [] }
      if (pause) data = { ...(data ?? { changes: [], reveals: [] }), source: { kind: 'round', round, pause: true } }
      return (
        data && {
          events: [{ eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }],
          authority: { source: 'status-round', round, status: 'accepted' },
        }
      )
    })
    return error === undefined ? { ok: true } : { ok: false, error }
  }
}
