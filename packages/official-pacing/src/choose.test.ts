import { expect, it } from 'vitest'
import type { PacingCandidate, PacingHistory } from '@harness-world/plugin-sdk'
import { choosePaced, tensionAt } from './choose.ts'
import { parsePacingDefinition, type PacingDefinition } from './definition.ts'

const definition: PacingDefinition = parsePacingDefinition({
  cycleRounds: 16,
  chance: 0.5,
  cooldownRounds: { low: 2, medium: 4, high: 8 },
  recoveryRounds: 3,
  stagnation: {
    afterRounds: 6,
    progress: { statuses: ['money'], activities: [] },
    maxChance: 1,
    maxTensionBoost: 0.4,
  },
  activities: { party: { intensity: 'high' } },
  beats: { knock: { intensity: 'low' }, rent: { intensity: 'medium' }, storm: { intensity: 'high' } },
})
const knock: PacingCandidate = { kind: 'beat', key: 'knock' },
  rent: PacingCandidate = { kind: 'beat', key: 'rent' },
  storm: PacingCandidate = { kind: 'beat', key: 'storm' },
  party: PacingCandidate = { kind: 'activity', key: 'party' }
const history = (overrides: Partial<PacingHistory> = {}): PacingHistory => ({
  round: 20,
  fired: [],
  lastProgressRound: 20,
  ...overrides,
})
/** Fixed draws; asking for more than were given fails the test. */
const draws = (...values: number[]) => {
  let index = 0
  const random = () => {
    if (index >= values.length) throw new Error('drew too many')
    return values[index++]!
  }
  return Object.assign(random, { used: () => index })
}
const choose = (candidates: readonly PacingCandidate[], at: PacingHistory, random: () => number) =>
  choosePaced(definition, { candidates, history: at, random })

it('does nothing and draws nothing without candidates', () => {
  const random = draws()
  expect(choose([], history(), random)).toMatchObject({ kind: 'none', reason: { why: 'no-candidates' } })
})

it("waits out the cooldown of the last event, by that event's intensity, without drawing", () => {
  const random = draws()
  const low = history({ fired: [{ kind: 'beat', key: 'knock', round: 19 }] })
  const high = history({ fired: [{ kind: 'beat', key: 'storm', round: 13 }] })
  expect(choose([knock], low, random)).toMatchObject({ kind: 'none', reason: { why: 'cooling' } })
  expect(choose([knock], high, random)).toMatchObject({ kind: 'none', reason: { why: 'cooling' } })
  expect(random.used()).toBe(0)
  // The cooldown is over at exactly its length.
  const over = history({ fired: [{ kind: 'beat', key: 'knock', round: 18 }] })
  expect(choose([knock], over, draws(0, 0))).toMatchObject({ kind: 'beat', key: 'knock' })
})

it('counts an activity start as an event too', () => {
  const at = history({ fired: [{ kind: 'activity', key: 'party', round: 15 }] })
  expect(choose([knock], at, draws())).toMatchObject({ kind: 'none', reason: { why: 'cooling' } })
})

it('stays out when the draw is not under the intervention chance', () => {
  expect(choose([knock], history(), draws(0.5))).toMatchObject({ kind: 'none', reason: { why: 'not-this-round' } })
  expect(choose([knock], history(), draws(0.49, 0))).toMatchObject({ kind: 'beat', key: 'knock' })
})

it('removes high events during recovery, and stays out if nothing else is left', () => {
  const at = history({ round: 21, fired: [{ kind: 'beat', key: 'storm', round: 12 }], lastProgressRound: 21 })
  const noCooldown = parsePacingDefinition({
    cycleRounds: 16,
    chance: 1,
    cooldownRounds: { low: 0, medium: 0, high: 0 },
    recoveryRounds: 10,
    beats: { knock: { intensity: 'low' }, storm: { intensity: 'high' } },
  })
  expect(choosePaced(noCooldown, { candidates: [storm], history: at, random: draws(0) })).toMatchObject({
    kind: 'none',
    reason: { why: 'recovering' },
  })
  expect(choosePaced(noCooldown, { candidates: [storm, knock], history: at, random: draws(0, 0.99) })).toMatchObject({
    kind: 'beat',
    key: 'knock',
  })
})

