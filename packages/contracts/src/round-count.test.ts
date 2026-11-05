import { expect, it } from 'vitest'
import { playerRoundNumber, type RoundCountEvent } from './round-count.ts'

const event = (seq: number, transactionId: string, eventType: string, data: object): RoundCountEvent =>
  ({ seq, transactionId, eventType, data }) as RoundCountEvent
const player = (seq: number, transactionId: string) =>
  event(seq, transactionId, 'action.resolved', { sourceRole: 'player' })
const round = (seq: number, value: number, pause = false) =>
  event(seq, 'round:' + seq, 'status.updated', {
    source: { kind: 'round', round: value, ...(pause ? { pause: true } : {}) },
    changes: [],
    reveals: [],
  })

it('counts a turn of several commits, a pause and earlier inputs as the player would', () => {
  expect(playerRoundNumber([], 0, false)).toEqual({ round: 0, turnCommits: 0 })
  expect(playerRoundNumber([player(1, 'a')], 0, false)).toEqual({ round: 1, turnCommits: 1 })
  // A line said with an action is one turn however many commits it took.
  expect(playerRoundNumber([player(1, 'a'), player(2, 'b')], 0, false)).toEqual({ round: 1, turnCommits: 2 })
  // Earlier inputs whose hook returned nothing still count; the pause adds this round.
  expect(playerRoundNumber([player(1, 'a')], 1, true)).toEqual({ round: 2, turnCommits: 0 })
  // Counting starts after the last recorded round, and NPC actions never count.
  expect(
    playerRoundNumber(
      [player(1, 'a'), round(2, 5), event(3, 'n', 'action.resolved', { sourceRole: 'agent' }), player(4, 'b')],
      3,
      false,
    ),
  ).toEqual({ round: 6, turnCommits: 1 })
})

it('counts a quick activity action, a start and an operation in two commits, once', () => {
  const start = event(1, 'start', 'activity.updated', {
    requestId: 'q:start',
    operation: 'start',
    state: { id: 'activity:1' },
  })
  const applied = event(3, 'apply', 'activity.updated', {
    requestId: 'q',
    operation: 'fish',
    state: { id: 'activity:1' },
  })
  expect(playerRoundNumber([start, player(2, 'start'), applied, player(4, 'apply')], 0, false)).toEqual({
    round: 1,
    turnCommits: 1,
  })
})

it('reads a recorded pause as that round, without counting it again', () => {
  expect(playerRoundNumber([player(1, 'a'), round(2, 1), round(3, 2, true)], 3, false)).toEqual({
    round: 2,
    turnCommits: 0,
  })
})

it('does not count a turn whose hook failed twice', () => {
  // No round record was written, so the earlier input stays counted and this one adds one.
  expect(playerRoundNumber([player(1, 'a'), player(2, 'b')], 1, false)).toEqual({ round: 2, turnCommits: 1 })
})

it('surfaces a corrupt status record instead of miscounting', () => {
  expect(() => playerRoundNumber([event(1, 'x', 'status.updated', { source: { kind: 'round' } })], 0, false)).toThrow(
    TypeError,
  )
})
