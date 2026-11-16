import { expect, it } from 'vitest'
import { NativeActivity } from '@perspectra/providers/activities'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities } from './map-activity.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'
import { addRpgEffectsExample } from '../../../../tests/support/rpg-effects-fixture.ts'

type Json = Record<string, any>
const player = 'character:player'
function fixture(edit: (config: Json) => void = () => {}) {
  const raw = referenceJson()
  addRpgEffectsExample(raw)
  edit(raw)
  const config = parseRpgConfig(raw, referencePack)
  const entry = generateMapActivities(config, { names: { [player]: '玩家' } })[0]!
  const activity = new NativeActivity(entry)
  const world = {
    locationId: 'location:ruin-1',
    arrivedAtSeq: 1,
    characterIds: [player],
    items: { current: [], lastObserved: [] },
  }
  const truth: Json = {
    public: {},
    characters: { [player]: { 'rpg-hp': 40, 'rpg-hp-max': 40, 'rpg-mp': 100, 'rpg-mp-max': 100, 'rpg-equipment': {} } },
  }
  let game = activity.initialize({ npcIds: [], world, truth, previous: null }, Math.random) as Json
  let revision = 1
  return {
    get game() {
      return game
    },
    step(skill?: string, target = '玩家', operation = skill ? 'skill' : 'guard') {
      const before = JSON.stringify(game)
      const result = activity.resolve(
        { id: 'activity:1', revision, game } as never,
        player,
        operation,
        skill ? { skill, target } : {},
        world,
        truth as never,
      ) as Json
      if (result.rejectReason) {
        expect(JSON.stringify(game)).toBe(before)
        return result
      }
      game = result.game
      revision++
      for (const row of result.status?.changes ?? []) truth.characters[row.holderId][row.key] = row.value
      return result
    },
  }
}

it('shields absorb overflow, replace rather than stack, break and expire only after valid holder actions', () => {
  const f = fixture()
  f.step('护盾术')
  expect(f.game.internal.shields).toEqual([{ unitId: player, amount: 4, remaining: 2 }])
  expect(f.game.public.units[0].hp).toBe(40)
  const before = structuredClone(f.game)
  expect(f.step('护盾术', '遗迹守卫').rejectReason).toBeTruthy()
  expect(f.game).toEqual(before)
  f.step('护盾术')
  expect(f.game.internal.shields[0]).toMatchObject({ amount: 4, remaining: 2 })
  f.step('普通攻击', '遗迹守卫')
  expect(f.game.internal.shields).toEqual([])
  expect(f.game.public.units[0].hp).toBe(36)
  const quiet = fixture(c => {
    c.enemies.golem.skills = []
    c.skills.find((s: Json) => s.id === 'ward').effects[0].turns = 1
  })
  quiet.step('护盾术')
  expect(quiet.game.internal.shields[0].remaining).toBe(1)
  quiet.step()
  expect(quiet.game.internal.shields).toEqual([])
})

it('runs non-fire periodic damage and healing after the holder acts, refreshes, caps healing and clears on retreat', () => {
  const f = fixture(c => {
    c.enemies.golem.skills = []
  })
  f.step('侵蚀术', '遗迹守卫')
  expect(f.game.public.units.find((u: Json) => u.id === 'golem').hp).toBe(46)
  expect(f.game.internal.conditions[0].remaining).toBe(2)
  f.step('侵蚀术', '遗迹守卫')
  expect(f.game.internal.conditions).toEqual([{ unitId: 'golem', statusId: 'venom', remaining: 2 }])
  f.step('再生术')
  expect(f.game.public.units[0].hp).toBe(40)
  expect(f.game.internal.conditions.find((s: Json) => s.unitId === player).remaining).toBe(2)
  f.step(undefined, '玩家', 'flee')
  expect(f.game.internal.conditions).toEqual([])
  expect(f.game.internal.shields).toEqual([])
})

