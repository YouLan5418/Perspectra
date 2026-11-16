import { AsyncLocalStorage } from 'node:async_hooks'
import type { CycleModelUsage } from '@perspectra/sdk'

export interface ModelExecutionObservation {
  readonly httpAttempts?: number
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly totalTokens?: number
  }
}

/** Numeric observations only; model messages, credentials and endpoint details never enter this account. */
export class ExecutionModelAccount {
  #sends = 0
  #transparent = 0
  #attempts = 0
  #retries = 0
  #usageReported = 0
  readonly #tokens: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {}

  send(): void {
    this.#sends++
  }

  attempt(ordinal: number): void {
    if (ordinal === 1) this.#transparent++
    this.#attempts++
    if (ordinal > 1) this.#retries++
  }

  report(observation: ModelExecutionObservation): void {
    if (observation.httpAttempts !== undefined) {
      this.#transparent++
      this.#attempts += observation.httpAttempts
      this.#retries += Math.max(0, observation.httpAttempts - 1)
    }
    if (observation.usage !== undefined) {
      this.#usageReported++
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
        const value = observation.usage[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
          this.#tokens[key] = (this.#tokens[key] ?? 0) + value
      }
    }
  }

  snapshot(): CycleModelUsage {
    return {
      sends: this.#sends,
      observedHttpAttempts: this.#attempts,
      observedHttpRetries: this.#retries,
      opaqueTransportCalls: Math.max(0, this.#sends - this.#transparent),
      usageReported: this.#usageReported,
      usageMissing: Math.max(0, this.#sends - this.#usageReported),
      ...this.#tokens,
    }
  }
}

const observation = new AsyncLocalStorage<ExecutionModelAccount>()

export function withExecutionObservation<T>(account: ExecutionModelAccount, work: () => T): T {
  return observation.run(account, work)
}

export function recordExecutionModelSend(): void {
  observation.getStore()?.send()
}

export function recordExecutionModelObservation(value: ModelExecutionObservation): void {
  observation.getStore()?.report(value)
}

/** Background memory work belongs to the instance, outside any player request. */
export function withoutExecutionObservation<T>(work: () => T): T {
  return observation.exit(work)
}

export function recordExecutionModelAttempt(ordinal: number): void {
  observation.getStore()?.attempt(ordinal)
}
