import { describe, expect, it } from 'vitest'
import type { RulebookEvent } from '@harness-world/kernel'
import { StatusState } from './status-state.ts'

const ids = ['character:player', 'character:friend']
const spawn = (characterId: string, locationId: string): RulebookEvent => ({
  eventType: 'character.upsert',
  data: { characterId, locationId },
})
const moved = (characterId: string, toLocationId: string): RulebookEvent => ({
  eventType: 'character.moved',
  data: { characterId, toLocationId },
})
const declaration = (extra: Record<string, unknown> = {}) => ({
  statuses: [
    { key: 'rpg-hp', label: '体力', type: 'number', owner: 'character', ...extra },
    { key: 'mood', label: '心情', type: 'string', owner: 'character' },
  ],
  operations: [],
})
const initial = (state: StatusState) =>
  state.initialEvent({
    public: {},
    characters: Object.fromEntries(ids.map(id => [id, { 'rpg-hp': 7, mood: 'calm' }])),
  }) as RulebookEvent

describe('status locations', () => {
  const state = () => new StatusState(declaration({ locations: ['location:ruin-1'] }), ids, [])

  it('a status limited to dungeon locations is not known at home', () => {
    const s = state()
    const events = [spawn('character:player', 'location:home'), spawn('character:friend', 'location:home'), initial(s)]
    const keys = (list: RulebookEvent[]) =>
      s
        .known(list, 'character:player')
        .filter(entry => entry.holderId === 'character:player')
        .map(entry => entry.key)
    expect(keys(events)).toEqual(['mood'])
    const inside = [...events, moved('character:player', 'location:ruin-1')]
    expect(keys(inside)).toEqual(['rpg-hp', 'mood'])
    expect(s.known(inside, 'character:player').find(entry => entry.key === 'rpg-hp')).toMatchObject({
      value: 7,
      current: true,
    })
    // The truth and the player's own view are unaffected by where she stands.
    expect(s.truth(events).characters['character:player']).toMatchObject({ 'rpg-hp': 7 })
  })

  it('uses the observer position, not the holder position', () => {
    const s = state()
    const events = [
      spawn('character:player', 'location:ruin-1'),
      spawn('character:friend', 'location:home'),
      initial(s),
    ]
    // Friend is at home and does not see player's hp; player in the ruin sees her own.
    expect(s.known(events, 'character:friend').some(entry => entry.key === 'rpg-hp')).toBe(false)
    expect(s.known(events, 'character:player').some(entry => entry.key === 'rpg-hp')).toBe(true)
  })

  it('rejects an empty or duplicate locations list', () => {
    expect(() => new StatusState(declaration({ locations: [] }), ids, [])).toThrow(/locations/)
    expect(() => new StatusState(declaration({ locations: ['location:a', 'location:a'] }), ids, [])).toThrow(
      /locations/,
    )
  })

  it('rejects a location the pack does not have when the pack locations are given', () => {
    const locations = ['location:home']
    expect(() => new StatusState(declaration({ locations: ['location:nowhere'] }), ids, [], locations)).toThrow(
      /locations/,
    )
    expect(() => new StatusState(declaration({ locations: ['location:home'] }), ids, [], locations)).not.toThrow()
  })
})
