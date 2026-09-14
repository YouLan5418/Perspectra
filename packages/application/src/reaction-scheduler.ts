import { sortActionGroups, stepManifestation, resolveGroupAction } from './action-groups.ts'
import { alwaysRetryableAvailability } from './runtime-availability.ts'
import {
  ModelBudgetLedger,
  ProviderCallStore,
  SafeAgentRunner,
  SubmitActionsValidator,
  type ManifestationProposalEnvelope,
  type ProviderCallRecord,
} from '@harness-world/agents'
import {
  brandId,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  resolutionAuthority,
  planStableCallBudget,
  WorldError,
  type ActionRequest,
  type CharacterId,
  type ClaimedReactionJob,
  type FaultInjector,
  type InteractionRoundId,
  type OutboxDraft,
  type Proposal,
  type ReactionAgentProvider,
  type ReactionCandidateDraft,
  type ReactionContextStimulusBundle,
  type ReactionJobOutcome,
  type ReactionProposalContext,
  type ReactionStimulusDraft,
  type ReactionWaveSettlementDraft,
  type StoredReactionCycleBundle,
  type SubmitActionsV2,
  type SubmitActionsV3,
  type SubmitActionsV4,
  type SubmitActionsV5,
  type ActionGroupBinding,
  type ManifestationProposal,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentCharacterLifecycle,
  characterRelationObservations,
  manifestationPolicyFromManifest,
  manifestUsesActionGroups,
  manifestUsesHostAuthority,
  manifestUsesInteractions,
  resolveManifestation,
  type CompiledWorldManifest,
  type RulebookRegistry,
  type RulebookResolver,
} from '@harness-world/kernel'
import {
  CharacterRuntimeAvailabilityService,
  WorldStore,
  type WriterLease,
} from '@harness-world/store-sqlite'
import type {
  PreparedPhase8ReactionParticipant,
  ReactionContextBinding,
} from './context-pipeline.ts'
import { compareActionOrderKey, sortActionOrderKeys } from './round-coordinator.ts'
import type { SceneDecisionService } from './scene-decision.ts'

export interface ReactionParticipantBinding extends ReactionContextBinding {
  readonly role: 'agent'
  readonly priority: number
  readonly estimatedTokens: number
  readonly timeoutMs: number
  readonly provider: ReactionAgentProvider
}

/** The branch composition root owns the lease; the Scheduler only renews and consumes it. */
export interface ReactionWriterLeasePort {
  current(): WriterLease
  renew(): WriterLease
}

export interface ReactionContextPreparer {
  prepareReaction(
    binding: ReactionContextBinding,
    context: ReactionProposalContext,
    history: ReturnType<WorldStore['readEvents']>,
    decision: ReturnType<SceneDecisionService['decideFromEvents']>,
    asOfWorldSeq: number,
    heartbeat: () => void,
  ): PreparedPhase8ReactionParticipant
}

export interface ReactionSchedulerOptions {
  readonly address: WorldAddress
  readonly manifest: CompiledWorldManifest
  /** The Host's own identity of the locked Manifest. A frozen resolution binds it into its trace. */
  readonly manifestHash: WorldHash
  readonly store: WorldStore
  readonly availability: CharacterRuntimeAvailabilityService
  readonly sceneDecision: SceneDecisionService
  readonly contextPipeline: ReactionContextPreparer
  readonly providerCalls: ProviderCallStore
  readonly rulebooks: RulebookRegistry
  readonly participants: readonly ReactionParticipantBinding[]
  readonly writer: ReactionWriterLeasePort
  readonly faultInjector?: FaultInjector
  readonly now?: () => number
  readonly claimTtlMs?: number
  readonly claimHeartbeatMs?: number
}

export interface ReactionWaveResult {
  readonly cycleId: string
  readonly rootRoundId: InteractionRoundId
  readonly wave: number
  readonly roundId: InteractionRoundId
  readonly transactionId: TransactionId
  readonly headSeq: number
  readonly tick: number
  readonly terminalReason: ReactionWaveSettlementDraft['terminalReason']
  readonly actionCount: number
}

interface PreparedJob {
  readonly job: ClaimedReactionJob
  readonly binding?: ReactionParticipantBinding
  readonly prepared?: PreparedPhase8ReactionParticipant
  readonly providerCall?: ProviderCallRecord
  readonly unavailableReason?: string
}

type ReactionCharacterProposal = Proposal & ManifestationProposalEnvelope

interface ExecutedJob {
  readonly job: ClaimedReactionJob
  readonly binding?: ReactionParticipantBinding
  readonly prepared?: PreparedPhase8ReactionParticipant
  readonly providerCall?: ProviderCallRecord
  readonly outcome: 'abstained' | 'proposed' | 'provider_terminal' | 'runtime_unavailable'
  readonly proposal: ReactionCharacterProposal
}

