import type {
  BranchId,
  CharacterId,
  DeliveryId,
  InteractionRoundId,
  SessionId,
  TenantId,
  TransactionId,
  WorldId,
} from './ids.ts'
import type { WorldHash, WorldJsonObject, WorldJsonValue } from './world-json.ts'
import type { ReactionCycleDraft, ReactionWaveSettlementDraft } from './reaction-cycle.ts'

export interface WorldAddress extends WorldJsonObject {
  readonly tenantId: TenantId
  readonly worldId: WorldId
  readonly branchId: BranchId
}
/** Serialize a WorldAddress without accepting partial routing. */
export function worldAddressKey(address: WorldAddress): string {
  return `${address.tenantId}\u001f${address.worldId}\u001f${address.branchId}`
}

export type FaultPoint =
  | 'store.after-event-insert'
  | 'store.before-commit'
  | 'store.after-commit'
  | 'session-delivery.after-inbox-insert'
  | 'session-delivery.after-observation-append'
  | 'session-delivery.after-commit'
  | 'outbox.before-receipt-commit'
  | 'outbox.after-receipt-commit'
  | 'quarantine.before-commit'
  | 'quarantine.after-commit'
  | 'quarantine-recovery.after-maintenance-commit'
  | 'quarantine-recovery.before-commit'
  | 'quarantine-recovery.after-commit'
  | 'memory.before-catchup'
  | 'memory.after-catchup-commit'
  | 'provider.before-dispatch'
  | 'provider.after-dispatch'
  | 'provider.after-response'
  | 'provider.before-world-commit'
  | 'reaction.after-player-enqueue'
  | 'reaction.after-player-preempt'
  | 'reaction.after-cancel-request'
  | 'reaction.after-job-claim'
  | 'reaction.after-wave-settle'

export interface FaultInjector {
  /** Pause, fail, or terminate execution at a named stable point. */
  hit(point: FaultPoint): void
}

export interface WorldEventDraft extends WorldJsonObject {
  readonly eventType: string
  readonly eventVersion: number
  readonly data: WorldJsonValue
}

export interface StoredWorldEvent extends WorldJsonObject {
  readonly address: WorldAddress
  readonly seq: number
  readonly tick: number
  readonly eventType: string
  readonly eventVersion: number
  readonly data: WorldJsonValue
  readonly previousHash: WorldHash | 'genesis'
  readonly eventHash: WorldHash
  readonly transactionId: TransactionId
  readonly eventOrdinal: number
}

export interface OutboxDraft extends WorldJsonObject {
  readonly deliveryId: DeliveryId
  readonly sessionId: SessionId
  readonly payload: WorldJsonValue
  readonly critical: boolean
}

/** Derived-state work requested atomically by an authoritative World commit. */
export interface CognitiveJobDraft extends WorldJsonObject {
  readonly characterId: CharacterId
}

export interface StoredCognitiveJob extends WorldJsonObject {
  readonly jobId: string
  readonly address: WorldAddress
  readonly transactionId: TransactionId
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  readonly status: 'pending' | 'completed' | 'failed'
  readonly attemptCount: number
  readonly lastError: string | null
  readonly jobHash: WorldHash
}

export interface StoredOutboxItem extends OutboxDraft {
  readonly address: WorldAddress
  readonly worldSeq: number
  readonly payloadHash: WorldHash
}

export interface CommitRoundRequest {
  readonly address: WorldAddress
  readonly transactionId: TransactionId
  readonly roundId: InteractionRoundId
  readonly expectedHeadSeq: number
  readonly expectedTick: number
  readonly nextTick: number
  readonly events: readonly WorldEventDraft[]
  readonly outbox: readonly OutboxDraft[]
  /** Non-authoritative derived-state work inserted in the same World transaction. */
  readonly cognitiveJobs?: readonly CognitiveJobDraft[]
  /** Durable, bounded NPC Reaction work created atomically with the Root Round. */
  readonly reactionCycle?: ReactionCycleDraft
  /** Exact claimed Reaction Jobs settled atomically with one NPC-only Round. */
  readonly reactionSettlement?: ReactionWaveSettlementDraft
  readonly correlationId: string
  /** Versioned participant/proposal/action/resolution authority committed with this Round. */
  readonly authority?: WorldJsonObject
  /** Non-authoritative audit detail written atomically with commit and excluded from all authority hashes. */
  readonly operationalSummary?: WorldJsonObject
  /** Durable proof that this input crossed admission before a draining barrier closed. */
  readonly admissionProof?: RoundAdmissionProof
  /** Operational fencing is excluded from authoritative hashes and required once a branch has acquired a database lease. */
  readonly writerFencingToken?: number
}

