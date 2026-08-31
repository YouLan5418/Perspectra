import type {
  CharacterId,
  InteractionRoundId,
  ReactionCycleId,
  ReactionJobId,
  TransactionId,
} from './ids.ts'
import type { WorldAddress } from './protocol.ts'
import type { StableCallBudgetPlan } from './stable-call-budget.ts'
import type { WorldHash, WorldJsonObject } from './world-json.ts'

export type ReactionCycleStatus = 'active' | 'stop_requested' | 'terminal'
export type ReactionCycleStopReason = 'player_preempted' | 'user_cancelled' | 'administrative_stop' | 'quarantined'
export type ReactionCycleTerminalReason =
  | 'quiescent'
  | 'all_abstained'
  | 'call_limit'
  | 'wave_limit'
  | 'token_budget_exhausted'
  | 'deadline_reached'
  | 'provider_terminal'
  | ReactionCycleStopReason

export type ReactionJobOutcome = 'proposed' | 'abstained' | 'provider_terminal' | 'runtime_unavailable' | 'rejected'

/** One Observation from the committing Root Round that may stimulate a character. */
export interface ReactionStimulusDraft extends WorldJsonObject {
  readonly sourceEventOrdinal: number
  readonly observationOrdinal: number
  readonly observationId: string
  readonly observerCharacterId: CharacterId
}

/** One candidate used to freeze the initial wave before any Provider dispatch. */
export interface ReactionCandidateDraft extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly estimatedTokens: number
  readonly stimuli: readonly ReactionStimulusDraft[]
}

/** Manifest-locked responsive/v1 limits attached atomically to one Root Round commit. */
export interface ReactionCycleDraft extends WorldJsonObject {
  readonly policyVersion: 'reaction-policy/v1'
  readonly profileId: 'responsive/v1'
  readonly maxWaves: number
  readonly maxNpcCalls: number
  readonly maxCallsPerCharacter: number
  readonly maxActionsPerCall: 1
  readonly allowedActionTypes: readonly ['speak@1']
  readonly initialTokenBudget: number
  readonly deadlineAtMs: number
  readonly candidates: readonly ReactionCandidateDraft[]
}

export interface StoredReactionCycle extends WorldJsonObject {
  readonly cycleId: ReactionCycleId
  readonly address: WorldAddress
  readonly rootRoundId: InteractionRoundId
  readonly rootTransactionId: TransactionId
  readonly createdAtSeq: number
  readonly policyVersion: 'reaction-policy/v1'
  readonly profileId: 'responsive/v1'
  readonly maxWaves: number
  readonly maxNpcCalls: number
  readonly maxCallsPerCharacter: number
  readonly maxActionsPerCall: 1
  readonly allowedActionTypes: readonly ['speak@1']
  readonly initialTokenBudget: number
  readonly deadlineAtMs: number
  readonly budgetHash: WorldHash
  readonly status: ReactionCycleStatus
  readonly stopReason: ReactionCycleStopReason | null
  readonly terminalReason: ReactionCycleTerminalReason | null
  readonly terminalAtSeq: number | null
  readonly cycleHash: WorldHash
  readonly stateHash: WorldHash
}

export interface StoredReactionWave extends WorldJsonObject {
  readonly cycleId: ReactionCycleId
  readonly address: WorldAddress
  readonly wave: number
  readonly baseHeadSeq: number
  readonly baseHeadHash: WorldHash
  readonly callsBefore: number
  readonly tokensBefore: number
  readonly budgetPlan: StableCallBudgetPlan
  readonly budgetPlanHash: WorldHash
  readonly reservedCalls: number
  readonly reservedTokens: number
  readonly status: 'frozen' | 'committed' | 'closed_without_dispatch'
  readonly reactionRoundId: InteractionRoundId | null
  readonly resultTransactionId: TransactionId | null
  readonly authorityHash: WorldHash | null
  readonly waveHash: WorldHash
  readonly stateHash: WorldHash
}

export interface StoredReactionJob extends WorldJsonObject {
  readonly jobId: ReactionJobId
  readonly address: WorldAddress
  readonly cycleId: ReactionCycleId
  readonly wave: number
  readonly characterId: CharacterId
  readonly stimulusHash: WorldHash
  readonly status: 'pending' | 'claimed' | 'settled' | 'skipped'
  readonly budgetDecision: 'reserved' | 'character_limit' | 'call_limit' | 'token_budget_exhausted'
  readonly budgetOrdinal: number | null
  readonly reservedTokens: number
  readonly claimOwnerId: string | null
  readonly claimExpiresAtMs: number | null
  readonly claimFencingToken: number | null
  readonly attemptCount: number
  readonly outcome: ReactionJobOutcome | null
  readonly contextReceiptId: string | null
  readonly contextReceiptHash: WorldHash | null
  readonly providerCallId: string | null
  readonly providerRequestHash: WorldHash | null
  readonly proposalHash: WorldHash | null
  readonly resultTransactionId: TransactionId | null
  readonly jobHash: WorldHash
  readonly stateHash: WorldHash
}

export interface StoredReactionStimulus extends WorldJsonObject {
  readonly jobId: ReactionJobId
  readonly address: WorldAddress
  readonly stimulusOrdinal: number
  readonly observerCharacterId: CharacterId
  readonly sourceRoundId: InteractionRoundId
  readonly sourceTransactionId: TransactionId
  readonly sourceEventSeq: number
  readonly sourceEventOrdinal: number
  readonly observationOrdinal: number
  readonly observationId: string
  readonly sourceEventHash: WorldHash
  readonly stimulusEntryHash: WorldHash
}

export interface StoredReactionCycleBundle extends WorldJsonObject {
  readonly cycle: StoredReactionCycle
  readonly waves: readonly StoredReactionWave[]
  readonly jobs: readonly StoredReactionJob[]
  readonly stimuli: readonly StoredReactionStimulus[]
  /** Immutable Cycle/Wave/Job/Stimulus authority bound into the Root Round. */
  readonly authorityHash: WorldHash
  /** Current mutable scheduler state, used for diagnostics and transfer integrity. */
  readonly bundleHash: WorldHash
}

/** A durable Reaction Job lease held under the current branch Writer lease. */
export type ClaimedReactionJob = StoredReactionJob & {
  readonly status: 'claimed'
  readonly budgetDecision: 'reserved'
  readonly budgetOrdinal: number
  readonly claimOwnerId: string
  readonly claimExpiresAtMs: number
  readonly claimFencingToken: number
}

/** Exact Context and append-once ProviderCall identities attached before dispatch. */
export interface ReactionJobProviderBinding {
  readonly contextReceiptId: string
  readonly contextReceiptHash: WorldHash
  readonly providerCallId: string
  readonly providerRequestHash: WorldHash
}
