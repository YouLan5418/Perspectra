import type { CharacterId } from '@harness-world/contracts'
import type { CharacterLoopSubmission } from './character-loop.ts'
import type { SchedulerTurnResult } from './scheduler.ts'

export type { BusinessRejection } from '@harness-world/contracts'

/** An unexpected implementation failure. Hosts report it separately from a business rejection. */
export interface PluginFault {
  readonly origin: 'plugin'
  readonly pluginId: string
  readonly operation: string
  readonly message: string
}

/** Controlled-commit fields already reported by CharacterLoop. */
export type ControlledCommitResult = Pick<
  CharacterLoopSubmission,
  'status' | 'controlledCommitted' | 'publicationRejected'
>

/** Hard limits supplied by a Host request, shared by all of its execution cycles. */
export interface ExecutionCycleBudget {
  readonly maxActivations: number
  readonly maxConcurrentActivations: number
  readonly deadlineMs?: number
}

/** `interrupted` reports cancellation; an expired hard deadline exhausts the request budget. */
export type ExecutionCycleTerminal = 'completed' | 'budget_exhausted' | 'interrupted' | 'failed'

export type LastDecisionOutcome =
  | { readonly decision: 'abstain' }
  | ({ readonly decision: 'perform' | 'publish' } & ControlledCommitResult)

export interface ExecutionCycleActivationResult extends SchedulerTurnResult {
  readonly characterId: CharacterId
  readonly controlledCommitted: boolean
  readonly publicationCommitted: boolean
  readonly lastDecision?: LastDecisionOutcome
}

export interface CycleModelUsage {
  readonly sends: number
  readonly observedHttpAttempts: number
  readonly observedHttpRetries: number
  readonly opaqueTransportCalls: number
  readonly usageReported: number
  readonly usageMissing: number
  /** Sums of reported usage only; missing reports are never replaced by zero. */
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

/** Trusted execution result; NPC action details still require viewer-specific projection. */
export interface ExecutionCycleResult {
  readonly cycleId: string
  readonly status: ExecutionCycleTerminal
  readonly calls: number
  readonly activations: readonly ExecutionCycleActivationResult[]
  readonly usage: CycleModelUsage
  readonly failure?: SchedulerTurnResult['failure'] | PluginFault
}
