import type { SchedulerCycle, SchedulerResult } from '@harness-world/plugin-sdk'

const invalid: SchedulerResult = { calls: 0, wave: 0, terminalReason: 'plugin_invalid', activations: [] }

function cycle(value: unknown): SchedulerCycle | undefined {
  const candidate = value as Partial<SchedulerCycle> | null | undefined
  if (
    typeof candidate?.terminalReason !== 'string' ||
    !Array.isArray(candidate.activations) ||
    !candidate.activations.every(entry => entry?.characterId !== undefined && typeof entry?.result === 'object')
  )
    return undefined
  return {
    calls: Number(candidate.calls) || 0,
    wave: Number(candidate.wave) || 0,
    terminalReason: candidate.terminalReason,
    activations: candidate.activations,
  }
}

/** A plugin's return value is unchecked at runtime; the player notices below it must not crash on one. */
export function normalizeSchedulerResult(value: unknown): SchedulerResult {
  const result = cycle(value)
  if (!result) return invalid
  const autonomy = (value as SchedulerResult).autonomy
  return autonomy !== undefined && cycle(autonomy) && cycle(autonomy.reactions) ? { ...result, autonomy } : result
}