it('DoT bypasses one-shot guard but consumes shields before HP, and healing ticks restore HP', () => {
  const f = fixture(c => {
    c.combatStatuses.rot = {
      name: '腐蚀',
      turns: 3,
      tick: { kind: 'damage', amount: 6 },
      timing: 'after-action',
      polarity: 'negative',
    }
    c.skills.find((s: Json) => s.id === 'strike').effects.push({ kind: 'status', status: 'rot' })
  })
  f.step('护盾术') // enemy hit: shield 4, rot awaits holder action
  f.step() // rot 6 absorbs 4 and hurts 2; guard still halves enemy's 8
  expect(f.game.public.units[0].hp).toBe(34)
  expect(f.game.internal.shields).toEqual([])
  const healing = fixture()
  healing.step() // guarded 4 damage
  healing.step('再生术') // 36 -> 40 then enemy hit 8
  expect(healing.game.public.units[0].hp).toBe(32)
  expect(healing.game.public.lastResult).toContain('再生恢复生命')
})

it('settles lethal periodic damage and clears all effects at victory or defeat', () => {
  const win = fixture(c => {
    c.enemies.golem.hp = 4
    c.enemies.golem.skills = []
  })
  win.step('护盾术')
  win.step('侵蚀术', '遗迹守卫')
  expect(win.game.public.cleared).toBe(true)
  expect(win.game.internal).toMatchObject({ conditions: [], shields: [] })
  const lose = fixture(c => {
    c.skills.find((s: Json) => s.id === 'strike').effects[0].amount = 100
  })
  lose.step('再生术')
  expect(lose.game.phase).toBe('defeat')
  expect(lose.game.internal).toMatchObject({ conditions: [], shields: [] })
})

it('accepts only the new format and rejects legacy or executable effect declarations', () => {
  const raw = referenceJson() as Json
  raw.combatStatuses = {
    burn: {
      name: '燃烧',
      turns: 3,
      timing: 'after-action',
      polarity: 'negative',
      tick: { kind: 'damage', amount: 3, element: 'fire' },
    },
  }
  expect(parseRpgConfig(raw, referencePack).combatStatuses.burn).toEqual(raw.combatStatuses.burn)
  raw.combatStatuses.burn.damage = 3
  expect(() => parseRpgConfig(raw, referencePack)).toThrow('不认识的字段')
  delete raw.combatStatuses
  addRpgEffectsExample(raw)
  raw.skills.at(-1).effects = [{ kind: 'script', code: 'throw 1' }]
  expect(() => parseRpgConfig(raw, referencePack)).toThrow('damage/heal/status/shield')
})

it('enemy effect skills execute against their declared side, including damage and self shields', () => {
  const attack = fixture(c => {
    c.skills.push({
      id: 'enemy-effect',
      name: '冲击',
      target: 'opponent',
      effects: [...[{ kind: 'damage', amount: 8 }]],
    })
    c.enemies.golem.skills = ['enemy-effect']
  })
  attack.step()
  expect(attack.game.public.units[0].hp).toBe(36)
  const shield = fixture(c => {
    c.skills.push({
      id: 'enemy-ward',
      name: '守卫护盾',
      target: 'self',
      effects: [...[{ kind: 'shield', amount: 10, turns: 1 }]],
    })
    c.enemies.golem.skills = ['enemy-ward']
  })
  shield.step()
  expect(shield.game.internal.shields).toEqual([{ unitId: 'golem', amount: 10, remaining: 1 }])
  shield.step('普通攻击', '遗迹守卫')
  expect(shield.game.public.units.find((u: Json) => u.id === 'golem').hp).toBe(50)
  expect(shield.game.public.lastResult).toContain('护盾吸收 8')
  // Reapplying on its own action replaces the remaining amount, never adds it.
  expect(shield.game.internal.shields[0].amount).toBe(10)
})

it('a shield granted by someone else counts the holder next valid action, including automatic enemy turns', () => {
  const f = fixture(c => {
    c.enemies.golem.skills = []
    const ward = c.skills.find((skill: Json) => skill.id === 'ward')
    ward.target = 'opponent'
    ward.effects[0].turns = 1
  })
  f.step('护盾术', '遗迹守卫')
  expect(f.game.internal.shields).toEqual([])
  expect(f.game.public.lastResult).toContain('护盾到期')
})

