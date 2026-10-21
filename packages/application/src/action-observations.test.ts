import { brandId, type CharacterId } from '@harness-world/contracts'
import { expect, it } from 'vitest'
import { actionObservations } from './action-observations.ts'

const actor = brandId('character:actor', 'CharacterId')
const witness = brandId('character:witness', 'CharacterId')
const outsider = brandId('character:outsider', 'CharacterId')
const player = brandId('character:player', 'CharacterId')

function contentOf(events: ReturnType<typeof actionObservations>['events'], observerId: CharacterId) {
  return events
    .map(event => (event.data as { value: { observerId: string; content: Record<string, unknown> } }).value)
    .find(value => value.observerId === observerId)?.content
}

it('gives occurrence-only observers no clause beyond the fact that something happened', () => {
  const { events } = actionObservations({
    roundId: brandId('round:private', 'InteractionRoundId'),
    actionId: 'action:private',
    actorId: actor,
    actionType: 'interact',
    status: 'accepted',
    audience: { fullContentCharacterIds: [actor, witness], occurrenceOnlyCharacterIds: [outsider] },
    shared: { interaction: { entityId: 'entity:letter' } },
    perObserver: () => ({ resultDescription: 'secret' }),
    playerBindings: [],
  })
  expect(contentOf(events, witness)).toMatchObject({
    interaction: { entityId: 'entity:letter' },
    resultDescription: 'secret',
  })
  expect(contentOf(events, outsider)).toEqual({
    actorId: actor,
    actionType: 'private_interaction',
    status: 'accepted',
    contentVisibility: 'occurrence_only',
  })
})

it('splits a move route by scene and delivers only to observing player sessions', () => {
  const { events, outbox } = actionObservations({
    roundId: brandId('round:move', 'InteractionRoundId'),
    actionId: 'action:move',
    actorId: actor,
    actionType: 'move',
    status: 'accepted',
    audience: { fullContentCharacterIds: [actor, witness, player], occurrenceOnlyCharacterIds: [] },
    route: {
      characterId: actor,
      fromLocationId: 'location:hall',
      toLocationId: 'location:garden',
      departureObservers: new Set([witness]),
      arrivalObservers: new Set([player]),
    },
    shared: {},
    playerBindings: [
      { characterId: player, sessionId: brandId('session:player', 'SessionId') },
      { characterId: outsider, sessionId: brandId('session:other', 'SessionId') },
    ],
  })
  expect(contentOf(events, actor)?.movement).toEqual({
    characterId: actor,
    fromLocationId: 'location:hall',
    toLocationId: 'location:garden',
  })
  expect(contentOf(events, witness)?.movement).toEqual({ characterId: actor, fromLocationId: 'location:hall' })
  expect(contentOf(events, player)?.movement).toEqual({ characterId: actor, toLocationId: 'location:garden' })
  expect(outbox.map(item => item.sessionId)).toEqual(['session:player'])
})
