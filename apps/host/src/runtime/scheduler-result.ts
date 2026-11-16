export { guardSchedulerReads, normalizeSchedulerResult, trackSchedulerTurns } from '@perspectra/core'

/** The player receives scheduling counters, never NPC outcomes or plugin-supplied activation details. */
export function playerSchedulerSummary(
  value:
    | {
        readonly calls?: unknown
        readonly wave?: unknown
        readonly terminalReason?: unknown
        readonly autonomousCalls?: unknown
        readonly reactionCalls?: unknown
      }
    | undefined,
) {
  if (!value) return null
  return {
    calls: Number.isSafeInteger(value.calls) ? value.calls : 0,
    wave: Number.isSafeInteger(value.wave) ? value.wave : 0,
    terminalReason: typeof value.terminalReason === 'string' ? value.terminalReason : 'unknown',
    ...(Number.isSafeInteger(value.autonomousCalls) ? { autonomousCalls: value.autonomousCalls } : {}),
    ...(Number.isSafeInteger(value.reactionCalls) ? { reactionCalls: value.reactionCalls } : {}),
  }
}