it('uses freshly applied armor modifiers within the same multi-effect action and refreshes without stacking', () => {
  const f = fixture(c => {
    c.enemies.golem.skills = []
    c.combatStatuses.fracture = {
      name: '破甲',
      turns: 3,
      timing: 'after-action',
      polarity: 'negative',
      modifiers: { defense: -3 },
    }
    c.skills.push({
      id: 'sunder',
      name: '破甲击',
      target: 'opponent',
      cost: { mp: 3 },
      effects: [
        { kind: 'status', status: 'fracture' },
        { kind: 'damage', amount: 8 },
      ],
    })
    c.characters[player].skills.push('sunder')
  })
  f.step('破甲击', '遗迹守卫')
  expect(f.game.public.units.find((u: Json) => u.id === 'golem').hp).toBe(40)
  expect(f.game.public.units[0].stats.mp).toBe(97)
  f.step('破甲击', '遗迹守卫')
  expect(f.game.internal.conditions).toEqual([{ unitId: 'golem', statusId: 'fracture', remaining: 2 }])
  expect(f.game.public.units[0].stats.mp).toBe(94)
})

it('keeps round-end bonuses through enemy action, then expires simultaneous modifiers at the boundary', () => {
  const f = fixture(c => {
    c.combatStatuses.attack = {
      name: '攻击提升',
      turns: 1,
      timing: 'round-end',
      polarity: 'positive',
      modifiers: { attack: 3 },
    }
    c.combatStatuses.defense = {
      name: '防御提升',
      turns: 1,
      timing: 'round-end',
      polarity: 'positive',
      modifiers: { defense: 3 },
    }
    c.skills.push({
      id: 'boost',
      name: '振奋',
      target: 'self',
      effects: [
        { kind: 'status', status: 'attack' },
        { kind: 'status', status: 'defense' },
      ],
    })
    c.characters[player].skills.push('boost')
  })
  expect(f.step('振奋', '遗迹守卫').rejectReason).toBeTruthy()
  f.step('振奋')
  expect(f.game.public.units[0].hp).toBe(35)
  expect(f.game.internal.conditions).toEqual([])
  expect(f.game.public.lastResult).toContain('攻击提升结束')
  expect(f.game.public.lastResult).toContain('防御提升结束')
  f.step('普通攻击', '遗迹守卫')
  expect(f.game.public.units.find((u: Json) => u.id === 'golem').hp).toBe(42)
})

it('cleanses negatives in declared order, preserves positive statuses and does not tick removed states', () => {
  const f = fixture(c => {
    c.enemies.golem.skills = []
    c.combatStatuses.poison = {
      name: '毒',
      turns: 2,
      timing: 'after-action',
      polarity: 'negative',
      tick: { kind: 'damage', amount: 8 },
    }
    c.combatStatuses.boost = {
      name: '提升',
      turns: 2,
      timing: 'after-action',
      polarity: 'positive',
      modifiers: { attack: 2 },
    }
    c.skills.push({
      id: 'clean',
      name: '洗净',
      target: 'self',
      effects: [
        { kind: 'status', status: 'poison' },
        { kind: 'status', status: 'boost' },
        { kind: 'cleanse', polarity: 'negative' },
      ],
    })
    c.characters[player].skills.push('clean')
  })
  f.step('洗净')
  expect(f.game.public.units[0].hp).toBe(40)
  expect(f.game.internal.conditions).toEqual([{ unitId: player, statusId: 'boost', remaining: 1 }])
})

it('bounds lifecycle and modifier declarations and refuses obsolete skill formats', () => {
  for (const edit of [
    (c: Json) => {
      c.skills[0].power = 8
    },
    (c: Json) => {
      c.skills[0].target = 'enemy'
    },
    (c: Json) => {
      c.combatStatuses.x = {
        name: 'X',
        turns: 100,
        timing: 'after-action',
        polarity: 'negative',
        modifiers: { defense: -1 },
      }
    },
    (c: Json) => {
      c.combatStatuses.x = {
        name: 'X',
        turns: 1,
        timing: 'arbitrary',
        polarity: 'negative',
        modifiers: { defense: -1 },
      }
    },
    (c: Json) => {
      c.combatStatuses.x = {
        name: 'X',
        turns: 1,
        timing: 'after-action',
        polarity: 'negative',
        modifiers: { defense: -1001 },
      }
    },
  ])
    expect(() => fixture(edit)).toThrow()
})
