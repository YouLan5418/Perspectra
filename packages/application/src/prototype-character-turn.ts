import { characterVisibleItems } from './character-visible-items.ts'
import { randomUUID } from 'node:crypto'
import { brandId, parseExpressionSegments, resolutionAuthority, type CharacterId, type WorldAddress, type WorldEventDraft,
  type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { characterRelationObservations, currentCharacterLifecycle,
  type CompiledWorldManifest, type RulebookRegistry } from '@harness-world/kernel'
import { CognitionProjectionRebuilder, CharacterViewBuilder, CharacterRuntimeAvailabilityService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import type { CognitiveMemoryService, RecalledMemory } from '@harness-world/memory'
import { SceneDecisionService } from './scene-decision.ts'
import { characterExecutionResult, expressionAfterExecution } from './character-execution-result.ts'

/** A returned payload failed format validation, rather than a transport failure. */
export class PrototypeInvalidOutputError extends TypeError {}
export class PrototypePresetError extends Error {}

export interface PrototypeTurnRequest {
  readonly context: WorldJsonObject
  readonly continuation: boolean
  readonly canPerform?: boolean
  readonly canRecall?: boolean
  readonly recallEvidence?: WorldJsonObject
  readonly result?: WorldJsonObject
}

/** Optional experiment observation; never becomes part of the Character request or World Event. */
export interface PrototypeRecallShadowObservation {
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly phase: 'automatic' | 'active'
  readonly query: string
  readonly keywordSourceIds: readonly string[]
  readonly deliveredSourceIds: readonly string[]
  readonly excludedSourceSeqs: readonly number[]
}
export interface PrototypeTurnResult {
  readonly status: 'published' | 'abstained' | 'budget_exhausted' | 'interrupted' | 'failed'
  readonly calls: number
  readonly performResult?: WorldJsonObject
  readonly failure?: 'provider_failed' | 'invalid_output' | 'preset_failed'
}

function object(value: unknown): WorldJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object')
  return value as WorldJsonObject
}

function recalledSourceIds(memories: readonly RecalledMemory[]): string[] {
  return memories.map(memory => {
    const source = object(object(memory.metadata).source)
    if (typeof source.sourceId !== 'string') throw new TypeError('recalled memory has no source ID')
    return source.sourceId
  })
}
function keys(value: WorldJsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('unexpected decision field')
}

/** One isolated activation, not a scheduler. Call only on a branch with no unfinished Reaction Cycle.
 * Uses the existing Rulebook, atomic WorldStore commit, scene audiences and character observations.
 * Intermediate model work is ephemeral; a committed operation is never rolled back for a failed reply.
 */
export class PrototypeCharacterTurn {
  #busy = false
  readonly #manifest: CompiledWorldManifest
  readonly #manifestHash
  readonly #scene: SceneDecisionService
  readonly #view: CharacterViewBuilder

  constructor(private readonly options: {
    readonly address: WorldAddress
    readonly store: WorldStore
    readonly memory?: CognitiveMemoryService
    readonly leases: WriterLeaseService
    readonly availability: CharacterRuntimeAvailabilityService
    readonly rulebooks: RulebookRegistry
    readonly decide: (request: PrototypeTurnRequest, signal: AbortSignal) => Promise<unknown>
    readonly projectContext?: (context: WorldJsonObject, canPerform: boolean) => WorldJsonObject
    readonly validateDecision?: (decision: WorldJsonObject, request: PrototypeTurnRequest) => void
    readonly executionResult?: (input: Parameters<typeof characterExecutionResult>[0]) =>
      ReturnType<typeof characterExecutionResult> & { readonly observationMetadata?: WorldJsonObject }
    readonly onRecallShadow?: (observation: PrototypeRecallShadowObservation) => void
    /** Host projection runs after the complete action transaction, never on model output. */
    readonly onCommitted?: () => Promise<void>
    /** With Core, preserve the authorized tail after its successfully archived prefix. */
    readonly shortTermAfterSeq?: (characterId: CharacterId) => number
    readonly recentObservations?: number
    readonly recentSelfObservations?: number
  }) {
    const stored = options.store.readManifest(options.address)
    if (stored === undefined || (stored.manifest as WorldJsonObject).schemaVersion !== 10) {
      throw new TypeError('single-turn prototype requires an activated v10 world')
    }
    this.#manifest = stored.manifest as CompiledWorldManifest
    this.#manifestHash = stored.manifestHash
    this.#scene = new SceneDecisionService(options.store, options.availability, 2)
    this.#view = new CharacterViewBuilder(options.store)
  }

  async run(characterId: CharacterId, options: { readonly signal?: AbortSignal; readonly maxCalls?: 1 | 2 | 3;
    readonly stimulus?: readonly WorldJsonObject[];
    readonly continuationOf?: { readonly actionId: string; readonly afterSeq?: number;
      readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue } } } = {}): Promise<PrototypeTurnResult> {
    if (this.#busy) throw new Error('single-turn prototype is busy')
    if (this.options.store.activeReactionCycle(this.options.address) !== undefined) {
      throw new Error('finish the existing Reaction Cycle before using the isolated prototype')
    }
    if (!this.#manifest.characters.some(character => character.characterId === characterId)
      || this.#manifest.playerBindings.some(binding => binding.characterId === characterId)) {
      throw new TypeError('activation requires a declared NPC')
    }
    this.#busy = true
    const ownerId = `prototype-turn:${randomUUID()}`
    const signal = options.signal === undefined ? AbortSignal.timeout(120_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    let lease: ReturnType<WriterLeaseService['acquire']> | undefined
    let calls = 0
    let recalledThisActivation = false
    let performResult: WorldJsonObject | undefined
    let modelFailure: PrototypeTurnResult['failure']
    const done = (status: PrototypeTurnResult['status']): PrototypeTurnResult => ({ status, calls,
      ...(performResult === undefined ? {} : { performResult }) })
    try {
      lease = this.options.leases.acquire(this.options.address, ownerId, 180_000)
      if (options.continuationOf !== undefined) {
        const prior = this.options.store.readEvents(this.options.address).findLast(event => event.eventType === 'action.resolved'
          && event.seq > (options.continuationOf!.afterSeq ?? 0)
          && object(event.data).actionId === options.continuationOf!.actionId && object(event.data).actorId === characterId
          && object(event.data).actionType === options.continuationOf!.action.actionType)
        if (prior === undefined) return done('failed')
        const resolved = object(prior.data)
        performResult = { operationId: options.continuationOf.actionId, action: options.continuationOf.action,
          status: resolved.accepted === true ? 'accepted' : 'rejected', reason: resolved.reason ?? null, eventRefs: [prior.seq] }
      }
      const maxCalls = options.continuationOf === undefined ? (options.maxCalls ?? 2) : 2
      for (let step = options.continuationOf === undefined ? 0 : 1; step < maxCalls; step += 1) {
        signal.throwIfAborted()
        const canPerform = options.continuationOf === undefined && (step === 0 || (step === 1 && maxCalls === 3))
        const head = this.options.store.head(this.options.address)
        const history = this.options.store.readEvents(this.options.address, head.headSeq)
        const sourceTicks = new Map(history.map(event => [event.seq, event.tick]))
        const withSourceAge = (memory: RecalledMemory) => {
          const sourceTick = sourceTicks.get(memory.sourceMaxSeq)
          if (sourceTick === undefined) throw new Error('memory source event is missing')
          return { ...memory, sourceAgeTicks: head.tick - sourceTick }
        }
        if (currentCharacterLifecycle(history, characterId) !== 'active') return done('interrupted')
        const rules = this.options.rulebooks.resolve(this.#manifest.rulebook.rulebookId,
          this.#manifest.rulebook.version, ownerId, this.options.address)
        const ruleContext = { manifest: this.#manifest, manifestHash: this.#manifestHash,
          events: history, characterId, asOfWorldSeq: head.headSeq,
          resolutionAuthority: resolutionAuthority('agent', 'standard') }
        const view = this.#view.rebuildAt(this.options.address, characterId, head.headSeq)
        const scene = this.#scene.decideFromEvents(this.options.address, characterId, history, head.headSeq)
        const character = this.#manifest.characters.find(value => value.characterId === characterId)!
        const recalled = this.options.memory?.prepareStimulus({
          address: this.options.address, roundId: brandId(`${ownerId}:${step}:memory`, 'InteractionRoundId'),
          participantId: characterId, characterId, asOfWorldSeq: head.headSeq,
          stimulus: options.stimulus ?? [], sceneCharacterIds: scene.observerIds,
          correlationId: `prototype-memory:${ownerId}:${step}`,
        })
        const afterSeq = this.options.shortTermAfterSeq?.(characterId)
        const ordered = view.observations.toSorted((left, right) => left.sourceSeq - right.sourceSeq)
        const recentObservations = afterSeq === undefined ? ordered.slice(-(this.options.recentObservations ?? 16))
          : ordered.filter(record => record.sourceSeq > afterSeq)
        const recentSelfObservations = afterSeq === undefined
          ? (this.options.recentSelfObservations ?? 8) === 0 ? [] : view.selfObservations.slice(-(this.options.recentSelfObservations ?? 8))
          : view.selfObservations.filter(record => record.sourceSeq > afterSeq)
        const recentSourceSeqs = new Set([...recentObservations, ...recentSelfObservations]
          .map(record => record.sourceSeq))
        const olderMemories = recalled?.memoryRecall.filter(memory =>
          !recentSourceSeqs.has(memory.sourceMaxSeq) && !('projectionId' in object(memory.metadata)))
          .map(withSourceAge)
        if (recalled?.recallPlan !== undefined && recalled.recall !== undefined) {
          const plan = recalled.recallPlan
          this.options.onRecallShadow?.({
            address: this.options.address, characterId, asOfWorldSeq: head.headSeq,
            phase: 'automatic', query: plan.schemaVersion === 'recall-query-plan/v2' ? plan.queryText : plan.query,
            keywordSourceIds: recalled.recall.memories.map(memory => memory.sourceRef.sourceId),
            deliveredSourceIds: recalledSourceIds(olderMemories ?? []),
            excludedSourceSeqs: [...recentSourceSeqs],
          })
        }
        // Do not copy scene member records or other characters' anchors into a model request.
        let context: WorldJsonObject = {
          character: { ...character, locationId: view.locationId },
          stimulus: options.stimulus ?? [],
          ...(olderMemories === undefined ? {} : { memories: olderMemories }),
          cognition: new CognitionProjectionRebuilder(this.options.store).rebuildCharacterAt(this.options.address, characterId, head.headSeq),
          scene: { locationId: view.locationId, people: scene.observerIds.map(id => ({ characterId: id,
            name: this.#manifest.characters.find(value => value.characterId === id)?.name ?? id })) },
          observations: recentObservations.map(record => {
            const value = object(record.value)
            if (value.content === null || typeof value.content !== 'object' || Array.isArray(value.content)) return record
            const content = object(value.content)
            if (typeof content.reason !== 'string') return record
            const { reason, ...rest } = content
            const feedback = (this.options.executionResult ?? characterExecutionResult)({ manifest: this.#manifest, events: history, actorId: characterId,
              action: { actionType: String(content.actionType), parameters: {} }, status: String(content.status), reason })
            return { ...record, value: { ...value, content: { ...rest, resultDescription: feedback.description! } } }
          }), selfObservations: recentSelfObservations,
          claims: view.claims, goals: view.goals,
          items: characterVisibleItems(this.#manifest, history, characterId, scene.observerIds),
          affordances: rules.affordances(ruleContext).filter(value => canPerform || value.actionType === 'speak')
            .map(value => ({ actionType: value.actionType,
              ...(value.destinations === undefined ? {} : { destinations: value.destinations }),
              ...(value.interactions === undefined ? {} : { interactions: value.interactions }) })),
        }
        context = this.options.projectContext?.(context, canPerform) ?? context
        calls += 1
        modelFailure = 'provider_failed'
        const visibleResult = performResult === undefined ? undefined : (this.options.executionResult ?? characterExecutionResult)({
          manifest: this.#manifest, events: history, actorId: characterId,
          action: object(performResult.action) as { actionType: string; parameters: WorldJsonValue },
          status: String(performResult.status), reason: typeof performResult.reason === 'string' ? performResult.reason : null })
        const canRecall = this.options.memory !== undefined && !recalledThisActivation && performResult === undefined
        const request: PrototypeTurnRequest = { context, continuation: step !== 0, canPerform, canRecall,
          ...(visibleResult === undefined ? {} : { result: { ...visibleResult,
            instruction: canPerform
              ? '你已看到上次执行的真实结果。还可以申请一次受控交互，或直接表达或 abstain；未执行的后续状态变化不能写成既成事实。'
              : expressionAfterExecution, action: performResult!.action! } }) }
        let raw = await this.options.decide(request, signal)
        modelFailure = undefined
        signal.throwIfAborted()
        // A changed world means this output is stale, including a change while awaiting the model.
        if (this.options.store.head(this.options.address).headSeq !== head.headSeq) return done('interrupted')
        lease = this.options.leases.renew(this.options.address, ownerId, lease.fencingToken, 180_000)
        modelFailure = 'invalid_output'
        let decision = object(raw)
        this.options.validateDecision?.(decision, request)
        if (decision.decision === 'recall') {
          keys(decision, ['decision', 'query'])
          if (!canRecall || typeof decision.query !== 'string' || decision.query.trim() !== decision.query
            || decision.query.length < 2 || decision.query.length > 120) throw new TypeError('invalid recall request')
          recalledThisActivation = true
          modelFailure = undefined // Memory integrity failures are not model output failures.
          const alreadyVisible = new Set([...recentSourceSeqs,
            ...(olderMemories ?? []).map(memory => memory.sourceMaxSeq)])
          const keywordMemories = this.options.memory!.recall(this.options.address, characterId, decision.query, head.headSeq)
          const memories = keywordMemories
            .filter(memory => !alreadyVisible.has(memory.sourceMaxSeq))
            .map(withSourceAge)
          this.options.onRecallShadow?.({
            address: this.options.address, characterId, asOfWorldSeq: head.headSeq,
            phase: 'active', query: decision.query,
            keywordSourceIds: recalledSourceIds(keywordMemories),
            deliveredSourceIds: recalledSourceIds(memories),
            excludedSourceSeqs: [...alreadyVisible],
          })
          // A search result is a bounded, attributed selection of this character's sources, not a verdict.
          const recallEvidence: WorldJsonObject = { query: decision.query, memories,
            note: '仅是你可访问记忆中的相关证据；他人发言不证明其内容，未找到也不证明事件未发生。' }
          calls += 1
          modelFailure = 'provider_failed'
          raw = await this.options.decide({ ...request, canRecall: false, recallEvidence }, signal)
          modelFailure = undefined
          signal.throwIfAborted()
          if (this.options.store.head(this.options.address).headSeq !== head.headSeq) return done('interrupted')
          lease = this.options.leases.renew(this.options.address, ownerId, lease.fencingToken, 180_000)
          modelFailure = 'invalid_output'
          decision = object(raw)
          this.options.validateDecision?.(decision, request)
        }
        if (decision.decision === 'abstain') {
          keys(decision, ['decision'])
          return done('abstained')
        }
        let action: { actionType: string; parameters: WorldJsonValue }
        if (decision.decision === 'publish') {
          keys(decision, ['decision', 'segments', 'addresseeIds'])
          const segments = parseExpressionSegments(decision.segments)
          const addresseeIds = decision.addresseeIds ?? []
          if (!Array.isArray(addresseeIds) || new Set(addresseeIds).size !== addresseeIds.length || addresseeIds.some(id => typeof id !== 'string'
            || id === characterId || !scene.observerIds.includes(brandId(id, 'CharacterId')))) {
            throw new TypeError('addressee must be another visible character')
          }
          action = { actionType: 'speak', parameters: { segments,
            ...(addresseeIds.length === 0 ? {} : { scope: 'direct', addresseeIds }) } }
        } else if (decision.decision === 'perform' && canPerform) {
          keys(decision, ['decision', 'actionType', 'parameters'])
          if (decision.actionType !== 'move' && decision.actionType !== 'interact') throw new TypeError('unsupported operation')
          const parameters = object(decision.parameters)
          keys(parameters, decision.actionType === 'move' ? ['locationId']
            : ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
          action = { actionType: decision.actionType, parameters }
        } else throw new TypeError('operation budget exhausted; publish or abstain only')
        modelFailure = undefined
        const roundId = brandId(`${ownerId}:${step}`, 'InteractionRoundId')
        const actionId = `${roundId}:action`
        const resolution = rules.resolve({ ...ruleContext, action, roundId, actionId })
        const events: WorldEventDraft[] = [...resolution.events]
        if (resolution.status === 'accepted' && action.actionType === 'move') {
          events.push(...this.#scene.transitionForMove(this.options.address, history, characterId,
            object(action.parameters).locationId as string, head.headSeq))
        }
        events.push({ eventType: 'action.resolved', eventVersion: 1, data: { roundId, actionId,
          participantId: ownerId, actorId: characterId, actionType: action.actionType,
          sourceRole: 'agent', order: 0, accepted: resolution.status === 'accepted', reason: resolution.reason ?? null } })
        const audience = this.#scene.audienceForAction(this.options.address, characterId, history, head.headSeq,
          { scope: resolution.observationScope?.scope ?? 'scene_public',
            ...(resolution.observationScope?.recipientIds === undefined ? {} : {
              recipientIds: resolution.observationScope.recipientIds.map(id => brandId(id, 'CharacterId')) }) })
        const speech = resolution.events.find(event => event.eventType === 'character.speak')
        const transfer = resolution.events.find(event => event.eventType === 'entity.transferred')
        const relations = characterRelationObservations(history, resolution.events)
        const movement = resolution.events.find(event => event.eventType === 'character.moved')
        const movementData = movement?.data as { readonly characterId: CharacterId;
          readonly fromLocationId: string | null; readonly toLocationId: string } | undefined
        // The same move reaches both scenes, but neither scene alone grants the whole route.
        const departureObservers = movement === undefined ? undefined : new Set(this.#scene
          .decideFromEvents(this.options.address, characterId, history, head.headSeq).observerIds)
        const arrivalObservers = movement === undefined ? undefined : new Set(this.#scene
          .decideFromEvents(this.options.address, characterId, [...history, ...events],
            head.headSeq + events.length).observerIds)
        const arrived = movement === undefined ? [] : this.#scene.audienceForAction(this.options.address,
          characterId, [...history, ...events], head.headSeq + events.length).fullContentCharacterIds
        const full = new Set([...audience.fullContentCharacterIds, ...arrived, characterId])
        const feedback = (this.options.executionResult ?? characterExecutionResult)({ manifest: this.#manifest,
          events: [...history, ...resolution.events], actorId: characterId, action,
          status: resolution.status, reason: resolution.reason ?? null })
        const outbox = []
        for (const observerId of new Set([...full, ...audience.occurrenceOnlyCharacterIds])) {
          const seesDeparture = observerId === characterId || departureObservers?.has(observerId) === true
          const seesArrival = observerId === characterId || arrivalObservers?.has(observerId) === true
          const id = `${actionId}:observer:${observerId}`
          const content: WorldJsonObject = full.has(observerId) ? {
            actorId: characterId, actionType: action.actionType, status: resolution.status,
            resultDescription: String(feedback.description)
              .replaceAll('你', observerId === characterId ? '你' : '行动者'),
            ...('observationMetadata' in feedback && feedback.observationMetadata !== undefined
              ? { resultMetadata: feedback.observationMetadata } : {}),
            ...(speech === undefined ? {} : { speech: speech.data }),
            ...(transfer === undefined ? {} : { interaction: transfer.data }),
            ...(movementData === undefined || (!seesDeparture && !seesArrival) ? {} : { movement: {
              characterId: movementData.characterId,
              ...(seesDeparture ? { fromLocationId: movementData.fromLocationId } : {}),
              ...(seesArrival ? { toLocationId: movementData.toLocationId } : {}),
            } }),
            ...(relations.length === 0 ? {} : { relations }),
          } : { actorId: characterId, actionType: 'private_interaction', status: resolution.status, contentVisibility: 'occurrence_only' }
          const value = { observerId, actionId, content }
          events.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id, value } })
          const player = this.#manifest.playerBindings.find(binding => binding.characterId === observerId)
          if (player !== undefined) outbox.push({ deliveryId: brandId(`${id}:delivery`, 'DeliveryId'),
            sessionId: player.sessionId, payload: { observationType: 'prototype-character-turn', observationId: id, value }, critical: true })
        }
        events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } })
        await this.options.store.commitRound({ address: this.options.address,
          transactionId: brandId(`${roundId}:commit`, 'TransactionId'), roundId,
          expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
          events, outbox, writerFencingToken: lease.fencingToken, correlationId: ownerId,
          // This experiment does not fabricate a legacy batch Authority or provider-replay receipt.
          authority: { actorId: characterId, actionId, action, status: resolution.status,
            reason: resolution.reason ?? null, resolutionAuthority: ruleContext.resolutionAuthority },
        })
        await this.options.onCommitted?.()
        if (action.actionType === 'speak') return done(resolution.status === 'accepted' ? 'published' : 'failed')
        performResult = { operationId: actionId, action, status: resolution.status, reason: resolution.reason ?? null,
          eventRefs: resolution.events.map((_, index) => head.headSeq + index + 1) }
      }
      return done('budget_exhausted')
    } catch (error) {
      if (signal.aborted) return done('interrupted')
      if (error instanceof PrototypeInvalidOutputError) modelFailure = 'invalid_output'
      if (error instanceof PrototypePresetError) modelFailure = 'preset_failed'
      // Storage, lease, context and Rulebook faults remain visible to the caller.
      if (modelFailure === undefined) throw error
      return { ...done('failed'), failure: modelFailure }
    } finally {
      if (lease !== undefined) this.options.leases.release(this.options.address, ownerId, lease.fencingToken)
      this.#busy = false
    }
  }
}
