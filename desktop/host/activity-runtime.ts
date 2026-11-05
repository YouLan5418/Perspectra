import { randomUUID } from 'node:crypto'
import {
  brandId,
  checkExpressionPolicy,
  parseExpressionSegments,
  resolutionAuthority,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
  type WorldEventDraft,
  type ActivityState,
  type ActivityPolicy as Policy,
  type ActivityRequest,
  type AutoStartCheck,
} from '@harness-world/contracts'
import type { ActivityInstance } from '@harness-world/plugin-sdk'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import {
  SceneDecisionService,
  executeWorldRound,
  characterExecutionResult,
  type CharacterTurnRequest,
  rejectionReasonText,
  ActivityStateRules,
  activityProgress,
  activityObject as object,
  activityExact as exact,
  activityStrings as strings,
  activityJson as json,
  parseActivityAutoStart,
  activityOperationOptions,
  checkActivityExpression,
  filterActivityAffordances,
  parseActivityOperationResult,
  parseActivityPlan,
  validateActivityDecision,
  abandonedActivity,
  activityOutcomeObservations,
  activityResultMetadata,
  activityUpdatedEvent,
  checkActivityRequest,
  escapedActivity,
  resumedActivity,
  startedActivity,
  suspendedActivity,
  actorWorldView,
  immediateActionDrafts,
  readActivityWorld,
  type ActivityWorld,
} from '@harness-world/application'
import {
  RulebookRegistry,
  type RulebookEvent,
  type RulebookResolver,
  type RulebookResolutionContext,
  type ActionAffordance,
  type CompiledWorldManifest,
} from '@harness-world/kernel'
import type { StatusRuntime } from './status-runtime.ts'
/** What the catalog lends each activity: one round's random sequence, the live committed prefix and its lifetime. */
export interface ActivityBindings {
  readonly randomSource: () => number
  readonly readCurrent: () => ActivityState | undefined
  readonly signal?: AbortSignal
}
/** Authorizes activity inputs and checks proposals before the existing core execution path. */
export class ActivityRuntime {
  readonly #mechanism: ActivityInstance
  readonly #rules: ActivityStateRules
  resolveAction:
    | ((
        context: RulebookResolutionContext,
        resolve: () => import('@harness-world/kernel').RulebookResolution,
      ) => Promise<import('@harness-world/kernel').RulebookResolution>)
    | undefined
  get title() {
    return this.#rules.title
  }
  get opening() {
    return this.#rules.opening
  }
  get npcIds() {
    return this.#rules.npcIds
  }
  get hasAutoStart() {
    return this.#mechanism.hasAutoStart
  }
  get participantSelection() {
    return this.#rules.participantSelection
  }
  /** The player-facing operations, by id and label, for the pack lens. */
  get operationLabels(): readonly { readonly id: string; readonly label: string }[] {
    return this.#rules.operations.map(op => ({ id: op.id, label: op.label }))
  }
  readonly #bindings: ActivityBindings
  get signal(): AbortSignal | undefined {
    return this.#bindings.signal
  }
  constructor(
    mechanism: ActivityInstance,
    readonly worldPath: string,
    readonly address: WorldAddress,
    readonly playerId: string,
    readonly key: string,
    readonly status: StatusRuntime | undefined,
    readonly coreRules: RulebookRegistry,
    bindings: ActivityBindings,
  ) {
    this.#mechanism = mechanism
    this.#bindings = bindings
    this.#rules = new ActivityStateRules(mechanism.definition, playerId, key)
  }
  state(events: readonly RulebookEvent[]) {
    return this.#rules.state(events)
  }
  #initialize(input: WorldJsonObject): unknown {
    let active = true
    try {
      return this.#mechanism.initialize(input, () => {
        if (!active) throw new Error('Activity random capability has ended')
        return this.#bindings.randomSource()
      })
    } finally {
      active = false
    }
  }
  current(): ActivityState | undefined {
    // Callers and creator hooks must not mutate the cached committed state.
    return structuredClone(this.#bindings.readCurrent())
  }
  scoped(state: ActivityState, actorId: string): WorldJsonObject {
    return this.#rules.scoped(state, actorId)
  }
  policy(state: ActivityState, actorId: string): Policy {
    return this.#rules.policy(this.#mechanism.policy(this.scoped(state, actorId), actorId))
  }
  options(state: ActivityState, actorId: string): WorldJsonObject[] {
    return activityOperationOptions(state, this.policy(state, actorId), this.#rules.operations, actorId)
  }
  /**
   * `shared.state` is this activity's committed state from a prefix the caller already read. `shared.world` lends
   * one snapshot to every activity in a pass. `shared.foreground` says another activity runs, so start choices,
   * which no surface shows then, are not computed.
   */
  view(
    actorId: string,
    shared: {
      state?: ActivityState | undefined
      world?: ActivityWorld
      readWorld?: () => ActivityWorld
      foreground?: boolean
    } = {},
  ): WorldJsonObject {
    const state = 'state' in shared ? shared.state : this.current()
    const starting = !shared.foreground || state?.game.active === true
    let snapshot = shared.world
    const read = () => (snapshot ??= shared.readWorld?.() ?? readActivityWorld(this.worldPath, this.address))
    let selection: WorldJsonObject | undefined
    if (starting && this.participantSelection && actorId === this.playerId) {
      const manifest = read().manifest
      const world = read().worldView(actorId)
      const candidates = manifest.characters
        .filter(
          character =>
            character.characterId !== actorId &&
            !manifest.playerBindings.some(binding => binding.characterId === character.characterId) &&
            (world.characterIds as string[]).includes(character.characterId) &&
            (!this.participantSelection!.candidates ||
              this.participantSelection!.candidates.includes(character.characterId)),
        )
        .map(character => ({ id: character.characterId, name: character.name }))
      selection = { min: this.participantSelection.min, max: this.participantSelection.max, candidates }
    }
    const member = state?.participants.includes(actorId) === true
    const quick =
      actorId === this.playerId && !state?.game.active && state?.suspendedTurn === undefined
        ? this.#rules.operations.filter(op => op.quick).map(op => ({ id: op.id, label: op.label }))
        : []
    return {
      title: this.title,
      activityKey: this.key,
      suspended: member && state?.suspendedTurn !== undefined,
      available: actorId === this.playerId,
      // A running or paused activity has no start condition to check (autoStartCandidate would return undefined).
      ...(starting &&
      actorId === this.playerId &&
      !state?.game.active &&
      state?.suspendedTurn === undefined &&
      this.hasAutoStart &&
      !this.#manualStartAllowed(read())
        ? { manualStart: false }
        : {}),
      ...(quick.length ? { quickOperations: quick } : {}),
      ...(selection ? { participantSelection: selection } : {}),
      ...(state && member
        ? {
            ...this.scoped(state, actorId),
            policy: state.game.active ? this.policy(state, actorId) : null,
            options: state.game.active ? this.options(state, actorId) : [],
          }
        : { id: null, revision: 0 }),
    }
  }
  projectContext(context: WorldJsonObject, canPerform: boolean): WorldJsonObject {
    const state = this.current(),
      actorId = String(object(context.character).characterId)
    if (!state?.game.active || !state.participants.includes(actorId)) return context
    const policy = this.policy(state, actorId)
    return {
      ...context,
      activity: this.scoped(state, actorId),
      expressionPolicy: {
        speech: policy.speech,
        speechChoices: policy.speechChoices,
        narration: policy.narration,
      },
      affordances: this.filterAffordances(
        context.affordances as unknown as ActionAffordance[],
        state,
        actorId,
        canPerform,
      ) as unknown as WorldJsonObject[],
    }
  }
  /** Optional response source, with only the current character's authorized request.
   * Includes the final continuation of an activity-ending operation, never later ordinary turns.
   * This does not execute or commit anything; the host retains all decision validation.
   */
  simulate(request: CharacterTurnRequest): WorldJsonValue | undefined {
    const actor = String(object(request.context.character).characterId),
      state = this.current()
    if (!state || actor === this.playerId || !state.participants.includes(actor)) return undefined
    const anchor = request.context.activity
    const metadata = request.result?.observationMetadata as WorldJsonObject | undefined
    const ended = metadata?.activity as WorldJsonObject | undefined
    if (anchor === undefined) {
      if (!request.continuation || state.game.active || ended?.id !== state.id || ended.lifecycle !== 'ended')
        return undefined
    } else checkActivityRequest(state, object(anchor).id, object(anchor).revision, actor)
    const output = this.#mechanism.simulate(request)
    return output === null ? undefined : (output as WorldJsonValue)
  }
  filterAffordances(
    base: readonly ActionAffordance[],
    state: ActivityState,
    actorId: string,
    canPerform = true,
  ): ActionAffordance[] {
    return filterActivityAffordances(
      base,
      this.policy(state, actorId),
      canPerform ? this.options(state, actorId) : [],
      canPerform,
    )
  }
  validateDecision(decision: WorldJsonObject, request: CharacterTurnRequest): void {
    const anchor = request.context.activity
    if (anchor === undefined) return
    const actor = String(object(request.context.character).characterId),
      snapshot = object(anchor),
      state = this.current()
    checkActivityRequest(state, snapshot.id, snapshot.revision, actor)
    validateActivityDecision(decision, this.policy(state, actor), Number(request.context.publicationCharacters ?? 2000))
  }
  rulebooks(external?: RulebookResolver): RulebookRegistry {
    const core = external ?? this.coreRules.resolve('builtin:speak-move', 2, 'activity', this.address)
    // The host's own player actions get the same status operations as the runtime chain.
    const base = external ?? this.status?.resolver(core, this.worldPath, this.address, this.playerId) ?? core
    const resolver: RulebookResolver = {
      affordances: context => {
        const values = base.affordances(context),
          state = this.state(context.events),
          actor = String(context.characterId)
        return state?.game.active && state.participants.includes(actor)
          ? this.filterAffordances(values, state, actor)
          : values
      },
      resolve: context => this.#resolve(context, base),
    }
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, resolver)
    return registry
  }
  #resolve(context: RulebookResolutionContext, base: RulebookResolver) {
    const state = this.state(context.events),
      actor = String(context.characterId),
      action = context.action
    const p = object(action.parameters),
      definition = typeof p.definitionRef === 'object' ? object(p.definitionRef) : undefined
    if (typeof definition?.id === 'string' && definition.id.startsWith('activity:')) {
      if (action.actionType !== 'interact') throw new TypeError('游戏操作必须使用 interact')
      exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
      exact(definition, ['id', 'version'])
      const args = object(p.arguments),
        target = object(p.targetRef)
      checkActivityRequest(state, args.activityId, args.revision, actor)
      if (
        p.bindingId !== state.id ||
        json(target) !== json({ kind: 'character', id: actor }) ||
        definition.version !== 1
      )
        throw new TypeError('活动绑定无效')
      const operation = definition.id.slice(9),
        op = this.#rules.operations.find(v => v.id === operation),
        policy = this.policy(state, actor)
      if (!op || !policy.operations.includes(operation) || (op.requiresTurn && state.game.turn !== actor))
        throw new TypeError('尚未轮到你或操作未被允许')
      const { activityId: _id, revision: _revision, ...parameters } = args
      if (!this.#rules.validArguments(operation, parameters)) throw new TypeError('游戏操作参数无效')
      const world = this.#worldView(context.manifest, context.events, actor, context.asOfWorldSeq)
      const resolved = parseActivityOperationResult(
        this.#mechanism.resolve(state, actor, operation, parameters, world, this.status?.truth(context.events) ?? null),
        this.#rules,
        state,
      )
      if ('rejected' in resolved) throw new TypeError(resolved.rejected)
      const { next } = resolved
      const update = this.#event(next, resolved.description, actor, context.actionId ?? '', operation)
      // Status changes commit with the activity update or not at all; reveals reach only the actor's scene.
      const status: WorldEventDraft[] = []
      if (Object.hasOwn(resolved, 'status')) {
        if (!this.status) throw new TypeError('本包没有状态脚本，活动不能改变状态')
        status.push(
          this.status.activityEvent(context.events, this.key, actor, resolved.status, [
            ...new Set([actor, ...(world.characterIds as string[])]),
          ]),
        )
      }
      const scripted: WorldEventDraft[] = []
      if (Object.hasOwn(resolved, 'playerExpression')) {
        if (actor !== this.playerId) throw new TypeError('只有玩家活动操作可以提交脚本玩家表达')
        // `narration` describes what happens around the player instead of putting words in their mouth.
        const expression = object(resolved.playerExpression),
          field = Object.hasOwn(expression, 'narration') ? 'narration' : 'text'
        exact(expression, [field])
        const content = expression[field]
        if (typeof content !== 'string' || !content.trim() || content.length > 2000)
          throw new TypeError('脚本玩家表达无效')
        checkActivityExpression(policy, field === 'text' ? { speech: content } : { narration: content })
        const actionId = (context.actionId ?? '') + ':scripted-player'
        const speech = base.resolve({
          ...context,
          actionId,
          action: {
            actionType: 'speak',
            parameters: {
              ...(field === 'text' ? { text: content } : { text: '', narration: content }),
              scope: 'scene_public',
            },
          },
        })
        if (speech.status !== 'accepted') throw new TypeError('脚本玩家表达没有通过规则裁定')
        const source = { script: 'scripts/activity.js', operation, activityId: state.id, revision: state.revision }
        const sourcedUpdate = {
          ...update,
          data: { ...object(update.data), scriptedPlayerExpression: { [field]: content, source } },
        }
        scripted.push(
          ...speech.events,
          ...this.#speechObservations(context.events, actor, actionId, speech.events, context.asOfWorldSeq),
          {
            eventType: 'action.resolved',
            eventVersion: 1,
            data: { actorId: actor, actionId, actionType: 'speak', accepted: true, sourceRole: 'player' },
          },
        )
        return {
          status: 'accepted' as const,
          events: [sourcedUpdate, ...status, ...scripted],
          observationScope: {
            scope: 'direct' as const,
            recipientIds: resolved.audience === 'self' ? [actor] : state.participants,
          },
        }
      }
      return {
        status: 'accepted' as const,
        events: [update, ...status],
        observationScope: {
          scope: 'direct' as const,
          recipientIds: resolved.audience === 'self' ? [actor] : state.participants,
        },
      }
    }
    if (state?.game.active && state.participants.includes(actor)) {
      const policy = this.policy(state, actor)
      if (action.actionType === 'speak') {
        const expression = {
          ...(Object.hasOwn(p, 'text') && p.text !== '' ? { speech: p.text } : {}),
          ...(Object.hasOwn(p, 'narration') && p.narration !== '' ? { narration: p.narration } : {}),
        }
        if (p.segments !== undefined)
          checkExpressionPolicy(parseExpressionSegments(p.segments, context.publicationCharacters ?? 2000), policy)
        else checkActivityExpression(policy, expression)
      } else if (action.actionType === 'move') {
        if (!policy.move) throw new TypeError('活动期间禁止移动')
      } else if (action.actionType !== 'interact' || !policy.interactions.includes(String(definition?.id))) {
        throw new TypeError('活动期间禁止此交互')
      }
    }
    const result = base.resolve(context)
    if (
      state?.game.active &&
      state.participants.includes(actor) &&
      action.actionType === 'speak' &&
      result.status === 'accepted'
    ) {
      const published = result.events.find(e => e.eventType === 'character.speak')
      const game = this.#mechanism.published(state, actor, published?.data ?? null)
      if (game !== null) {
        const next = { ...state, revision: state.revision + 1, game: this.#rules.game(game, state.participants) }
        return {
          ...result,
          events: [...result.events, this.#event(next, '', actor, context.actionId ?? '', 'published')],
        }
      }
    }
    return result
  }
  #event(
    state: ActivityState,
    description: string,
    actorId: string,
    actionId: string,
    operation: string,
  ): WorldEventDraft {
    return activityUpdatedEvent({ key: this.key, state, description, actorId, actionId, operation })
  }
  #worldView(
    manifest: CompiledWorldManifest,
    events: readonly RulebookEvent[],
    actorId: string,
    asOfWorldSeq: number | undefined,
  ): WorldJsonObject {
    return actorWorldView(this.worldPath, this.address, manifest, events, actorId, asOfWorldSeq)
  }
  #speechObservations(
    events: readonly RulebookEvent[],
    actorId: string,
    actionId: string,
    drafts: readonly WorldEventDraft[],
    asOfWorldSeq: number | undefined,
  ): WorldEventDraft[] {
    if (asOfWorldSeq === undefined) throw new TypeError('活动世界视图缺少提交前缀')
    const store = new WorldStore(this.worldPath),
      availability = new CharacterRuntimeAvailabilityService(this.worldPath)
    try {
      const audience = new SceneDecisionService(store, availability).audienceForAction(
        this.address,
        brandId(actorId, 'CharacterId'),
        events,
        asOfWorldSeq,
        { scope: 'scene_public' },
      )
      const speech = drafts.find(e => e.eventType === 'character.speak')
      if (!speech) throw new TypeError('表达裁定未生成发言事件')
      return [...new Set([...audience.fullContentCharacterIds, actorId])].map(observerId => ({
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: {
          id: actionId + ':' + observerId,
          value: { observerId, content: { actorId, actionType: 'speak', status: 'accepted', speech: speech.data } },
        },
      }))
    } finally {
      availability.close()
      store.close()
    }
  }
  executionResult = (input: Parameters<typeof characterExecutionResult>[0]) => {
    const parameters = object(input.action.parameters)
    if (String(object(parameters.definitionRef ?? {}).id).startsWith('activity:') && input.status === 'accepted') {
      const latest = input.events.findLast(e => e.eventType === 'activity.updated')
      if (latest) {
        const data = object(latest.data)
        return {
          status: 'accepted' as const,
          description: String(data.description),
          observationMetadata: activityResultMetadata(this.state([latest])!, String(data.operation)),
        }
      }
    }
    return characterExecutionResult(input)
  }
  #plan(value: unknown): string | undefined {
    return parseActivityPlan(value, this.current(), this.playerId)
  }
  // Scheduling sees the whole committed state, internal included: a game may keep whose hidden turn it is
  // out of every participant's view and still decide whom to activate. Only an activation leaves the script.
  schedule(): string | undefined {
    const state = this.current()
    if (!state?.game.active) return undefined
    return this.#plan(this.#mechanism.schedule(state))
  }
  outcome(result: WorldJsonObject): string | undefined {
    const state = this.current()
    if (!state?.game.active) return undefined
    return this.#plan(this.#mechanism.outcome(result, state))
  }
  #observations(
    state: ActivityState,
    description: string,
    actor: string,
    actionId: string,
    observerIds = state.participants,
    operation = state.revision === 1 ? 'start' : 'result',
  ): readonly WorldEventDraft[] {
    return activityOutcomeObservations({ state, description, actorId: actor, actionId, observerIds, operation })
  }
  /** The author's start condition after a player round. Only reads truth and the player's authorized facts;
   * undefined when this script declares no condition, already runs, or holds paused progress for the player. */
  autoStartCandidate(
    snapshot?: ActivityWorld,
  ):
    | { conditions: number; met: boolean; checks: AutoStartCheck[]; parameters: WorldJsonObject; notice?: string }
    | undefined {
    if (!this.hasAutoStart) return undefined
    snapshot ??= readActivityWorld(this.worldPath, this.address)
    const current = this.state(snapshot.events)
    if (current?.game.active || current?.suspendedTurn !== undefined) return undefined
    const truth = snapshot.truth(this.status)
    const world = snapshot.worldView(this.playerId)
    const previous = current ? this.scoped(structuredClone(current), this.playerId) : null
    const output = this.#mechanism.autoStart(truth, world, previous)
    return parseActivityAutoStart(output, this.participantSelection)
  }

  /** A script with autoStart offers its manual start only while the same conditions all hold. */
  #manualStartAllowed(snapshot?: ActivityWorld): boolean {
    try {
      return this.autoStartCandidate(snapshot)?.met !== false
    } catch {
      // A broken hook hides the entry; apply re-runs it and reports the error, as automatic starts do.
      return false
    }
  }
  /** `quiet` marks the start a quick operation makes on the player's behalf: it writes no opening line. */
  async apply(request: ActivityRequest, auto?: { notice?: string }, quiet = false): Promise<boolean> {
    if (request.operation === 'start' && auto === undefined && this.autoStartCandidate()?.met === false)
      throw new TypeError('这场活动的开始条件尚未满足')
    if (request.activityId === null && this.#rules.operations.some(op => op.quick && op.id === request.operation)) {
      // Two ordinary commits: a management start, then the counted operation. A retry reuses both request IDs.
      // The player made one action, so only the operation's own result is shown.
      if (request.revision !== 0 || Object.keys(request.parameters).length) throw new TypeError('快捷操作请求已失效')
      const startId = request.requestId + ':start'
      const startedNow = await this.apply({ ...request, operation: 'start', requestId: startId }, undefined, true)
      const store = new WorldStore(this.worldPath)
      let started: ActivityState
      try {
        const update = store
          .readEvents(this.address)
          .findLast(e => e.eventType === 'activity.updated' && object(e.data).requestId === startId)
        if (!update) throw new TypeError('快捷操作的活动没有开始')
        started = object(update.data).state as unknown as ActivityState
      } finally {
        store.close()
      }
      return (await this.apply({ ...request, activityId: started.id, revision: started.revision })) || startedNow
    }
    const store = new WorldStore(this.worldPath),
      leases = new WriterLeaseService(this.worldPath),
      owner = 'activity:' + request.requestId
    const availability = new CharacterRuntimeAvailabilityService(this.worldPath)
    let retry = false
    try {
      const committed = await executeWorldRound(
        { store, leases, address: this.address, owner, actorId: this.playerId, signal: this.signal },
        ({ head, events }) => {
          const current = this.state(events)
          const foreground = [...activityProgress(events).values()].find(state => state.game.active)
          if (request.activityKey !== undefined && request.activityKey !== this.key)
            throw new TypeError('活动标识不匹配')
          const input = { ...request, actorId: this.playerId }
          const prior = events.findLast(
            e => e.eventType === 'activity.updated' && object(e.data).requestId === request.requestId,
          )
          if (prior) {
            if (json(object(object(prior.data).input)) !== json(input)) throw new TypeError('同一请求 ID 不能改变内容')
            return undefined
          }
          const actionId = owner + ':action'
          let state: ActivityState, description: string, drafts: WorldEventDraft[], observerIds: string[]
          if (request.operation === 'start') {
            if (
              foreground ||
              current?.suspendedTurn !== undefined ||
              request.activityId !== null ||
              request.revision !== 0
            )
              throw new TypeError('已有活动、存在暂停进度或开始请求失效')
            if (this.participantSelection) exact(request.parameters, ['npcIds'])
            else if (Object.keys(request.parameters).length) throw new TypeError('开始操作没有参数')
            const npcIds = this.participantSelection ? strings(request.parameters.npcIds) : this.npcIds
            if (!this.#rules.validParticipants([this.playerId, ...npcIds]))
              throw new TypeError('选择的活动参与者不符合人数或候选限制')
            const manifest = store.readManifest(this.address)!.manifest as CompiledWorldManifest
            if (
              npcIds.some(
                id =>
                  !manifest.characters.some(c => c.characterId === id) ||
                  manifest.playerBindings.some(b => b.characterId === id),
              )
            )
              throw new TypeError('活动 NPC 未声明')
            const scene = new SceneDecisionService(store, availability).decideFromEvents(
              this.address,
              brandId(this.playerId, 'CharacterId'),
              events,
              head.headSeq,
            )
            if (npcIds.some(id => !scene.observerIds.includes(brandId(id, 'CharacterId'))))
              throw new TypeError('需要与游戏参与者在同一场景')
            const participants = [this.playerId, ...npcIds]
            state = startedActivity({
              id: 'activity:' + randomUUID(),
              participants,
              game: this.#rules.game(
                this.#initialize({
                  playerId: this.playerId,
                  npcIds,
                  world: this.#worldView(manifest, events, this.playerId, head.headSeq),
                  previous: current ? this.scoped(current, this.playerId) : null,
                }),
                participants,
              ),
            })
            description = this.title + '开始。'
            observerIds = participants
            drafts = [this.#event(state, description, this.playerId, actionId, 'start')]
          } else if (['suspend', 'resume', 'abandon'].includes(request.operation)) {
            if (
              !current ||
              current.id !== request.activityId ||
              current.revision !== request.revision ||
              Object.keys(request.parameters).length
            )
              throw new TypeError('活动控制请求已失效')
            if (request.operation === 'suspend') {
              checkActivityRequest(current, request.activityId, request.revision, this.playerId)
              state = suspendedActivity(current)
              description = this.title + '已暂停，进度保留，恢复自由互动。'
            } else if (request.operation === 'abandon') {
              state = abandonedActivity(current)
              description = this.title + '的暂停进度已放弃，已提交的经历仍保留。'
            } else {
              if (foreground || current.suspendedTurn === undefined)
                throw new TypeError('请先暂停当前活动，或选择有暂停进度的活动')
              state = resumedActivity(current)
              const manifest = store.readManifest(this.address)!.manifest as CompiledWorldManifest
              const world = this.#worldView(manifest, events, this.playerId, head.headSeq)
              const rejection = this.#mechanism.resume(this.scoped(state, this.playerId), world)
              // A hook may accept remote continuation; without one, retain the original same-scene rule.
              if (rejection !== null) {
                const result = object(rejection)
                exact(result, ['rejectReason'])
                if (
                  typeof result.rejectReason !== 'string' ||
                  !result.rejectReason.trim() ||
                  result.rejectReason.length > 2000
                )
                  throw new TypeError('活动恢复条件返回无效')
                throw new TypeError(result.rejectReason)
              }
              if (
                this.#mechanism.hasResume() !== true &&
                state.participants.slice(1).some(id => !(world.characterIds as string[]).includes(id))
              )
                throw new TypeError('恢复活动需要与参与者在同一场景')
              this.#rules.game(state.game, state.participants)
              description = this.title + '已恢复，继续此前进度。'
            }
            observerIds = [this.playerId]
            drafts = [this.#event(state, description, this.playerId, actionId, request.operation)]
          } else {
            checkActivityRequest(current, request.activityId, request.revision, this.playerId)
            if (request.operation === 'retry') {
              if (Object.keys(request.parameters).length) throw new TypeError('重试没有参数')
              retry = true
              return undefined
            }
            if (!this.#rules.validArguments(request.operation, request.parameters))
              throw new TypeError('游戏操作参数无效')
            const manifest = store.readManifest(this.address)!
            const rules = this.rulebooks().resolve('builtin:speak-move', 2, owner, this.address)
            const resolution = rules.resolve({
              manifest: manifest.manifest as CompiledWorldManifest,
              manifestHash: manifest.manifestHash,
              events,
              characterId: this.playerId,
              actionId,
              asOfWorldSeq: head.headSeq,
              resolutionAuthority: resolutionAuthority('player', 'standard'),
              action: {
                actionType: 'interact',
                parameters: {
                  targetRef: { kind: 'character', id: this.playerId },
                  bindingId: current.id,
                  definitionRef: { id: 'activity:' + request.operation, version: 1 },
                  arguments: { activityId: current.id, revision: current.revision, ...request.parameters },
                },
              },
            })
            observerIds = [...(resolution.observationScope?.recipientIds ?? current.participants)]
            drafts = [...resolution.events]
            state = object(drafts[0]!.data).state as ActivityState
            description = String(object(drafts[0]!.data).description)
          }
          if (auto && request.operation !== 'start') throw new TypeError('只有开始可以由宿主自动发出')
          drafts[0] = {
            ...drafts[0]!,
            data: {
              ...object(drafts[0]!.data),
              requestId: request.requestId,
              input,
              ...(auto ? { source: 'auto' } : {}),
            },
          }
          // An author's opening (the automatic notice first, then the declared opening) replaces the fixed line for
          // the player alone; it is written from the player's side, so participants keep the fixed line.
          const notice = request.operation === 'start' ? (auto?.notice ?? this.opening) : undefined
          drafts.push(
            ...(quiet
              ? []
              : notice === undefined
                ? this.#observations(state, description, this.playerId, actionId, observerIds, request.operation)
                : [
                    ...this.#observations(state, notice, this.playerId, actionId, [this.playerId], request.operation),
                    ...this.#observations(
                      state,
                      description,
                      this.playerId,
                      actionId,
                      observerIds.filter(id => id !== this.playerId),
                      request.operation,
                    ),
                  ]),
            // A host-initiated start is direction, not a player action, so it never counts as a player round.
            {
              eventType: 'action.resolved',
              eventVersion: 1,
              data: {
                actorId: this.playerId,
                actionId,
                actionType: 'interact',
                accepted: true,
                sourceRole: auto ? 'director' : 'player',
              },
            },
          )
          return {
            events: drafts,
            authority: { actorId: this.playerId, request: input, status: 'accepted' },
          }
        },
      )
      return retry || committed !== undefined
    } finally {
      availability.close()
      leases.close()
      store.close()
    }
  }
  /** Host override: deliberately never invokes creator policy, resolve, schedule or onOutcome. */
  async escape(): Promise<void> {
    const store = new WorldStore(this.worldPath),
      leases = new WriterLeaseService(this.worldPath),
      owner = 'escape:' + randomUUID()
    try {
      await executeWorldRound(
        { store, leases, address: this.address, owner, actorId: this.playerId, signal: this.signal },
        ({ events }) => {
          const state = this.state(events)
          if (!state?.game.active) return
          const next = escapedActivity(state)
          const description = '玩家使用宿主逃生按钮中止活动，已解除本活动的交互限制与调度。'
          return {
            events: [
              this.#event(next, description, this.playerId, owner, 'host-escape'),
              ...this.#observations(next, description, this.playerId, owner),
            ],
            authority: { actorId: this.playerId, source: 'host-escape', status: 'accepted' },
          }
        },
      )
    } finally {
      leases.close()
      store.close()
    }
  }
  async speak(text: string, requestId: string, signal?: AbortSignal): Promise<void> {
    return this.worldAction(
      {
        actionType: 'speak',
        parameters: { text, scope: 'direct', addresseeIds: this.current()?.participants.slice(1) ?? [] },
      },
      requestId,
      signal,
    )
  }
  async worldAction(
    action: { actionType: string; parameters: WorldJsonObject },
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const store = new WorldStore(this.worldPath),
      leases = new WriterLeaseService(this.worldPath),
      owner = 'activity-world:' + requestId
    const availability = new CharacterRuntimeAvailabilityService(this.worldPath)
    try {
      const committed = await executeWorldRound(
        {
          store,
          leases,
          address: this.address,
          owner,
          actorId: this.playerId,
          signal: AbortSignal.any([...(this.signal ? [this.signal] : []), ...(signal ? [signal] : [])]),
        },
        async ({ head, events, prior }) => {
          const state = this.state(events)
          if (!state?.game.active) throw new TypeError('活动已结束')
          if (prior) {
            if (json(object(prior.authority.action)) !== json(action)) throw new TypeError('同一请求不能改变内容')
            return
          }
          if (action.actionType === 'speak') {
            const policy = this.policy(state, this.playerId)
            checkActivityExpression(policy, {
              ...(Object.hasOwn(action.parameters, 'text') ? { speech: action.parameters.text } : {}),
              ...(Object.hasOwn(action.parameters, 'narration') ? { narration: action.parameters.narration } : {}),
            })
          }
          const manifest = store.readManifest(this.address)!,
            rules = this.rulebooks().resolve('builtin:speak-move', 2, owner, this.address)
          const context = {
            manifest: manifest.manifest as CompiledWorldManifest,
            manifestHash: manifest.manifestHash,
            events,
            characterId: this.playerId,
            actionId: owner,
            asOfWorldSeq: head.headSeq,
            resolutionAuthority: resolutionAuthority('player', 'standard'),
            action,
          }
          const result = this.resolveAction
            ? await this.resolveAction(context, () => rules.resolve(context))
            : rules.resolve(context)
          // A rejected status operation and a plugin's rule tell the player their own reason; others stay generic.
          if (result.status !== 'accepted')
            throw new TypeError(
              this.status?.rejectionReason(result.events, this.playerId, result.reason) ??
                (result.reason?.startsWith('plugin:') ? rejectionReasonText(result.reason) : undefined) ??
                '这次操作未被规则接受',
            )
          const outcome = {
            manifest: manifest.manifest as CompiledWorldManifest,
            events: [...events, ...result.events],
            actorId: brandId(this.playerId, 'CharacterId'),
            action,
            status: result.status,
            reason: null,
          }
          const description = (this.status?.executionResult(outcome) ?? this.executionResult(outcome)).description
          const drafts = immediateActionDrafts({
            scene: new SceneDecisionService(store, availability),
            address: this.address,
            manifest: manifest.manifest as CompiledWorldManifest,
            events,
            headSeq: head.headSeq,
            actorId: brandId(this.playerId, 'CharacterId'),
            actionId: owner,
            action,
            result,
            description: String(description),
          })
          return {
            events: drafts,
            authority: { actorId: this.playerId, action, status: 'accepted' },
          }
        },
      )
      if (committed) this.status?.externalActions?.committed()
    } catch (error) {
      this.status?.externalActions?.failed()
      throw error
    } finally {
      availability.close()
      leases.close()
      store.close()
    }
  }
}
