import { expect, it } from 'vitest'
import { AutonomyPolicy } from './autonomy-policy.ts'

const source = {
  config: {},
  characterIds: ['character:a', 'character:player'],
  locationIds: ['location:home'],
  targetIds: [],
  definitionIds: ['status:work'],
}
const policy = (triggers: unknown[], everyPlayerTurns = 1) =>
  AutonomyPolicy.parse(
    {
      characters: [
        {
          characterId: 'character:a',
          triggers,
          everyPlayerTurns,
          opportunities: 1,
          interactions: [],
          locationIds: ['location:home'],
        },
      ],
    },
    source,
    'character:player',
  )
const move = (n: number) => ({ transactionId: 'move-' + n, seq: n, pause: false, actionType: 'move' })
const work = (n: number) => ({
  transactionId: 'work-' + n,
  seq: n,
  pause: false,
  actionType: 'interact',
  definitionId: 'status:work',
})

it('counts a trigger with its own interval apart from the role interval', () => {
  const a = policy([
    { actionType: 'move', everyPlayerTurns: 3 },
    { actionType: 'interact', definitionId: 'status:work' },
  ])
  // Work keeps the role's every-turn rhythm while moves only wake her on every third move.
  expect(a.due({ actions: [move(1)], afterSeq: 0 })).toEqual([])
  expect(a.due({ actions: [move(1), move(2)], afterSeq: 1 })).toEqual([])
  expect(a.due({ actions: [move(1), move(2), move(3)], afterSeq: 2 })).toEqual(['character:a'])
  expect(a.due({ actions: [move(1), move(2), move(3), work(4)], afterSeq: 3 })).toEqual(['character:a'])
  // Moves are not mixed into the shared count: with a role interval of 2, one move then one work is only the
  // first shared match, where a combined count would already have reached two.
  const b = policy(
    [
      { actionType: 'move', everyPlayerTurns: 3 },
      { actionType: 'interact', definitionId: 'status:work' },
    ],
    2,
  )
  expect(b.due({ actions: [move(1), work(2)], afterSeq: 1 })).toEqual([])
  expect(b.due({ actions: [move(1), work(2), work(3)], afterSeq: 2 })).toEqual(['character:a'])
})

it('keeps the old combined count when no trigger declares its own interval', () => {
  const a = policy([{ actionType: 'move' }, { actionType: 'interact', definitionId: 'status:work' }], 2)
  expect(a.due({ actions: [move(1), work(2)], afterSeq: 1 })).toEqual(['character:a'])
})

it('rejects an invalid trigger interval', () => {
  expect(() => policy([{ actionType: 'move', everyPlayerTurns: 0 }])).toThrow('1–100')
})
