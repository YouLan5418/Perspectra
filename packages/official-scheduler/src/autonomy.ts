import type { SchedulerActivation, SchedulerResult, SchedulerRound } from '@harness-world/plugin-sdk'

/** Staged autonomous opportunities and their reactions. All temporary budgets belong to this scheduler. */
export async function runAutonomousSchedule(
  round: SchedulerRound,
  react: (round: SchedulerRound) => Promise<SchedulerResult>,
): Promise<SchedulerResult> {
  const autonomy = round.autonomy!
  const signal = AbortSignal.any([round.signal, AbortSignal.timeout(autonomy.deadlineSeconds * 1000)])
  const before = round.headSeq()
  const activations: SchedulerActivation[] = []
  const counts = new Map(round.initialCounts)
  let remaining = autonomy.maximumNpcCalls,
    exhausted = false,
    calls = 0,
    reason = 'quiescent'
  const spend = () => {
    if (remaining <= 0) {
      exhausted = true
      throw new Error('autonomous model call budget exhausted')
    }
    remaining--
  }
  const maximum = Math.max(0, ...autonomy.roles.map(role => role.opportunities))
  outer: for (let opportunity = 0; opportunity < maximum; opportunity++) {
    for (const role of autonomy.roles) {
      if (opportunity >= role.opportunities) continue
      if (signal.aborted) {
        reason = 'interrupted'
        break outer
      }
      const available = Math.min(autonomy.maximumNpcCalls - calls, remaining)
      if (available < 2) {
        reason = 'call_limit'
        break outer
      }
      const result = await round.turn(role.characterId, {
        kind: 'autonomous',
        signal,
        maxCalls: 2,
        maxModelCalls: available,
        beforeModelCall: spend,
        stimulusSeqs: round.observationSeqs(role.characterId, round.afterSeq, round.headSeq()),
      })
      calls += result.calls
      activations.push({ characterId: role.characterId, result })
      counts.set(role.characterId, (counts.get(role.characterId) ?? 0) + 1)
      if (result.status === 'failed' || result.status === 'interrupted') {
        reason = exhausted ? 'call_limit' : result.status
        break outer
      }
    }
  }
  const autonomousCalls = autonomy.maximumNpcCalls - remaining
  let reactions: SchedulerResult | undefined
  if (!signal.aborted && reason !== 'failed' && reason !== 'interrupted' && autonomy.reactionLimits.maximumWaves > 0) {
    remaining = autonomy.reactionLimits.maximumNpcCalls
    exhausted = false
    const { autonomy: _autonomy, ...base } = round
    reactions = await react({
      ...base,
      phase: 'scene',
      signal,
      afterSeq: before,
      initialCounts: counts,
      limits: autonomy.reactionLimits,
      turn: (id, options) => round.turn(id, { ...options, beforeModelCall: spend }),
    })
    if (exhausted) reason = 'call_limit'
    else if (reactions.terminalReason !== 'quiescent') reason = reactions.terminalReason
  }
  if (signal.aborted) reason = 'interrupted'
  const reactionCalls = reactions === undefined ? 0 : autonomy.reactionLimits.maximumNpcCalls - remaining
  return {
    calls,
    wave: 0,
    activations,
    terminalReason: reason,
    autonomy: {
      activations,
      autonomousCalls,
      reactionCalls,
      ...(reactions === undefined ? {} : { reactions }),
      terminalReason: reason,
    },
  }
}
