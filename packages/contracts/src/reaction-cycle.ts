import type {
  CharacterId,
  InteractionRoundId,
  ReactionCycleId,
  ReactionJobId,
  TransactionId,
} from './ids.ts'
import type { InteractionRef } from './interaction-definition.ts'
import type { WorldAddress } from './protocol.ts'
import type { StableCallBudgetPlan } from './stable-call-budget.ts'
import type { WorldHash, WorldJsonObject, WorldJsonValue } from './world-json.ts'

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

/** Hash-locked Manifest capability gate. Historical Manifests are interpreted as disabled. */
export type ReactionPolicyV1 =
  | {
      readonly version: 'reaction-policy/v1'
      readonly mode: 'disabled'
    }
  | {
      readonly version: 'reaction-policy/v1'
      readonly mode: 'responsive'
      readonly profile: 'responsive/v1'
    }
  /**
   * The profile that classifies each observer before it weighs them. It is selected by the world, not by
   * a runtime switch: a world that declared v1 must keep its candidate order and its budget hash, and a
   * host option could not promise that across machines.
   */
  | {
      readonly version: 'reaction-policy/v1'
      readonly mode: 'responsive'
      readonly profile: 'responsive/v2'
    }

export type ReactionProfileId = 'responsive/v1' | 'responsive/v2'

/**
 * What an observer is to the action that reached them. `self` is the actor, and a self-stimulus never
 * appends a call to its own cycle; `direct` means the effect landed on the observer; `addressee` means
 * the action named them without landing on them; `witness` is everyone else who could see it.
 */
export type ReactionRoleClass = 'self' | 'direct' | 'addressee' | 'witness'

/**
 * Why one observer is being weighed. The entry identity is a definition when a definition adjudicated
 * the action - the frozen path always has one - and the action itself otherwise, since speech and
 * movement are not resolved by a registered definition.
 */
export interface ReactionEvidenceV1 extends WorldJsonObject {
  readonly version: 'reaction-evidence/v1'
  readonly sourceEventOrdinal: number
  readonly observationId: string
  readonly observerCharacterId: CharacterId
  readonly actionId: string
  readonly entry:
    | { readonly kind: 'definition'; readonly definitionRef: InteractionRef }
    | { readonly kind: 'action'; readonly actionType: string; readonly actionVersion: number }
  readonly roleClass: ReactionRoleClass
}

/** One Observation from the committing Root Round that may stimulate a character. */
export interface ReactionStimulusDraft extends WorldJsonObject {
  readonly sourceEventOrdinal: number
  readonly observationOrdinal: number
  readonly observationId: string
  readonly observerCharacterId: CharacterId
  /** Present under responsive/v2, absent under v1, whose stored bytes stay as they were. */
  readonly roleClass?: ReactionRoleClass
  readonly evidence?: ReactionEvidenceV1
}

/** One candidate used to freeze the initial wave before any Provider dispatch. */
export interface ReactionCandidateDraft extends WorldJsonObject {
  /** Present under responsive/v2: the strongest class among this candidate's stimuli. */
  readonly roleClass?: ReactionRoleClass
  readonly characterId: CharacterId
  readonly estimatedTokens: number
  readonly stimuli: readonly ReactionStimulusDraft[]
}

