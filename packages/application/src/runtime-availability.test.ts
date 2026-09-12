import { describe, expect, it } from 'vitest'
import type { RuntimeAvailabilityState } from '@harness-world/contracts'
import {
  SCHEDULABLE_AVAILABILITY_STATES, alwaysRetryableAvailability, availabilityRecovery, retryableAvailability,
} from './runtime-availability.ts'

describe('runtime availability retry policy', () => {
  it('schedules every self-clearing state plus the Provider quality states', () => {
    expect([...SCHEDULABLE_AVAILABILITY_STATES].sort()).toEqual([
      'budget_unavailable', 'model_unavailable', 'provider_output_invalid', 'ready', 'session_lag',
    ])
  })

  it('lets a path without a quality signal retry only the always-retryable states', () => {
    for (const state of ['ready', 'session_lag', 'budget_unavailable'] as const) {
      expect(alwaysRetryableAvailability(state)).toBe(true)
    }
    for (const state of [
      'provider_output_invalid', 'model_unavailable', 'provisioning', 'offline', 'disabled',
    ] as const) {
      expect(alwaysRetryableAvailability(state)).toBe(false)
    }
    expect(alwaysRetryableAvailability(undefined)).toBe(false)
  })

  it('retries a self-clearing state with or without the Provider quality signal', () => {
    for (const state of ['ready', 'session_lag', 'budget_unavailable'] as const) {
      expect(retryableAvailability(state, true)).toBe(true)
      expect(retryableAvailability(state, false)).toBe(true)
    }
  })

  it('retries a Provider quality state only while that backoff is present', () => {
    for (const state of ['provider_output_invalid', 'model_unavailable'] as const) {
      expect(retryableAvailability(state, true)).toBe(true)
      expect(retryableAvailability(state, false)).toBe(false)
    }
  })

  it('keeps Host-set and unknown states out of scheduling', () => {
    const blocked: readonly RuntimeAvailabilityState[] = ['provisioning', 'offline', 'disabled']
    for (const state of blocked) {
      expect(retryableAvailability(state, true)).toBe(false)
      expect(retryableAvailability(state, false)).toBe(false)
    }
    expect(retryableAvailability(undefined, true)).toBe(false)
  })

  it('returns a participant to ready once it was retried', () => {
    for (const state of [
      'session_lag', 'budget_unavailable', 'provider_output_invalid', 'model_unavailable',
    ] as const) {
      expect(availabilityRecovery(state)).toEqual({ state: 'ready', reason: null })
    }
    expect(availabilityRecovery('ready')).toBeUndefined()
    expect(availabilityRecovery(undefined)).toBeUndefined()
    expect(availabilityRecovery('offline')).toBeUndefined()
    expect(availabilityRecovery('provisioning')).toBeUndefined()
  })
})
