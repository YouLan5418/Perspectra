import { expect, it } from 'vitest'
import Ajv from 'ajv'
import { NativeActivity } from '@perspectra/providers/activities'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities } from './map-activity.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'
import { addRpgValuesExample } from '../../../../tests/support/rpg-values-fixture.ts'
import schema from './config-schema.json' with { type: 'json' }
type Json = Record<string, any>
const player = 'character:player'
function fixture(edit: (c: Json) => void = () => {}) {
  const raw = referenceJson()
  addRpgValuesExample(raw)
  edit(raw)
  const config = parseRpgConfig(raw, referencePack),
    activity = new NativeActivity(generateMapActivities(config, { names: { [player]: '玩家' } })[0]!)
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
  let game = activity.initialize({ npcIds: [], world, truth, previous: null }, () => 0.5) as Json,
    revision = 1
  return {
    get game() {
      return game
    },
    step(skill: string, target = '遗迹守卫') {
      const result = activity.resolve(
        { id: 'activity:1', revision, game } as never,
        player,
        'skill',
        { skill, target },
        world,
        truth as never,
      ) as Json
      if (!result.rejectReason) {
        game = result.game
        revision++
        for (const row of result.status?.changes ?? []) truth.characters[row.holderId][row.key] = row.value
      }
      return result
    },
  }
}
it('keeps independent bounded resources, rejects insufficient costs, charges once, and only triggers on positive-to-zero', () => {
  const f = fixture(),
    initial = structuredClone(f.game)
  expect(f.step('怒击').rejectReason).toContain('怒气不足')
  expect(f.game).toEqual(initial)
  f.step('压制')
  expect(f.game.internal.values.units[player].rage).toBe(3)
  expect(f.game.internal.values.units.golem.posture).toBe(2)
  f.step('压制')
  expect(f.game.internal.values.units[player].rage).toBe(6)
  expect(f.game.internal.values.units[player].posture).toBe(4)
  expect(f.game.internal.conditions.find((s: Json) => s.statusId === 'broken').remaining).toBe(2)
  f.step('怒击')
  expect(f.game.internal.values.units[player].rage).toBe(4)
  expect(f.game.internal.conditions.find((s: Json) => s.statusId === 'broken').remaining).toBe(1)
  f.step('压制')
  expect(f.game.internal.conditions.some((s: Json) => s.statusId === 'broken')).toBe(false)
  expect(f.game.internal.values.units.golem.posture).toBe(0)
  const before = structuredClone(f.game)
  expect(f.step('怒击', '玩家').rejectReason).toBeTruthy()
  expect(f.game).toEqual(before)
})
it('shared rain writes and custom resistance/temporary attributes actually change damage', () => {
  const run = (edit: (c: Json) => void, prepare?: string) => {
    const f = fixture(c => {
      c.enemies.golem.skills = []
      edit(c)
    })
    if (prepare) f.step(prepare, '玩家')
    const before = f.game.public.units.find((u: Json) => u.id === 'golem').hp
    f.step('雨中火球')
    return before - f.game.public.units.find((u: Json) => u.id === 'golem').hp
  }
  const dry = run(c => {
    c.battleValues.shared.rain.initial = 1
    c.enemies.golem.battleValues.attributes['heat-resist'] = 0
  })
  const wet = run(c => {
    c.enemies.golem.battleValues.attributes['heat-resist'] = 0
  }, '唤雨')
  const resistant = run(() => {})
  expect(wet).toBeLessThan(dry)
  expect(resistant).toBeLessThan(dry)
  const f = fixture(c => {
    c.enemies.golem.skills = ['rainfire']
  })
  f.step('隔热术', '玩家')
  expect(f.game.public.battleValues.units.find((u: Json) => u.unitId === player).attributes[0].value).toBe(25)
  const protectedHp = f.game.public.units[0].hp
  const no = fixture(c => {
    c.enemies.golem.skills = ['rainfire']
    c.combatStatuses.insulated.attributeModifiers['heat-resist'] = 0
  })
  no.step('隔热术', '玩家')
  expect(protectedHp).toBeGreaterThan(no.game.public.units[0].hp)
  f.step('唤雨', '玩家')
  f.step('唤雨', '玩家')
  expect(f.game.public.battleValues.units.find((u: Json) => u.unitId === player).attributes[0].value).toBe(0)
  expect(f.game.internal.values.shared.rain).toBe(5)
})
it('conditions reject without mutations; shields prevent HP-loss resource gains; all-target actor/shared writes and cost happen once', () => {
  const f = fixture(c => {
    c.battleValues.shared.rain.initial = 0
  })
  const before = structuredClone(f.game)
  expect(f.step('雨中火球').rejectReason).toContain('条件')
  expect(f.game).toEqual(before)
  f.step('炽热护盾', '玩家')
  expect(f.game.internal.values.units[player].rage).toBe(0)
  const all = fixture(c => {
    c.enemies.extra = { ...structuredClone(c.enemies.golem), name: '另一个守卫', skills: [] }
    c.maps[0].enemies.push('extra')
    c.enemies.golem.skills = []
    c.characters[player].battleValues = { resources: { rage: 10 } }
    c.skills.push({
      id: 'all',
      name: '全体试验',
      target: 'opponent',
      scope: 'all',
      resourceCost: { rage: 5 },
      effects: [
        { kind: 'value', scope: 'shared', key: 'rain', delta: 1 },
        { kind: 'value', scope: 'actor', key: 'posture', delta: -1 },
        { kind: 'value', scope: 'target', key: 'posture', delta: -1 },
      ],
    })
    c.characters[player].skills.push('all')
  })
  all.step('全体试验')
  expect(all.game.internal.values.shared.rain).toBe(3)
  expect(all.game.internal.values.units[player]).toEqual({ rage: 5, posture: 3 })
  expect(all.game.internal.values.units.golem.posture).toBe(3)
  expect(all.game.internal.values.units.extra.posture).toBe(3)
})
it('validates declarations, scope, cross-references, limits and restricted writes in compiler/runtime', () => {
  const validate = new Ajv({ strict: true }).compile(schema),
    raw = referenceJson()
  addRpgValuesExample(raw)
  expect(validate(raw), JSON.stringify(validate.errors)).toBe(true)
  expect(() => parseRpgConfig(raw, referencePack)).not.toThrow()
  for (const edit of [
    (c: Json) => {
      c.battleValues.resources.rage.min = 1
    },
    (c: Json) => {
      c.battleValues.shared.rain.max = 10000
    },
    (c: Json) => {
      c.skills.at(-1).effects = [{ kind: 'value', scope: 'world', key: 'rain', delta: 1 }]
    },
    (c: Json) => {
      c.skills.at(-1).requires = [{ value: { scope: 'target', kind: 'resource', key: 'rage' }, atLeast: 1 }]
    },
    (c: Json) => {
      c.combatStatuses.insulated.attributeModifiers['heat-resist'] = 1001
    },
  ]) {
    const c = structuredClone(raw)
    edit(c)
    expect(validate(c)).toBe(false)
    expect(() => parseRpgConfig(c, referencePack)).toThrow()
  }
  for (const edit of [
    (c: Json) => {
      c.battleValues.shared.rain.initial = 6
    },
    (c: Json) => {
      c.battleValues.resources.posture.onZeroStatus = 'missing'
    },
    (c: Json) => {
      c.skills.at(-1).resourceCost = { missing: 1 }
    },
    (c: Json) => {
      c.skills.at(-1).resourceCost = { rage: 11 }
    },
    (c: Json) => {
      c.skills.at(-1).effects = [{ kind: 'value', scope: 'target', key: 'heat-resist', delta: 1 }]
    },
    (c: Json) => {
      c.characters[player].battleValues = { resources: { rage: 11 } }
    },
    (c: Json) => {
      c.skills.at(-1).effects = [{ kind: 'damage', amount: 3, resistance: 'missing' }]
    },
  ]) {
    const c = structuredClone(raw)
    edit(c)
    expect(() => parseRpgConfig(c, referencePack)).toThrow()
  }
})

