import { expect, it } from 'vitest'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities } from './map-activity.ts'
import { officialRpgBattleView } from './battle-view.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'

const player = 'character:player'
function fixture(raw = referenceJson()) {
  const hooks = generateMapActivities(parseRpgConfig(raw, referencePack))[0]!.activity
  const scoped: WorldJsonObject = {
    activityKey: 'rpg-map-ruin-1',
    id: 'activity:test',
    revision: 3,
    game: {
      active: true,
      phase: 'fighting',
      round: 2,
      turn: player,
      private: { note: 'player-secret' },
      public: {
        lastResult: '已裁定',
        units: [
          {
            id: player,
            name: '玩家',
            team: 'party',
            hp: 25,
            maxHp: 40,
            stats: { hp: 25, mp: 0 },
            secret: 'not-a-display-field',
          },
          { id: 'character:cheng', name: '澄', team: 'party', hp: 30, maxHp: 30, stats: { mp: 12 } },
          { id: 'golem', name: '遗迹守卫', team: 'enemy', hp: 50, maxHp: 50, strategy: 'not-a-display-field' },
        ],
      },
    },
  }
  return { hooks, scoped }
}

it('only projects visible units and the player skills, not private state or enemy configuration', () => {
  const { hooks, scoped } = fixture()
  const view = officialRpgBattleView(hooks, scoped, player, [player])!
  expect(view.units.map(unit => unit.id)).toEqual([player, 'golem'])
  expect(view.skills.find(skill => skill.name === '普通攻击')!.targets).toEqual(['遗迹守卫'])
  expect(view.skills.find(skill => skill.name === '治疗术')).toMatchObject({
    targets: ['玩家'],
    costs: [{ label: '魔力', amount: 3, shortfall: 3 }],
    unavailable: '魔力不足',
  })
  expect(JSON.stringify(view)).not.toMatch(/player-secret|not-a-display-field|private|strategy|stats/)
  expect(officialRpgBattleView(hooks, scoped, 'character:cheng', [player])).toBeUndefined()
  expect(officialRpgBattleView({ ...hooks }, scoped, player, [player])).toBeUndefined()
})

it('falls back on incomplete views and every non-running battle state', () => {
  const { hooks, scoped } = fixture(),
    game = scoped.game as WorldJsonObject
  for (const phase of ['enter', 'standby', 'aftermath', 'finished', 'host-aborted']) {
    expect(officialRpgBattleView(hooks, { ...scoped, game: { ...game, phase } }, player, [player])).toBeUndefined()
  }
  expect(officialRpgBattleView(hooks, { ...scoped, suspended: true }, player, [player])).toBeUndefined()
  expect(
    officialRpgBattleView(hooks, { ...scoped, game: { ...game, active: false } }, player, [player]),
  ).toBeUndefined()
  expect(
    officialRpgBattleView(hooks, { ...scoped, game: { ...game, public: { units: [{}] } } }, player, [player]),
  ).toBeUndefined()
})

it('copies only authorized shield and status labels, omitting absent units and extra state fields', () => {
  const { hooks, scoped } = fixture()
  const pub = (scoped.game as WorldJsonObject).public as Record<string, WorldJsonObject[string]>
  pub.combatEffects = [
    {
      unitId: player,
      shield: { amount: 4, remaining: 2, secret: 'private-shield' },
      statuses: [{ name: '再生', remaining: 1, timing: 'after-action', polarity: 'positive', statusId: 'hidden-id' }],
    },
    {
      unitId: 'character:cheng',
      statuses: [{ name: 'absent-status', remaining: 2, timing: 'after-action', polarity: 'negative' }],
    },
  ]
  const view = officialRpgBattleView(hooks, scoped, player, [player])!
  expect(view.units[0]).toMatchObject({
    shield: { amount: 4, remaining: 2 },
    statuses: [{ name: '再生', remaining: 1, timing: 'after-action', polarity: 'positive' }],
  })
  expect(JSON.stringify(view)).not.toMatch(/private-shield|hidden-id|absent-status/)
  pub.combatEffects = [{ unitId: player, shield: { amount: -1, remaining: 2 }, statuses: [] }]
  expect(officialRpgBattleView(hooks, scoped, player, [player])).toBeUndefined()
})

it('publishes the actual price of learned skills and drops the shortfall once the balance covers it', () => {
  const { hooks, scoped } = fixture()
  const units = ((scoped.game as WorldJsonObject).public as WorldJsonObject).units as WorldJsonObject[]
  const stats = units[0]!.stats as Record<string, number>
  const skills = () => officialRpgBattleView(hooks, scoped, player, [player])!.skills
  expect(skills().find(s => s.name === '普通攻击')?.costs).toEqual([])
  stats.mp = 2
  expect(skills().find(s => s.name === '火球术')?.costs).toEqual([{ label: '魔力', amount: 3, shortfall: 1 }])
  stats.mp = 8
  expect(skills().find(s => s.name === '火球术')).toEqual({
    name: '火球术',
    targets: ['遗迹守卫'],
    costs: [{ label: '魔力', amount: 3 }],
  })
  delete stats.mp
  expect(skills().find(s => s.name === '火球术')).toMatchObject({
    unavailable: '暂无法核实',
    costs: [{ label: '魔力', amount: 3 }],
  })
})

it('omits a price whose stat label is unavailable here, preserving eligible choices', () => {
  const config = referenceJson()
  const mp = config.stats.find((stat: { key: string }) => stat.key === 'mp')
  mp.locations = ['location:ruin-2']
  mp.label = '本地不可见的数值'
  const { hooks, scoped } = fixture(config)
  const pub = (scoped.game as WorldJsonObject).public as WorldJsonObject
  const stats = (pub.units as WorldJsonObject[])[0]!.stats as Record<string, number>
  const skill = () => officialRpgBattleView(hooks, scoped, player, [player])!.skills.find(s => s.name === '火球术')
  expect(skill()).toEqual({ name: '火球术', targets: ['遗迹守卫'], unavailable: '当前不可用' })
  stats.mp = 8
  expect(skill()).toEqual({ name: '火球术', targets: ['遗迹守卫'] })
})
