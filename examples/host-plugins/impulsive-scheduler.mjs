// Example of replacing the official scheduler: impatient characters get to answer first.
// It uses only the public plugin surface, so it can be copied anywhere and edited freely.
//
// Staying within round.limits is this example's own choice. The host passes the player's limits as
// advice and does not enforce them on a third-party scheduler: spending is the author's responsibility.
export const hostApi = '2.0'

const version = '0.2.0'

async function activity(round) {
  const activations = []
  let calls = 0
  for (let n = 0; n < round.activity.opportunities && round.activity.next(); n++) {
    if (round.signal.aborted) break
    const id = round.activity.next()
    const outcome = await round.turn(id, { signal: round.signal, maxCalls: 2,
      stimulusSeqs: round.observationSeqs(id, 0, round.headSeq()).toSorted((a, b) => a - b).slice(-8) })
    calls += outcome.calls
    activations.push({ characterId: id, result: outcome })
    if (round.activity.resultUnknown()) break
  }
  return { calls, wave: activations.length, terminalReason: round.signal.aborted ? 'interrupted' : 'quiescent', activations }
}

async function autonomous(round, priority) {
  const rank = id => priority.includes(id) ? priority.indexOf(id) : priority.length
  const roles = [...round.autonomy.roles].sort((a, b) => rank(a.characterId) - rank(b.characterId))
  const activations = []
  let calls = 0
  for (const role of roles) {
    for (let n = 0; n < role.opportunities && calls + 2 <= round.autonomy.maximumNpcCalls; n++) {
      if (round.signal.aborted) break
      const outcome = await round.turn(role.characterId, { kind: 'autonomous', signal: round.signal,
        stimulusSeqs: round.observationSeqs(role.characterId, round.afterSeq, round.headSeq()),
        maxCalls: 2, maxModelCalls: round.autonomy.maximumNpcCalls - calls })
      calls += outcome.calls
      activations.push({ characterId: role.characterId, result: outcome })
      if (outcome.status === 'failed' || outcome.status === 'interrupted')
        return { calls, wave: 1, terminalReason: outcome.status, activations }
    }
  }
  return { calls, wave: 1, terminalReason: round.signal.aborted ? 'interrupted' : 'quiescent', activations }
}

async function run(round, priority) {
  if (round.phase === 'activity') return activity(round)
  if (round.phase === 'autonomy') return autonomous(round, priority)
  const ordinary = await scene(round, priority)
  if (!round.autonomy || round.signal.aborted || ordinary.terminalReason === 'failed') return ordinary
  const result = await autonomous(round, priority)
  return { ...ordinary, autonomy: { activations: result.activations, autonomousCalls: result.calls,
    reactionCalls: 0, terminalReason: result.terminalReason } }
}

async function scene(round, priority) {
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
      identity: { priority },
      open: async () => ({ run: round => run(round, priority) }),
    }),
  )
}
