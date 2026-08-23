import { describe, expect, it } from 'vitest'
import { ApplicationRuntimeMetrics, type DegradedParticipantStatus } from './runtime-metrics.ts'

describe('ApplicationRuntimeMetrics', () => {
  it('reports fixed-cardinality participant and Session degradation counters', () => {
    const metrics = new ApplicationRuntimeMetrics()
    const statuses: readonly DegradedParticipantStatus[] = [
      'provider_failed', 'provider_timeout', 'budget_exhausted',
      'schema_invalid', 'lifecycle_ineligible', 'runtime_unavailable',
    ]
    for (const status of statuses) metrics.recordParticipant(status)
    metrics.recordParticipant('provider_failed')
    metrics.recordSessionDeliveryFailure()
    expect(metrics.snapshot()).toEqual({
      participantTerminals: {
        provider_failed: 2,
        provider_timeout: 1,
        budget_exhausted: 1,
        schema_invalid: 1,
        lifecycle_ineligible: 1,
        runtime_unavailable: 1,
      },
      sessionDeliveryFailures: 1,
    })
  })
})