it('finishes actor/shared writes after lethal damage, once even for an all-target victory', () => {
  for (const scope of ['one', 'all']) {
    const f = fixture(c => {
      c.enemies.golem.hp = 1
      c.enemies.golem.skills = []
      if (scope === 'all') {
        c.enemies.extra = { ...structuredClone(c.enemies.golem), name: '另一个守卫' }
        c.maps[0].enemies.push('extra')
      }
      c.skills.push({
        id: 'finisher',
        name: '终结数值',
        target: 'opponent',
        scope,
        effects: [
          { kind: 'damage', amount: 999 },
          { kind: 'value', scope: 'shared', key: 'rain', delta: 1 },
          { kind: 'value', scope: 'actor', key: 'rage', delta: 2 },
          { kind: 'value', scope: 'target', key: 'posture', delta: -1 },
        ],
      })
      c.characters[player].skills.push('finisher')
    })
    f.step('终结数值')
    expect(f.game.public.cleared).toBe(true)
    expect(f.game.internal.values.shared.rain).toBe(3)
    expect(f.game.internal.values.units[player].rage).toBe(2)
    expect(f.game.internal.values.units.golem.posture).toBe(4)
  }
})
it('cost-to-zero applies its status once, replenishment permits a later distinct zero transition', () => {
  const f = fixture(c => {
    c.enemies.golem.skills = []
    c.characters[player].battleValues = { resources: { posture: 4 } }
    c.skills.push(
      {
        id: 'spend',
        name: '消耗架势',
        target: 'self',
        resourceCost: { posture: 4 },
        effects: [{ kind: 'value', scope: 'actor', key: 'rage', delta: 1 }],
      },
      {
        id: 'restore',
        name: '恢复架势',
        target: 'self',
        effects: [{ kind: 'value', scope: 'actor', key: 'posture', delta: 4 }],
      },
    )
    c.characters[player].skills.push('spend', 'restore')
  })
  f.step('消耗架势', '玩家')
  expect(f.game.internal.conditions.find((s: Json) => s.statusId === 'broken').remaining).toBe(2)
  const before = structuredClone(f.game)
  expect(f.step('消耗架势', '玩家').rejectReason).toBeTruthy()
  expect(f.game).toEqual(before)
  f.step('恢复架势', '玩家')
  expect(f.game.internal.values.units[player].posture).toBe(4)
  f.step('消耗架势', '玩家')
  expect(f.game.internal.conditions.find((s: Json) => s.statusId === 'broken').remaining).toBe(2)
})