/** Manifest-locked responsive/v1 limits attached atomically to one Root Round commit. */
export interface ReactionCycleDraft extends WorldJsonObject {
  readonly policyVersion: 'reaction-policy/v1'
  readonly profileId: ReactionProfileId
  readonly maxWaves: number
  readonly maxNpcCalls: number
  readonly maxCallsPerCharacter: number
  readonly maxActionsPerCall: 1 | 2
  /**
   * The world operation a Cycle carries, at the version its Manifest addresses: v7 takes, v8 and v9
   * interact at 1, and the frozen path interacts at 2 because its request names a binding and a
   * definition lock rather than a catalog entry.
   */
  readonly allowedActionTypes: readonly ['speak@1'] | readonly ['speak@1', 'move@1', 'take@1']
    | readonly ['speak@1', 'move@1', 'interact@1'] | readonly ['speak@1', 'move@1', 'interact@2']
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
  readonly profileId: ReactionProfileId
  readonly maxWaves: number
  readonly maxNpcCalls: number
  readonly maxCallsPerCharacter: number
  readonly maxActionsPerCall: 1 | 2
  /**
   * The world operation a Cycle carries, at the version its Manifest addresses: v7 takes, v8 and v9
   * interact at 1, and the frozen path interacts at 2 because its request names a binding and a
   * definition lock rather than a catalog entry.
   */
  readonly allowedActionTypes: readonly ['speak@1'] | readonly ['speak@1', 'move@1', 'take@1']
    | readonly ['speak@1', 'move@1', 'interact@1'] | readonly ['speak@1', 'move@1', 'interact@2']
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
  /**
   * Why this observation was weighed, under responsive/v2. Absent under v1, whose stored bytes and
   * entry hash stay exactly as they were; present it joins the hash, so a stimulus cannot be re-read
   * with a different basis than the one it was admitted on.
   */
  readonly evidence?: ReactionEvidenceV1
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

/** Privacy-safe operational view exposed by reaction.get/list/cancel. */
export interface ReactionCycleView extends WorldJsonObject {
  readonly cycleId: ReactionCycleId
  readonly address: WorldAddress
  readonly rootRoundId: InteractionRoundId
  readonly policyVersion: 'reaction-policy/v1'
  readonly profileId: ReactionProfileId
  readonly status: ReactionCycleStatus
  readonly stopReason: ReactionCycleStopReason | null
  readonly terminalReason: ReactionCycleTerminalReason | null
  readonly currentWave: number
  readonly maxWaves: number
  readonly maxNpcCalls: number
  readonly maxCallsPerCharacter: number
  readonly initialTokenBudget: number
  readonly usedCalls: number
  readonly usedTokens: number
  readonly createdAtSeq: number
  readonly deadlineAtMs: number
  readonly terminalAtSeq: number | null
  readonly lastCommittedWave: number | null
  readonly lastReactionRoundId: InteractionRoundId | null
  readonly lastResultTransactionId: TransactionId | null
  readonly lastAuthorityHash: WorldHash | null
  readonly stateHash: WorldHash
}

export interface ReactionListQuery extends WorldJsonObject {
  readonly status?: ReactionCycleStatus
  readonly limit?: number
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

/** One exact committed Observation exposed to one Character in a frozen Reaction Wave. */
export interface ReactionContextStimulus extends WorldJsonObject {
  readonly observationId: string
  readonly sourceEventSeq: number
  readonly sourceEventHash: WorldHash
  readonly content: WorldJsonValue
}

/** Durable stimulus envelope used instead of manufacturing a player Action. */
export interface ReactionContextStimulusBundle extends WorldJsonObject {
  readonly schemaVersion: 'reaction-stimulus-context/v1'
  readonly cycleId: ReactionCycleId
  readonly wave: number
  readonly characterId: CharacterId
  readonly stimulusHash: WorldHash
  readonly stimuli: readonly ReactionContextStimulus[]
}

/** Provider-facing NPC-only context. It deliberately has no playerAction field. */
export interface ReactionProposalContext extends WorldJsonObject {
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly tick: number
  readonly origin: {
    readonly kind: 'reaction'
    readonly cycleId: ReactionCycleId
    readonly rootRoundId: InteractionRoundId
    readonly wave: number
  }
  readonly stimulus: ReactionContextStimulusBundle
  readonly candidateHash: WorldHash
}

export interface ReactionAgentProvider {
  /** Untrusted model output; the active runtime validates submit_actions/v7 before use. */
  propose(context: ReactionProposalContext): Promise<WorldJsonObject>
}

/** One exact claimed Job outcome consumed by a Reaction Round transaction. */
export interface ReactionJobSettlementDraft extends WorldJsonObject {
  readonly jobId: ReactionJobId
  readonly claimOwnerId: string
  readonly claimFencingToken: number
  readonly expectedStateHash: WorldHash
  readonly outcome: ReactionJobOutcome
  readonly proposalHash: WorldHash | null
}

/**
 * Exact outcome of one frozen Wave. A null terminalReason requests continuation;
 * the Store independently derives the next budget plan and rejects mismatches.
 */
export interface ReactionWaveSettlementDraft extends WorldJsonObject {
  readonly cycleId: ReactionCycleId
  readonly wave: number
  readonly terminalReason: ReactionCycleTerminalReason | null
  readonly jobs: readonly ReactionJobSettlementDraft[]
  readonly nextWaveCandidates?: readonly ReactionCandidateDraft[]
}
