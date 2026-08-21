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
import type { WorldStore } from '@harness-world/store-sqlite'

export interface SimulationOptions {
  readonly store: WorldStore
  readonly address: WorldAddress
  readonly playerCharacterId: CharacterId
  readonly playerSessionId: SessionId
  readonly agents?: readonly AgentProvider[]
  readonly directors?: readonly DirectorProvider[]
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

function assertProposal(proposal: Proposal): void {
  if (proposal.actions.length > 2) throw new Error(`participant ${proposal.participantId} exceeded the two-action limit`)
  const ids = new Set(proposal.actions.map(action => action.actionId))
  if (ids.size !== proposal.actions.length) throw new Error(`participant ${proposal.participantId} repeated an action id`)
}

/** Minimal deterministic TURN_DRIVEN pipeline used by the Phase 0 no-model gate. */
export class WorldSimulation {
  readonly #store: WorldStore
  readonly #address: WorldAddress
  readonly #playerCharacterId: CharacterId
  readonly #playerSessionId: SessionId
  readonly #agents: readonly AgentProvider[]
  readonly #directors: readonly DirectorProvider[]

  constructor(options: SimulationOptions) {
    this.#store = options.store
    this.#address = options.address
    this.#playerCharacterId = options.playerCharacterId
    this.#playerSessionId = options.playerSessionId
    this.#agents = options.agents ?? []
    this.#directors = options.directors ?? []
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
    for (const provider of [...this.#agents, ...this.#directors]) {
      const candidate = await provider.propose(context)
      assertProposal(candidate)
      if (proposals.some(value => value.participantId === candidate.participantId)) {
        throw new Error(`duplicate participant ${candidate.participantId}`)
      }
      proposals.push(candidate)
    }
    const actions = [playerAction, ...proposals.flatMap(value => value.actions)]
    const events: WorldEventDraft[] = []
    const outbox: OutboxDraft[] = []
    for (const [ordinal, action] of actions.entries()) {
      events.push({
        eventType: action.actionType === 'character.speak' ? 'character.spoke' : 'character.acted',
        eventVersion: 1,
        data: { actionId: action.actionId, actorId: action.actorId, actionType: action.actionType, parameters: action.parameters },
      })
      events.push({
        eventType: 'action.resolved',
        eventVersion: 1,
        data: { actionId: action.actionId, accepted: true, order: ordinal },
      })
      const observationId = deterministicId('observation', { roundId, actionId: action.actionId })
      const observationValue: WorldJsonValue = {
        observerId: this.#playerCharacterId,
        actionId: action.actionId,
        content: action.actionType === 'character.speak' ? action.parameters : { actionType: action.actionType },
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
