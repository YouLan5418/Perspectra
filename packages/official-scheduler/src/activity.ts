import type { SchedulerActivation, SchedulerResult, SchedulerRound } from '@harness-world/plugin-sdk'

/** The official activity opportunity policy. The host alone determines the legal next participant and outcome. */
export async function runActivitySchedule(round: SchedulerRound): Promise<SchedulerResult> {
  const activity = round.activity!
  const signal = AbortSignal.any([round.signal, AbortSignal.timeout(activity.deadlineSeconds * 1000)])
  const activations: SchedulerActivation[] = []
  let calls = 0
  for (
    let opportunity = 0;
    opportunity < activity.opportunities && activity.next() !== undefined && !signal.aborted;
    opportunity++
  ) {
    const id = activity.next()!
    const result = await round.turn(id, {
      signal,
      maxCalls: 2,
      stimulusSeqs: round
        .observationSeqs(id, 0, round.headSeq())
        .toSorted((a, b) => a - b)
        .slice(-8),
    })
    calls += result.calls
    activations.push({ characterId: id, result })
    if (activity.resultUnknown()) return { calls, wave: opportunity + 1, activations, terminalReason: 'result_unknown' }
  }
  return {
    calls,
    wave: activations.length,
    activations,
    terminalReason: signal.aborted ? 'interrupted' : activity.next() !== undefined ? 'opportunity_limit' : 'quiescent',
  }
}
