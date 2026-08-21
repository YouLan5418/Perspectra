import type { WorldJsonObject } from '@harness-world/contracts'

export type OperationMetric = 'rpc_requests' | 'rpc_errors' | 'branch_forks' | 'branch_transitions'

/** Fixed-cardinality process metrics; authoritative state never depends on these counters. */
export class OperationsMetrics {
  readonly #values: Record<OperationMetric, number> = {
    rpc_requests: 0,
    rpc_errors: 0,
    branch_forks: 0,
    branch_transitions: 0,
  }

  increment(metric: OperationMetric, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('metric increment must be a positive safe integer')
    this.#values[metric] += amount
  }

  snapshot(): WorldJsonObject {
    return { ...this.#values }
  }
}
