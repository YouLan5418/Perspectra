import {
  brandId,
  deterministicId,
  hashWorldJson,
  type ActionRequest,
  type AgentProvider,
  type CharacterId,
  type CommitRoundResult,
  type DirectorProvider,
  type InteractionRoundId,
  type OutboxDraft,
  type Proposal,
  type ProposalContext,
  type SessionId,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { SubmitActionsValidator } from '@harness-world/agents'
import type { WorldStore } from '@harness-world/store-sqlite'

export interface SimulationParticipantBinding {
  readonly participantId: string
  readonly actorId: CharacterId
  readonly allowedActionTypes: readonly string[]
  readonly provider: AgentProvider | DirectorProvider
}

export interface SimulationActionResolution {
  readonly status: 'accepted' | 'rejected'
  readonly events: readonly WorldEventDraft[]
  readonly reason?: string
}

export interface SimulationRulebook {
  resolve(action: ActionRequest, context: ProposalContext): SimulationActionResolution
}

/** Safe default for the prototype: Provider output is visible as a rejected proposal, never as a world fact. */
export class RejectingSimulationRulebook implements SimulationRulebook {
  resolve(): SimulationActionResolution {
    return { status: 'rejected', events: [], reason: 'no authoritative Simulation Rulebook is configured' }
  }
}

export interface SimulationOptions {
  readonly store: WorldStore
  readonly address: WorldAddress
  readonly playerCharacterId: CharacterId
  readonly playerSessionId: SessionId
  readonly agents?: readonly SimulationParticipantBinding[]
  readonly directors?: readonly SimulationParticipantBinding[]
  readonly rulebook?: SimulationRulebook
}

export interface SubmitPlayerMessageRequest {
  readonly idempotencyKey: string
  readonly text: string
}

export interface SimulationRoundResult {
  readonly roundId: InteractionRoundId
  readonly proposals: readonly Proposal[]
  readonly actions: readonly ActionRequest[]
  readonly commit: CommitRoundResult
}

/** Minimal deterministic TURN_DRIVEN pipeline used by the Phase 0 no-model gate. */
export class WorldSimulation {
  readonly #store: WorldStore
  readonly #address: WorldAddress
  readonly #playerCharacterId: CharacterId
  readonly #playerSessionId: SessionId
  readonly #participants: readonly SimulationParticipantBinding[]
  readonly #rulebook: SimulationRulebook
  readonly #validator = new SubmitActionsValidator()

  constructor(options: SimulationOptions) {
    this.#store = options.store
    this.#address = options.address
    this.#playerCharacterId = options.playerCharacterId
    this.#playerSessionId = options.playerSessionId
    this.#participants = [...options.agents ?? [], ...options.directors ?? []]
    if (new Set(this.#participants.map(value => value.participantId)).size !== this.#participants.length) {
      throw new TypeError('Simulation participantId values must be unique')
    }
    this.#rulebook = options.rulebook ?? new RejectingSimulationRulebook()
  }

  /** Accept one exact player message and advance the branch by one Round/Tick. */
  async submitPlayerMessage(request: SubmitPlayerMessageRequest): Promise<SimulationRoundResult> {
    if (request.idempotencyKey.length === 0) throw new TypeError('idempotencyKey cannot be empty')
    if (request.text.length === 0) throw new TypeError('player message cannot be empty')
    const roundId = brandId(deterministicId('round', {
      address: this.#address,
      idempotencyKey: request.idempotencyKey,
    }), 'InteractionRoundId') as InteractionRoundId
    const transactionId = brandId(`transaction:${roundId}`, 'TransactionId') as TransactionId
    const head = this.#store.roundBase(transactionId) ?? this.#store.head(this.#address)
    const playerAction: ActionRequest = {
      actionId: deterministicId('action', { roundId, participantId: 'player', ordinal: 0 }),
      actorId: this.#playerCharacterId,
      actionType: 'character.speak',
      actionVersion: 1,
      parameters: { text: request.text },
    }
    const context: ProposalContext = {
      address: this.#address,
      roundId,
      tick: head.tick + 1,
      playerAction,
      candidateHash: hashWorldJson('world-player-candidate', playerAction),
    }

    const proposals: Proposal[] = []
    for (const binding of this.#participants) {
      const candidate = await binding.provider.propose(context)
      proposals.push(this.#validator.validate({ schemaVersion: 1, ...candidate }, {
        participantId: binding.participantId,
        actorId: binding.actorId,
        allowedActionTypes: binding.allowedActionTypes,
        maxActions: 2,
        correlationId: `simulation:${roundId}:${binding.participantId}`,
      }))
    }
    const actions = [playerAction, ...proposals.flatMap(value => value.actions)]
    const events: WorldEventDraft[] = []
    const outbox: OutboxDraft[] = []
    for (const [ordinal, action] of actions.entries()) {
      const isPlayerAction = ordinal === 0
      const resolution: SimulationActionResolution = isPlayerAction
        ? {
            status: 'accepted' as const,
            events: [{
              eventType: 'character.spoke',
              eventVersion: 1,
              data: { actionId: action.actionId, actorId: action.actorId, actionType: action.actionType, parameters: action.parameters },
            }],
          }
        : this.#rulebook.resolve(action, context)
      events.push(...resolution.events)
      events.push({
        eventType: 'action.resolved',
        eventVersion: 1,
        data: {
          actionId: action.actionId,
          accepted: resolution.status === 'accepted',
          order: ordinal,
          reason: resolution.reason ?? null,
        },
      })
      const observationId = deterministicId('observation', { roundId, actionId: action.actionId })
      const observationValue: WorldJsonValue = {
        observerId: this.#playerCharacterId,
        actionId: action.actionId,
        content: isPlayerAction
          ? action.parameters
          : { actionType: action.actionType, status: resolution.status, reason: resolution.reason ?? null },
      }
      events.push({
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: observationId, value: observationValue },
      })
      outbox.push({
        deliveryId: brandId(deterministicId('delivery', { roundId, observationId }), 'DeliveryId'),
        sessionId: this.#playerSessionId,
        payload: { observationId, value: observationValue },
        critical: true,
      })
    }
    events.push({ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } })
    const commit = await this.#store.commitRound({
      address: this.#address,
      transactionId,
      roundId,
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events,
      outbox,
      correlationId: `round:${roundId}`,
    })
    return { roundId, proposals, actions, commit }
  }
}
