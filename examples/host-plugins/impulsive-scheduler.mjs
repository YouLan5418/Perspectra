// Example of replacing the official scheduler: impatient characters get to answer first.
// It uses only the public plugin surface, so it can be copied anywhere and edited freely.
//
// Staying within round.limits is this example's own choice. The host passes the player's limits as
// advice and does not enforce them on a third-party scheduler: spending is the author's responsibility.
export const hostApi = '1.1'

const version = '0.1.0'

async function run(round, priority) {
  const { maximumWaves, maximumNpcCalls, maximumCallsPerCharacter } = round.limits
  const activations = []
  const counts = new Map(round.initialCounts)
  let calls = 0
  let wave = 0
  let afterSeq = round.afterSeq
  const result = terminalReason => ({ calls, wave, terminalReason, activations })

  while (wave < maximumWaves) {
    const head = round.headSeq()
    // Who has something new to react to. The host only lists what each character was allowed to observe.
    const pending = new Map()
    for (const { seq, characterId, substantive } of round.observationsSince(afterSeq, head)) {
      if (!substantive || !round.characterIds.includes(characterId)) continue
      if ((counts.get(characterId) ?? 0) >= maximumCallsPerCharacter) continue
      pending.set(characterId, [...(pending.get(characterId) ?? []), seq])
    }
    if (pending.size === 0) return result('quiescent')
    afterSeq = head
    wave++

    const rank = id => (priority.includes(id) ? priority.indexOf(id) : priority.length)
    for (const [id, stimulusSeqs] of [...pending].sort(([a], [b]) => rank(a) - rank(b))) {
      if (round.signal.aborted) return result('interrupted')
      if (calls + 2 > maximumNpcCalls) return result('call_limit')
      const outcome = await round.turn(id, {
        signal: round.signal,
        stimulusSeqs,
        maxCalls: 2,
        maxModelCalls: maximumNpcCalls - calls,
      })
      calls += outcome.calls
      activations.push({ characterId: id, result: outcome })
      counts.set(id, (counts.get(id) ?? 0) + 1)
      if (outcome.status === 'failed') return result('failed')
      if (outcome.status === 'interrupted') return result('interrupted')
    }
  }
  return result('wave_limit')
}

export default function impulsiveScheduler(ctx, config) {
  const priority = String(config.priority ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
  ctx.effect(() =>
    ctx.scheduler.register({
      id: 'impulsive-scheduler',
      version,
      open: async () => ({ run: round => run(round, priority) }),
    }),
  )
}
