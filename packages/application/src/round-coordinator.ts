import {
  SubmitActionsValidator,
  ModelBudgetLedger,
  SafeAgentRunner,
} from '@harness-world/agents'
import {
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  deterministicId,
  failWorld,
  hashWorldJson,
  WorldError,
  type ActionRequest,
  type AgentProvider,
  type CharacterId,
  type InteractionRoundId,
  type OutboxDraft,
  type Proposal,
  type ProposalContext,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  createCoreRulebookRegistry,
  currentCharacterLifecycle,
  parsePlayerActionInput,
  parsePlayerRoundResult,
  runtimeManifestFromStored,
  type CompiledWorldManifest,
  type PlayerActionInput,
  type PlayerRoundResult,
  type RoundExecutionLane,
  type RulebookResolution,
  type RulebookRegistry,
  type RulebookResolver,
} from '@harness-world/kernel'
import {
  RoundInbox,
  CharacterRuntimeAvailabilityService,
  WorldStore,
  WriterLeaseService,
  type ClaimedRound,
  type WriterLease,
  type CommittedRoundRecord,
} from '@harness-world/store-sqlite'
import { type CognitiveMemoryService, type CognitiveProposalContext, type MemorySourceRef } from '@harness-world/memory'
import type { SceneDecision, SceneDecisionService } from './scene-decision.ts'
import type { ApplicationRuntimeMetrics } from './runtime-metrics.ts'

export type RoundParticipantRole = 'agent' | 'director'
export type ParticipantTerminalStatus = 'proposed' | 'provider_failed' | 'provider_timeout' | 'budget_exhausted' | 'schema_invalid' | 'lifecycle_ineligible' | 'runtime_unavailable'

export interface RoundParticipant {
  readonly participantId: string
  readonly role: RoundParticipantRole
  readonly actorId: CharacterId
  readonly allowedActionTypes: readonly string[]
  readonly priority: number
  readonly estimatedTokens: number
  readonly timeoutMs: number
  readonly provider: AgentProvider
}

export interface RoundCoordinatorOptions {
  readonly store: WorldStore
  readonly inbox: RoundInbox
  readonly leases: WriterLeaseService
  readonly availability: CharacterRuntimeAvailabilityService
  readonly runtimeLane: RoundExecutionLane
  readonly ownerId: string
  readonly participants: readonly RoundParticipant[]
  readonly modelBudgetTokens: number
  readonly leaseTtlMs?: number
  readonly rulebooks?: RulebookRegistry
  readonly sceneDecision?: SceneDecisionService
  readonly cognitiveMemory?: CognitiveMemoryService
  readonly runtimeMetrics?: ApplicationRuntimeMetrics
}

export interface SubmitCoordinatedRoundRequest {
  readonly idempotencyKey: string
  readonly principalId: string
  readonly action: PlayerActionInput
  readonly correlationId: string
}

export interface RoundAcceptedResult {
  readonly status: 'queued' | 'processing' | 'committed' | 'failed' | 'cancelled'
  readonly roundId: InteractionRoundId
  readonly inboxSeq: number
  readonly idempotencyKey: string
}

interface FrozenParticipant {
  readonly binding: RoundParticipant
  readonly status: ParticipantTerminalStatus
  readonly proposal: Proposal
  readonly cognitive?: {
    readonly contextHash: ReturnType<typeof hashWorldJson>
    readonly memorySourceRefs: readonly MemorySourceRef[]
    readonly recallResultHash: ReturnType<typeof hashWorldJson>
  }
  readonly availabilityTransition?: {
    readonly state: 'session_lag' | 'model_unavailable' | 'budget_unavailable'
    readonly reason: string
  }
}

export interface ActionOrderKey {
  readonly sourceRole: 'player' | RoundParticipantRole
  readonly priority: number
  readonly actorId: CharacterId
  readonly actionId: string
}

interface OrderedAction extends ActionOrderKey {
  readonly action: ActionRequest
  readonly participantId: string
  /** Position in the participant's validated Proposal before global resolution ordering. */
  readonly proposalOrdinal: number
}

const roleRank = { player: 0, agent: 1, director: 2 } as const

/** Compare the frozen ActionOrderKey tuple without consulting mutable world state. */
export function compareActionOrderKey(left: ActionOrderKey, right: ActionOrderKey): number {
  const role = roleRank[left.sourceRole] - roleRank[right.sourceRole]
  if (role !== 0) return role
  const priority = right.priority - left.priority
  if (priority !== 0) return priority
  const actor = left.actorId.localeCompare(right.actorId)
  if (actor !== 0) return actor
  return left.actionId.localeCompare(right.actionId)
}

