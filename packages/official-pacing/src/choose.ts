import type { PacingCandidate, PacingChoice, PacingHistory, PacingIntensity } from '@harness-world/plugin-sdk'
import type { PacingDefinition } from './definition.ts'

/** Where the rhythm is at this round: 0 at the trough, 1 at the crest. It paces supply, not how a scene feels. */
export function tensionAt(round: number, cycleRounds: number): number {
  return (Math.sin((2 * Math.PI * round) / cycleRounds) + 1) / 2
}

const MINIMUM_WEIGHT = 0.05

function weight(intensity: PacingIntensity, tension: number): number {
  const raw = intensity === 'low' ? 1 - tension : intensity === 'high' ? tension : 1 - Math.abs(2 * tension - 1)
  return Math.max(MINIMUM_WEIGHT, raw)
}

/** A pure decision over committed history and recorded draws, so a replay reaches the same answer. */
export function choosePaced(
  definition: PacingDefinition,
  input: {
    readonly candidates: readonly PacingCandidate[]
    readonly history: PacingHistory
    readonly random: () => number
  },
): PacingChoice {
  const { candidates, history, random } = input
  const { round } = history
  const intensityOf = (candidate: { readonly kind: 'activity' | 'beat'; readonly key: string }) =>
    (candidate.kind === 'activity' ? definition.activities : definition.beats)[candidate.key]
  const idle = round - history.lastProgressRound,
    stalled = definition.stagnation
  const stagnation =
    stalled === undefined || idle <= stalled.afterRounds
      ? 0
      : Math.min(1, (idle - stalled.afterRounds) / stalled.afterRounds)
  const tension = Math.min(1, tensionAt(round, definition.cycleRounds) + stagnation * (stalled?.maxTensionBoost ?? 0))
  const chance = definition.chance + stagnation * ((stalled?.maxChance ?? definition.chance) - definition.chance)
  const none = (why: string): PacingChoice => ({ kind: 'none', reason: { round, tension, stagnation, chance, why } })

  if (!candidates.length) return none('no-candidates')
  const last = history.fired.findLast(event => intensityOf(event) !== undefined)
  const lastIntensity = last && intensityOf(last)
  const since = last ? round - last.round : Infinity
  if (lastIntensity !== undefined && since < definition.cooldownRounds[lastIntensity]) return none('cooling')
  if (random() >= chance) return none('not-this-round')
  // Recovery follows the high event's own cooldown: other events may return first, another high one may not.
  const recovering = lastIntensity === 'high' && since < definition.cooldownRounds.high + definition.recoveryRounds
  const open = recovering ? candidates.filter(candidate => intensityOf(candidate) !== 'high') : candidates
  if (!open.length) return none('recovering')
  const weights = open.map(candidate => {
    const intensity = intensityOf(candidate)
    if (intensity === undefined) throw new TypeError(`节奏没有管理 ${candidate.key}`)
    return weight(intensity, tension)
  })
  let pick = random() * weights.reduce((sum, value) => sum + value, 0)
  const index = weights.findIndex(value => (pick -= value) < 0)
  const chosen = open[index === -1 ? open.length - 1 : index]!
  return {
    kind: chosen.kind,
    key: chosen.key,
    reason: { round, tension, stagnation, chance, why: 'chosen' },
  }
}