export interface StoredRoundAuthority extends WorldJsonObject {
  readonly transactionId: TransactionId
  readonly roundId: InteractionRoundId
  readonly authorityHash: WorldHash
  readonly authority: WorldJsonObject
}

export interface RoundAdmissionProof extends WorldJsonObject {
  readonly inboxSeq: number
  readonly inputHash: WorldHash
}

export interface CommitRoundResult {
  readonly status: 'committed' | 'already_committed'
  readonly headSeq: number
  readonly tick: number
  readonly bundleHash: WorldHash
}

export interface AppendDeliveryRequest {
  readonly sessionId: SessionId
  readonly sessionDeliverySeq: number
  readonly deliveryId: DeliveryId
  readonly payloadHash: WorldHash
  readonly observationEvent: WorldJsonValue
  readonly correlationId: string
}

export interface AppendDeliveryResult {
  readonly status: 'applied' | 'already_applied'
  readonly cursor: number
}

export type ProjectionKind = 'observation' | 'claim' | 'goal' | 'visibility'

export interface ProjectionRecord extends WorldJsonObject {
  readonly kind: ProjectionKind
  readonly id: string
  readonly value: WorldJsonValue
  readonly sourceSeq: number
}

export interface ProjectionBundle extends WorldJsonObject {
  readonly address: WorldAddress
  readonly asOfWorldSeq: number
  readonly observations: readonly ProjectionRecord[]
  readonly claims: readonly ProjectionRecord[]
  readonly goals: readonly ProjectionRecord[]
  readonly visibility: readonly ProjectionRecord[]
  readonly bundleHash: WorldHash
}

export interface CharacterSceneView extends WorldJsonObject {
  readonly sceneId: string
  readonly value: WorldJsonValue
  readonly sourceSeq: number
}

export interface SelfObservationView extends WorldJsonObject {
  readonly observationId: string
  readonly sourceSeq: number
  readonly content: WorldJsonValue
}

export type CharacterLifecycleState = 'active' | 'incapacitated' | 'dead' | 'departed'
export type RuntimeAvailabilityState =
  | 'provisioning'
  | 'ready'
  | 'session_lag'
  | 'model_unavailable'
  | 'provider_output_invalid'
  | 'budget_unavailable'
  | 'offline'
  | 'disabled'

export interface CharacterRuntimeAvailability extends WorldJsonObject {
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly state: RuntimeAvailabilityState
  readonly reason: string | null
  readonly changedAtMs: number
}

export interface CharacterView extends WorldJsonObject {
  readonly address: WorldAddress
  readonly characterId: CharacterId
  readonly asOfWorldSeq: number
  /** Authoritative domain fact reconstructed from the event prefix. */
  readonly lifecycleState: CharacterLifecycleState
  readonly locationId: string | null
  readonly scenes: readonly CharacterSceneView[]
  readonly observations: readonly ProjectionRecord[]
  readonly selfObservations: readonly SelfObservationView[]
  readonly claims: readonly ProjectionRecord[]
  readonly goals: readonly ProjectionRecord[]
  readonly visibility: readonly ProjectionRecord[]
  readonly bundleHash: WorldHash
}

export interface ActionRequest extends WorldJsonObject {
  readonly actionId: string
  readonly actorId: CharacterId
  readonly actionType: string
  readonly actionVersion: number
  readonly parameters: WorldJsonValue
}

export interface Proposal extends WorldJsonObject {
  readonly participantId: string
  readonly actions: readonly ActionRequest[]
}

export interface ProposalContext {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly tick: number
  readonly playerAction: ActionRequest
  readonly candidateHash: WorldHash
}

export interface AgentProvider {
  propose(context: ProposalContext): Promise<Proposal>
}

/** Phase 8 provider contract; participant identity is bound by the host call rather than model output. */
export interface Phase8AgentProvider {
  propose(context: ProposalContext): Promise<import('./cognition-projection.ts').SubmitActionsV2>
}

export interface DirectorProvider {
  propose(context: ProposalContext): Promise<Proposal>
}
