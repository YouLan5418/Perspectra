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

export interface FaultInjector {
  /** Pause, fail, or terminate execution at a named stable point. */
  hit(point: FaultPoint): void | Promise<void>
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
  readonly correlationId: string
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

export interface DirectorProvider {
  propose(context: ProposalContext): Promise<Proposal>
}