interface OrderedReactionAction {
  readonly jobId: ClaimedReactionJob['jobId']
  readonly participantId: string
  readonly sourceRole: 'agent'
  readonly priority: number
  readonly actorId: CharacterId
  readonly actionId: string
  readonly action: ActionRequest
  readonly proposalOrdinal: number
  readonly manifestation?: ManifestationProposal
  readonly actionGroup?: ActionGroupBinding
}

interface BuiltReactionRound {
  readonly events: readonly WorldEventDraft[]
  readonly outbox: readonly OutboxDraft[]
  readonly cognitiveCharacterIds: readonly CharacterId[]
  readonly nextWaveCandidates: readonly ReactionCandidateDraft[]
  readonly authority: WorldJsonObject
  readonly outcomes: ReadonlyMap<ClaimedReactionJob['jobId'], ReactionJobOutcome>
  readonly actionCount: number
}

const terminalCallStates = new Set<ProviderCallRecord['state']>([
  'failed_before_dispatch', 'provider_rejected', 'timed_out_ambiguous', 'invalid_response',
  'budget_exhausted', 'discarded_after_quarantine',
])
const providerTerminalForFailure = {
  provider_timeout: 'timed_out_ambiguous',
  budget_exhausted: 'budget_exhausted',
  provider_failed: 'provider_rejected',
} as const

/** Execute one already frozen NPC-only wave without entering the player Inbox. */
export class ReactionScheduler {
  readonly #bindings: ReadonlyMap<CharacterId, ReactionParticipantBinding>
  readonly #rulebook: RulebookResolver
  readonly #validator = new SubmitActionsValidator()
  readonly #now: () => number
  readonly #claimTtlMs: number
  readonly #claimHeartbeatMs: number