it('weighs by tension: high at the crest, low at the trough, nothing ever at zero', () => {
  // cycle 16: round 4 is the crest and round 12 the trough; the last draw picks along the weights.
  expect(tensionAt(4, 16)).toBeCloseTo(1)
  expect(tensionAt(12, 16)).toBeCloseTo(0)
  const crest = history({ round: 4, lastProgressRound: 4 }),
    trough = history({ round: 12, lastProgressRound: 12 })
  const all = [knock, rent, storm]
  expect(choose(all, crest, draws(0, 0.5))).toMatchObject({ key: 'storm' })
  expect(choose(all, trough, draws(0, 0))).toMatchObject({ key: 'knock' })
  // Low keeps its small floor at the crest, so it can still happen.
  expect(choose(all, crest, draws(0, 0))).toMatchObject({ key: 'knock' })
})

it('raises tension and chance as the story stalls, up to the declared limits', () => {
  const trough = (lastProgressRound: number) => history({ round: 12, lastProgressRound })
  const fresh = choose([knock], trough(12), draws(0, 0)),
    stalled = choose([knock], trough(6 - 6), draws(0, 0)),
    atLimit = choose([knock], trough(-100), draws(0, 0))
  expect(fresh.reason).toMatchObject({ stagnation: 0, chance: 0.5 })
  expect(stalled.reason).toMatchObject({ stagnation: 1, chance: 1 })
  expect(atLimit.reason).toEqual(stalled.reason)
  expect(Number(stalled.reason.tension)).toBeCloseTo(0.4)
  // Right at afterRounds nothing has changed yet.
  expect(choose([knock], trough(6), draws(0, 0)).reason).toMatchObject({ stagnation: 0 })
  // A world that declares no stagnation stays at its base chance.
  const plain = parsePacingDefinition({
    cycleRounds: 16,
    chance: 0.5,
    cooldownRounds: { low: 0, medium: 0, high: 0 },
    recoveryRounds: 0,
    beats: { knock: { intensity: 'low' } },
  })
  expect(choosePaced(plain, { candidates: [knock], history: trough(-100), random: draws(0.6) }).kind).toBe('none')
})

it('gives the same answer for the same input, with a fixed number of draws', () => {
  const at = history({ round: 9, lastProgressRound: 2 })
  const first = draws(0.1, 0.7),
    second = draws(0.1, 0.7)
  expect(choose([knock, rent, storm, party], at, first)).toEqual(choose([knock, rent, storm, party], at, second))
  expect(first.used()).toBe(2)
  expect(second.used()).toBe(2)
})

it('never breaks a cooldown or recovery over a long run', () => {
  let seed = 12345
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const fired: { kind: 'activity' | 'beat'; key: string; round: number }[] = []
  const intensityOf = { knock: 'low', rent: 'medium', storm: 'high' } as const
  for (let round = 1; round <= 10000; round++) {
    const choice = choose([knock, rent, storm], { round, fired, lastProgressRound: round }, random)
    if (choice.kind === 'none') continue
    const last = fired.at(-1)
    if (last) {
      const previous = intensityOf[last.key as keyof typeof intensityOf]
      expect(round - last.round).toBeGreaterThanOrEqual(definition.cooldownRounds[previous])
      if (previous === 'high' && round - last.round < definition.cooldownRounds.high + definition.recoveryRounds)
        expect(choice.key).not.toBe('storm')
    }
    fired.push({ kind: choice.kind, key: choice.key, round })
  }
  // A property of the mechanism on this synthetic run, not evidence about how it feels to play.
  const counts = fired.reduce<Record<string, number>>(
    (all, row) => ({ ...all, [row.key]: (all[row.key] ?? 0) + 1 }),
    {},
  )
  expect(counts.knock).toBeGreaterThan(0)
  expect(counts.rent).toBeGreaterThan(0)
  expect(counts.storm).toBeGreaterThan(0)
  expect(fired.length).toBeGreaterThan(500)
})
