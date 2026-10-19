import {
  parseManifestationProposal
} from '@harness-world/agents'
import {
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  resolutionAuthority,
  type ActionGroupBinding,
  type ActionRequest,
  type CharacterId,
  type FaultInjector,
  type InteractionRoundId,
  type ManifestationProposal,
  type OutboxDraft,
  type PlayerSubmissionV2,
  type ProposalContext,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue
} from '@harness-world/contracts'
import {
  characterRelationObservations,
  createCoreRulebookRegistry,
  parsePlayerActionInput,
  parsePlayerRoundResult,
  resolveManifestation,
  runtimeManifestFromStored,
  type CompiledWorldManifestV10,
  type PlayerActionInput,
  type PlayerRoundResult,
  type RoundExecutionLane,
  type RulebookRegistry,
  type RulebookResolution,
  type RulebookResolver
} from '@harness-world/kernel'
import { type CognitiveMemoryService } from '@harness-world/memory'
import {
  CharacterRuntimeAvailabilityService,
  RoundInbox,
  WorldStore,
  WriterLeaseService,
  type ClaimedRound,
  type CommittedRoundRecord,
  type WriterLease,
} from '@harness-world/store-sqlite'
import { bindFrozenInteractionPerformance, resolveGroupAction, stepManifestation } from './action-groups.ts'
import { bindPlayerProvisional, verifyPlayerProvisional } from './player-provisional.ts'
import type { SceneDecisionService } from './scene-decision.ts'

/** Durable effect of committing exactly one accepted player Round; the Host scheduling quantum. */
export interface AcceptedRoundStep {
  readonly roundId: InteractionRoundId
  readonly transactionId: TransactionId
  readonly headSeq: number
  readonly tick: number
  readonly bundleHash: WorldHash
}

interface CommittedAcceptedRound {
  readonly roundId: InteractionRoundId
  readonly transactionId: TransactionId
  readonly result: PlayerRoundResult
}

export interface RoundCoordinatorOptions {
  readonly store: WorldStore
  readonly inbox: RoundInbox
  readonly leases: WriterLeaseService
  readonly availability: CharacterRuntimeAvailabilityService
  readonly runtimeLane: RoundExecutionLane
  readonly ownerId: string
  readonly leaseTtlMs?: number
  readonly rulebooks?: RulebookRegistry
  readonly sceneDecision?: SceneDecisionService
  readonly cognitiveMemory?: CognitiveMemoryService
  readonly faultInjector?: FaultInjector
}

export interface SubmitCoordinatedRoundRequest {
  readonly idempotencyKey: string
  readonly principalId: string
  readonly action: PlayerActionInput
  readonly manifestation?: ManifestationProposal
  readonly correlationId: string
}

export interface RoundAcceptedResult {
  readonly status: 'queued' | 'processing' | 'committed' | 'failed' | 'cancelled'
  readonly roundId: InteractionRoundId
  readonly inboxSeq: number
  readonly idempotencyKey: string
}

interface OrderedAction {
  readonly sourceRole: 'player'
  readonly priority: number
  readonly actorId: CharacterId
  readonly actionId: string
  readonly action: ActionRequest
  readonly participantId: string
  /** Position in the participant's validated Proposal before global resolution ordering. */
  readonly proposalOrdinal: number
  readonly manifestation?: ManifestationProposal
  readonly actionGroup?: ActionGroupBinding
}

export const parseClaimedPlayerAction = parsePlayerActionInput

interface ClaimedPlayerSubmission {
  readonly action: PlayerActionInput
  readonly manifestation?: ManifestationProposal
}

/** Preserve legacy Inbox bytes while parsing the explicitly wrapped manifestation form. */
export function parseClaimedPlayerSubmission(value: WorldJsonValue): ClaimedPlayerSubmission {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('claimed player submission must be an object')
  }
  const root = value as Record<string, WorldJsonValue>
  if ('actionType' in root) return { action: parsePlayerActionInput(value) }
  const keys = Object.keys(root).sort(compareWorldText)
  if (keys.join(',') !== 'action,manifestation') {
    throw new TypeError('claimed player manifestation submission has an invalid shape')
  }
  return {
    action: parsePlayerActionInput(root.action!),
    manifestation: parseManifestationProposal(root.manifestation),
  }
}

