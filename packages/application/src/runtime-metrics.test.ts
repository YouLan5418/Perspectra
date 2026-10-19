import { describe, expect, it } from 'vitest'
import { ApplicationRuntimeMetrics } from './runtime-metrics.ts'

describe('ApplicationRuntimeMetrics', () => {
  it('reports Session delivery failures without obsolete NPC participant counters', () => {
    const metrics = new ApplicationRuntimeMetrics()
    metrics.recordSessionDeliveryFailure()
    expect(metrics.snapshot()).toEqual({
      sessionDeliveryFailures: 1,
    })
  })
})
