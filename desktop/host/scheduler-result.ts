import type { SchedulerCycle, SchedulerResult, SchedulerRound } from '@harness-world/plugin-sdk'

const invalid: SchedulerResult = { calls: 0, wave: 0, terminalReason: 'plugin_invalid', activations: [] }

function cycle(value: unknown): SchedulerCycle | undefined {
  const candidate = value as Partial<SchedulerCycle> | null | undefined
  if (
    typeof candidate?.terminalReason !== 'string' ||
    !Array.isArray(candidate.activations) ||
    !candidate.activations.every(
      entry => entry?.characterId !== undefined && typeof entry?.result === 'object' && entry.result !== null,
    )
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

/** The official scheduler waits for its own turns; a plugin may not. `settle` cancels and waits for whatever
 * is still running, and turns started after that are refused. */
export function trackSchedulerTurns(round: SchedulerRound): { round: SchedulerRound; settle(): Promise<void> } {
  const controller = new AbortController()
  const running: Promise<unknown>[] = []
  let open = true
  // Marked as handled here so a plugin that drops the promise cannot take the process down with it.
  const handled = <T>(turn: Promise<T>) => {
    turn.catch(() => undefined)
    return turn
  }
  return {
    round: {
      ...round,
      signal: AbortSignal.any([round.signal, controller.signal]),
      turn: (id, options) => {
        if (!open) return handled(Promise.reject(new TypeError('this round has ended')))
        const turn = handled(round.turn(id, options))
        running.push(turn)
        return turn
      },
    },
    settle: async () => {
      open = false
      controller.abort()
      await Promise.allSettled(running)
    },
  }
}
