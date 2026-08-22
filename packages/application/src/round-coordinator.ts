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
  type ActionRequest,
  type AgentProvider,
  type CharacterId,
  type OutboxDraft,
  type Proposal,
  type ProposalContext,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  SpeakMoveRulebook,
  currentCharacterLifecycle,
  parsePlayerActionInput,
  parsePlayerRoundResult,
  type CompiledWorldManifest,
  type PlayerActionInput,
  type PlayerRoundResult,
  type RoundExecutionLane,
  type RulebookResolution,
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

export type RoundParticipantRole = 'agent' | 'director'
export type ParticipantTerminalStatus = 'proposed' | 'provider_failed' | 'budget_exhausted' | 'schema_invalid' | 'lifecycle_ineligible' | 'runtime_unavailable'

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
}

export interface SubmitCoordinatedRoundRequest {
  readonly idempotencyKey: string
  readonly principalId: string
  readonly action: PlayerActionInput
  readonly correlationId: string
}

interface FrozenParticipant {
  readonly binding: RoundParticipant
  readonly status: ParticipantTerminalStatus
  readonly proposal: Proposal
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
  readonly #rulebook = new SpeakMoveRulebook()
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
    this.#manifest = stored.manifest as CompiledWorldManifest
    this.#address = options.runtimeLane.address
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

  submit(request: SubmitCoordinatedRoundRequest): Promise<PlayerRoundResult> {
    if (this.#closed) return Promise.reject(new Error('RoundCoordinator is closed'))
    this.#validateSubmission(request)
    if (!this.#manifest.playerBindings.some(value => value.principalId === request.principalId)) {
      failWorld({
        errorCode: 'UNAUTHORIZED',
        category: 'admission',
        message: 'principal has no PlayerBinding in this world',
        retryable: false,
        correlationId: request.correlationId,
        address: this.#address,
      })
    }
    const queued = this.options.inbox.enqueue({
      address: this.#address,
      idempotencyKey: request.idempotencyKey,
      principalId: request.principalId,
      input: request.action,
      correlationId: request.correlationId,
    }, this.#manifest.roundQueueLimit)
    return this.options.runtimeLane.enqueueRound(async () => {
      const completed = this.options.inbox.readCompleted(this.#address, request.idempotencyKey)
      if (completed !== undefined) return parsePlayerRoundResult(completed)
      return this.#drainUntil(queued.inboxSeq, request.correlationId)
    })
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
    const frozen = await this.#freezeParticipants(proposalContext, history)
    const ordered = this.#orderedActions(playerAction, frozen)
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
      const resolution = this.#rulebook.resolve(
        this.#manifest,
        [...history, ...events],
        item.action.actorId,
        { actionType: item.action.actionType, parameters: item.action.parameters },
      )
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
      const observationId = deterministicId('observation:coordinated-round', { roundId, actionId: item.action.actionId })
      const observation = {
        observerId: binding.characterId,
        actionId: item.action.actionId,
        content: {
          actionType: item.action.actionType,
          actorId: item.action.actorId,
          status: resolution.status,
          reason: resolution.reason ?? null,
        },
      }
      events.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id: observationId, value: observation } })
      outbox.push({
        deliveryId: brandId(deterministicId('delivery:coordinated-round', { roundId, observationId }), 'DeliveryId'),
        sessionId: binding.sessionId,
        payload: { observationId, value: observation },
        critical: true,
      })
    }
    events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } })
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
      correlationId,
      admissionProof: { inboxSeq: claimed.inboxSeq, inputHash: claimed.inputHash },
      writerFencingToken: this.#lease.fencingToken,
    })
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

  async #freezeParticipants(context: ProposalContext, history: readonly { readonly eventType: string; readonly data: WorldJsonValue }[]): Promise<FrozenParticipant[]> {
    const frozen: FrozenParticipant[] = []
    const actionIds = new Set<string>([context.playerAction.actionId])
    const runner = new SafeAgentRunner(new ModelBudgetLedger(this.options.modelBudgetTokens))
    for (const binding of this.#participants) {
      if (currentCharacterLifecycle(history, binding.actorId) !== 'active') {
        frozen.push({ binding, status: 'lifecycle_ineligible', proposal: { participantId: binding.participantId, actions: [] } })
        continue
      }
      if (this.options.availability.get(this.#address, binding.actorId)?.state !== 'ready') {
        frozen.push({ binding, status: 'runtime_unavailable', proposal: { participantId: binding.participantId, actions: [] } })
        continue
      }
      this.#renewLease()
      const run = await runner.propose(
        `provider:${context.roundId}:${binding.participantId}`,
        binding.estimatedTokens,
        binding.timeoutMs,
        binding.participantId,
        binding.provider,
        context,
      )
      this.#renewLease()
      if (run.status === 'fallback') {
        frozen.push({ binding, status: run.failure!, proposal: run.proposal })
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
          frozen.push({ binding, status: 'schema_invalid', proposal: { participantId: binding.participantId, actions: [] } })
          continue
        }
        for (const action of proposal.actions) actionIds.add(action.actionId)
        frozen.push({ binding, status: 'proposed', proposal })
      } catch {
        frozen.push({ binding, status: 'schema_invalid', proposal: { participantId: binding.participantId, actions: [] } })
      }
    }
    return frozen
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
    }]
    for (const participant of frozen) {
      for (const action of participant.proposal.actions) {
        actions.push({
          action,
          sourceRole: participant.binding.role,
          participantId: participant.binding.participantId,
          priority: participant.binding.priority,
          actorId: action.actorId,
          actionId: action.actionId,
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
