import type {
  CharacterLoopActivation,
  CharacterLoopInstance,
  CharacterLoopPreparation,
  CharacterLoopSubmission,
} from '@harness-world/plugin-sdk'
import { characterVisibleItems } from './character-visible-items.ts'
import { randomUUID } from 'node:crypto'
import {
  brandId,
  canonicalizeWorldJson,
  parseExpressionSegments,
  resolutionAuthority,
  type CharacterId,
  type CharacterView,
  type StoredWorldEvent,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  characterRelationObservations,
  currentCharacterLifecycle,
  type CompiledWorldManifest,
  type RulebookRegistry,
  type RulebookResolution,
  type RulebookResolutionContext,
} from '@harness-world/kernel'
import {
  CognitionProjectionRebuilder,
  CharacterViewBuilder,
  CharacterRuntimeAvailabilityService,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import { actionObservations, movementRoute } from './action-observations.ts'
import { SceneDecisionService } from './scene-decision.ts'
import { characterExecutionResult, expressionAfterExecution } from './character-execution-result.ts'

/** A returned payload failed format validation, rather than a transport failure. */
export class InvalidCharacterOutputError extends TypeError {}
export class CharacterPresetError extends Error {}
export class CharacterLoopError extends Error {}

export interface CharacterTurnRequest {
  /** Host diagnostic correlation only; not included in model-visible context. */
  readonly decisionId?: string
  readonly context: WorldJsonObject
  readonly continuation: boolean
  readonly canPerform?: boolean
  readonly result?: WorldJsonObject
  readonly canContinueAfterPublish?: boolean
  readonly afterPublication?: boolean
  readonly canExpressBeforeAction?: boolean
}

/** Optional experiment observation; never becomes part of the Character request or World Event. */
export interface CharacterTurnResult {
  readonly status: 'published' | 'abstained' | 'budget_exhausted' | 'interrupted' | 'inactive' | 'stale' | 'failed'
  readonly calls: number
  /** Last prefix actually read by the model; scheduling must not consume later observations. */
  readonly asOfWorldSeq?: number
  readonly performResult?: WorldJsonObject
  readonly failure?: 'provider_failed' | 'invalid_output' | 'preset_failed'
}

// Turns sharing one store may compute independently, but serialize their complete commit/projection.
// Nothing here survives a process or becomes part of the world's durable protocol.
const activeCharacters = new WeakMap<WorldStore, Set<CharacterId>>()

class ActivationStopped extends Error {
  constructor(readonly status: 'stale' | 'inactive') {
    super(status)
  }
}

const commits = new WeakMap<WorldStore, Promise<void>>()
async function commitInOrder<T>(store: WorldStore, work: () => Promise<T>): Promise<T> {
  const previous = commits.get(store) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(done => {
    release = done
  })
  commits.set(store, current)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (commits.get(store) === current) commits.delete(store)
  }
}

function object(value: unknown): WorldJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object')
  return value as WorldJsonObject
}

const privateAudienceHint =
  '这句话是只对你说的（不是公开发言）。若你决定回应，受众由你选择：想只让对方听到，publish 时设 scope 为 private 或 direct，并把对方放进 addresseeIds；省略 scope 且不填 addresseeIds 时，你的回应全场可闻。同一次 publish 的所有片段共用一个受众，叙述里写“压低声音”不会改变实际受众。'

/** Marks speech addressed only to this character, so the reply audience is a conscious choice; never chooses it. */
function withAudienceHints(stimulus: readonly WorldJsonObject[], characterId: CharacterId): WorldJsonObject[] {
  const asObject = (value: WorldJsonValue | undefined): WorldJsonObject | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WorldJsonObject) : undefined
  return stimulus.map(item => {
    const speech = asObject(asObject(item.content)?.speech)
    if (speech === undefined) return item
    const addressed =
      (speech.scope === 'private' || speech.scope === 'direct') &&
      speech.characterId !== characterId &&
      Array.isArray(speech.addresseeIds) &&
      speech.addresseeIds.includes(characterId)
    return addressed ? { ...item, audienceHint: privateAudienceHint } : item
  })
}

function keys(value: WorldJsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('unexpected decision field')
}

