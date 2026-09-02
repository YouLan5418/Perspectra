import type { ReactionCycleTerminalReason, WorldJsonObject } from '@harness-world/contracts'

export type OperationMetric =
  | 'rpc_requests'
  | 'rpc_errors'
  | 'branch_forks'
  | 'branch_transitions'
  | 'branch_work_failures'
  | 'player_rounds_committed'
  | 'reaction_cycles_started'
  | 'reaction_cycles_completed'
  | 'reaction_waves_committed'
  | 'reaction_actions_accepted'
  | 'shutdown_timeouts'

/** Fixed-cardinality process metrics; authoritative state never depends on these counters. */
export class OperationsMetrics {
  readonly #values: Record<OperationMetric, number> = {
    rpc_requests: 0,
    rpc_errors: 0,
    branch_forks: 0,
    branch_transitions: 0,
    branch_work_failures: 0,
    player_rounds_committed: 0,
    reaction_cycles_started: 0,
    reaction_cycles_completed: 0,
    reaction_waves_committed: 0,
    reaction_actions_accepted: 0,
    shutdown_timeouts: 0,
  }
  readonly #terminalReasons: Record<ReactionCycleTerminalReason, number> = {
    quiescent: 0,
    all_abstained: 0,
    call_limit: 0,
    wave_limit: 0,
    token_budget_exhausted: 0,
    deadline_reached: 0,
    provider_terminal: 0,
    player_preempted: 0,
    user_cancelled: 0,
    administrative_stop: 0,
    quarantined: 0,
  }

  increment(metric: OperationMetric, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('metric increment must be a positive safe integer')
    this.#values[metric] += amount
  }

  /** Count one durable Cycle termination by its closed-set reason; never by address or world text. */
  recordTerminalReason(reason: ReactionCycleTerminalReason): void {
    this.#terminalReasons[reason] += 1
  }

  snapshot(): WorldJsonObject {
    return { ...this.#values, reactionTerminalReasons: { ...this.#terminalReasons } }
  }
}