export const parseClaimedPlayerAction = parsePlayerActionInput

/** The sole production coordinator for player, NPC, and Director actions in one durable Round. */
export class RoundCoordinator {
  readonly #manifest: CompiledWorldManifest
  readonly #address: WorldAddress
  readonly #participants: readonly RoundParticipant[]
  readonly #validator = new SubmitActionsValidator()
  readonly #rulebook: RulebookResolver
  readonly #leaseTtlMs: number
  #lease: WriterLease
  #closed = false

  constructor(private readonly options: RoundCoordinatorOptions) {
    const stored = options.store.readManifest(options.runtimeLane.address)
    if (stored === undefined || stored.manifestHash !== options.runtimeLane.manifestHash) {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE',
        category: 'integrity',
        message: 'RoundCoordinator manifest is not active in WorldStore',
        retryable: false,
        correlationId: `coordinator:${options.ownerId}`,
        address: options.runtimeLane.address,
      })
    }
    this.#manifest = runtimeManifestFromStored(stored.manifest)
    this.#address = options.runtimeLane.address
    this.#rulebook = (options.rulebooks ?? createCoreRulebookRegistry()).resolve(
      this.#manifest.rulebook.rulebookId,
      this.#manifest.rulebook.version,
      `coordinator:${options.ownerId}`,
      this.#address,
    )
    this.#participants = [...options.participants].sort((left, right) =>
      roleRank[left.role] - roleRank[right.role]
      || right.priority - left.priority
      || left.participantId.localeCompare(right.participantId))
    if (new Set(this.#participants.map(value => value.participantId)).size !== this.#participants.length) {
      throw new TypeError('Round participantId values must be unique')
    }
    const characterIds = new Set(this.#manifest.characters.map(value => value.characterId))
    if (this.#participants.some(value => !characterIds.has(value.actorId))) {
      throw new TypeError('Round participant actorId must exist in the manifest')
    }
    if (options.cognitiveMemory !== undefined && options.sceneDecision === undefined) {
      throw new TypeError('Cognitive Memory requires an authoritative Scene decision service')
    }
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
      throw new RangeError('leaseTtlMs must be a positive safe integer')
    }
    if (this.#participants.some(value => !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0
      || value.timeoutMs + Math.max(100, Math.ceil(value.timeoutMs / 10)) >= this.#leaseTtlMs)) {
      throw new RangeError('every participant timeoutMs plus renewal margin must be shorter than leaseTtlMs')
    }
    new ModelBudgetLedger(options.modelBudgetTokens)
    this.#lease = options.leases.acquire(this.#address, options.ownerId, this.#leaseTtlMs)
  }

  /** Drain durable post-commit cognitive work under the current database Writer Lease. */
  processCognitiveJobs(): { readonly completed: number; readonly failed: number } {
    if (this.options.cognitiveMemory === undefined) return { completed: 0, failed: 0 }
    this.#refreshLease()
    const result = this.options.cognitiveMemory.processPending(
      this.#address,
      this.options.ownerId,
      this.#lease.fencingToken,
      () => this.#renewLease(),
    )
    for (const failure of result.failed) {
      this.options.availability.set(
        this.#address,
        failure.characterId,
        'session_lag',
        `Cognitive Memory worker failed: ${failure.error}`,
      )
    }
    return { completed: result.completed, failed: result.failed.length }
  }

  submit(request: SubmitCoordinatedRoundRequest): Promise<PlayerRoundResult> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    const queued = this.#enqueue(request)
    return this.options.runtimeLane.enqueueRound(async () => {
      const completed = this.options.inbox.readCompleted(this.#address, request.idempotencyKey)
      if (completed !== undefined) return parsePlayerRoundResult(completed)
      return this.#drainUntil(queued.inboxSeq, request.correlationId)
    })
  }

  accept(request: SubmitCoordinatedRoundRequest): RoundAcceptedResult {
    if (this.#closed) throw new Error('RoundCoordinator is closed')
    const queued = this.#enqueue(request)
    const durable = this.options.inbox.readStatus(this.#address, { idempotencyKey: request.idempotencyKey })!
    return {
      status: durable.status,
      roundId: queued.roundId,
      inboxSeq: queued.inboxSeq,
      idempotencyKey: request.idempotencyKey,
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.options.leases.release(this.#address, this.options.ownerId, this.#lease.fencingToken)
  }

  /** Finish every Round admitted before an administrative draining barrier. */
  drainAccepted(correlationId: string): Promise<number> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    return this.options.runtimeLane.enqueueRound(async () => {
      let drained = 0
      while (true) {
        this.#refreshLease()
        const claimed = this.options.inbox.claimNext(this.#address, this.options.ownerId, this.#lease.fencingToken)
        if (claimed === undefined) return drained
        await this.#commitAndComplete(claimed, correlationId)
        drained += 1
      }
    })
  }

  async #drainUntil(targetSeq: number, correlationId: string): Promise<PlayerRoundResult> {
    while (true) {
      this.#refreshLease()
      const claimed = this.options.inbox.claimNext(this.#address, this.options.ownerId, this.#lease.fencingToken)
      if (claimed === undefined) throw new Error(`Round Inbox lost admitted item ${targetSeq}`)
      const committed = await this.#commitAndComplete(claimed, correlationId)
      if (claimed.inboxSeq === targetSeq) return committed.result
    }
  }

  async #commitAndComplete(
    claimed: ClaimedRound,
    correlationId: string,
  ): Promise<{ readonly transactionId: TransactionId; readonly result: PlayerRoundResult }> {
    const committed = await this.#commitClaimed(claimed, correlationId)
    this.#renewLease()
    this.options.inbox.complete(
      this.#address,
      claimed.inboxSeq,
      this.options.ownerId,
      this.#lease.fencingToken,
      { transactionId: committed.transactionId, bundleHash: committed.result.bundleHash },
      committed.result,
    )
    return committed
  }

  async #commitClaimed(
    claimed: ClaimedRound,
    correlationId: string,
  ): Promise<{ readonly transactionId: TransactionId; readonly result: PlayerRoundResult }> {
    const binding = this.#manifest.playerBindings.find(value => value.principalId === claimed.principalId)
    if (binding === undefined) throw new Error('admitted coordinated Round lost its PlayerBinding')
    const action = parseClaimedPlayerAction(claimed.input)
    const identity = {
      address: this.#address,
      inboxSeq: claimed.inboxSeq,
      idempotencyKey: claimed.idempotencyKey,
      inputHash: claimed.inputHash,
    }
    const transactionId = brandId(deterministicId('transaction:coordinated-round', identity), 'TransactionId')
    const roundId = brandId(deterministicId('round:coordinated', identity), 'InteractionRoundId')
    const playerAction: ActionRequest = {
      actionId: deterministicId('action:coordinated-player', { roundId, inboxSeq: claimed.inboxSeq }),
      actorId: binding.characterId,
      actionType: action.actionType,
      actionVersion: 1,
      parameters: action.parameters,
    }
    const committed = this.options.store.committedRound(this.#address, transactionId)
    if (committed !== undefined) {
      return { transactionId, result: this.#committedPlayerResult(committed, roundId, playerAction) }
    }
    const head = this.options.store.head(this.#address)
    const history = this.options.store.readEvents(this.#address, head.headSeq)
    const sceneDecision = this.options.sceneDecision?.decideFromEvents(
      this.#address, binding.characterId, history, head.headSeq,
    )
    const proposalContext: ProposalContext = {
      address: this.#address,
      roundId,
      tick: head.tick + 1,
      playerAction,
      candidateHash: hashWorldJson('world-player-candidate-s1', {
        baseHeadSeq: head.headSeq,
        baseTick: head.tick,
        playerAction,
      }),
    }
    const frozen = await this.#freezeParticipants(
      proposalContext,
      history,
      sceneDecision?.schedulableCharacterIds,
      sceneDecision,
      head.headSeq,
    )
    const ordered = this.#orderedActions(playerAction, frozen)
    const contextHash = hashWorldJson('round-proposal-context', {
      address: proposalContext.address,
      roundId: proposalContext.roundId,
      tick: proposalContext.tick,
      playerAction: proposalContext.playerAction,
      candidateHash: proposalContext.candidateHash,
    })
    const participants = [
      {
        participantId: 'player', role: 'player', actorId: binding.characterId, terminalStatus: 'proposed',
        providerInvocationId: null, contextHash, profileVersion: null, budgetEvaluationId: null,
        modelReplayRecordHash: null, budgetReservationRecordHash: null,
        responseHash: hashWorldJson('round-player-action-response', playerAction), proposalId: null,
        proposalHash: hashWorldJson('round-player-proposal', { actions: [playerAction] }),
      },
      ...frozen.map(value => {
        const proposalHash = hashWorldJson('round-participant-proposal', value.proposal)
        return {
          participantId: value.binding.participantId,
          role: value.binding.role,
          actorId: value.binding.actorId,
          terminalStatus: value.status,
          providerInvocationId: deterministicId('provider-invocation:round-participant', { roundId, participantId: value.binding.participantId }),
          contextHash: value.cognitive?.contextHash ?? contextHash,
          profileVersion: 'agent-provider-port/v1',
          budgetEvaluationId: deterministicId('budget-evaluation:round-participant', { roundId, participantId: value.binding.participantId }),
          modelReplayRecordHash: null,
          budgetReservationRecordHash: null,
          responseHash: hashWorldJson('round-participant-response', value.proposal),
          proposalId: deterministicId('proposal:round-participant', { roundId, participantId: value.binding.participantId, proposalHash }),
          proposalHash,
          ...(value.cognitive === undefined ? {} : {
            memorySourceRefs: value.cognitive.memorySourceRefs,
            recallResultHash: value.cognitive.recallResultHash,
          }),
        }
      }),
    ]
    const actions = ordered.map(item => ({
      actionId: item.action.actionId,
      participantId: item.participantId,
      sourceRole: item.sourceRole,
      actorId: item.action.actorId,
      actionType: item.action.actionType,
      actionVersion: item.action.actionVersion,
      parameters: item.action.parameters,
      proposalOrdinal: item.proposalOrdinal,
      orderKey: {
        phase: item.sourceRole === 'player' ? 0 : 1,
        roleRank: roleRank[item.sourceRole],
        priority: item.priority,
        actorId: item.actorId,
        actionId: item.actionId,
      },
    }))
    const resolutions: WorldJsonValue[] = []
    let candidateHash = proposalContext.candidateHash
    const events: WorldEventDraft[] = frozen.map(value => ({
      eventType: 'round.participant-terminal',
      eventVersion: 1,
      data: {
        roundId,
        participantId: value.binding.participantId,
        role: value.binding.role,
        status: value.status,
        actionCount: value.proposal.actions.length,
      },
    }))
    const outbox: OutboxDraft[] = []
    let playerResolution: RulebookResolution | undefined
    for (const [ordinal, item] of ordered.entries()) {
      const actionPrefix = [...history, ...events]
      const resolution = this.#rulebook.resolve({
        manifest: this.#manifest,
        events: actionPrefix,
        characterId: item.action.actorId,
        action: { actionType: item.action.actionType, parameters: item.action.parameters },
      })
      const phase8Audience = this.options.sceneDecision?.version === 2
        ? this.options.sceneDecision.audienceForAction(
          this.#address,
          item.action.actorId,
          actionPrefix,
          head.headSeq + events.length,
          {
            scope: resolution.observationScope?.scope ?? 'scene_public',
            ...(resolution.observationScope?.recipientIds === undefined ? {} : {
              recipientIds: resolution.observationScope.recipientIds.map(value => brandId(value, 'CharacterId')),
            }),
          },
        )
        : undefined
      const candidateHashBefore = candidateHash
      const ruleTraceHash = hashWorldJson('round-rule-trace', {
        rulebook: this.#manifest.rulebook,
        action: item.action,
        status: resolution.status,
        reason: resolution.reason ?? null,
        events: resolution.events,
        ...(this.options.sceneDecision?.version !== 2 ? {} : {
          observationScope: resolution.observationScope ?? { scope: 'scene_public' },
        }),
      })
      candidateHash = resolution.status === 'accepted'
        ? hashWorldJson('round-candidate-after-resolution', {
          candidateHashBefore, actionId: item.action.actionId, events: resolution.events, ruleTraceHash,
        })
        : candidateHashBefore
      resolutions.push({
        actionId: item.action.actionId,
        status: resolution.status,
        reason: resolution.reason ?? null,
        orderKey: actions[ordinal]!.orderKey,
        candidateHashBefore,
        candidateHashAfter: candidateHash,
        ruleTraceHash,
        entropyRefs: [],
        conflictingActionId: null,
      })
      if (item.sourceRole === 'player') playerResolution = resolution
      events.push(...resolution.events, {
        eventType: 'action.resolved',
        eventVersion: 1,
        data: {
          roundId,
          actionId: item.action.actionId,
          participantId: item.participantId,
          actorId: item.action.actorId,
          actionType: item.action.actionType,
          sourceRole: item.sourceRole,
          order: ordinal,
          accepted: resolution.status === 'accepted',
          reason: resolution.reason ?? null,
        },
      })
      const publicSpeech = (this.#manifest.rulebook.version >= 4
        || this.#manifest.contentPack?.runtimeCapabilities.publicSpeechObservationVersion === 1)
        ? resolution.events.find(event => event.eventType === 'character.speak')
        : undefined
      const occurrenceOnly = new Set(phase8Audience?.occurrenceOnlyCharacterIds ?? [])
      const observerIds = phase8Audience === undefined
        ? this.options.sceneDecision?.decideFromEvents(
          this.#address, binding.characterId, [...history, ...events], head.headSeq,
        ).visibleResultCharacterIds ?? [binding.characterId]
        : [...phase8Audience.fullContentCharacterIds, ...phase8Audience.occurrenceOnlyCharacterIds]
      for (const observerId of observerIds) {
        const observationId = this.options.sceneDecision === undefined
          ? deterministicId('observation:coordinated-round', { roundId, actionId: item.action.actionId })
          : deterministicId('observation:scene-result', { roundId, actionId: item.action.actionId, observerId })
        const observation = {
          observerId,
          actionId: item.action.actionId,
          content: occurrenceOnly.has(observerId) ? {
            actionType: 'private_interaction',
            actorId: item.action.actorId,
            status: resolution.status,
            reason: resolution.reason ?? null,
            contentVisibility: 'occurrence_only',
          } : {
            actionType: item.action.actionType,
            actorId: item.action.actorId,
            status: resolution.status,
            reason: resolution.reason ?? null,
            ...(publicSpeech === undefined ? {} : { speech: publicSpeech.data }),
          },
        }
        events.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id: observationId, value: observation } })
        if (observerId === binding.characterId) {
          outbox.push({
            deliveryId: brandId(deterministicId('delivery:coordinated-round', { roundId, observationId }), 'DeliveryId'),
            sessionId: binding.sessionId,
            payload: { observationId, value: observation },
            critical: true,
          })
        }
      }
    }
    events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } })
    const cognitiveCharacterIds = this.options.cognitiveMemory === undefined
      ? []
      : [...new Set(ordered.map(item => item.action.actorId).concat(sceneDecision!.observerIds))].sort()
    this.#renewLease()
    const commit = await this.options.store.commitRound({
      address: this.#address,
      transactionId,
      roundId,
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events,
      outbox,
      ...(cognitiveCharacterIds.length === 0
        ? {}
        : { cognitiveJobs: cognitiveCharacterIds.map(characterId => ({ characterId })) }),
      authority: {
        schemaVersion: 2,
        roundId,
        baseHeadSeq: head.headSeq,
        baseTick: head.tick,
        contextHash,
        participants,
        actions,
        resolutions,
        finalCandidateHash: candidateHash,
      },
      operationalSummary: {
        participantTerminals: frozen.map(value => ({
          participantId: value.binding.participantId,
          role: value.binding.role,
          terminalStatus: value.status,
        })),
      },
      correlationId,
      admissionProof: { inboxSeq: claimed.inboxSeq, inputHash: claimed.inputHash },
      writerFencingToken: this.#lease.fencingToken,
    })
    for (const participant of frozen) {
      if (participant.status !== 'proposed') this.options.runtimeMetrics?.recordParticipant(participant.status)
      if (participant.availabilityTransition !== undefined) {
        this.options.availability.set(
          this.#address,
          participant.binding.actorId,
          participant.availabilityTransition.state,
          participant.availabilityTransition.reason,
        )
      }
    }
    this.processCognitiveJobs()
    return {
      transactionId,
      result: {
        status: playerResolution!.status,
        reason: playerResolution!.reason ?? null,
        headSeq: commit.headSeq,
        tick: commit.tick,
        bundleHash: commit.bundleHash,
      },
    }
  }

  #enqueue(request: SubmitCoordinatedRoundRequest) {
    this.#validateSubmission(request)
    if (!this.#manifest.playerBindings.some(value => value.principalId === request.principalId)) {
      failWorld({
        errorCode: 'UNAUTHORIZED', category: 'admission', message: 'principal has no PlayerBinding in this world',
        retryable: false, correlationId: request.correlationId, address: this.#address,
      })
    }
    return this.options.inbox.enqueue({
      address: this.#address, idempotencyKey: request.idempotencyKey, principalId: request.principalId,
      input: request.action, correlationId: request.correlationId,
    }, this.#manifest.roundQueueLimit)
  }

  async #freezeParticipants(
    context: ProposalContext,
    history: readonly { readonly eventType: string; readonly data: WorldJsonValue }[],
    schedulableCharacterIds?: readonly CharacterId[],
    sceneDecision?: SceneDecision,
    asOfWorldSeq = 0,
  ): Promise<FrozenParticipant[]> {
    const frozen: FrozenParticipant[] = []
    const actionIds = new Set<string>([context.playerAction.actionId])
    const runner = new SafeAgentRunner(new ModelBudgetLedger(this.options.modelBudgetTokens))
    for (const binding of this.#participants) {
      if (schedulableCharacterIds !== undefined && !schedulableCharacterIds.includes(binding.actorId)) continue
      if (currentCharacterLifecycle(history, binding.actorId) !== 'active') {
        frozen.push({ binding, status: 'lifecycle_ineligible', proposal: { participantId: binding.participantId, actions: [] } })
        continue
      }
      if (this.options.availability.get(this.#address, binding.actorId)?.state !== 'ready') {
        frozen.push({ binding, status: 'runtime_unavailable', proposal: { participantId: binding.participantId, actions: [] } })
        continue
      }
      let providerContext: ProposalContext | CognitiveProposalContext = context
      let cognitive: FrozenParticipant['cognitive']
      if (this.options.cognitiveMemory !== undefined) {
        try {
          this.#renewLease()
          const prepared = this.options.cognitiveMemory.prepare({
            address: this.#address,
            roundId: context.roundId,
            tick: context.tick,
            participantId: binding.participantId,
            characterId: binding.actorId,
            asOfWorldSeq,
            playerAction: context.playerAction,
            candidateHash: context.candidateHash,
            allowedActionTypes: binding.allowedActionTypes,
            sceneDecision: sceneDecision!,
            correlationId: `cognitive:${context.roundId}:${binding.participantId}`,
            heartbeat: () => this.#renewLease(),
          })
          providerContext = prepared
          cognitive = {
            contextHash: prepared.contextHash,
            memorySourceRefs: prepared.memorySourceRefs,
            recallResultHash: prepared.recallResultHash,
          }
        } catch (error: unknown) {
          if (error instanceof WorldError && error.envelope.category === 'integrity') throw error
          frozen.push(this.#frozen(
            binding,
            'runtime_unavailable',
            { participantId: binding.participantId, actions: [] },
            undefined,
            { state: 'session_lag', reason: `Cognitive Memory catch-up failed: ${String(error)}` },
          ))
          continue
        }
      }
      this.#renewLease()
      const run = await runner.propose(
        `provider:${context.roundId}:${binding.participantId}`,
        binding.estimatedTokens,
        binding.timeoutMs,
        binding.participantId,
        binding.provider,
        providerContext,
      )
      this.#renewLease()
      if (run.status === 'fallback') {
        const failure = run.failure!
        frozen.push(this.#frozen(
          binding,
          failure,
          run.proposal,
          cognitive,
          failure === 'budget_exhausted'
            ? { state: 'budget_unavailable', reason: 'model budget was exhausted' }
            : { state: 'model_unavailable', reason: failure === 'provider_timeout' ? 'provider timed out' : 'provider failed' },
        ))
        continue
      }
      try {
        const proposal = this.#validator.validate({
          schemaVersion: 1,
          participantId: run.proposal.participantId,
          actions: run.proposal.actions,
        }, {
          participantId: binding.participantId,
          actorId: binding.actorId,
          allowedActionTypes: binding.allowedActionTypes,
          maxActions: 2,
          correlationId: `coordinator:${context.roundId}:${binding.participantId}`,
        })
        if (proposal.actions.some(action => actionIds.has(action.actionId))) {
          frozen.push(this.#frozen(
            binding, 'schema_invalid', { participantId: binding.participantId, actions: [] }, cognitive,
            { state: 'model_unavailable', reason: 'provider returned a divergent action schema' },
          ))
          continue
        }
        for (const action of proposal.actions) actionIds.add(action.actionId)
        frozen.push(this.#frozen(binding, 'proposed', proposal, cognitive))
      } catch {
        frozen.push(this.#frozen(
          binding, 'schema_invalid', { participantId: binding.participantId, actions: [] }, cognitive,
          { state: 'model_unavailable', reason: 'provider returned an invalid action schema' },
        ))
      }
    }
    return frozen
  }

  #frozen(
    binding: RoundParticipant,
    status: ParticipantTerminalStatus,
    proposal: Proposal,
    cognitive?: FrozenParticipant['cognitive'],
    availabilityTransition?: FrozenParticipant['availabilityTransition'],
  ): FrozenParticipant {
    return {
      binding, status, proposal,
      ...(cognitive === undefined ? {} : { cognitive }),
      ...(availabilityTransition === undefined ? {} : { availabilityTransition }),
    }
  }

  #committedPlayerResult(
    committed: CommittedRoundRecord,
    expectedRoundId: string,
    expectedPlayerAction: ActionRequest,
  ): PlayerRoundResult {
    if (committed.roundId !== expectedRoundId) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'committed coordinated Round is bound to an unexpected roundId',
        retryable: false,
        correlationId: `coordinator:${committed.transactionId}`,
        address: this.#address,
      })
    }
    const playerResolutions = committed.events.filter((event) => {
      if (event.eventType !== 'action.resolved' || event.eventVersion !== 1
        || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return false
      const data = event.data as Record<string, WorldJsonValue>
      return data.roundId === expectedRoundId
        && data.actionId === expectedPlayerAction.actionId
        && data.participantId === 'player'
        && data.actorId === expectedPlayerAction.actorId
        && data.actionType === expectedPlayerAction.actionType
        && data.sourceRole === 'player'
        && data.order === 0
    })
    if (playerResolutions.length !== 1) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'committed coordinated Round has no unique player Resolution',
        retryable: false,
        correlationId: `coordinator:${committed.transactionId}`,
        address: this.#address,
      })
    }
    const resolution = playerResolutions[0]!.data as Record<string, WorldJsonValue>
    if (typeof resolution.accepted !== 'boolean'
      || (resolution.reason !== null && typeof resolution.reason !== 'string')) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'committed player Resolution has an invalid durable shape',
        retryable: false,
        correlationId: `coordinator:${committed.transactionId}`,
        address: this.#address,
      })
    }
    return parsePlayerRoundResult({
      status: resolution.accepted ? 'accepted' : 'rejected',
      reason: resolution.reason,
      headSeq: committed.headSeq,
      tick: committed.tick,
      bundleHash: committed.bundleHash,
    })
  }

  #refreshLease(): void {
    this.#lease = this.options.leases.acquire(this.#address, this.options.ownerId, this.#leaseTtlMs)
    this.#renewLease()
  }

  #renewLease(): void {
    this.#lease = this.options.leases.renew(
      this.#address,
      this.options.ownerId,
      this.#lease.fencingToken,
      this.#leaseTtlMs,
    )
  }

  #orderedActions(playerAction: ActionRequest, frozen: readonly FrozenParticipant[]): OrderedAction[] {
    const actions: OrderedAction[] = [{
      action: playerAction,
      sourceRole: 'player',
      participantId: 'player',
      priority: Number.MAX_SAFE_INTEGER,
      actorId: playerAction.actorId,
      actionId: playerAction.actionId,
      proposalOrdinal: 0,
    }]
    for (const participant of frozen) {
      for (const [proposalOrdinal, action] of participant.proposal.actions.entries()) {
        actions.push({
          action,
          sourceRole: participant.binding.role,
          participantId: participant.binding.participantId,
          priority: participant.binding.priority,
          actorId: action.actorId,
          actionId: action.actionId,
          proposalOrdinal,
        })
      }
    }
    return actions.sort(compareActionOrderKey)
  }

  #validateSubmission(request: SubmitCoordinatedRoundRequest): void {
    canonicalizeWorldJson(request.action)
    for (const [name, value] of [
      ['idempotencyKey', request.idempotencyKey],
      ['principalId', request.principalId],
      ['correlationId', request.correlationId],
      ['action.actionType', request.action.actionType],
    ] as const) {
      assertProtocolString(value, name)
    }
    const keys = Object.keys(request.action).sort()
    if (keys.join(',') !== 'actionType,parameters') throw new TypeError('action must contain exactly actionType and parameters')
  }
}
