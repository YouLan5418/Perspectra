import { expect, it } from 'vitest'
import type { RoundCountEvent, WorldJsonObject } from '@harness-world/contracts'
import { pacingHistory } from './pacing-state.ts'

let seq = 0
const event = (eventType: string, data: WorldJsonObject, transactionId = 'tx:' + seq): RoundCountEvent => ({
  seq: ++seq,
  transactionId,
  eventType,
  data,
})
const player = () => event('action.resolved', { sourceRole: 'player' })
const status = (source: WorldJsonObject, changes: WorldJsonObject[] = []) =>
  event('status.updated', { source, changes, reveals: [] } as unknown as WorldJsonObject)
const activity = (activityKey: string, operation: string, active = true) =>
  event('activity.updated', { activityKey, operation, state: { id: 'a', game: { active } } })
const scope = {
  managedActivities: ['party'],
  progress: { statuses: ['money'], activities: ['battle'] },
}

it('starts empty', () => {
  expect(pacingHistory([], 0, scope)).toEqual({ round: 0, fired: [], lastProgressRound: 0 })
})

it('records managed starts and beats with the round they happened in, in order', () => {
  seq = 0
  const events = [
    player(),
    activity('party', 'start'),
    player(),
    status({ kind: 'beat', beatId: 'knock' }),
    player(),
    activity('other', 'start'),
    activity('party', 'guess'),
  ]
  expect(pacingHistory(events, 0, scope)).toMatchObject({
    fired: [
      { kind: 'activity', key: 'party', round: 1 },
      { kind: 'beat', key: 'knock', round: 2 },
    ],
  })
})

it('counts declared progress only, and ignores the initial values', () => {
  seq = 0
  const money = { holderId: null, key: 'money', value: 1 }
  const noise = { holderId: null, key: 'time', value: 2 }
  expect(pacingHistory([status({ kind: 'initial' }, [money]), player()], 0, scope).lastProgressRound).toBe(0)
  seq = 0
  const changed = [player(), status({ kind: 'operation', operation: 'x', actorId: 'p' }, [money]), player()]
  expect(pacingHistory(changed, 0, scope).lastProgressRound).toBe(1)
  seq = 0
  const unrelated = [player(), status({ kind: 'operation', operation: 'x', actorId: 'p' }, [noise]), player()]
  expect(pacingHistory(unrelated, 0, scope).lastProgressRound).toBe(0)
})

it('counts a declared activity finishing as progress, not its moves', () => {
  seq = 0
  const moved = [player(), activity('battle', 'strike'), player()]
  expect(pacingHistory(moved, 0, scope).lastProgressRound).toBe(0)
  seq = 0
  const finished = [player(), activity('battle', 'strike', false), player()]
  expect(pacingHistory(finished, 0, scope).lastProgressRound).toBe(1)
})

it('reads the current round with the turn in progress counted once', () => {
  seq = 0
  const events = [player(), player(), player()]
  expect(pacingHistory(events, 1, scope).round).toBe(2)
})
