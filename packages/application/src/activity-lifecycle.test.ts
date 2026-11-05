import { expect, it } from 'vitest'
import type { ActivityState, WorldJsonObject } from '@harness-world/contracts'
import {
  abandonedActivity,
  activityOutcomeObservations,
  activityResultMetadata,
  activityUpdatedEvent,
  checkActivityRequest,
  escapedActivity,
  resumedActivity,
  startedActivity,
  suspendedActivity,
} from './activity-lifecycle.ts'

const PLAYER = 'character:player',
  NPC = 'character:npc'
const running: ActivityState = {
  id: 'activity:1',
  revision: 4,
  participants: [PLAYER, NPC],
  game: {
    active: true,
    phase: 'play',
    turn: NPC,
    round: 3,
    public: { score: 2 },
    private: { [PLAYER]: {}, [NPC]: { secret: 1 } },
    internal: { answer: 7 },
  },
} as unknown as ActivityState

it('starts at revision one with the given game', () => {
  expect(startedActivity({ id: 'activity:2', participants: [PLAYER], game: running.game })).toEqual({
    id: 'activity:2',
    revision: 1,
    participants: [PLAYER],
    game: running.game,
  })
})

it('keeps every bit of progress across a pause and resume', () => {
  const paused = suspendedActivity(running)
  expect(paused).toEqual({
    ...running,
    revision: 5,
    suspendedTurn: NPC,
    game: { ...running.game, active: false, turn: null },
  })
  const resumed = resumedActivity(paused)
  expect(resumed).toEqual({ ...running, revision: 6 })
  expect(resumed).not.toHaveProperty('suspendedTurn')
})

it('abandons only paused progress and keeps what already happened', () => {
  expect(() => abandonedActivity(running)).toThrow('只能放弃暂停中的活动')
  const abandoned = abandonedActivity(suspendedActivity(running))
  expect(abandoned.game).toMatchObject({ active: false, phase: 'host-aborted', turn: null, public: { score: 2 } })
  expect(abandoned.revision).toBe(6)
  expect(abandoned).not.toHaveProperty('suspendedTurn')
})

it('refuses to resume what was never paused', () => {
  expect(() => resumedActivity(running)).toThrow(TypeError)
})

it('escapes from any running state without consulting a script', () => {
  expect(escapedActivity(running)).toEqual({
    ...running,
    revision: 5,
    game: { ...running.game, active: false, phase: 'host-aborted', turn: null },
  })
})

it('accepts only a live request from a participant', () => {
  expect(() => checkActivityRequest(running, 'activity:1', 4, NPC)).not.toThrow()
  for (const [state, id, revision, actor] of [
    [undefined, 'activity:1', 4, NPC],
    [{ ...running, game: { ...running.game, active: false } }, 'activity:1', 4, NPC],
    [running, 'activity:other', 4, NPC],
    [running, 'activity:1', 3, NPC],
    [running, 'activity:1', 4, 'character:stranger'],
  ] as const)
    expect(() => checkActivityRequest(state as ActivityState | undefined, id, revision, actor)).toThrow('已失效')
})

// Saves already hold these shapes: changing them breaks every world in progress.
it('keeps the committed event shape', () => {
  expect(
    activityUpdatedEvent({
      key: 'guess',
      state: running,
      description: '继续。',
      actorId: PLAYER,
      actionId: 'action:1',
      operation: 'guess',
    }),
  ).toEqual({
    eventType: 'activity.updated',
    eventVersion: 1,
    data: {
      activityKey: 'guess',
      state: running,
      description: '继续。',
      actorId: PLAYER,
      actionId: 'action:1',
      operation: 'guess',
    },
  })
})

it('reports each lifecycle in the result metadata', () => {
  const cases: [string, string][] = [
    ['suspend', 'suspended'],
    ['resume', 'resumed'],
    ['start', 'started'],
    ['guess', 'updated'],
  ]
  for (const [operation, lifecycle] of cases)
    expect(activityResultMetadata(running, operation)).toEqual({
      activity: { id: 'activity:1', revision: 4, phase: 'play', round: 3, active: true, lifecycle },
    })
  const ended = { ...running, game: { ...running.game, active: false } } as ActivityState
  expect(activityResultMetadata(ended, 'guess')).toMatchObject({ activity: { lifecycle: 'ended' } })
})

it('tells the named participants, wherever they are, with the same text and metadata', () => {
  const drafts = activityOutcomeObservations({
    state: running,
    description: '第 3 轮结束。',
    actorId: PLAYER,
    actionId: 'action:1',
    observerIds: [PLAYER, NPC],
    operation: 'guess',
  })
  expect(drafts.map(event => (event.data as WorldJsonObject).id)).toEqual(['action:1:' + PLAYER, 'action:1:' + NPC])
  expect(((drafts[1]!.data as WorldJsonObject).value as WorldJsonObject).content).toEqual({
    actorId: PLAYER,
    actionType: 'interact',
    status: 'accepted',
    resultDescription: '第 3 轮结束。',
    resultMetadata: activityResultMetadata(running, 'guess'),
  })
  expect(JSON.stringify(drafts)).not.toContain('answer')
})
