import { expect, it } from 'vitest'
import { battleKnowledge } from './battle-knowledge.ts'
import { NativeActivity } from '@perspectra/providers/activities'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities } from './map-activity.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'
import { addRpgValuesExample } from '../../../../tests/support/rpg-values-fixture.ts'

it('gives each participant only their learned skill costs/effects and battle rules, without enemy secrets', () => {
  const raw = referenceJson()
  const companion = structuredClone(raw.characters['character:cheng'])
  addRpgValuesExample(raw)
  raw.characters['character:cheng'] = { ...companion, skills: ['pressure', 'rain'] }
  raw.characters['character:player'].skills = ['rage-strike', 'hot-ward']
  const activities = generateMapActivities(parseRpgConfig(raw, referencePack), {
    names: { 'character:player': '玩家', 'character:cheng': '澄' },
  })
  const activity = new NativeActivity(activities[0]!)
  const game = activity.initialize(
    {
      playerId: 'character:player',
      npcIds: ['character:cheng'],
      world: {
        locationId: 'location:ruin-1',
        arrivedAtSeq: 0,
        characterIds: ['character:player', 'character:cheng'],
        items: { current: [], lastObserved: [] },
      },
      truth: {
        public: {},
        characters: {
          'character:player': { 'rpg-hp': 40, 'rpg-hp-max': 40, 'rpg-mp': 8, 'rpg-mp-max': 8 },
          'character:cheng': { 'rpg-hp': 30, 'rpg-hp-max': 30, 'rpg-mp': 12, 'rpg-mp-max': 12 },
        },
      },
      previous: null,
    },
    Math.random,
  ) as any
  expect(game.private).toEqual({ 'character:player': {}, 'character:cheng': {} })
  const config = parseRpgConfig(raw, referencePack)
  const player = battleKnowledge(config, 'character:player') as any
  const npc = battleKnowledge(config, 'character:cheng') as any
  expect(npc.skills.map((s: any) => s.id)).toEqual(['pressure', 'rain'])
  expect(player.skills.find((s: any) => s.id === 'rage-strike').resourceCost).toEqual({ rage: 5 })
  expect(player.skills.find((s: any) => s.id === 'hot-ward').effects.map((e: any) => e.kind)).toEqual([
    'shield',
    'status',
  ])
  expect(player.combatStatuses.burn.tick).toEqual({ kind: 'damage', amount: 3, element: 'fire' })
  expect(npc.battleValues.resources.rage.onHpLoss).toBe(3)
  expect(npc.battleValues.resources.posture.onZeroStatus).toBe('broken')
  expect(npc.combatStatuses.broken.modifiers.defense).toBe(-3)
  expect(JSON.stringify(npc)).not.toMatch(/hot-ward|rage-strike|enemy-strike|lowest-hp|random|drops|scripted/)
  npc.skills[0].effects[0].amount = 999
  expect(raw.skills.find((s: any) => s.id === 'pressure').effects[0].amount).toBe(1)
  expect(player.skills.find((s: any) => s.id === 'rage-strike').effects[0].amount).toBe(4)
})

it('does not persist repeated skill definitions into bounded activity state', () => {
  const raw = referenceJson()
  for (const map of raw.maps) map.scripted = []
  for (let i = 0; i < 100; i++) {
    raw.skills.push({
      id: 'bulk-' + i,
      name: 'Bulk ' + i,
      target: 'opponent',
      effects: Array.from({ length: 8 }, () => ({ kind: 'damage', amount: 1 })),
    })
    raw.characters['character:player'].skills.push('bulk-' + i)
    raw.characters['character:cheng'].skills.push('bulk-' + i)
  }
  const generated = generateMapActivities(parseRpgConfig(raw, referencePack), { names: {} })
  const game = new NativeActivity(generated[0]!).initialize(
    {
      playerId: 'character:player',
      npcIds: ['character:cheng'],
      previous: null,
      world: {
        locationId: 'location:ruin-1',
        arrivedAtSeq: 0,
        characterIds: ['character:player', 'character:cheng'],
        items: { current: [], lastObserved: [] },
      },
      truth: { public: {}, characters: {} },
    },
    Math.random,
  ) as any
  expect(game.private).toEqual({ 'character:player': {}, 'character:cheng': {} })
  expect(JSON.stringify(game).length).toBeLessThan(65536)
})
