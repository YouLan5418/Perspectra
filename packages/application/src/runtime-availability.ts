import type { RuntimeAvailabilityState } from '@harness-world/contracts'

/**
 * States whose cause is expected to clear without a Host action. A participant in one of these states keeps
 * its place in scheduling and is retried every Round, so one failed preparation does not remove it from the
 * world for good. Host-set states (provisioning, offline, disabled) stay blocking.
 */
const SELF_CLEARING_AVAILABILITY_STATES: readonly RuntimeAvailabilityState[] = ['ready', 'session_lag']

/**
 * Provider-family states that are only retried while the quality backoff is present to decide when, so a
 * persistently failing Provider is not re-called every Round.
 */
const PROVIDER_QUALITY_AVAILABILITY_STATES: readonly RuntimeAvailabilityState[] = ['provider_output_invalid']

/** States a Scene Decision may schedule. The Scene has no Provider quality signal, so it lists both groups. */
export const SCHEDULABLE_AVAILABILITY_STATES: readonly RuntimeAvailabilityState[] = [
  ...SELF_CLEARING_AVAILABILITY_STATES, ...PROVIDER_QUALITY_AVAILABILITY_STATES,
]

/** Whether this Round may attempt the participant instead of skipping it at the availability gate. */
export function retryableAvailability(
  state: RuntimeAvailabilityState | undefined,
  hasProviderQuality: boolean,
): boolean {
  if (state === undefined) return false
  if (SELF_CLEARING_AVAILABILITY_STATES.includes(state)) return true
  return PROVIDER_QUALITY_AVAILABILITY_STATES.includes(state) && hasProviderQuality
}

/** The transition that returns a retried participant to `ready`, or `undefined` when it was already ready. */
export function availabilityRecovery(
  state: RuntimeAvailabilityState | undefined,
): { readonly state: 'ready'; readonly reason: null } | undefined {
  if (state === 'ready' || state === undefined) return undefined
  return retryableAvailability(state, true) ? { state: 'ready', reason: null } : undefined
}