/** Admits and atomically commits player actions; NPC decisions run in PrototypeCharacterTurn. */
export class RoundCoordinator {
  readonly #manifest: CompiledWorldManifestV10
  readonly #address: WorldAddress
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
    if (options.cognitiveMemory !== undefined && options.sceneDecision === undefined) {
      throw new TypeError('Cognitive Memory requires an authoritative Scene decision service')
    }
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
      throw new RangeError('leaseTtlMs must be a positive safe integer')
    }
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

  /** Share the current writer lease with the player input worker. */
  get writerLease(): WriterLease { return this.#lease }

  /**
   * Ensure this Host is still the writer, taking the lease again if it lapsed while idle. A renewal only
   * works on a live lease, so a Host that paused longer than the TTL - a person reading, a page left open -
   * would otherwise fail its next turn with WRITER_LEASE_LOST. `acquire` refuses a live lease another owner
   * holds, so this can never take a branch someone else is writing.
   */
  refreshWriterLease(): void { this.#refreshLease() }

  /** Finish every Round admitted before an administrative draining barrier. */
  drainAccepted(correlationId: string): Promise<number> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    return this.options.runtimeLane.enqueueRound(async () => {
      let drained = 0
      while (true) {
        if (this.options.store.openReactionCycleId(this.#address) !== undefined) {
          failWorld({
            errorCode: 'BRANCH_DRAINING', category: 'admin',
            message: 'accepted Round drain must wait for the open Reaction Cycle', retryable: true,
            correlationId, address: this.#address,
          })
        }
        this.#refreshLease()
        const claimed = this.options.inbox.claimNext(this.#address, this.options.ownerId, this.#lease.fencingToken)
        if (claimed === undefined) return drained
        await this.#commitAndComplete(claimed, correlationId)
        drained += 1
      }
    })
  }

  /** Commit exactly one durable player Inbox item. */
  processNextAccepted(correlationId: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    return this.options.runtimeLane.enqueueRound(async () => {
      if (await this.#runAcceptedStep(correlationId) === undefined) {
        throw new Error('Round Inbox lost an admitted player item')
      }
    })
  }

  /** Commit at most one accepted player Round and report the durable step for Host scheduling. */
  processNextAcceptedStep(correlationId: string): Promise<AcceptedRoundStep | undefined> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    return this.options.runtimeLane.enqueueRound(() => this.#runAcceptedStep(correlationId))
  }

  async #runAcceptedStep(correlationId: string): Promise<AcceptedRoundStep | undefined> {
    this.#refreshLease()
    const claimed = this.options.inbox.claimNext(
      this.#address,
      this.options.ownerId,
      this.#lease.fencingToken,
    )
    if (claimed === undefined) return undefined
    const committed = await this.#commitAndComplete(claimed, correlationId)
    return {
      roundId: committed.roundId,
      transactionId: committed.transactionId,
      headSeq: committed.result.headSeq,
      tick: committed.result.tick,
      bundleHash: committed.result.bundleHash,
    }
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
  ): Promise<CommittedAcceptedRound> {
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
  ): Promise<CommittedAcceptedRound> {
    const binding = this.#manifest.playerBindings.find(value => value.principalId === claimed.principalId)
    if (binding === undefined) throw new Error('admitted coordinated Round lost its PlayerBinding')
    const inputJob = this.options.inbox.readPlayerInput(this.#address, claimed.idempotencyKey)
    const intentSubmission = typeof claimed.input === 'object' && claimed.input !== null && !Array.isArray(claimed.input)
      && Object.hasOwn(claimed.input, 'playerInputId') ? inputJob?.records.validated as PlayerSubmissionV2 | undefined : undefined
    if (typeof claimed.input === 'object' && claimed.input !== null && Object.hasOwn(claimed.input, 'playerInputId')
      && (intentSubmission === undefined || inputJob!.principalId !== claimed.principalId
        || (claimed.input as WorldJsonObject).playerInputId !== inputJob!.inputId
        || intentSubmission.version !== 'player-submission/v2' || intentSubmission.actions.some(value => value.actorId !== binding.characterId))) {
      throw new TypeError('player input Round has no matching validated submission')
    }
    const submission = intentSubmission === undefined ? parseClaimedPlayerSubmission(claimed.input) : { action: {
      actionType: intentSubmission.actions[0]!.actionType, parameters: intentSubmission.actions[0]!.parameters,
    } }
    const action = submission.action
    const identity = {
      address: this.#address,
      inboxSeq: claimed.inboxSeq,
      idempotencyKey: claimed.idempotencyKey,
      inputHash: claimed.inputHash,
    }
    const transactionId = brandId(deterministicId('transaction:coordinated-round', identity), 'TransactionId')
    const roundId = brandId(deterministicId('round:coordinated', identity), 'InteractionRoundId')
    const playerAction: ActionRequest = intentSubmission?.actions[0] ?? {
      actionId: deterministicId('action:coordinated-player', { roundId, inboxSeq: claimed.inboxSeq }),
      actorId: binding.characterId,
      actionType: action.actionType,
      actionVersion: 1,
      parameters: action.parameters,
    }
    const committed = this.options.store.committedRound(this.#address, transactionId)
    if (committed !== undefined) {
      return {
        roundId,
        transactionId,
        result: this.#committedPlayerResult(committed, roundId, playerAction),
      }
    }
    if (this.options.store.openReactionCycleId(this.#address) !== undefined) {
      failWorld({ errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime', retryable: false,
        message: 'unfinished legacy NPC Reaction Cycles cannot be resumed by this runtime',
        correlationId, address: this.#address })
    }
    const head = this.options.store.head(this.#address)
    const history = this.options.store.readEvents(this.#address, head.headSeq)
    const sceneDecision = this.options.sceneDecision?.decideFromEvents(
      this.#address, binding.characterId, history, head.headSeq,
    )
    const playerBaseResolution = this.#rulebook.resolve({
      manifest: this.#manifest,
      events: history,
      characterId: playerAction.actorId,
      actionId: playerAction.actionId,
      manifestHash: this.options.runtimeLane.manifestHash,
      asOfWorldSeq: head.headSeq,
      roundId,
      resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
      action: { actionType: playerAction.actionType, parameters: playerAction.parameters },
    })
    const playerObservationScope = playerBaseResolution.observationScope ?? { scope: 'scene_public' as const }
    let playerAudience = this.options.sceneDecision?.version === 2
      ? this.options.sceneDecision.audienceForAction(
        this.#address,
        playerAction.actorId,
        history,
        head.headSeq,
        {
          scope: playerObservationScope.scope,
          ...(playerObservationScope.recipientIds === undefined ? {} : {
            recipientIds: playerObservationScope.recipientIds.map(value => brandId(value, 'CharacterId')),
          }),
        },
      )
      : undefined
    const provisionalMoveTarget = playerAction.actionType === 'move' ? (playerAction.parameters as WorldJsonObject).locationId : undefined
    const provisional = bindPlayerProvisional(
      this.#address, head.headSeq, head.eventHash, playerAction, {
        ...playerBaseResolution,
        events: [
          ...playerBaseResolution.events,
          ...(playerBaseResolution.status === 'accepted' && typeof provisionalMoveTarget === 'string' && this.options.sceneDecision?.version === 2
            ? this.options.sceneDecision.transitionForMove(this.#address, history, playerAction.actorId, provisionalMoveTarget, head.headSeq) : []),
        ],
      },
    )
    const playerSteps = [{ action: playerAction, resolution: playerBaseResolution, provisional, audience: playerAudience }]
    if (intentSubmission !== undefined) {
      const stopped = new Set<string>()
      if (playerBaseResolution.status === 'rejected') stopped.add('player')
      for (const extra of intentSubmission.actions.slice(1)) {
        const prefix = [...history, ...playerSteps.flatMap(step => step.provisional!.binding.events.map(value => value.event))]
        const { resolution } = resolveGroupAction(extra, 'player', true, stopped, () => this.#rulebook.resolve({
          manifest: this.#manifest, events: prefix, characterId: extra.actorId, actionId: extra.actionId,
          manifestHash: this.options.runtimeLane.manifestHash, asOfWorldSeq: head.headSeq, roundId,
          resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
          action: { actionType: extra.actionType, parameters: extra.parameters },
        }))
        const target = (extra.parameters as WorldJsonObject).locationId
        const events = [...resolution.events, ...(resolution.status === 'accepted' && extra.actionType === 'move'
          && typeof target === 'string' && this.options.sceneDecision?.version === 2
          ? this.options.sceneDecision.transitionForMove(this.#address, prefix, extra.actorId, target, head.headSeq) : [])]
        const scope = resolution.observationScope ?? { scope: 'scene_public' as const }
        const audience = this.options.sceneDecision?.version === 2 ? this.options.sceneDecision.audienceForAction(
          this.#address, extra.actorId, prefix, head.headSeq, { scope: scope.scope,
            ...(scope.recipientIds === undefined ? {} : { recipientIds: scope.recipientIds.map(id => brandId(id, 'CharacterId')) }) }) : undefined
        playerSteps.push({ action: extra, resolution, audience,
          provisional: bindPlayerProvisional(this.#address, head.headSeq, head.eventHash, extra, { ...resolution, events }) })
      }
    }
    const s1History = provisional === undefined ? history : [...history, ...playerSteps.flatMap(step => step.provisional!.binding.events.map(value => value.event))]
    const s1Decision = provisional === undefined ? sceneDecision
      : this.options.sceneDecision?.decideFromEvents(this.#address, playerAction.actorId, s1History, head.headSeq)
    if (provisional !== undefined && playerObservationScope.scope === 'scene_public' && playerAudience !== undefined && s1Decision !== undefined) {
      playerAudience = { ...playerAudience, fullContentCharacterIds: [...new Set([
        ...playerAudience.fullContentCharacterIds, ...s1Decision.observerIds,
      ])].sort(compareWorldText) }
    }
    playerSteps[0]!.audience = playerAudience
    for (const step of playerSteps.slice(1)) {
      if ((step.resolution.observationScope?.scope ?? 'scene_public') === 'scene_public' && step.audience !== undefined && s1Decision !== undefined) {
        step.audience = { ...step.audience, fullContentCharacterIds: [...new Set([...step.audience.fullContentCharacterIds, ...s1Decision.observerIds])].sort(compareWorldText) }
      }
    }
    const proposalContext: ProposalContext = {
      address: this.#address,
      roundId,
      tick: head.tick + 1,
      playerAction,
      ...(submission.manifestation === undefined ? {} : { playerManifestation: submission.manifestation }),
      candidateHash: hashWorldJson('world-player-candidate-s1', {
        baseHeadSeq: head.headSeq,
        baseTick: head.tick,
        ...(provisional === undefined ? {} : { provisionalResolutionHash: provisional.hash }),
        ...(intentSubmission === undefined ? {} : { playerGroupHash: hashWorldJson('player-provisional-group/v1', playerSteps.map(step => step.provisional!.hash)) }),
        playerAction,
        ...(submission.manifestation === undefined ? {} : { playerManifestation: submission.manifestation }),
      }),
    }
    const ordered = this.#orderedActions(playerAction, submission.manifestation, intentSubmission?.actions)
    const contextHash = hashWorldJson('round-proposal-context', {
      address: proposalContext.address,
      roundId: proposalContext.roundId,
      tick: proposalContext.tick,
      playerAction: proposalContext.playerAction,
      ...(proposalContext.playerManifestation === undefined ? {} : {
        playerManifestation: proposalContext.playerManifestation,
      }),
      candidateHash: proposalContext.candidateHash,
    })
    const participants = [
      {
        participantId: 'player', role: 'player', actorId: binding.characterId, terminalStatus: 'proposed',
        providerInvocationId: null, contextHash, profileVersion: null, budgetEvaluationId: null,
        modelReplayRecordHash: null, budgetReservationRecordHash: null,
        responseHash: intentSubmission !== undefined ? hashWorldJson('round-player-submission-response/v2', intentSubmission) : submission.manifestation === undefined
          ? hashWorldJson('round-player-action-response', playerAction)
          : hashWorldJson('round-player-action-response', {
            action: playerAction, manifestation: submission.manifestation,
          }),
        proposalId: null,
        proposalHash: hashWorldJson('round-player-proposal', {
          actions: intentSubmission?.actions ?? [playerAction],
          ...(submission.manifestation === undefined ? {} : { manifestation: submission.manifestation }),
        }),
        ...(submission.manifestation === undefined ? {} : { manifestation: submission.manifestation }),
      },
    ]
    const actions = ordered.map(item => ({
      actionId: item.action.actionId,
      participantId: item.participantId,
      sourceRole: item.sourceRole,
      resolutionAuthority: resolutionAuthority(
        item.sourceRole,
        item.sourceRole === 'player' ? 'manual_player_immediate' : 'standard',
      ),
      actorId: item.action.actorId,
      actionType: item.action.actionType,
      actionVersion: item.action.actionVersion,
      parameters: item.action.parameters,
      proposalOrdinal: item.proposalOrdinal,
      ...(item.actionGroup === undefined ? {} : { actionGroup: item.actionGroup }),
      ...(item.manifestation === undefined ? {} : { manifestation: item.manifestation }),
      orderKey: {
        phase: 0,
        roleRank: 0,
        priority: item.priority,
        actorId: item.actorId,
        actionId: item.actionId,
        ...(item.actionGroup === undefined ? {} : {
          groupParticipantId: item.participantId,
          groupFirstActionId: ordered.find(first => first.participantId === item.participantId && first.proposalOrdinal === 0)!.actionId,
          stepOrdinal: item.proposalOrdinal,
        }),
      },
    }))
    const resolutions: WorldJsonValue[] = []
    let candidateHash = proposalContext.candidateHash
    const events: WorldEventDraft[] = []
    const outbox: OutboxDraft[] = []
    let playerResolution: RulebookResolution | undefined
    const observedCharacters = new Set<CharacterId>()
    const stoppedGroups = new Set<string>()
    for (const [ordinal, item] of ordered.entries()) {
      const actionPrefix = [...history, ...events]
      const groupPerformance = item.actionGroup?.manifestations[item.proposalOrdinal] ?? null
      const rulebookAction = bindFrozenInteractionPerformance(item.action, groupPerformance)
      const actionAuthority = resolutionAuthority(
        item.sourceRole,
        item.sourceRole === 'player' ? 'manual_player_immediate' : 'standard',
      )
      const { resolution: baseResolution, skipped } = resolveGroupAction(rulebookAction, item.participantId,
        item.actionGroup !== undefined, stoppedGroups,
        () => playerSteps.find(step => step.action.actionId === item.action.actionId)!.resolution)
      const moveTarget = item.action.actionType === 'move'
        ? (item.action.parameters as WorldJsonObject).locationId
        : undefined
      const resolution: RulebookResolution = baseResolution.status === 'accepted'
        && typeof moveTarget === 'string'
        && this.options.sceneDecision?.version === 2
        ? {
          ...baseResolution,
          events: [
            ...baseResolution.events,
            ...this.options.sceneDecision.transitionForMove(
              this.#address, actionPrefix, item.action.actorId, moveTarget, head.headSeq + events.length,
            ),
          ],
        }
        : baseResolution
      const performance = item.actionGroup === undefined ? item.manifestation
        : skipped || item.action.actionType === 'interact'
          ? undefined
          : stepManifestation(groupPerformance, resolution.status === 'accepted')
      const hostManifestation = performance === undefined ? undefined : {
        proposal: performance,
        resolution: resolveManifestation({
          roundId,
          actionId: item.action.actionId,
          actorId: item.action.actorId,
          manifestation: performance,
          events: actionPrefix,
        }),
      }
      const manifestation = hostManifestation ?? resolution.manifestation
      const manifestationResolution = manifestation?.resolution
      const resolvedEvents = hostManifestation === undefined
        ? resolution.events
        : [...resolution.events, ...hostManifestation.resolution.events]
      if (item.sourceRole === 'player' && provisional !== undefined) {
        verifyPlayerProvisional(playerSteps.find(step => step.action.actionId === item.action.actionId)!.provisional!, item.action, { ...resolution, events: resolvedEvents })
      }
      const phase8Audience = item.sourceRole === 'player' && provisional !== undefined ? playerSteps.find(step => step.action.actionId === item.action.actionId)!.audience : this.options.sceneDecision?.version === 2
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
        resolutionAuthority: actionAuthority,
        action: item.action,
        status: skipped ? 'skipped' : resolution.status,
        reason: resolution.reason ?? null,
        events: resolvedEvents,
        ...(manifestation === undefined ? {} : { manifestation }),
        ...(this.options.sceneDecision?.version !== 2 ? {} : {
          observationScope: resolution.observationScope ?? { scope: 'scene_public' },
        }),
      })
      candidateHash = resolution.status === 'accepted' || (manifestationResolution?.events.length ?? 0) > 0
        ? hashWorldJson('round-candidate-after-resolution', {
          candidateHashBefore, actionId: item.action.actionId, events: resolvedEvents, ruleTraceHash,
        })
        : candidateHashBefore
      resolutions.push({
        actionId: item.action.actionId,
        status: skipped ? 'skipped' : resolution.status,
        reason: resolution.reason ?? null,
        orderKey: actions[ordinal]!.orderKey,
        candidateHashBefore,
        candidateHashAfter: candidateHash,
        ruleTraceHash,
        entropyRefs: [],
        conflictingActionId: null,
        ...(manifestationResolution === undefined ? {} : { manifestation: manifestationResolution }),
        // The frozen path binds the definition set and the resolved role bindings it actually used, so a
        // durable Authority can prove which lock produced this action rather than only which verb ran.
        ...(resolution.interactionTrace === undefined ? {} : { interaction: resolution.interactionTrace }),
      })
      if (item.sourceRole === 'player' && playerResolution === undefined) playerResolution = resolution
      events.push(...resolvedEvents, {
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
          ...(manifestationResolution === undefined ? {} : { manifestationStatus: manifestationResolution.status }),
        },
      })
      const publicSpeech = (this.#manifest.rulebook.version >= 4
        || this.#manifest.contentPack?.runtimeCapabilities.publicSpeechObservationVersion === 1)
        ? resolution.events.find(event => event.eventType === 'character.speak')
        : undefined
      const publicManifestation = resolvedEvents.find(event => event.eventType === 'character.manifested')
      const publicInteraction = resolution.events.find(event => event.eventType === 'entity.transferred')
      const relations = characterRelationObservations(actionPrefix, resolution.events)
      const playerMovement = item.sourceRole === 'player' && resolution.status === 'accepted'
        && this.options.sceneDecision?.version === 2
        ? resolvedEvents.find(event => event.eventType === 'character.moved') : undefined
      const playerMovementData = playerMovement?.data as {
        readonly characterId: CharacterId
        readonly fromLocationId: string | null
        readonly toLocationId: string
      } | undefined
      // Arrival witnesses learn the destination; departure witnesses learn the origin. Only the actor gets both.
      const departureObservers = playerMovement === undefined ? undefined : new Set(this.options.sceneDecision!
        .decideFromEvents(this.#address, item.action.actorId, actionPrefix, head.headSeq + events.length).observerIds)
      const arrivalObservers = playerMovement === undefined ? undefined : new Set(this.options.sceneDecision!
        .decideFromEvents(this.#address, item.action.actorId, [...actionPrefix, ...resolvedEvents],
          head.headSeq + events.length + resolvedEvents.length).observerIds)
      const occurrenceOnly = new Set(phase8Audience?.occurrenceOnlyCharacterIds ?? [])
      const observerIds = phase8Audience === undefined
        ? this.options.sceneDecision?.decideFromEvents(
          this.#address, binding.characterId, [...history, ...events], head.headSeq,
        ).visibleResultCharacterIds ?? [binding.characterId]
        : [...phase8Audience.fullContentCharacterIds, ...phase8Audience.occurrenceOnlyCharacterIds]
      for (const observerId of observerIds) {
        const seesDeparture = observerId === item.action.actorId || departureObservers?.has(observerId) === true
        const seesArrival = observerId === item.action.actorId || arrivalObservers?.has(observerId) === true
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
            contentVisibility: 'occurrence_only',
          } : {
            actionType: item.action.actionType,
            actorId: item.action.actorId,
            status: skipped ? 'skipped' : resolution.status,
            reason: resolution.reason ?? null,
            // Keep the complete source distinct from the extracted expression and adjudicated facts.
            // A partial audience must never receive a private sibling clause or a move destination.
            ...(item.sourceRole !== 'player' || intentSubmission === undefined
              || (observerId !== binding.characterId && !playerSteps.every(step =>
                step.resolution.status === 'accepted' && step.action.actionType !== 'move'
                && step.audience?.fullContentCharacterIds.includes(observerId))) ? {} : {
                playerInput: { actorId: binding.characterId, sourceText: intentSubmission.sourceText,
                  sourceSpans: intentSubmission.sourceSpans,
                  note: '原始玩家输入，仅作解释证据；抽取可能不完整，原文不证明动作成功，也不替 NPC 决定行动。' },
              }),
            ...(publicSpeech === undefined ? {} : { speech: publicSpeech.data }),
            ...(publicManifestation === undefined ? {} : { manifestation: publicManifestation.data }),
            ...(publicInteraction === undefined ? {} : { interaction: publicInteraction.data }),
            ...(playerMovementData === undefined || (!seesDeparture && !seesArrival) ? {} : {
              movement: {
                characterId: playerMovementData.characterId,
                ...(seesDeparture ? { fromLocationId: playerMovementData.fromLocationId } : {}),
                ...(seesArrival ? { toLocationId: playerMovementData.toLocationId } : {}),
              },
            }),
            ...(relations.length === 0 ? {} : { relations }),
          },
        }
        observedCharacters.add(observerId)
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
    const cognitiveCharacters = new Set<CharacterId>()
    if (this.options.cognitiveMemory !== undefined) {
      for (const item of ordered) cognitiveCharacters.add(item.action.actorId)
      for (const observerId of sceneDecision!.observerIds) cognitiveCharacters.add(observerId)
      for (const observerId of observedCharacters) cognitiveCharacters.add(observerId)
    }
    const cognitiveCharacterIds = [...cognitiveCharacters].sort(compareWorldText)
    const authority = {
      schemaVersion: 6,
      roundId,
      baseHeadSeq: head.headSeq,
      baseTick: head.tick,
      contextHash,
      participants,
      actions,
      resolutions,
      finalCandidateHash: candidateHash,
      ...(provisional === undefined ? {} : { playerProvisional: provisional }),
      ...(intentSubmission === undefined ? {} : { playerSubmission: intentSubmission, playerProvisionalGroup: playerSteps.map(step => step.provisional!) }),
    } as const
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
      authority,
      correlationId,
      admissionProof: { inboxSeq: claimed.inboxSeq, inputHash: claimed.inputHash },
      writerFencingToken: this.#lease.fencingToken,
    })
    this.processCognitiveJobs()
    return {
      roundId,
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
      input: request.manifestation === undefined
        ? request.action
        : { action: request.action, manifestation: request.manifestation },
      correlationId: request.correlationId,
    }, this.#manifest.roundQueueLimit)
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

  #orderedActions(
    playerAction: ActionRequest,
    playerManifestation?: ManifestationProposal,
    playerGroup?: readonly ActionRequest[],
  ): OrderedAction[] {
    const actions: OrderedAction[] = [{
      action: playerAction,
      sourceRole: 'player',
      participantId: 'player',
      priority: Number.MAX_SAFE_INTEGER,
      actorId: playerAction.actorId,
      actionId: playerAction.actionId,
      proposalOrdinal: 0,
      ...(playerManifestation === undefined ? {} : { manifestation: playerManifestation }),
    }]
    if (playerGroup !== undefined) {
      actions.splice(0, 1, ...playerGroup.map((action, proposalOrdinal) => ({
        action, sourceRole: 'player' as const, participantId: 'player', priority: Number.MAX_SAFE_INTEGER,
        actorId: action.actorId, actionId: action.actionId, proposalOrdinal,
        actionGroup: { version: 'bounded-action-group/v1' as const, manifestations: playerGroup.map(() => null) },
      })))
    }
    return actions
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
    const keys = Object.keys(request.action).sort(compareWorldText)
    if (keys.join(',') !== 'actionType,parameters') throw new TypeError('action must contain exactly actionType and parameters')
    if (request.manifestation !== undefined) {
      throw new TypeError('Manifest v10 does not accept legacy free-text player manifestation')
    }
  }
}
