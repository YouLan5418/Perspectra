import type { WorldJsonObject } from '@harness-world/contracts'
import type { ParticipantTerminalStatus } from './round-coordinator.ts'

export type DegradedParticipantStatus = Exclude<ParticipantTerminalStatus, 'proposed'>

/** Fixed-cardinality application metrics. They report runtime outcomes but never affect authority. */
export class ApplicationRuntimeMetrics {
  readonly #participantTerminals: Record<DegradedParticipantStatus, number> = {
    provider_failed: 0,
    provider_timeout: 0,
    budget_exhausted: 0,
    schema_invalid: 0,
    lifecycle_ineligible: 0,
    runtime_unavailable: 0,
  }
  #sessionDeliveryFailures = 0

  recordParticipant(status: DegradedParticipantStatus): void {
    this.#participantTerminals[status] += 1
  }

  recordSessionDeliveryFailure(): void {
    this.#sessionDeliveryFailures += 1
  }

  snapshot(): WorldJsonObject {
    return {
      participantTerminals: { ...this.#participantTerminals },
      sessionDeliveryFailures: this.#sessionDeliveryFailures,
    }
  }
}