  constructor(private readonly options: ReactionSchedulerOptions) {
    const bindings = new Map<CharacterId, ReactionParticipantBinding>()
    for (const binding of options.participants) {
      if (bindings.has(binding.actorId)) throw new TypeError(`duplicate Reaction participant ${binding.actorId}`)
      if (!options.manifest.characters.some(character => character.characterId === binding.actorId)) {
        throw new TypeError(`Reaction participant ${binding.actorId} is absent from the Manifest`)
      }
      if (!binding.allowedActionTypes.includes('speak') || binding.allowedActionTypes.some(value =>
        !(manifestUsesActionGroups(options.manifest) ? ['speak', 'move', manifestUsesInteractions(options.manifest) ? 'interact' : 'take'] : ['speak']).includes(value))) {
        throw new TypeError('Reaction v1 participants must allow only speak')
      }
      if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs <= 0) {
        throw new RangeError('Reaction participant timeoutMs must be a positive safe integer')
      }
      if (!Number.isSafeInteger(binding.estimatedTokens) || binding.estimatedTokens <= 0) {
        throw new RangeError('Reaction participant estimatedTokens must be a positive safe integer')
      }
      bindings.set(binding.actorId, binding)
    }
    this.#bindings = bindings
    this.#rulebook = options.rulebooks.resolve(
      options.manifest.rulebook.rulebookId,
      options.manifest.rulebook.version,
      'reaction-scheduler:rulebook',
      options.address,
    )
    this.#now = options.now ?? Date.now
    this.#claimTtlMs = options.claimTtlMs ?? 30_000
    this.#claimHeartbeatMs = options.claimHeartbeatMs ?? 10_000
    if (!Number.isSafeInteger(this.#claimTtlMs) || this.#claimTtlMs <= 1) {
      throw new RangeError('Reaction claimTtlMs must be a safe integer greater than 1')
    }
    if (!Number.isSafeInteger(this.#claimHeartbeatMs) || this.#claimHeartbeatMs <= 0
      || this.#claimHeartbeatMs >= this.#claimTtlMs) {
      throw new RangeError('Reaction claimHeartbeatMs must be a positive safe integer below claimTtlMs')
    }
  }

  async runCurrentWave(): Promise<ReactionWaveResult | undefined> {
    const initial = this.options.store.activeReactionCycle(this.options.address)
    if (initial === undefined || initial.cycle.status === 'terminal') return undefined
    if ((initial.cycle.allowedActionTypes.includes('interact@1' as never) !== manifestUsesInteractions(this.options.manifest)) || initial.cycle.maxActionsPerCall !== (manifestUsesActionGroups(this.options.manifest) ? 2 : 1)) {
      throw new Error('Reaction Cycle action policy differs from Manifest')
    }
    const wave = initial.waves.at(-1)!
    if (wave.status !== 'frozen') throw new Error('active Reaction Cycle does not end in a frozen Wave')
    const head = this.options.store.head(this.options.address)
    if (head.headSeq !== wave.baseHeadSeq || head.eventHash !== wave.baseHeadHash) {
      throw new Error('Reaction Wave base Head is divergent')
    }
    const roundId = brandId(deterministicId('round:reaction-cycle/v1', {
      address: this.options.address, cycleId: initial.cycle.cycleId, wave: wave.wave,
    }), 'InteractionRoundId')
    const transactionId = brandId(deterministicId('transaction:reaction-cycle/v1', {
      address: this.options.address, cycleId: initial.cycle.cycleId, wave: wave.wave,
    }), 'TransactionId')
    const claims = this.#claimWave(initial)
    const current = this.options.store.readReactionCycle(this.options.address, initial.cycle.cycleId)
    if (current === undefined || current.cycle.status === 'terminal') {
      throw new Error('Reaction Cycle disappeared after Wave claims')
    }
    const history = this.options.store.readEvents(this.options.address, head.headSeq)
    const candidateHash = hashWorldJson('world-reaction-candidate-s1/v1', {
      address: this.options.address,
      cycleId: initial.cycle.cycleId,
      wave: wave.wave,
      baseHeadSeq: head.headSeq,
      baseTick: head.tick,
      jobs: claims.map(job => ({
        jobId: job.jobId, characterId: job.characterId,
        stimulusHash: job.stimulusHash, reservedTokens: job.reservedTokens,
      })),
    })
    const prepared: PreparedJob[] = []
    for (const job of claims) prepared.push(this.#prepareJob(current, job, roundId, candidateHash, history, head.tick + 1))
    this.options.writer.renew()
    const runner = new SafeAgentRunner(new ModelBudgetLedger(
      prepared.reduce((total, value) => total + (value.providerCall === undefined ? 0 : value.job.reservedTokens), 0),
    ))
    const executed = await this.#executeWave(prepared, runner)
    this.options.writer.renew()
    const built = this.#buildRound(initial, roundId, candidateHash, history, executed, head.headSeq, head.tick, wave.wave)
    const refreshed = this.options.store.readReactionCycle(this.options.address, initial.cycle.cycleId)
    if (refreshed === undefined || refreshed.cycle.status === 'terminal') throw new Error('Reaction Cycle disappeared before Wave commit')
    const terminalReason = this.#terminalReason(refreshed, executed, built.nextWaveCandidates)
    const settlement: ReactionWaveSettlementDraft = {
      cycleId: initial.cycle.cycleId,
      wave: wave.wave,
      terminalReason,
      jobs: executed.map(value => {
        const outcome = built.outcomes.get(value.job.jobId)!
        const proposalHash = outcome === 'proposed' || outcome === 'rejected'
          ? hashWorldJson('round-participant-proposal', value.proposal)
          : null
        return {
          jobId: value.job.jobId,
          claimOwnerId: value.job.claimOwnerId,
          claimFencingToken: value.job.claimFencingToken,
          expectedStateHash: value.job.stateHash,
          outcome,
          proposalHash,
        }
      }),
      nextWaveCandidates: built.nextWaveCandidates,
    }
    if (executed.some(value => value.providerCall?.state === 'validated')) {
      this.options.faultInjector?.hit('provider.before-world-commit')
    }
    const lease = this.options.writer.current()
    const commit = await this.options.store.commitRound({
      address: this.options.address,
      transactionId,
      roundId,
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events: built.events,
      outbox: built.outbox,
      ...(built.cognitiveCharacterIds.length === 0 ? {} : {
        cognitiveJobs: built.cognitiveCharacterIds.map(characterId => ({ characterId })),
      }),
      authority: built.authority,
      reactionSettlement: settlement,
      operationalSummary: {
        schemaVersion: 'round-operational-summary/v1',
        origin: 'reaction',
        cycleId: initial.cycle.cycleId,
        wave: wave.wave,
        participantTerminals: executed.map(value => ({
          participantId: value.binding?.participantId ?? null,
          actorId: value.job.characterId,
          terminalStatus: built.outcomes.get(value.job.jobId)!,
        })),
      },
      correlationId: `reaction:${initial.cycle.cycleId}:${wave.wave}`,
      writerFencingToken: lease.fencingToken,
    })
    this.#reconcileCommittedCalls(transactionId)
    return {
      cycleId: initial.cycle.cycleId,
      rootRoundId: initial.cycle.rootRoundId,
      wave: wave.wave,
      roundId,
      transactionId,
      headSeq: commit.headSeq,
      tick: commit.tick,
      terminalReason,
      actionCount: built.actionCount,
    }
  }

  #claimWave(bundle: StoredReactionCycleBundle): ClaimedReactionJob[] {
    const wave = bundle.waves.at(-1)!
    const expected = bundle.jobs.filter(job => job.wave === wave.wave && job.budgetDecision === 'reserved').length
    const claimed: ClaimedReactionJob[] = []
    for (let index = 0; index < expected; index += 1) {
      const lease = this.options.writer.current()
      const job = this.options.store.claimNextReactionJob(
        this.options.address, lease.ownerId, lease.fencingToken, this.#claimTtlMs, true,
      )
      if (job === undefined || job.wave !== wave.wave) throw new Error('Reaction Wave could not claim every reserved Job')
      claimed.push(job)
    }
    return claimed.sort((left, right) => compareWorldText(left.characterId, right.characterId))
  }

  #prepareJob(
    cycle: StoredReactionCycleBundle,
    claimed: ClaimedReactionJob,
    roundId: InteractionRoundId,
    candidateHash: WorldHash,
    history: ReturnType<WorldStore['readEvents']>,
    tick: number,
  ): PreparedJob {
    const binding = this.#bindings.get(claimed.characterId)
    if (binding === undefined) return { job: claimed, unavailableReason: 'participant binding is unavailable' }
    if (cycle.cycle.status === 'stop_requested' && claimed.providerCallId === null) {
      return { job: claimed, binding, unavailableReason: 'Reaction Cycle stopped before Provider dispatch' }
    }
    if (currentCharacterLifecycle(history, claimed.characterId) !== 'active') {
      return { job: claimed, binding, unavailableReason: 'character lifecycle is not active' }
    }
    if (!alwaysRetryableAvailability(this.options.availability.get(this.options.address, claimed.characterId)?.state)) {
      return { job: claimed, binding, unavailableReason: 'character runtime is unavailable' }
    }
    const decision = this.options.sceneDecision.decideFromEvents(
      this.options.address, claimed.characterId, history, cycle.waves.at(-1)!.baseHeadSeq,
    )
    if (!decision.observerIds.includes(claimed.characterId)) {
      return { job: claimed, binding, unavailableReason: 'character is not present in the frozen Scene' }
    }
    const stimulus: ReactionContextStimulusBundle = {
      schemaVersion: 'reaction-stimulus-context/v1',
      cycleId: cycle.cycle.cycleId,
      wave: claimed.wave,
      characterId: claimed.characterId,
      stimulusHash: claimed.stimulusHash,
      stimuli: cycle.stimuli.filter(value => value.jobId === claimed.jobId).map(value => {
        const source = history.find(event => event.seq === value.sourceEventSeq)
        if (source?.eventHash !== value.sourceEventHash || source.eventType !== 'observation.upsert') {
          throw new Error(`Reaction stimulus ${value.observationId} is missing or divergent`)
        }
        const data = source.data as { readonly id?: unknown; readonly value?: WorldJsonValue }
        if (data.id !== value.observationId || data.value === undefined) {
          throw new Error(`Reaction stimulus ${value.observationId} content is divergent`)
        }
        return {
          observationId: value.observationId,
          sourceEventSeq: source.seq,
          sourceEventHash: source.eventHash,
          content: source.data,
        }
      }),
    }
    const context: ReactionProposalContext = {
      address: this.options.address,
      roundId,
      tick,
      origin: {
        kind: 'reaction', cycleId: cycle.cycle.cycleId,
        rootRoundId: cycle.cycle.rootRoundId, wave: claimed.wave,
      },
      stimulus,
      candidateHash,
    }
    let prepared: PreparedPhase8ReactionParticipant
    try {
      prepared = this.options.contextPipeline.prepareReaction(
        binding, context, history, decision, cycle.waves.at(-1)!.baseHeadSeq,
        () => { this.options.writer.renew() },
      )
    } catch (error: unknown) {
      if (error instanceof WorldError && error.envelope.category === 'integrity') throw error
      return { job: claimed, binding, unavailableReason: String(error) }
    }
    let providerCall = this.options.providerCalls.prepare(prepared.receipt)
    const lease = this.options.writer.current()
    const job = this.options.store.bindReactionJobProvider(
      this.options.address, claimed.jobId, lease.ownerId, lease.fencingToken,
      claimed.claimFencingToken, {
        contextReceiptId: prepared.receipt.receiptId,
        contextReceiptHash: prepared.receipt.receiptHash,
        providerCallId: providerCall.modelCallId,
        providerRequestHash: prepared.receipt.providerRequestHash,
      },
    )
    providerCall = this.options.providerCalls.read(providerCall.modelCallId)!
    return { job, binding, prepared, providerCall }
  }

  async #executeWave(prepared: readonly PreparedJob[], runner: SafeAgentRunner): Promise<ExecutedJob[]> {
    // A fast/replayed/unavailable participant still owns a claim until the whole wave settles.
    const claims = prepared.map(value => value.job)
    let failure: { readonly error: unknown } | undefined
    const renewClaims = () => {
      if (failure !== undefined) return
      try {
        const lease = this.options.writer.renew()
        for (const [index, job] of claims.entries()) {
          claims[index] = this.options.store.renewReactionJobClaim(
            this.options.address, job.jobId, lease.ownerId, lease.fencingToken,
            job.claimFencingToken, this.#claimTtlMs,
          )
        }
      } catch (error: unknown) {
        failure = { error }
      }
    }
    const heartbeat = setInterval(renewClaims, this.#claimHeartbeatMs)
    try {
      // Do not release the wave while a sibling may still write its ProviderCall result.
      const results = await Promise.allSettled(prepared.map(value => this.#executeJob(value, runner)))
      renewClaims()
      if (failure !== undefined) throw failure.error
      const executed: ExecutedJob[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') throw result.reason
        executed.push({ ...result.value, job: claims[index]! })
      }
      return executed
    } finally {
      clearInterval(heartbeat)
    }
  }

  async #executeJob(prepared: PreparedJob, runner: SafeAgentRunner): Promise<ExecutedJob> {
    const empty = { participantId: prepared.binding?.participantId ?? `unavailable:${prepared.job.characterId}`, actions: [] }
    if (prepared.unavailableReason !== undefined || prepared.binding === undefined
      || prepared.prepared === undefined || prepared.providerCall === undefined) {
      return { ...prepared, outcome: 'runtime_unavailable', proposal: empty }
    }
    let providerCall = prepared.providerCall
    let output: SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5 | undefined
    if (providerCall.state === 'dispatch_started') {
      providerCall = this.options.providerCalls.markTerminal(providerCall.modelCallId, 'timed_out_ambiguous', {
        reason: 'Reaction Provider dispatch had no durable response',
      })
    } else if (providerCall.state === 'response_received') {
      output = providerCall.response as SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5
    } else if (providerCall.state === 'validated') {
      output = providerCall.proposal as SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5
    }
    if (providerCall.state === 'committed') {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
        message: 'uncommitted Reaction Job references an already committed ProviderCall', retryable: false,
        correlationId: `reaction:${prepared.job.cycleId}:${prepared.job.wave}:${prepared.job.jobId}`,
        address: this.options.address,
      })
    }
    if (terminalCallStates.has(providerCall.state)) {
      return { ...prepared, providerCall, outcome: 'provider_terminal', proposal: empty }
    }
    if (output === undefined) {
      const run = await runner.invoke(
        providerCall.modelCallId,
        prepared.job.reservedTokens,
        prepared.binding.timeoutMs,
        prepared.binding.provider,
        prepared.prepared.providerContext,
        () => {
          this.options.faultInjector?.hit('provider.before-dispatch')
          providerCall = this.options.providerCalls.markDispatchStarted(providerCall.modelCallId)
        },
        () => { this.options.faultInjector?.hit('provider.after-dispatch') },
      )
      if (run.status === 'fallback') {
        const state = providerTerminalForFailure[run.failure!]
        providerCall = this.options.providerCalls.markTerminal(providerCall.modelCallId, state, { reason: run.failure! })
        return { ...prepared, providerCall, outcome: 'provider_terminal', proposal: empty }
      }
      output = run.output
      providerCall = this.options.providerCalls.recordResponse(providerCall.modelCallId, output, {
        provider: 'scripted', requestId: null, usage: null, cache: null,
      })
      this.options.faultInjector?.hit('provider.after-response')
    }
    const replayingValidated = providerCall.state === 'validated'
    try {
      const authorization = {
        participantId: prepared.binding.participantId,
        actorId: prepared.binding.actorId,
        allowedActionTypes: manifestUsesActionGroups(this.options.manifest) ? prepared.binding.allowedActionTypes : ['speak'],
        maxActions: manifestUsesActionGroups(this.options.manifest) ? 2 : 1,
        maxReflectionOperations: 0,
        correlationId: `reaction:${prepared.job.cycleId}:${prepared.job.wave}:${prepared.job.jobId}`,
      }
      const validated = manifestUsesActionGroups(this.options.manifest)
        ? (manifestUsesInteractions(this.options.manifest) ? this.#validator.validateV5(output, authorization) : this.#validator.validateV4(output, authorization))
        : manifestationPolicyFromManifest(this.options.manifest).mode === 'enabled'
        ? this.#validator.validateV3(output, authorization)
        : this.#validator.validateV2(output, authorization)
      providerCall = this.options.providerCalls.markValidated(providerCall.modelCallId, output)
      return {
        ...prepared,
        providerCall,
        outcome: validated.proposal.actions.length === 0 ? 'abstained' : 'proposed',
        proposal: validated.proposal,
      }
    } catch (error: unknown) {
      if (replayingValidated) {
        failWorld({
          errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
          message: 'durably validated Reaction Provider output no longer validates', retryable: false,
          correlationId: `reaction:${prepared.job.cycleId}:${prepared.job.wave}:${prepared.job.jobId}`,
          address: this.options.address,
        })
      }
      providerCall = this.options.providerCalls.markTerminal(providerCall.modelCallId, 'invalid_response', {
        reason: String(error),
      })
      return { ...prepared, providerCall, outcome: 'provider_terminal', proposal: empty }
    }
  }

  #buildRound(
    cycle: StoredReactionCycleBundle,
    roundId: InteractionRoundId,
    candidateHashInput: WorldHash,
    history: ReturnType<WorldStore['readEvents']>,
    executed: readonly ExecutedJob[],
    baseHeadSeq: number,
    baseTick: number,
    wave: number,
  ): BuiltReactionRound {
    const unordered = executed.flatMap(value => value.proposal.actions.map((action, proposalOrdinal): OrderedReactionAction => ({
      jobId: value.job.jobId,
      participantId: value.binding!.participantId,
      sourceRole: 'agent',
      priority: value.binding!.priority,
      actorId: action.actorId,
      actionId: action.actionId,
      action,
      proposalOrdinal,
      ...(value.proposal.actionGroup === undefined ? {} : { actionGroup: value.proposal.actionGroup }),
      ...(value.proposal.manifestation === undefined ? {} : { manifestation: value.proposal.manifestation }),
    })))
    const actions = manifestUsesActionGroups(this.options.manifest)
      ? sortActionGroups(unordered, compareActionOrderKey) : sortActionOrderKeys(unordered)
    if (new Set(actions.map(value => value.actionId)).size !== actions.length) {
      throw new TypeError('Reaction actionId values must be unique within one Wave')
    }
    const events: WorldEventDraft[] = executed.map(value => ({
      eventType: 'round.participant-terminal', eventVersion: 1,
      data: {
        roundId,
        participantId: value.binding?.participantId ?? `unavailable:${value.job.characterId}`,
        role: 'agent', status: value.outcome,
        actionCount: value.proposal.actions.length,
      },
    }))
    const outbox: OutboxDraft[] = []
    const authorityActions: WorldJsonValue[] = []
    const resolutions: WorldJsonValue[] = []
    const outcomeByJob = new Map(executed.map(value => [value.job.jobId, value.outcome as ReactionJobOutcome] as const))
    const candidateStimuli = new Map<CharacterId, ReactionStimulusDraft[]>()
    const estimatedTokens = new Map<CharacterId, number>()
    for (const wave of cycle.waves) {
      for (const decision of wave.budgetPlan.decisions) {
        estimatedTokens.set(decision.candidate.characterId, decision.candidate.estimatedTokens)
      }
    }
    const cognitiveCharacters = new Set<CharacterId>()
    let candidateHash = candidateHashInput
    const stoppedGroups = new Set<string>()
    for (const [ordinal, item] of actions.entries()) {
      const actionPrefix = [...history, ...events]
      const actionAuthority = resolutionAuthority('agent', 'standard')
      const { resolution: baseResolution, skipped } = resolveGroupAction(item.action, item.participantId, item.actionGroup !== undefined, stoppedGroups, () => this.#rulebook.resolve({
        manifest: this.options.manifest,
        events: actionPrefix,
        characterId: item.action.actorId,
        actionId: item.action.actionId,
        manifestHash: this.options.manifestHash,
        asOfWorldSeq: baseHeadSeq,
        ...(manifestUsesHostAuthority(this.options.manifest) ? { resolutionAuthority: actionAuthority } : {}),
        action: { actionType: item.action.actionType, parameters: item.action.parameters },
      }))
      const moveTarget = item.action.actionType === 'move' ? (item.action.parameters as WorldJsonObject).locationId : undefined
      const resolution = baseResolution.status === 'accepted' && typeof moveTarget === 'string'
        ? { ...baseResolution, events: [...baseResolution.events, ...this.options.sceneDecision.transitionForMove(
          this.options.address, actionPrefix, item.actorId, moveTarget, baseHeadSeq + events.length,
        )] } : baseResolution
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
      const audience = this.options.sceneDecision.audienceForAction(
        this.options.address,
        item.action.actorId,
        actionPrefix,
        baseHeadSeq + events.length,
        {
          scope: resolution.observationScope?.scope ?? 'scene_public',
          ...(resolution.observationScope?.recipientIds === undefined ? {} : {
            recipientIds: resolution.observationScope.recipientIds.map(value => brandId(value, 'CharacterId')),
          }),
        },
      )
      const orderKey = {
        phase: 1, roleRank: 1, priority: item.priority,
        actorId: item.actorId, actionId: item.actionId,
        ...(item.actionGroup === undefined ? {} : {
          groupParticipantId: item.participantId,
          groupFirstActionId: actions.find(first => first.participantId === item.participantId && first.proposalOrdinal === 0)!.actionId,
          stepOrdinal: item.proposalOrdinal,
        }),
      }
      const candidateHashBefore = candidateHash
      const ruleTraceHash = hashWorldJson('round-rule-trace', {
        rulebook: this.options.manifest.rulebook,
        ...(manifestUsesHostAuthority(this.options.manifest) ? { resolutionAuthority: actionAuthority } : {}),
        action: item.action,
        status: skipped ? 'skipped' : resolution.status,
        reason: resolution.reason ?? null,
        events: resolvedEvents,
        ...(manifestation === undefined ? {} : { manifestation }),
        observationScope: resolution.observationScope ?? { scope: 'scene_public' },
      })
      candidateHash = resolution.status === 'accepted' || (manifestationResolution?.events.length ?? 0) > 0
        ? hashWorldJson('round-candidate-after-resolution', {
          candidateHashBefore, actionId: item.action.actionId, events: resolvedEvents, ruleTraceHash,
        })
        : candidateHashBefore
      authorityActions.push({
        actionId: item.action.actionId,
        participantId: item.participantId,
        sourceRole: 'agent',
        ...(manifestUsesHostAuthority(this.options.manifest) ? { resolutionAuthority: actionAuthority } : {}),
        actorId: item.action.actorId,
        actionType: item.action.actionType,
        actionVersion: item.action.actionVersion,
        parameters: item.action.parameters,
        proposalOrdinal: item.proposalOrdinal,
        ...(item.actionGroup === undefined ? {} : { actionGroup: item.actionGroup }),
        ...(item.manifestation === undefined ? {} : { manifestation: item.manifestation }),
        orderKey,
      })
      resolutions.push({
        actionId: item.action.actionId,
        status: skipped ? 'skipped' : resolution.status,
        reason: resolution.reason ?? null,
        orderKey,
        candidateHashBefore,
        candidateHashAfter: candidateHash,
        ruleTraceHash,
        entropyRefs: [],
        conflictingActionId: null,
        ...(manifestationResolution === undefined ? {} : { manifestation: manifestationResolution }),
      })
      outcomeByJob.set(item.jobId, resolution.status === 'accepted' ? 'proposed' : 'rejected')
      events.push(...resolvedEvents, {
        eventType: 'action.resolved', eventVersion: 1,
        data: {
          roundId, actionId: item.action.actionId, participantId: item.participantId,
          actorId: item.action.actorId, actionType: item.action.actionType,
          sourceRole: 'agent', order: ordinal, accepted: resolution.status === 'accepted',
          reason: resolution.reason ?? null,
          ...(manifestationResolution === undefined ? {} : { manifestationStatus: manifestationResolution.status }),
        },
      })
      const publicSpeech = resolution.events.find(event => event.eventType === 'character.speak')
      const publicManifestation = resolvedEvents.find(event => event.eventType === 'character.manifested')
      const publicInteraction = resolution.events.find(event => event.eventType === 'entity.transferred')
      const relations = characterRelationObservations(actionPrefix, resolution.events)
      const occurrenceOnly = new Set(audience.occurrenceOnlyCharacterIds)
      const observerIds = [...new Set([
        ...audience.fullContentCharacterIds,
        ...audience.occurrenceOnlyCharacterIds,
      ])].sort(compareWorldText)
      for (const observerId of observerIds) {
        const observationId = deterministicId('observation:scene-result', {
          roundId, actionId: item.action.actionId, observerId,
        })
        const observation = {
          observerId,
          actionId: item.action.actionId,
          content: occurrenceOnly.has(observerId) ? {
            actionType: 'private_interaction', actorId: item.action.actorId,
            status: resolution.status, contentVisibility: 'occurrence_only',
          } : {
            actionType: item.action.actionType, actorId: item.action.actorId,
            status: skipped ? 'skipped' : resolution.status, reason: resolution.reason ?? null,
            ...(publicSpeech === undefined ? {} : { speech: publicSpeech.data }),
            ...(publicManifestation === undefined ? {} : { manifestation: publicManifestation.data }),
            ...(publicInteraction === undefined ? {} : { interaction: publicInteraction.data }),
            ...(relations.length === 0 ? {} : { relations }),
          },
        }
        const sourceEventOrdinal = events.length
        events.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id: observationId, value: observation } })
        cognitiveCharacters.add(observerId)
        const player = this.options.manifest.playerBindings.find(value => value.characterId === observerId)
        if (player !== undefined) {
          outbox.push({
            deliveryId: brandId(deterministicId('delivery:reaction-round', { roundId, observationId }), 'DeliveryId'),
            sessionId: player.sessionId,
            payload: {
              observationType: 'reaction-round',
              observationId,
              value: observation,
              cycleId: cycle.cycle.cycleId,
              wave,
              roundId,
              rootRoundId: cycle.cycle.rootRoundId,
            },
            critical: true,
          })
        }
        const next = this.#bindings.get(observerId)
        if (next !== undefined && estimatedTokens.has(observerId) && observerId !== item.action.actorId) {
          const stimuli = candidateStimuli.get(observerId) ?? []
          stimuli.push({ sourceEventOrdinal, observationOrdinal: 0, observationId, observerCharacterId: observerId })
          candidateStimuli.set(observerId, stimuli)
        }
      }
      cognitiveCharacters.add(item.action.actorId)
    }
    events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: baseTick + 1, roundId } })
    const nextWaveCandidates = [...candidateStimuli].map(([characterId, stimuli]) => ({
      characterId,
      estimatedTokens: estimatedTokens.get(characterId)!,
      stimuli,
    })).sort((left, right) => compareWorldText(left.characterId, right.characterId))
    const participants = executed.map(value => {
      const proposalHash = hashWorldJson('round-participant-proposal', value.proposal)
      return {
        participantId: value.binding?.participantId ?? `unavailable:${value.job.characterId}`,
        role: 'agent',
        actorId: value.job.characterId,
        terminalStatus: outcomeByJob.get(value.job.jobId)!,
        providerInvocationId: value.providerCall?.modelCallId ?? null,
        contextHash: value.prepared?.receipt.contextHash ?? hashWorldJson('reaction-context-unavailable/v1', { jobId: value.job.jobId }),
        profileVersion: 'agent-provider-port/v1',
        budgetEvaluationId: deterministicId('budget-evaluation:reaction-participant/v1', { jobId: value.job.jobId }),
        modelReplayRecordHash: value.providerCall === undefined ? null : hashWorldJson('provider-call-record/v1', value.providerCall),
        budgetReservationRecordHash: hashWorldJson('reaction-budget-reservation/v1', {
          jobId: value.job.jobId, reservedTokens: value.job.reservedTokens,
        }),
        responseHash: value.providerCall?.responseHash ?? null,
        proposalId: value.proposal.actions.length === 0 ? null : deterministicId('proposal:reaction-participant/v1', {
          roundId, participantId: value.binding!.participantId, proposalHash,
        }),
        proposalHash,
        ...(value.prepared === undefined ? {} : {
          memorySourceRefs: value.prepared.memorySourceRefs,
          recallResultHash: value.prepared.recallResultHash,
          contextReceiptId: value.prepared.receipt.receiptId,
          providerRequestHash: value.prepared.receipt.providerRequestHash,
        }),
        ...(value.providerCall === undefined ? {} : { providerCallState: value.providerCall.state }),
        ...(value.proposal.actionGroup === undefined ? {} : { actionGroup: value.proposal.actionGroup }),
      ...(value.proposal.manifestation === undefined ? {} : { manifestation: value.proposal.manifestation }),
      }
    })
    const authority = {
      schemaVersion: manifestUsesHostAuthority(this.options.manifest) ? 5 : manifestUsesActionGroups(this.options.manifest) ? 4 : 3,
      origin: {
        kind: 'reaction', cycleId: cycle.cycle.cycleId,
        rootRoundId: cycle.cycle.rootRoundId, wave: cycle.waves.at(-1)!.wave,
      },
      roundId,
      baseHeadSeq,
      baseTick,
      contextHash: hashWorldJson('round-reaction-context/v1', participants.map(value => ({
        participantId: value.participantId, contextHash: value.contextHash,
      }))),
      participants,
      actions: authorityActions,
      resolutions,
      finalCandidateHash: candidateHash,
    } as const
    return {
      events,
      outbox,
      cognitiveCharacterIds: [...cognitiveCharacters].sort(compareWorldText),
      nextWaveCandidates,
      authority,
      outcomes: outcomeByJob,
      actionCount: actions.length,
    }
  }

  #terminalReason(
    bundle: StoredReactionCycleBundle,
    executed: readonly ExecutedJob[],
    candidates: readonly ReactionCandidateDraft[],
  ): ReactionWaveSettlementDraft['terminalReason'] {
    if (bundle.cycle.status === 'stop_requested') return bundle.cycle.stopReason
    if (executed.some(value => value.outcome === 'provider_terminal')) return 'provider_terminal'
    if (this.#now() >= bundle.cycle.deadlineAtMs) return 'deadline_reached'
    if (candidates.length === 0) return executed.every(value => value.outcome === 'abstained') ? 'all_abstained' : 'quiescent'
    const wave = bundle.waves.at(-1)!.wave
    if (wave + 1 > bundle.cycle.maxWaves) return 'wave_limit'
    const currentIds = new Set(executed.map(value => value.job.jobId))
    const dispatched = bundle.jobs.filter(job => job.providerCallId !== null
      && (job.status === 'settled' || currentIds.has(job.jobId)))
    const callsByCharacter = new Map<CharacterId, number>()
    for (const job of dispatched) callsByCharacter.set(job.characterId, (callsByCharacter.get(job.characterId) ?? 0) + 1)
    const plan = planStableCallBudget(candidates.map(candidate => ({
      wave: wave + 1,
      characterId: candidate.characterId,
      stimulusHash: hashWorldJson('reaction-preview-stimulus/v1', candidate.stimuli),
      jobId: deterministicId('reaction-preview-job/v1', { wave: wave + 1, characterId: candidate.characterId }),
      estimatedTokens: candidate.estimatedTokens,
    })), {
      remainingCalls: bundle.cycle.maxNpcCalls - dispatched.length,
      remainingTokens: bundle.cycle.initialTokenBudget - dispatched.reduce((total, job) => total + job.reservedTokens, 0),
      maxCallsPerCharacter: bundle.cycle.maxCallsPerCharacter,
      usedCallsByCharacter: [...callsByCharacter].map(([characterId, calls]) => ({ characterId, calls })),
    })
    if (plan.reservedCalls > 0) return null
    return plan.decisions.some(decision => decision.exclusion === 'token_budget_exhausted')
      ? 'token_budget_exhausted'
      : 'call_limit'
  }

  #reconcileCommittedCalls(transactionId: TransactionId): void {
    const authority = this.options.store.readRoundAuthority(this.options.address, transactionId)!
    const participants = authority.authority.participants as readonly WorldJsonObject[]
    for (const participant of participants) {
      const callId = participant.providerInvocationId
      if (typeof callId !== 'string') continue
      const call = this.options.providerCalls.read(callId)!
      if (call.state === 'validated') {
        this.options.providerCalls.markCommitted(callId, transactionId, authority.authorityHash)
      }
    }
  }
}