/** One isolated activation, not a scheduler.
 * Uses the existing Rulebook, atomic WorldStore commit, scene audiences and character observations.
 * Intermediate model work is ephemeral; a committed operation is never rolled back for a failed reply.
 */
export class CharacterTurn {
  readonly #manifest: CompiledWorldManifest
  readonly #manifestHash
  readonly #scene: SceneDecisionService
  readonly #view: CharacterViewBuilder

  constructor(
    private readonly options: {
      readonly loop: CharacterLoopInstance
      readonly onLoopFailure?: (characterId: CharacterId, error: unknown) => void
      readonly address: WorldAddress
      readonly store: WorldStore
      readonly leases: WriterLeaseService
      readonly availability: CharacterRuntimeAvailabilityService
      readonly rulebooks: RulebookRegistry
      readonly decide: (
        request: CharacterTurnRequest,
        signal: AbortSignal,
        reserveFormatRetry?: () => boolean,
        beforeModelCall?: () => void,
      ) => Promise<unknown>
      readonly projectContext?: (context: WorldJsonObject, canPerform: boolean) => WorldJsonObject
      /** Optional host executor. No SQLite transaction is open while it awaits external work. */
      readonly resolveAction?: (
        context: RulebookResolutionContext,
        signal: AbortSignal,
        resolve: () => RulebookResolution,
      ) => Promise<RulebookResolution>
      readonly validateDecision?: (decision: WorldJsonObject, request: CharacterTurnRequest) => void
      readonly executionResult?: (
        input: Parameters<typeof characterExecutionResult>[0],
      ) => ReturnType<typeof characterExecutionResult> & { readonly observationMetadata?: WorldJsonObject }
      readonly onTrace?: (
        kind: 'action' | 'turn',
        characterId: string,
        decisionId: string | null,
        data: WorldJsonObject,
      ) => void
      /** Host projection runs after the complete action transaction, never on model output. */
      readonly onCommitted?: () => Promise<void>
      readonly onActionFailure?: () => void
      /** With Core, preserve the authorized tail after its successfully archived prefix. */
      readonly shortTermAfterSeq?: (characterId: CharacterId) => number | undefined
      readonly publicationCharacters?: number
      readonly activationTimeoutMs?: number
      readonly recentObservations?: number
      readonly recentSelfObservations?: number
      /** Only the ordinary, locally adjudicated path permits reusing an unchanged authorized view. */
      readonly allowUnrelatedCommits?: boolean
      /** Experimental, bounded extra decision after the first pre-action publication. */
      readonly continueAfterPublish?: boolean
      readonly beforeActionExpression?: boolean
    },
  ) {
    if (
      options.activationTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.activationTimeoutMs) ||
        options.activationTimeoutMs < 1000 ||
        options.activationTimeoutMs > 600000)
    )
      throw new RangeError('invalid activation timeout')
    parseExpressionSegments([{ type: 'speech', text: 'x' }], options.publicationCharacters ?? 2000)
    const stored = options.store.readManifest(options.address)
    if (stored === undefined || (stored.manifest as WorldJsonObject).schemaVersion !== 10) {
      throw new TypeError('a single-turn activation requires an activated v10 world')
    }
    this.#manifest = stored.manifest as CompiledWorldManifest
    this.#manifestHash = stored.manifestHash
    this.#scene = new SceneDecisionService(options.store, options.availability)
    this.#view = new CharacterViewBuilder(options.store)
  }

  #visibleState(
    characterId: CharacterId,
    asOfWorldSeq: number,
    canPerform: boolean,
    prepared?: { readonly history: readonly StoredWorldEvent[]; readonly view: CharacterView },
  ): string {
    const history = prepared?.history ?? this.options.store.readEvents(this.options.address, asOfWorldSeq)
    const {
      asOfWorldSeq: _viewSeq,
      bundleHash: _viewHash,
      ...view
    } = prepared?.view ?? this.#view.rebuildAt(this.options.address, characterId, asOfWorldSeq)
    const {
      asOfWorldSeq: _cognitionSeq,
      bundleHash: _cognitionHash,
      ...cognition
    } = new CognitionProjectionRebuilder(this.options.store).rebuildCharacterAt(
      this.options.address,
      characterId,
      asOfWorldSeq,
    )
    const scene = this.#scene.decideFromEvents(this.options.address, characterId, history, asOfWorldSeq)
    const rules = this.options.rulebooks.resolve(
      this.#manifest.rulebook.rulebookId,
      this.#manifest.rulebook.version,
      'turn-view',
      this.options.address,
    )
    const affordances = rules
      .affordances({
        manifest: this.#manifest,
        manifestHash: this.#manifestHash,
        events: history,
        characterId,
        asOfWorldSeq,
        publicationCharacters: this.options.publicationCharacters ?? 2000,
        resolutionAuthority: resolutionAuthority('agent', 'standard'),
      })
      .filter(value => canPerform || value.actionType === 'speak')
    return Buffer.from(
      canonicalizeWorldJson({
        view,
        cognition,
        people: scene.observerIds,
        affordances,
        items: characterVisibleItems(this.#manifest, history, characterId, scene.observerIds),
      } as unknown as WorldJsonObject),
    ).toString('utf8')
  }

  async run(
    characterId: CharacterId,
    options: {
      readonly signal?: AbortSignal
      readonly maxCalls?: 1 | 2 | 3
      /** Strict decision-call ceiling, including result-aware follow-ups. */
      readonly maxModelCalls?: number
      readonly beforeModelCall?: () => void
      readonly onCommitted?: (asOfWorldSeq: number, headSeq: number) => void
      readonly stimulus?: readonly WorldJsonObject[]
      readonly continuationOf?: {
        readonly actionId: string
        readonly afterSeq?: number
        readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
      }
    } = {},
  ): Promise<CharacterTurnResult> {
    const active = activeCharacters.get(this.options.store) ?? new Set<CharacterId>()
    activeCharacters.set(this.options.store, active)
    if (active.has(characterId)) throw new Error('character turn is busy')
    if (
      !this.#manifest.characters.some(character => character.characterId === characterId) ||
      this.#manifest.playerBindings.some(binding => binding.characterId === characterId)
    ) {
      throw new TypeError('activation requires a declared NPC')
    }
    active.add(characterId)
    const ownerId = `character-turn:${randomUUID()}`
    const lifetime = new AbortController()
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(this.options.activationTimeoutMs ?? 120_000),
      ...(options.signal ? [options.signal] : []),
    ])
    let lease: ReturnType<WriterLeaseService['acquire']> | undefined
    let calls = 0
    let performResult: WorldJsonObject | undefined
    let publicationFailure: WorldJsonObject | undefined
    let modelFailure: CharacterTurnResult['failure']
    let asOfWorldSeq: number | undefined
    let attempt = 0
    let decisionId: string | null = null
    const done = (status: CharacterTurnResult['status']): CharacterTurnResult => {
      this.options.onTrace?.('turn', characterId, decisionId, {
        status,
        calls,
        ...(status !== 'failed' || modelFailure === undefined ? {} : { failure: modelFailure }),
      })
      return {
        status,
        calls,
        ...(asOfWorldSeq === undefined ? {} : { asOfWorldSeq }),
        ...(performResult === undefined ? {} : { performResult }),
      }
    }
    let closed = false
    let busy = false
    let pendingOperation: Promise<unknown> | undefined
    let pendingRequest: CharacterTurnRequest | undefined
    let pendingSubmit: ((raw: unknown) => Promise<CharacterLoopSubmission>) | undefined
    let published = false
    const assertLive = () => {
      signal.throwIfAborted()
      if (closed) throw new Error('character activation has ended')
    }
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
      assertLive()
      if (busy) throw new Error('character activation operation is busy')
      busy = true
      const pending = (async () => {
        try {
          return await work()
        } finally {
          busy = false
        }
      })()
      pendingOperation = pending
      // The host also awaits abandoned work before releasing its store handles.
      void pending.catch(() => undefined)
      return pending
    }
    try {
      if (options.continuationOf !== undefined) {
        const prior = this.options.store
          .readEvents(this.options.address)
          .findLast(
            event =>
              event.eventType === 'action.resolved' &&
              event.seq > (options.continuationOf!.afterSeq ?? 0) &&
              object(event.data).actionId === options.continuationOf!.actionId &&
              object(event.data).actorId === characterId &&
              object(event.data).actionType === options.continuationOf!.action.actionType,
          )
        if (prior === undefined) return done('failed')
        const resolved = object(prior.data)
        performResult = {
          operationId: options.continuationOf.actionId,
          action: options.continuationOf.action,
          status: resolved.accepted === true ? 'accepted' : 'rejected',
          reason: resolved.reason ?? null,
          eventRefs: [prior.seq],
        }
      }
      const prepare = (settings: CharacterLoopPreparation): CharacterTurnRequest => {
        assertLive()
        if (busy) throw new Error('character activation operation is busy')
        modelFailure = undefined
        const { canContinueAfterPublish, afterPublication } = settings
        const canPerform = settings.canPerform && options.continuationOf === undefined
        const attemptId = attempt++
        let head = this.options.store.head(this.options.address)
        asOfWorldSeq = head.headSeq
        let history = this.options.store.readEvents(this.options.address, head.headSeq)
        const initialView = this.options.allowUnrelatedCommits
          ? this.#view.rebuildFromEvents(this.options.address, characterId, head.headSeq, history)
          : undefined
        const state =
          initialView === undefined
            ? undefined
            : this.#visibleState(characterId, head.headSeq, canPerform, { history, view: initialView })
        const isCurrent = () => {
          const current = this.options.store.head(this.options.address).headSeq
          return (
            current === asOfWorldSeq ||
            (state !== undefined && state === this.#visibleState(characterId, current, canPerform))
          )
        }
        if (currentCharacterLifecycle(history, characterId) !== 'active') throw new ActivationStopped('inactive')
        const rules = this.options.rulebooks.resolve(
          this.#manifest.rulebook.rulebookId,
          this.#manifest.rulebook.version,
          ownerId,
          this.options.address,
        )
        let ruleContext = {
          publicationCharacters: this.options.publicationCharacters ?? 2000,
          manifest: this.#manifest,
          manifestHash: this.#manifestHash,
          events: history,
          characterId,
          asOfWorldSeq: head.headSeq,
          resolutionAuthority: resolutionAuthority('agent', 'standard'),
        }
        const view =
          initialView ?? this.#view.rebuildFromEvents(this.options.address, characterId, head.headSeq, history)
        let scene = this.#scene.decideFromEvents(this.options.address, characterId, history, head.headSeq)
        const character = this.#manifest.characters.find(value => value.characterId === characterId)!
        const afterSeq = this.options.shortTermAfterSeq?.(characterId)
        const ordered = view.observations.toSorted((left, right) => left.sourceSeq - right.sourceSeq)
        const recentObservations =
          afterSeq === undefined
            ? ordered.slice(-(this.options.recentObservations ?? 16))
            : ordered.filter(record => record.sourceSeq > afterSeq)
        const recentSelfObservations =
          afterSeq === undefined
            ? (this.options.recentSelfObservations ?? 8) === 0
              ? []
              : view.selfObservations.slice(-(this.options.recentSelfObservations ?? 8))
            : view.selfObservations.filter(record => record.sourceSeq > afterSeq)
        // Do not copy scene member records or other characters' anchors into a model request.
        let context: WorldJsonObject = {
          publicationCharacters: this.options.publicationCharacters ?? 2000,
          character: { ...character, locationId: view.locationId },
          stimulus: withAudienceHints(options.stimulus ?? [], characterId),
          cognition: new CognitionProjectionRebuilder(this.options.store).rebuildCharacterAt(
            this.options.address,
            characterId,
            head.headSeq,
          ),
          scene: {
            locationId: view.locationId,
            name:
              this.#manifest.locations.find(location => location.locationId === view.locationId)?.name ??
              view.locationId ??
              '当前位置',
            people: scene.observerIds.map(id => ({
              characterId: id,
              name: this.#manifest.characters.find(value => value.characterId === id)?.name ?? id,
            })),
          },
          observations: recentObservations.map(record => {
            const value = object(record.value)
            if (value.content === null || typeof value.content !== 'object' || Array.isArray(value.content))
              return record
            const content = object(value.content)
            if (typeof content.reason !== 'string') return record
            const { reason, ...rest } = content
            const feedback = (this.options.executionResult ?? characterExecutionResult)({
              manifest: this.#manifest,
              events: history,
              actorId: characterId,
              action: { actionType: String(content.actionType), parameters: {} },
              status: String(content.status),
              reason,
            })
            return { ...record, value: { ...value, content: { ...rest, resultDescription: feedback.description! } } }
          }),
          selfObservations: recentSelfObservations,
          claims: view.claims,
          goals: view.goals,
          items: characterVisibleItems(this.#manifest, history, characterId, scene.observerIds),
          affordances: rules
            .affordances(ruleContext)
            .filter(value => canPerform || value.actionType === 'speak')
            .map(value => ({
              actionType: value.actionType,
              ...(value.destinations === undefined ? {} : { destinations: value.destinations }),
              ...(value.interactions === undefined ? {} : { interactions: value.interactions }),
            })),
        }
        context = this.options.projectContext?.(context, canPerform) ?? context
        const latestResult = publicationFailure ?? performResult
        const resultEventRefs = latestResult?.eventRefs
        const resultSeq = Array.isArray(resultEventRefs) ? resultEventRefs.at(-1) : undefined
        // A continuation describes its own committed action, even if another actor has since committed
        // a private result. Its scene/context above still uses the latest authorized world prefix.
        const visibleResult =
          latestResult === undefined
            ? undefined
            : (this.options.executionResult ?? characterExecutionResult)({
                manifest: this.#manifest,
                events: typeof resultSeq === 'number' ? history.filter(event => event.seq <= resultSeq) : history,
                actorId: characterId,
                action: object(latestResult.action) as { actionType: string; parameters: WorldJsonValue },
                status: String(latestResult.status),
                reason: typeof latestResult.reason === 'string' ? latestResult.reason : null,
              })
        const request: CharacterTurnRequest = {
          context,
          continuation:
            settings.continuation || options.continuationOf !== undefined || publicationFailure !== undefined,
          canPerform,
          canExpressBeforeAction:
            canPerform && this.options.beforeActionExpression === true && context.activity === undefined,
          ...(canContinueAfterPublish === undefined ? {} : { canContinueAfterPublish }),
          ...(afterPublication ? { afterPublication: true } : {}),
          ...(visibleResult === undefined
            ? {}
            : {
                result: {
                  ...visibleResult,
                  instruction:
                    publicationFailure !== undefined
                      ? '上次表达没有传达给收件人。请依据当前授权场景重新决定；只能选择本次提供的行动、表达或 abstain。'
                      : canPerform
                        ? '你已看到上次执行的真实结果。还可以申请一次受控交互，或直接表达或 abstain；未执行的后续状态变化不能写成既成事实。'
                        : expressionAfterExecution,
                  action: latestResult!.action!,
                },
              }),
        }
        pendingRequest = request
        pendingSubmit = async (raw: unknown): Promise<CharacterLoopSubmission> => {
          let controlledCommitted = false
          assertLive()
          if (!isCurrent()) throw new ActivationStopped('stale')
          modelFailure = 'invalid_output'
          const decision = object(structuredClone(raw))
          this.options.validateDecision?.(decision, request)
          if (decision.decision === 'abstain') {
            keys(decision, ['decision'])
            modelFailure = undefined
            return { decision: 'abstain', status: 'accepted', controlledCommitted: false, publicationRejected: false }
          }
          let action: { actionType: string; parameters: WorldJsonValue }
          let beforeAction: { actionType: string; parameters: WorldJsonValue } | undefined
          let rejectedPublication: WorldJsonObject | undefined
          const publication = (expression: WorldJsonObject) => {
            keys(expression, ['segments', 'scope', 'addresseeIds'])
            const segments = parseExpressionSegments(expression.segments, this.options.publicationCharacters ?? 2000)
            const addresseeIds = expression.addresseeIds ?? []
            if (
              !Array.isArray(addresseeIds) ||
              new Set(addresseeIds).size !== addresseeIds.length ||
              addresseeIds.some(
                id =>
                  typeof id !== 'string' ||
                  id === characterId ||
                  !this.#manifest.characters.some(character => character.characterId === id),
              )
            ) {
              throw new TypeError('addressee must be another declared character')
            }
            const scope = expression.scope ?? (addresseeIds.length === 0 ? 'scene_public' : 'direct')
            if (
              typeof scope !== 'string' ||
              !['scene_public', 'direct', 'private', 'self'].includes(scope) ||
              (scope === 'direct' || scope === 'private' ? addresseeIds.length === 0 : addresseeIds.length !== 0)
            ) {
              throw new TypeError('publication scope and addressees do not match')
            }
            return { actionType: 'speak', parameters: { segments, scope, addresseeIds } }
          }
          if (decision.decision === 'publish') {
            keys(decision, ['decision', 'segments', 'scope', 'addresseeIds'])
            const { decision: _decision, ...expression } = decision
            action = publication(expression)
          } else if (decision.decision === 'perform' && canPerform) {
            keys(decision, ['decision', 'actionType', 'parameters', 'before'])
            if (decision.actionType !== 'move' && decision.actionType !== 'interact')
              throw new TypeError('unsupported operation')
            const parameters = object(decision.parameters)
            keys(
              parameters,
              decision.actionType === 'move'
                ? ['locationId']
                : ['targetRef', 'bindingId', 'definitionRef', 'arguments'],
            )
            action = { actionType: decision.actionType, parameters }
            if (decision.before !== undefined) {
              if (!request.canExpressBeforeAction) throw new TypeError('pre-action expression unavailable')
              beforeAction = publication(object(decision.before))
            }
          } else throw new TypeError('operation budget exhausted; publish or abstain only')
          modelFailure = undefined
          const committed = await commitInOrder(this.options.store, async () => {
            assertLive()
            if (!isCurrent()) return false
            lease = this.options.leases.acquire(this.options.address, ownerId, 30_000)
            try {
              let ownPrefix: number | undefined
              let lastStatus: 'accepted' | 'rejected' = 'rejected'
              const actions = beforeAction === undefined ? [action] : [beforeAction, action]
              for (const [index, action] of actions.entries()) {
                assertLive()
                // Resolve and grant audiences at the latest prefix, never at a speculative model prefix.
                const latest = this.options.store.head(this.options.address)
                if (latest.headSeq !== head.headSeq || latest.eventHash !== head.eventHash)
                  history = this.options.store.readEvents(this.options.address, latest.headSeq)
                head = latest
                // The head may advance between the earlier freshness check and acquiring the lease.
                // Recheck while holding the lease before using the latest prefix to resolve this output.
                if (ownPrefix === undefined ? !isCurrent() : head.headSeq !== ownPrefix) return false
                ruleContext = { ...ruleContext, events: history, asOfWorldSeq: head.headSeq }
                scene = this.#scene.decideFromEvents(this.options.address, characterId, history, head.headSeq)
                this.options.validateDecision?.(decision, request)
                const roundId = brandId(
                  `${ownerId}:${attemptId}${beforeAction !== undefined && index === 0 ? ':before' : ''}`,
                  'InteractionRoundId',
                )
                const actionId = `${roundId}:action`
                const actionStartedAt = new Date().toISOString(),
                  actionStarted = performance.now()
                const actionContext = { ...ruleContext, action, roundId, actionId }
                const resolve = () => rules.resolve(actionContext)
                const resolution = this.options.resolveAction
                  ? await this.options.resolveAction(actionContext, signal, resolve)
                  : resolve()
                assertLive()
                if (this.options.store.head(this.options.address).headSeq !== head.headSeq)
                  throw new Error('World changed while awaiting an external action; do not repeat the external effect')
                if (action.actionType === 'speak' && resolution.reason === 'SPEECH_RECIPIENT_UNREACHABLE') {
                  rejectedPublication = { action, status: resolution.status, reason: resolution.reason }
                }
                const events: WorldEventDraft[] = [...resolution.events]
                if (resolution.status === 'accepted' && action.actionType === 'move') {
                  events.push(
                    ...this.#scene.transitionForMove(
                      this.options.address,
                      history,
                      characterId,
                      object(action.parameters).locationId as string,
                      head.headSeq,
                    ),
                  )
                }
                events.push({
                  eventType: 'action.resolved',
                  eventVersion: 1,
                  data: {
                    roundId,
                    actionId,
                    participantId: ownerId,
                    actorId: characterId,
                    actionType: action.actionType,
                    sourceRole: 'agent',
                    order: 0,
                    accepted: resolution.status === 'accepted',
                    reason: resolution.reason ?? null,
                  },
                })
                const audience = this.#scene.audienceForAction(
                  this.options.address,
                  characterId,
                  history,
                  head.headSeq,
                  {
                    scope: resolution.observationScope?.scope ?? 'scene_public',
                    ...(resolution.observationScope?.recipientIds === undefined
                      ? {}
                      : {
                          recipientIds: resolution.observationScope.recipientIds.map(id => brandId(id, 'CharacterId')),
                        }),
                  },
                )
                const speech = resolution.events.find(event => event.eventType === 'character.speak')
                const transfer = resolution.events.find(event => event.eventType === 'entity.transferred')
                const relations = characterRelationObservations(history, resolution.events)
                // The same move reaches both scenes, but neither scene alone grants the whole route.
                const route = movementRoute(
                  this.#scene,
                  this.options.address,
                  resolution.events.find(event => event.eventType === 'character.moved'),
                  { events: history, asOfSeq: head.headSeq },
                  { events: [...history, ...events], asOfSeq: head.headSeq + events.length },
                )
                const arrived =
                  route === undefined
                    ? []
                    : this.#scene.audienceForAction(
                        this.options.address,
                        characterId,
                        [...history, ...events],
                        head.headSeq + events.length,
                      ).fullContentCharacterIds
                const feedback = (this.options.executionResult ?? characterExecutionResult)({
                  manifest: this.#manifest,
                  events: [...history, ...resolution.events],
                  actorId: characterId,
                  action,
                  status: resolution.status,
                  reason: resolution.reason ?? null,
                })
                const observed = actionObservations({
                  roundId,
                  actionId,
                  actorId: characterId,
                  actionType: action.actionType,
                  status: resolution.status,
                  audience: {
                    fullContentCharacterIds: [...audience.fullContentCharacterIds, ...arrived, characterId],
                    occurrenceOnlyCharacterIds: audience.occurrenceOnlyCharacterIds,
                  },
                  ...(route === undefined ? {} : { route }),
                  shared: {
                    ...('observationMetadata' in feedback && feedback.observationMetadata !== undefined
                      ? { resultMetadata: feedback.observationMetadata }
                      : {}),
                    ...(speech === undefined ? {} : { speech: speech.data }),
                    ...(transfer === undefined ? {} : { interaction: transfer.data }),
                    ...(relations.length === 0 ? {} : { relations }),
                  },
                  perObserver: observerId => ({
                    resultDescription: String(feedback.description).replaceAll(
                      '你',
                      observerId === characterId ? '你' : '行动者',
                    ),
                  }),
                  playerBindings: this.#manifest.playerBindings,
                })
                events.push(...observed.events)
                const outbox = observed.outbox
                events.push({
                  eventType: 'world.tick-advanced',
                  eventVersion: 1,
                  data: { tick: head.tick + 1, roundId },
                })
                await this.options.store.commitRound({
                  address: this.options.address,
                  transactionId: brandId(`${roundId}:commit`, 'TransactionId'),
                  roundId,
                  expectedHeadSeq: head.headSeq,
                  expectedTick: head.tick,
                  nextTick: head.tick + 1,
                  events,
                  outbox,
                  writerFencingToken: lease.fencingToken,
                  correlationId: ownerId,
                  // This experiment does not fabricate a legacy batch Authority or provider-replay receipt.
                  authority: {
                    actorId: characterId,
                    actionId,
                    action,
                    status: resolution.status,
                    reason: resolution.reason ?? null,
                    resolutionAuthority: ruleContext.resolutionAuthority,
                  },
                })
                if (action.actionType !== 'speak') {
                  controlledCommitted = true
                  performResult = {
                    operationId: actionId,
                    action,
                    status: resolution.status,
                    reason: resolution.reason ?? null,
                    eventRefs: resolution.events.map((_, index) => head.headSeq + index + 1),
                  }
                }
                ownPrefix = this.options.store.head(this.options.address).headSeq
                this.options.onTrace?.('action', characterId, decisionId, {
                  actionId,
                  action: action as unknown as WorldJsonObject,
                  status: resolution.status,
                  reason: resolution.reason ?? null,
                  afterSeq: head.headSeq,
                  headSeq: ownPrefix,
                  startedAt: actionStartedAt,
                  durationMs: Math.round(performance.now() - actionStarted),
                  eventRefs: events.map((_, index) => head.headSeq + index + 1),
                })
                await this.options.onCommitted?.()
                options.onCommitted?.(asOfWorldSeq!, ownPrefix)
                lastStatus = resolution.status
                if (resolution.status !== 'accepted' && action.actionType === 'speak') return resolution.status
              }
              return lastStatus
            } finally {
              this.options.leases.release(this.options.address, ownerId, lease.fencingToken)
              lease = undefined
            }
          })
          if (committed === false) throw new ActivationStopped('stale')
          publicationFailure = rejectedPublication
          if (controlledCommitted) publicationFailure = undefined
          if (action.actionType === 'speak' && committed === 'accepted') published = true
          return {
            decision: action.actionType === 'speak' ? 'publish' : 'perform',
            status: committed,
            controlledCommitted,
            publicationRejected: rejectedPublication !== undefined,
          }
        }
        return structuredClone(request)
      }
      const activation: CharacterLoopActivation = {
        characterId,
        signal,
        maxCalls: options.maxCalls ?? 2,
        maxModelCalls: options.maxModelCalls ?? Infinity,
        continuation: options.continuationOf !== undefined,
        continueAfterPublish: this.options.continueAfterPublish === true,
        get calls() {
          return calls
        },
        get performResult() {
          return performResult === undefined ? undefined : structuredClone(performResult)
        },
        prepare,
        decide: reserveFormatRetry =>
          exclusive(async () => {
            if (!pendingRequest) throw new Error('prepare a character request before deciding')
            const request = structuredClone(pendingRequest)
            decisionId = randomUUID()
            let repaired = false
            calls += 1
            modelFailure = 'provider_failed'
            const raw = await this.options.decide(
              { ...request, decisionId },
              signal,
              () => {
                assertLive()
                if (repaired || reserveFormatRetry?.() === false) return false
                repaired = true
                calls += 1
                return true
              },
              options.beforeModelCall,
            )
            modelFailure = undefined
            assertLive()
            return raw
          }),
        submit: raw =>
          exclusive(async () => {
            if (!pendingSubmit) throw new Error('prepare a character request before submitting')
            const submit = pendingSubmit
            pendingSubmit = undefined
            pendingRequest = undefined
            return submit(raw)
          }),
      }
      const status = await this.options.loop.run(activation)
      if (busy) throw new CharacterLoopError('character loop returned with unfinished work')
      assertLive()
      if (
        !['published', 'abstained', 'budget_exhausted', 'failed'].includes(status) ||
        (status === 'published' && !published)
      )
        throw new CharacterLoopError('character loop returned an unsupported or uncommitted result')
      return done(status)
    } catch (error) {
      this.options.onActionFailure?.()
      if (signal.aborted) return done('interrupted')
      if (error instanceof ActivationStopped) return done(error.status)
      if (error instanceof CharacterLoopError) {
        modelFailure = undefined
        this.options.onLoopFailure?.(characterId, error.cause ?? error)
        return done('failed')
      }
      if (error instanceof InvalidCharacterOutputError) modelFailure = 'invalid_output'
      if (error instanceof CharacterPresetError) modelFailure = 'preset_failed'
      // Storage, lease, context and Rulebook faults remain visible to the caller.
      if (modelFailure === undefined) throw error
      return { ...done('failed'), failure: modelFailure }
    } finally {
      closed = true
      lifetime.abort(new Error('character activation has ended'))
      await pendingOperation?.catch(() => undefined)
      if (lease !== undefined) this.options.leases.release(this.options.address, ownerId, lease.fencingToken)
      active.delete(characterId)
      if (active.size === 0) activeCharacters.delete(this.options.store)
    }
  }
}
