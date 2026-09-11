import { sortActionGroups, stepManifestation, resolveGroupAction } from './action-groups.ts'
import {
  SubmitActionsValidator,
  parseManifestationProposal,
  ReflectionPolicyValidator,
  ModelBudgetLedger,
  ProviderCallStore,
  ProviderQualityStore,
  SafeAgentRunner,
  type ManifestationProposalEnvelope,
  type ProviderCallRecord,
  type ProviderQualityDecision,
} from '@harness-world/agents'
import {
  PHASE8_SUBMIT_ACTIONS_PROFILE,
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  WorldError,
  type ActionRequest,
  type CharacterCognitionView,
  type ContextReceipt,
  type FaultInjector,
  type SubmitActionsV2,
  type SubmitActionsV3,
  type SubmitActionsV4,
  type SubmitActionsV5,
  type ActionGroupBinding,
  type CharacterId,
  type InteractionRoundId,
  type ManifestationProposal,
  type OutboxDraft,
  type Proposal,
  type ProposalContext,
  type ReactionCycleDraft,
  type ReactionCycleId,
  type RuntimeAvailabilityState,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  createCoreRulebookRegistry,
  currentCharacterLifecycle,
  manifestUsesPhase8Contracts,
  manifestationPolicyFromManifest,
  manifestUsesActionGroups,
  manifestUsesInteractions,
  parsePlayerActionInput,
  parsePlayerRoundResult,
  reactionPolicyFromManifest,
  resolveManifestation,
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
import type { SceneActionAudience, SceneDecision, SceneDecisionService } from './scene-decision.ts'
import type { ApplicationRuntimeMetrics } from './runtime-metrics.ts'
import { availabilityRecovery, retryableAvailability } from './runtime-availability.ts'
import type { Phase8ContextPipeline } from './context-pipeline.ts'

export type RoundParticipantRole = 'agent' | 'director'
export type ParticipantTerminalStatus = 'proposed' | 'provider_failed' | 'provider_timeout' | 'budget_exhausted' | 'schema_invalid' | 'provider_output_invalid' | 'lifecycle_ineligible' | 'runtime_unavailable'

export interface RoundParticipant {
  readonly participantId: string
  readonly role: RoundParticipantRole
  readonly actorId: CharacterId
  readonly allowedActionTypes: readonly string[]
  readonly priority: number
  readonly estimatedTokens: number
  readonly timeoutMs: number
  readonly provider: { propose(context: ProposalContext): Promise<Proposal | SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5> }
}

export interface ReactionParticipantDraftBinding {
  readonly actorId: CharacterId
  readonly estimatedTokens: number
}

const RESPONSIVE_V1_MAX_WAVES = 3
const RESPONSIVE_V1_MAX_NPC_CALLS = 8
const RESPONSIVE_V1_MAX_CALLS_PER_CHARACTER = 2
const REACTION_CYCLE_DEADLINE_MS = 30_000

/** Durable effect of committing exactly one accepted player Round; the Host scheduling quantum. */
export interface AcceptedRoundStep {
  readonly roundId: InteractionRoundId
  readonly transactionId: TransactionId
  readonly headSeq: number
  readonly tick: number
  readonly bundleHash: WorldHash
  readonly openedCycleId: ReactionCycleId | null
}

interface CommittedAcceptedRound {
  readonly roundId: InteractionRoundId
  readonly transactionId: TransactionId
  readonly openedCycleId: ReactionCycleId | null
  readonly result: PlayerRoundResult
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
  readonly contextPipeline?: Phase8ContextPipeline
  readonly providerCalls?: ProviderCallStore
  readonly providerQuality?: ProviderQualityStore
  readonly faultInjector?: FaultInjector
  readonly runtimeMetrics?: ApplicationRuntimeMetrics
  readonly reactionParticipants?: readonly ReactionParticipantDraftBinding[]
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

type CharacterProposal = Proposal & ManifestationProposalEnvelope

interface FrozenParticipant {
  readonly binding: RoundParticipant
  readonly status: ParticipantTerminalStatus
  readonly proposal: CharacterProposal
  readonly cognitive?: {
    readonly contextHash: ReturnType<typeof hashWorldJson>
    readonly memorySourceRefs: readonly MemorySourceRef[]
    readonly recallResultHash: ReturnType<typeof hashWorldJson>
    readonly contextReceiptId?: string
    readonly providerRequestHash?: ReturnType<typeof hashWorldJson>
    readonly receipt?: ContextReceipt
    readonly cognition?: CharacterCognitionView
  }
  readonly reflection?: ReturnType<ReflectionPolicyValidator['evaluate']>
  readonly providerCall?: ProviderCallRecord
  readonly providerQuality?: ProviderQualityDecision
  readonly availabilityTransition?: {
    readonly state: RuntimeAvailabilityState
    readonly reason: string | null
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
  readonly manifestation?: ManifestationProposal
  readonly actionGroup?: ActionGroupBinding
}

const roleRank = { player: 0, agent: 1, director: 2 } as const
type ProviderInvocationFailure = 'budget_exhausted' | 'provider_failed' | 'provider_timeout'

const terminalForFailure = {
  budget_exhausted: 'budget_exhausted',
  provider_failed: 'provider_rejected',
  provider_timeout: 'timed_out_ambiguous',
} as const

const participantFailureForCallState: Partial<Record<ProviderCallRecord['state'], ParticipantTerminalStatus>> = {
  failed_before_dispatch: 'provider_failed', provider_rejected: 'provider_failed',
  timed_out_ambiguous: 'provider_timeout', invalid_response: 'schema_invalid',
  budget_exhausted: 'budget_exhausted', discarded_after_quarantine: 'provider_failed',
}

const availabilityForFailure: Record<ProviderInvocationFailure | 'schema_invalid', FrozenParticipant['availabilityTransition']> = {
  budget_exhausted: { state: 'budget_unavailable', reason: 'model budget was exhausted' },
  provider_failed: { state: 'model_unavailable', reason: 'provider failed' },
  provider_timeout: { state: 'model_unavailable', reason: 'provider timed out' },
  schema_invalid: { state: 'model_unavailable', reason: 'provider returned an invalid action schema' },
}

const availabilityForTerminalCallState: Partial<Record<ProviderCallRecord['state'], FrozenParticipant['availabilityTransition']>> = {
  failed_before_dispatch: availabilityForFailure.provider_failed,
  provider_rejected: availabilityForFailure.provider_failed,
  timed_out_ambiguous: { state: 'model_unavailable', reason: 'provider result is ambiguous' },
  invalid_response: availabilityForFailure.schema_invalid,
  budget_exhausted: availabilityForFailure.budget_exhausted,
  discarded_after_quarantine: availabilityForFailure.provider_failed,
}

const availabilityStatesForTerminal: Record<ParticipantTerminalStatus, readonly RuntimeAvailabilityState[]> = {
  proposed: ['ready'],
  provider_failed: ['model_unavailable'],
  provider_timeout: ['model_unavailable'],
  budget_exhausted: ['budget_unavailable'],
  schema_invalid: ['ready', 'model_unavailable'],
  provider_output_invalid: ['provider_output_invalid'],
  lifecycle_ineligible: [],
  runtime_unavailable: ['session_lag'],
}

/** Compare the frozen ActionOrderKey tuple without consulting mutable world state. */
export function compareActionOrderKey(left: ActionOrderKey, right: ActionOrderKey): number {
  const role = roleRank[left.sourceRole] - roleRank[right.sourceRole]
  if (role !== 0) return role
  const priority = right.priority - left.priority
  if (priority !== 0) return priority
  const actor = compareWorldText(left.actorId, right.actorId)
  if (actor !== 0) return actor
  return compareWorldText(left.actionId, right.actionId)
}

/** Return the single authoritative Action order for player-root and NPC-only Rounds. */
export function sortActionOrderKeys<T extends ActionOrderKey>(values: readonly T[]): T[] {
  return [...values].sort(compareActionOrderKey)
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

interface ParticipantVisibleProposalContext {
  readonly context: ProposalContext
  readonly excludedStimulus?: ActionRequest
}

function participantVisibleContext(
  context: ProposalContext,
  binding: RoundParticipant,
  audience: SceneActionAudience | undefined,
  playerStatus: RulebookResolution['status'],
  directorCanSeeFull: boolean,
): ParticipantVisibleProposalContext {
  if (audience === undefined) return { context }
  const full = binding.role === 'director'
    ? directorCanSeeFull
    : audience.fullContentCharacterIds.includes(binding.actorId)
  if (full) return { context }
  const occurrenceOnly = binding.role === 'agent'
    && audience.occurrenceOnlyCharacterIds.includes(binding.actorId)
  const playerAction: ActionRequest = occurrenceOnly
    ? {
      actionId: deterministicId('action:occurrence-only-stimulus/v1', {
        roundId: context.roundId, participantId: binding.participantId,
      }),
      actorId: context.playerAction.actorId,
      actionType: 'private_interaction',
      actionVersion: 1,
      parameters: { status: playerStatus, contentVisibility: 'occurrence_only' },
    }
    : {
      actionId: deterministicId('action:no-visible-stimulus/v1', {
        roundId: context.roundId, participantId: binding.participantId,
      }),
      actorId: binding.actorId,
      actionType: 'context.no-visible-stimulus',
      actionVersion: 1,
      parameters: { visibility: 'none' },
    }
  const { playerManifestation: _hiddenManifestation, ...visibleBase } = context
  return {
    context: {
      ...visibleBase,
      playerAction,
      candidateHash: hashWorldJson('participant-visible-player-candidate-s1', {
        address: context.address,
        roundId: context.roundId,
        tick: context.tick,
        participantId: binding.participantId,
        playerAction,
      }),
    },
    excludedStimulus: context.playerAction,
  }
}

/** The sole production coordinator for player, NPC, and Director actions in one durable Round. */
export class RoundCoordinator {
  readonly #manifest: CompiledWorldManifest
  readonly #address: WorldAddress
  readonly #participants: readonly RoundParticipant[]
  readonly #validator = new SubmitActionsValidator()
  readonly #reflection = new ReflectionPolicyValidator()
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
      || compareWorldText(left.participantId, right.participantId))
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
    if (manifestUsesPhase8Contracts(this.#manifest) && options.contextPipeline !== undefined
      && this.#participants.length > 0
      && (options.providerCalls === undefined || options.providerQuality === undefined)) {
      throw new TypeError('Phase 8 participants require durable Provider call and quality boundaries')
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

  /** Expose the current writer lease for the reaction system to share. */
  get writerLease(): WriterLease { return this.#lease }

  /** Renew the writer lease; called by the reaction system before long operations. */
  renewWriterLease(): void { this.#renewLease() }

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

  /** Commit exactly one durable Inbox item so the composition root can interleave its Reaction Cycle. */
  processNextAccepted(correlationId: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    return this.options.runtimeLane.enqueueRound(async () => {
      if (await this.#runAcceptedStep(correlationId) === undefined) {
        throw new Error('Round Inbox lost an admitted responsive/v1 item')
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
      openedCycleId: committed.openedCycleId,
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
    const submission = parseClaimedPlayerSubmission(claimed.input)
    const action = submission.action
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
      this.reconcileCommittedProviderCalls(transactionId)
      this.reconcileCommittedAvailability(transactionId)
      return {
        roundId,
        transactionId,
        openedCycleId: this.options.store.reactionCycleIdByRootTransaction(this.#address, transactionId) ?? null,
        result: this.#committedPlayerResult(committed, roundId, playerAction),
      }
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
      action: { actionType: playerAction.actionType, parameters: playerAction.parameters },
    })
    const playerObservationScope = playerBaseResolution.observationScope ?? { scope: 'scene_public' as const }
    const playerAudience = this.options.sceneDecision?.version === 2
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
    const proposalContext: ProposalContext = {
      address: this.#address,
      roundId,
      tick: head.tick + 1,
      playerAction,
      ...(submission.manifestation === undefined ? {} : { playerManifestation: submission.manifestation }),
      candidateHash: hashWorldJson('world-player-candidate-s1', {
        baseHeadSeq: head.headSeq,
        baseTick: head.tick,
        playerAction,
        ...(submission.manifestation === undefined ? {} : { playerManifestation: submission.manifestation }),
      }),
    }
    const frozen = await this.#freezeParticipants(
      proposalContext,
      history,
      sceneDecision?.schedulableCharacterIds,
      sceneDecision,
      head.headSeq,
      playerAudience,
      playerBaseResolution.status,
      playerObservationScope.scope === 'scene_public',
    )
    const ordered = this.#orderedActions(playerAction, frozen, submission.manifestation)
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
        responseHash: submission.manifestation === undefined
          ? hashWorldJson('round-player-action-response', playerAction)
          : hashWorldJson('round-player-action-response', {
            action: playerAction, manifestation: submission.manifestation,
          }),
        proposalId: null,
        proposalHash: hashWorldJson('round-player-proposal', {
          actions: [playerAction],
          ...(submission.manifestation === undefined ? {} : { manifestation: submission.manifestation }),
        }),
        ...(submission.manifestation === undefined ? {} : { manifestation: submission.manifestation }),
      },
      ...frozen.map(value => {
        const proposalHash = hashWorldJson('round-participant-proposal', value.proposal)
        return {
          participantId: value.binding.participantId,
          role: value.binding.role,
          actorId: value.binding.actorId,
          terminalStatus: value.status,
          providerInvocationId: value.providerCall?.modelCallId
            ?? deterministicId('provider-invocation:round-participant', { roundId, participantId: value.binding.participantId }),
          contextHash: value.cognitive?.contextHash ?? contextHash,
          profileVersion: 'agent-provider-port/v1',
          budgetEvaluationId: deterministicId('budget-evaluation:round-participant', { roundId, participantId: value.binding.participantId }),
          modelReplayRecordHash: value.providerCall === undefined
            ? null
            : hashWorldJson('provider-call-record/v1', value.providerCall),
          budgetReservationRecordHash: null,
          responseHash: value.providerCall?.responseHash ?? hashWorldJson('round-participant-response', value.proposal),
          proposalId: deterministicId('proposal:round-participant', { roundId, participantId: value.binding.participantId, proposalHash }),
          proposalHash,
          ...(value.cognitive === undefined ? {} : {
            memorySourceRefs: value.cognitive.memorySourceRefs,
            recallResultHash: value.cognitive.recallResultHash,
            ...(value.cognitive.contextReceiptId === undefined ? {} : {
              contextReceiptId: value.cognitive.contextReceiptId,
              providerRequestHash: value.cognitive.providerRequestHash!,
            }),
          }),
          ...(value.reflection === undefined ? {} : { cognitivePolicyReceipt: value.reflection.receipt }),
          ...(value.providerCall === undefined ? {} : { providerCallState: value.providerCall.state }),
          ...(value.providerQuality === undefined ? {} : {
            providerQualityDecision: {
              policyId: 'provider-quality/v1',
              responseMode: value.providerQuality.responseMode,
              reflectionMode: value.providerQuality.reflectionMode,
              stateHash: value.providerQuality.state.stateHash,
            },
          }),
          ...(value.proposal.actionGroup === undefined ? {} : { actionGroup: value.proposal.actionGroup }),
          ...(value.proposal.manifestation === undefined ? {} : {
            manifestation: value.proposal.manifestation,
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
      ...(item.actionGroup === undefined ? {} : { actionGroup: item.actionGroup }),
      ...(item.manifestation === undefined ? {} : { manifestation: item.manifestation }),
      orderKey: {
        phase: item.sourceRole === 'player' ? 0 : 1,
        roleRank: roleRank[item.sourceRole],
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
    const reactionStimuli: {
      sourceEventOrdinal: number
      observationId: string
      observerId: CharacterId
      actorId: CharacterId
      sourceRole: 'player' | RoundParticipantRole
    }[] = []
    const stoppedGroups = new Set<string>()
    for (const [ordinal, item] of ordered.entries()) {
      const actionPrefix = [...history, ...events]
      const { resolution: baseResolution, skipped } = resolveGroupAction(item.action, item.participantId, item.actionGroup !== undefined, stoppedGroups, () => item.sourceRole === 'player'
        ? playerBaseResolution
        : this.#rulebook.resolve({
          manifest: this.#manifest,
          events: actionPrefix,
          characterId: item.action.actorId,
          action: { actionType: item.action.actionType, parameters: item.action.parameters },
        }))
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
        : skipped ? undefined : stepManifestation(item.actionGroup.manifestations[item.proposalOrdinal]!, resolution.status === 'accepted')
      const manifestation = performance === undefined ? undefined : {
        proposal: performance,
        resolution: resolveManifestation({
          roundId,
          actionId: item.action.actionId,
          actorId: item.action.actorId,
          manifestation: performance,
          events: actionPrefix,
        }),
      }
      const manifestationResolution = manifestation?.resolution
      const resolvedEvents = manifestationResolution === undefined
        ? resolution.events
        : [...resolution.events, ...manifestationResolution.events]
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
      })
      if (item.sourceRole === 'player') playerResolution = resolution
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
            contentVisibility: 'occurrence_only',
          } : {
            actionType: item.action.actionType,
            actorId: item.action.actorId,
            status: skipped ? 'skipped' : resolution.status,
            reason: resolution.reason ?? null,
            ...(publicSpeech === undefined ? {} : { speech: publicSpeech.data }),
            ...(publicManifestation === undefined ? {} : { manifestation: publicManifestation.data }),
            ...(publicInteraction === undefined ? {} : { interaction: publicInteraction.data }),
          },
        }
        reactionStimuli.push({
          sourceEventOrdinal: events.length,
          observationId,
          observerId,
          actorId: item.action.actorId,
          sourceRole: item.sourceRole,
        })
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
    for (const participant of frozen) {
      if (participant.reflection?.status === 'accepted' && participant.reflection.receipt.operationHashes.length > 0) {
        events.push(participant.reflection.event!)
      }
    }
    events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } })
    const cognitiveCharacters = new Set<CharacterId>()
    if (this.options.cognitiveMemory !== undefined) {
      for (const item of ordered) cognitiveCharacters.add(item.action.actorId)
      for (const observerId of sceneDecision!.observerIds) cognitiveCharacters.add(observerId)
      if (manifestUsesActionGroups(this.#manifest)) {
        for (const stimulus of reactionStimuli) cognitiveCharacters.add(stimulus.observerId)
      }
      for (const participant of frozen) {
        if (participant.reflection?.status === 'accepted') cognitiveCharacters.add(participant.binding.actorId)
      }
    }
    const cognitiveCharacterIds = [...cognitiveCharacters].sort(compareWorldText)
    const authority = {
      schemaVersion: manifestUsesActionGroups(this.#manifest) ? 4 : 2,
      roundId,
      baseHeadSeq: head.headSeq,
      baseTick: head.tick,
      contextHash,
      participants,
      actions,
      resolutions,
      finalCandidateHash: candidateHash,
    } as const
    this.#renewLease()
    if (frozen.some(value => value.providerCall?.state === 'validated')) {
      this.options.faultInjector?.hit('provider.before-world-commit')
    }
    const reactionCycle = this.#buildReactionCycleDraft(
      reactionStimuli,
      new Set(frozen.map(participant => participant.binding.actorId)),
    )
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
      ...(reactionCycle === undefined ? {} : { reactionCycle }),
      authority,
      operationalSummary: {
        schemaVersion: 'round-operational-summary/v1',
        participantTerminals: frozen.map(value => ({
          participantId: value.binding.participantId,
          role: value.binding.role,
          terminalStatus: value.status,
        })),
        participantAvailability: frozen.filter(value => value.availabilityTransition !== undefined).map(value => ({
          participantId: value.binding.participantId,
          actorId: value.binding.actorId,
          terminalStatus: value.status,
          state: value.availabilityTransition!.state,
          reason: value.availabilityTransition!.reason,
        })),
      },
      correlationId,
      admissionProof: { inboxSeq: claimed.inboxSeq, inputHash: claimed.inputHash },
      writerFencingToken: this.#lease.fencingToken,
    })
    this.reconcileCommittedProviderCalls(transactionId)
    this.reconcileCommittedAvailability(transactionId)
    for (const participant of frozen) {
      if (participant.status !== 'proposed') this.options.runtimeMetrics?.recordParticipant(participant.status)
    }
    this.processCognitiveJobs()
    return {
      roundId,
      transactionId,
      openedCycleId: this.options.store.reactionCycleIdByRootTransaction(this.#address, transactionId) ?? null,
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

  async #freezeParticipants(
    context: ProposalContext,
    history: readonly { readonly eventType: string; readonly data: WorldJsonValue }[],
    schedulableCharacterIds?: readonly CharacterId[],
    sceneDecision?: SceneDecision,
    asOfWorldSeq = 0,
    playerAudience?: SceneActionAudience,
    playerStatus: RulebookResolution['status'] = 'accepted',
    directorCanSeeFull = true,
  ): Promise<FrozenParticipant[]> {
    const frozen: FrozenParticipant[] = []
    const actionIds = new Set<string>([context.playerAction.actionId])
    const runner = new SafeAgentRunner(new ModelBudgetLedger(this.options.modelBudgetTokens))
    for (const binding of this.#participants) {
      if (schedulableCharacterIds !== undefined) {
        if (binding.role === 'agent' && !schedulableCharacterIds.includes(binding.actorId)) continue
        if (binding.role === 'director') {
          const eligible = sceneDecision?.schemaVersion === 'scene-decision/v2'
            ? sceneDecision.directorEligible === true
            : schedulableCharacterIds.includes(binding.actorId)
          if (!eligible) continue
        }
      }
      if (currentCharacterLifecycle(history, binding.actorId) !== 'active') {
        frozen.push({ binding, status: 'lifecycle_ineligible', proposal: { participantId: binding.participantId, actions: [] } })
        continue
      }
      const availabilityState = this.options.availability.get(this.#address, binding.actorId)?.state
      if (!retryableAvailability(availabilityState, this.options.providerQuality !== undefined)) {
        frozen.push({ binding, status: 'runtime_unavailable', proposal: { participantId: binding.participantId, actions: [] } })
        continue
      }
      let providerQuality = this.options.providerQuality?.beginEligibleTick(
        this.#address, binding.participantId, context.roundId,
      )
      if (providerQuality?.responseMode === 'skip') {
        frozen.push(this.#frozen(
          binding, 'provider_output_invalid', { participantId: binding.participantId, actions: [] }, undefined,
          {
            state: 'provider_output_invalid',
            reason: `Provider output probe is backed off for ${providerQuality.state.responseBackoffRemaining} more eligible Tick(s)`,
          },
          undefined, undefined, providerQuality,
        ))
        continue
      }
      const visible = participantVisibleContext(
        context, binding, playerAudience, playerStatus, directorCanSeeFull,
      )
      let providerContext: ProposalContext | CognitiveProposalContext = visible.context
      let cognitive: FrozenParticipant['cognitive']
      if (this.options.contextPipeline !== undefined) {
        try {
          this.#renewLease()
          const prepared = this.options.contextPipeline.prepare(
            binding, visible.context, history as ReturnType<WorldStore['readEvents']>, sceneDecision!, asOfWorldSeq,
            () => this.#renewLease(), visible.excludedStimulus,
          )
          providerContext = prepared.providerContext
          cognitive = {
            contextHash: prepared.receipt.contextHash,
            memorySourceRefs: prepared.memorySourceRefs,
            recallResultHash: prepared.recallResultHash,
            contextReceiptId: prepared.receipt.receiptId,
            providerRequestHash: prepared.receipt.providerRequestHash,
            receipt: prepared.receipt,
            ...(prepared.cognition === undefined ? {} : { cognition: prepared.cognition }),
          }
        } catch (error: unknown) {
          if (error instanceof WorldError && error.envelope.category === 'integrity') throw error
          frozen.push(this.#frozen(
            binding, 'runtime_unavailable', { participantId: binding.participantId, actions: [] }, undefined,
            { state: 'session_lag', reason: `Phase 8 Context preparation failed: ${String(error)}` },
            undefined, undefined, providerQuality,
          ))
          continue
        }
      } else if (this.options.cognitiveMemory !== undefined) {
        try {
          this.#renewLease()
          const prepared = this.options.cognitiveMemory.prepare({
            address: this.#address,
            roundId: visible.context.roundId,
            tick: visible.context.tick,
            participantId: binding.participantId,
            characterId: binding.actorId,
            asOfWorldSeq,
            playerAction: visible.context.playerAction,
            candidateHash: visible.context.candidateHash,
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
            undefined, undefined, providerQuality,
          ))
          continue
        }
      }
      this.#renewLease()
      let providerCall = cognitive?.receipt === undefined || this.options.providerCalls === undefined
        ? undefined
        : this.options.providerCalls.prepare(cognitive.receipt)
      let providerOutput: Proposal | SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5 | undefined
      if (providerCall?.state === 'dispatch_started') {
        providerCall = this.options.providerCalls!.markTerminal(providerCall.modelCallId, 'timed_out_ambiguous', {
          reason: 'provider dispatch had no durable terminal result',
        })
      } else if (providerCall?.state === 'response_received') {
        providerOutput = providerCall.response as Proposal | SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5
      } else if (providerCall?.state === 'validated') {
        providerOutput = providerCall.proposal as Proposal | SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5
      }
      if (providerCall !== undefined && !['prepared', 'response_received', 'validated'].includes(providerCall.state)) {
        let failure = participantFailureForCallState[providerCall.state]!
        let transition = availabilityForTerminalCallState[providerCall.state]!
        if (providerCall.state === 'invalid_response' && providerQuality !== undefined) {
          const invalid = this.#invalidProviderOutput(binding, providerCall, providerQuality)
          failure = invalid.status
          transition = invalid.transition!
          providerQuality = invalid.quality
        }
        frozen.push(this.#frozen(
          binding, failure, { participantId: binding.participantId, actions: [] }, cognitive,
          transition,
          undefined, providerCall, providerQuality,
        ))
        continue
      }
      if (providerOutput === undefined) {
        const run = await runner.invoke(
          `provider:${context.roundId}:${binding.participantId}`,
          binding.estimatedTokens,
          binding.timeoutMs,
          binding.provider,
          providerContext,
          providerCall === undefined ? undefined : () => {
            this.options.faultInjector?.hit('provider.before-dispatch')
            providerCall = this.options.providerCalls!.markDispatchStarted(providerCall!.modelCallId)
          },
          providerCall === undefined ? undefined : () => {
            this.options.faultInjector?.hit('provider.after-dispatch')
          },
        )
        this.#renewLease()
        if (run.status === 'fallback') {
          const failure = run.failure!
          if (providerCall !== undefined) {
            providerCall = this.options.providerCalls!.markTerminal(
              providerCall.modelCallId,
              terminalForFailure[failure],
              { reason: failure },
            )
          }
          if (failure !== 'budget_exhausted' && providerCall !== undefined && providerQuality !== undefined) {
            // The Provider call ledger already records the exact failure; counting it here only escalates the
            // shared retry backoff, so a broken Provider is not re-called on every eligible Round.
            providerQuality = { ...providerQuality, state: this.options.providerQuality!.recordResponse(
              this.#address, binding.participantId, providerCall.modelCallId, 'invalid',
            ) }
          }
          frozen.push(this.#frozen(
            binding, failure, { participantId: binding.participantId, actions: [] }, cognitive,
            availabilityForFailure[failure],
            undefined, providerCall, providerQuality,
          ))
          continue
        }
        providerOutput = run.output
        if (providerCall !== undefined) {
          providerCall = this.options.providerCalls!.recordResponse(providerCall.modelCallId, providerOutput, {
            provider: 'scripted', requestId: null, usage: null, cache: null,
          })
          this.options.faultInjector?.hit('provider.after-response')
        }
      }
      try {
        const authorization = {
          participantId: binding.participantId,
          actorId: binding.actorId,
          allowedActionTypes: binding.allowedActionTypes,
          maxActions: PHASE8_SUBMIT_ACTIONS_PROFILE.maximumExternalActions,
          correlationId: `coordinator:${context.roundId}:${binding.participantId}`,
        }
        let proposal: CharacterProposal
        let reflection: FrozenParticipant['reflection']
        if (manifestUsesPhase8Contracts(this.#manifest) && binding.role === 'agent') {
          const validatorAuthorization = {
            ...authorization,
            maxReflectionOperations: PHASE8_SUBMIT_ACTIONS_PROFILE.maximumReflectionOperations,
          }
          const validated = manifestUsesActionGroups(this.#manifest)
            ? (manifestUsesInteractions(this.#manifest) ? this.#validator.validateV5(providerOutput, validatorAuthorization) : this.#validator.validateV4(providerOutput, validatorAuthorization))
            : manifestationPolicyFromManifest(this.#manifest).mode === 'enabled'
            ? this.#validator.validateV3(providerOutput, validatorAuthorization)
            : this.#validator.validateV2(providerOutput, validatorAuthorization)
          proposal = validated.proposal
          const reflectionOperations = 'reflectionOperations' in validated ? validated.reflectionOperations : undefined
          if (reflectionOperations !== undefined && providerQuality?.reflectionMode !== 'suspended') {
            if (cognitive?.receipt === undefined || cognitive.cognition === undefined) {
              throw new TypeError('Phase 8 Reflection requires the exact Character Context prefix')
            }
            reflection = this.#reflection.evaluate({
              participantId: binding.participantId, actorId: binding.actorId,
              contextReceipt: cognitive.receipt, cognition: cognitive.cognition,
              contextProfileId: cognitive.receipt.contextProfileId,
              operations: reflectionOperations,
              correlationId: `reflection:${context.roundId}:${binding.participantId}`,
            })
          }
        } else {
          const legacy = providerOutput as Proposal
          proposal = this.#validator.validate({
            schemaVersion: 1, participantId: legacy.participantId, actions: legacy.actions,
          }, authorization)
        }
        if (proposal.actions.some(action => actionIds.has(action.actionId))) {
          if (providerCall?.state === 'response_received') {
            providerCall = this.options.providerCalls!.markTerminal(providerCall.modelCallId, 'invalid_response', {
              reason: 'provider reused an actionId already frozen in the Round',
            })
          }
          const invalid = this.#invalidProviderOutput(binding, providerCall, providerQuality)
          frozen.push(this.#frozen(
            binding, invalid.status, { participantId: binding.participantId, actions: [] }, cognitive,
            invalid.transition,
            undefined, providerCall, invalid.quality,
          ))
          continue
        }
        for (const action of proposal.actions) actionIds.add(action.actionId)
        if (providerCall !== undefined && providerQuality !== undefined && this.options.providerQuality !== undefined) {
          const responseState = this.options.providerQuality.recordResponse(
            this.#address, binding.participantId, providerCall.modelCallId, 'valid',
          )
          providerQuality = { ...providerQuality, state: responseState }
          if (reflection !== undefined) {
            const reflectionState = this.options.providerQuality.recordReflection(
              this.#address, binding.participantId, `${providerCall.modelCallId}:reflection`,
              reflection.status === 'accepted' ? 'valid' : 'invalid',
            )
            providerQuality = { ...providerQuality, state: reflectionState }
          }
        }
        if (providerCall !== undefined) {
          providerCall = this.options.providerCalls!.markValidated(providerCall.modelCallId, providerOutput)
        }
        frozen.push(this.#frozen(
          binding, 'proposed', proposal, cognitive,
          availabilityRecovery(availabilityState),
          reflection, providerCall, providerQuality,
        ))
      } catch (error: unknown) {
        if (providerCall?.state === 'validated') {
          failWorld({
            errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
            message: 'durably validated Provider output no longer validates', retryable: false,
            correlationId: `provider-call:${providerCall.modelCallId}`, address: this.#address, roundId: context.roundId,
          })
        }
        if (providerCall?.state === 'response_received') {
          providerCall = this.options.providerCalls!.markTerminal(providerCall.modelCallId, 'invalid_response', {
            reason: String(error),
          })
        }
        const invalid = this.#invalidProviderOutput(binding, providerCall, providerQuality)
        frozen.push(this.#frozen(
          binding, invalid.status, { participantId: binding.participantId, actions: [] }, cognitive,
          invalid.transition,
          undefined, providerCall, invalid.quality,
        ))
      }
    }
    return frozen
  }

  #frozen(
    binding: RoundParticipant,
    status: ParticipantTerminalStatus,
    proposal: CharacterProposal,
    cognitive?: FrozenParticipant['cognitive'],
    availabilityTransition?: FrozenParticipant['availabilityTransition'],
    reflection?: FrozenParticipant['reflection'],
    providerCall?: ProviderCallRecord,
    providerQuality?: ProviderQualityDecision,
  ): FrozenParticipant {
    return {
      binding, status, proposal,
      ...(cognitive === undefined ? {} : { cognitive }),
      ...(availabilityTransition === undefined ? {} : { availabilityTransition }),
      ...(reflection === undefined ? {} : { reflection }),
      ...(providerCall === undefined ? {} : { providerCall }),
      ...(providerQuality === undefined ? {} : { providerQuality }),
    }
  }

  #invalidProviderOutput(
    binding: RoundParticipant,
    providerCall: ProviderCallRecord | undefined,
    quality: ProviderQualityDecision | undefined,
  ): {
    readonly status: 'schema_invalid' | 'provider_output_invalid'
    readonly transition?: FrozenParticipant['availabilityTransition']
    readonly quality?: ProviderQualityDecision
  } {
    if (providerCall === undefined || quality === undefined || this.options.providerQuality === undefined) {
      return {
        status: 'schema_invalid',
        transition: { state: 'model_unavailable', reason: 'provider returned an invalid action schema' },
      }
    }
    const state = this.options.providerQuality.recordResponse(
      this.#address, binding.participantId, providerCall.modelCallId, 'invalid',
    )
    const nextQuality = { ...quality, state }
    return state.responseInvalidStreak < 3
      ? { status: 'schema_invalid', transition: { state: 'ready', reason: null }, quality: nextQuality }
      : {
          status: 'provider_output_invalid',
          transition: {
            state: 'provider_output_invalid',
            reason: `Provider output is invalid; probe backoff level ${state.responseBackoffLevel}`,
          },
          quality: nextQuality,
        }
  }

  /** Complete the derivation-side call marker after a world commit won a crash race. */
  reconcileCommittedProviderCalls(transactionId: TransactionId): void {
    if (this.options.providerCalls === undefined) return
    const authority = this.options.store.readRoundAuthority(this.#address, transactionId)!
    for (const participant of authority.authority.participants as readonly WorldJsonObject[]) {
      if (participant.providerCallState !== 'validated' || typeof participant.providerInvocationId !== 'string') continue
      const stored = this.options.providerCalls.read(participant.providerInvocationId)
      if (stored === undefined) continue
      this.options.providerCalls.markCommitted(stored.modelCallId, transactionId, authority.authorityHash)
    }
  }

  /** Apply durable post-commit availability intent after validating it against Round Authority. */
  reconcileCommittedAvailability(transactionId: TransactionId): void {
    const summary = this.options.store.committedRoundOperationalSummary(this.#address, transactionId)
    if (summary?.schemaVersion !== 'round-operational-summary/v1') return
    const availabilityValues = summary.participantAvailability
    if (!Array.isArray(availabilityValues)) this.#invalidOperationalSummary(transactionId)
    const authority = this.options.store.readRoundAuthority(this.#address, transactionId)
    if (authority === undefined || !Array.isArray(authority.authority.participants)) {
      this.#invalidOperationalSummary(transactionId)
    }
    const authorityParticipants = (authority.authority.participants as readonly WorldJsonValue[]).map(value => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        this.#invalidOperationalSummary(transactionId)
      }
      return value as WorldJsonObject
    })
    const seen = new Set<string>()
    for (const value of availabilityValues) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        this.#invalidOperationalSummary(transactionId)
      }
      const transition = value as WorldJsonObject
      if (typeof transition.participantId !== 'string' || typeof transition.actorId !== 'string'
        || typeof transition.terminalStatus !== 'string' || typeof transition.state !== 'string'
        || !(transition.reason === null || typeof transition.reason === 'string')) {
        this.#invalidOperationalSummary(transactionId)
      }
      const participantKey = `${transition.participantId}\u001f${transition.actorId}`
      if (seen.has(participantKey)) this.#invalidOperationalSummary(transactionId)
      seen.add(participantKey)
      if (!Object.hasOwn(availabilityStatesForTerminal, transition.terminalStatus)) {
        this.#invalidOperationalSummary(transactionId)
      }
      const terminalStatus = transition.terminalStatus as ParticipantTerminalStatus
      const state = transition.state as RuntimeAvailabilityState
      if (!availabilityStatesForTerminal[terminalStatus].includes(state)
        || (state === 'ready') !== (transition.reason === null)) {
        this.#invalidOperationalSummary(transactionId)
      }
      const participant = authorityParticipants.find(candidate => (
        candidate.participantId === transition.participantId
        && candidate.actorId === transition.actorId
        && candidate.terminalStatus === terminalStatus
      ))
      if (participant === undefined) this.#invalidOperationalSummary(transactionId)
      this.options.availability.set(
        this.#address,
        brandId(transition.actorId, 'CharacterId'),
        state,
        transition.reason as string | null,
      )
    }
  }

  #invalidOperationalSummary(transactionId: TransactionId): never {
    failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
      message: 'committed Round operational reconciliation intent diverged from Authority', retryable: false,
      correlationId: `round-operational-summary:${transactionId}`, address: this.#address,
    })
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
    frozen: readonly FrozenParticipant[],
    playerManifestation?: ManifestationProposal,
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
          ...(participant.proposal.actionGroup === undefined ? {} : { actionGroup: participant.proposal.actionGroup }),
          ...(participant.proposal.manifestation === undefined ? {} : {
            manifestation: participant.proposal.manifestation,
          }),
        })
      }
    }
    return manifestUsesActionGroups(this.#manifest) ? sortActionGroups(actions, compareActionOrderKey) : sortActionOrderKeys(actions)
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
      if (manifestUsesActionGroups(this.#manifest)) throw new TypeError('Manifest v7 does not accept legacy free-text player manifestation')
      if (manifestationPolicyFromManifest(this.#manifest).mode !== 'enabled') {
        failWorld({
          errorCode: 'INVALID_REQUEST', category: 'admission',
          message: 'player manifestation requires an enabled Manifest capability', retryable: false,
          correlationId: request.correlationId, address: this.#address,
        })
      }
      parseManifestationProposal(request.manifestation)
    }
  }

  #buildReactionCycleDraft(
    stimuli: readonly {
      sourceEventOrdinal: number
      observationId: string
      observerId: CharacterId
      actorId: CharacterId
      sourceRole: 'player' | RoundParticipantRole
    }[],
    rootParticipantActorIds: ReadonlySet<CharacterId>,
  ): ReactionCycleDraft | undefined {
    const policy = reactionPolicyFromManifest(this.#manifest)
    if (policy.mode !== 'responsive') return undefined
    const reactionParticipants = this.options.reactionParticipants ?? []
    const playerCharacters = new Set(this.#manifest.playerBindings.map(binding => binding.characterId))
    const stimuliByObserver = new Map<CharacterId, { sourceEventOrdinal: number; observationOrdinal: number; observationId: string; observerCharacterId: CharacterId }[]>()
    for (const stimulus of stimuli) {
      if (stimulus.observerId === stimulus.actorId
        || (stimulus.sourceRole === 'player' && rootParticipantActorIds.has(stimulus.observerId))) continue
      let bucket = stimuliByObserver.get(stimulus.observerId)
      if (bucket === undefined) {
        bucket = []
        stimuliByObserver.set(stimulus.observerId, bucket)
      }
      bucket.push({
        sourceEventOrdinal: stimulus.sourceEventOrdinal,
        observationOrdinal: 0,
        observationId: stimulus.observationId,
        observerCharacterId: stimulus.observerId,
      })
    }
    const candidates = reactionParticipants
      .filter(participant => !playerCharacters.has(participant.actorId) && stimuliByObserver.has(participant.actorId))
      .map(participant => ({
        characterId: participant.actorId,
        estimatedTokens: participant.estimatedTokens,
        stimuli: stimuliByObserver.get(participant.actorId)!,
      }))
      .sort((left, right) => compareWorldText(left.characterId, right.characterId))
    if (candidates.length === 0) return undefined
    const maximumEstimate = Math.max(...candidates.map(candidate => candidate.estimatedTokens))
    const initialTokenBudget = Math.min(
      this.options.modelBudgetTokens,
      RESPONSIVE_V1_MAX_NPC_CALLS * maximumEstimate,
    )
    return {
      policyVersion: 'reaction-policy/v1',
      profileId: 'responsive/v1',
      maxWaves: RESPONSIVE_V1_MAX_WAVES,
      maxNpcCalls: RESPONSIVE_V1_MAX_NPC_CALLS,
      maxCallsPerCharacter: RESPONSIVE_V1_MAX_CALLS_PER_CHARACTER,
      maxActionsPerCall: manifestUsesActionGroups(this.#manifest) ? 2 : 1,
      allowedActionTypes: manifestUsesInteractions(this.#manifest) ? ['speak@1', 'move@1', 'interact@1'] : manifestUsesActionGroups(this.#manifest) ? ['speak@1', 'move@1', 'take@1'] : ['speak@1'],
      initialTokenBudget,
      deadlineAtMs: Date.now() + REACTION_CYCLE_DEADLINE_MS,
      candidates,
    }
  }
}
