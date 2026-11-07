import { expect, it } from 'vitest'
import { StatusState } from '@harness-world/application'
import { StatusScripts } from '@harness-world/official-status'

const moduleSource = `globalThis.packPlugin = {
  definition: {
    statuses: [{ key: 'rpg-hp', label: '体力', type: 'number', owner: 'character', locations: ['location:ruin-1'] }],
    actions: [],
  },
  initialize(ids) { return { public: {}, characters: Object.fromEntries(ids.map(id => [id, { 'rpg-hp': 5 }])) } },
  policy() { return { operations: [] } },
  resolve() { return null },
}`

it('a module-declared status with locations is parsed and filtered by location', () => {
  const scripts = new StatusScripts({
    modules: [{ id: 'rpg', source: moduleSource, characters: [], unavailableCapabilities: [] }],
  })
  const state = new StatusState(scripts.definition, ['character:player'], [], ['location:home', 'location:ruin-1'])
  expect(state.statuses[0]).toMatchObject({ key: 'rpg-hp', locations: ['location:ruin-1'] })
  const events = [
    { eventType: 'character.upsert', data: { characterId: 'character:player', locationId: 'location:home' } },
    state.initialEvent(scripts.initialize(['character:player'])),
  ]
  expect(state.known(events as never, 'character:player')).toEqual([])
  const inside = [
    ...events,
    { eventType: 'character.moved', data: { characterId: 'character:player', toLocationId: 'location:ruin-1' } },
  ]
  expect(state.known(inside as never, 'character:player').map(entry => entry.key)).toEqual(['rpg-hp'])
})
