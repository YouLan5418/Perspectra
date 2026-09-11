import { describe, expect, it } from 'vitest'
import type { RuntimeAvailabilityState } from '@harness-world/contracts'
import {
  SCHEDULABLE_AVAILABILITY_STATES, availabilityRecovery, retryableAvailability,
} from './runtime-availability.ts'

describe('runtime availability retry policy', () => {
  it('schedules every self-clearing state plus the Provider quality state', () => {
    expect([...SCHEDULABLE_AVAILABILITY_STATES].sort()).toEqual([
      'provider_output_invalid', 'ready', 'session_lag',
    ])
  })

  it('retries a self-clearing state with or without the Provider quality signal', () => {
    for (const state of ['ready', 'session_lag'] as const) {
      expect(retryableAvailability(state, true)).toBe(true)
      expect(retryableAvailability(state, false)).toBe(true)
    }
  })

  it('retries the Provider quality state only while that backoff is present', () => {
    expect(retryableAvailability('provider_output_invalid', true)).toBe(true)
    expect(retryableAvailability('provider_output_invalid', false)).toBe(false)
  })

  it('keeps Host-set and unknown states out of scheduling', () => {
    const blocked: readonly RuntimeAvailabilityState[] = [
      'provisioning', 'model_unavailable', 'budget_unavailable', 'offline', 'disabled',
    ]
    for (const state of blocked) {
      expect(retryableAvailability(state, true)).toBe(false)
      expect(retryableAvailability(state, false)).toBe(false)
    }
    expect(retryableAvailability(undefined, true)).toBe(false)
  })

  it('returns a participant to ready only after it was retried', () => {
    expect(availabilityRecovery('session_lag')).toEqual({ state: 'ready', reason: null })
    expect(availabilityRecovery('provider_output_invalid')).toEqual({ state: 'ready', reason: null })
    expect(availabilityRecovery('ready')).toBeUndefined()
    expect(availabilityRecovery(undefined)).toBeUndefined()
    expect(availabilityRecovery('offline')).toBeUndefined()
  })
})
