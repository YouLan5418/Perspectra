import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { brandId, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { CharacterViewBuilder, WorldStore } from '@perspectra/core/store'
import { openRpgFixture, openRpgWorld, type RpgFixture, type RpgFixtureOptions } from '../support/rpg-fixture.ts'
import { restoreStoryNode } from '../../apps/host/src/story-nodes.ts'

// The default player frontend sends a battle button as a world action (`runtime.perform` → `/act interact`), not
// through `activityAction`. Its result may move the party home; those at home see them arrive and nothing else.

const PLAYER = 'character:player',
  CHENG = 'character:cheng',
  ARU = 'character:aru'
const HOME = 'location:living-room',
  RUIN1 = 'location:ruin-1'
type Json = Record<string, any>
const data = (event: { data: unknown }) => event.data as Json

const open: RpgFixture[] = []
afterEach(async () => {
  for (const f of open.splice(0)) await f.close()
})
async function fixture(config: NonNullable<RpgFixtureOptions['config']>, decide?: RpgFixtureOptions['decide']) {
  const f = await openRpgFixture({ places: { [CHENG]: RUIN1 }, config, ...(decide ? { decide } : {}) })
  open.push(f)
  return f
}
const observed = (f: RpgFixture, observerId: string, from: number) => {
  const store = new WorldStore(join(f.data, 'world.sqlite'))
  try {
    const view = new CharacterViewBuilder(store).rebuildAt(
      f.runtime.address,
      brandId(observerId, 'CharacterId'),
      store.head(f.runtime.address).headSeq,
    )
    return view.observations.filter(o => o.sourceSeq > from).map(o => (o.value as WorldJsonObject).content as Json)
  } finally {
    store.close()
  }
}
/** The battle button for `operation`, as the default frontend performs it on the player's turn. */
function battle(f: RpgFixture) {
  return data(f.events().findLast(e => e.eventType === 'activity.updated' && data(e).activityKey === 'rpg-map-ruin-1')!)
    .state as Json
}
async function press(f: RpgFixture, operation: string, extra: Json = {}) {
  const state = battle(f)
  expect(state.game.turn).toBe(PLAYER)
  await f.runtime.perform({
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'character', id: PLAYER },
      bindingId: state.id,
      definitionRef: { id: 'activity:' + operation, version: 1 },
      arguments: { activityId: state.id, revision: state.revision, ...extra },
    },
  })
}

it.each([
  { held: true, hp: 32, afterBurn: 30 },
  { held: false, hp: 29, afterBurn: 26 },
])('uses current equipment custody during another character’s turn (held=$held)', async ({ held, hp, afterBurn }) => {
  const f = await fixture(
    c => {
      c.maps[0].scripted = []
      c.combatStatuses = { burn: { name: '灼烧', turns: 3, damage: 3, element: 'fire' } }
      c.characters[PLAYER].defense = 3
      c.equipment['entity:iron-sword'] = { slot: 'weapon', resistances: { fire: 20 } }
      c.skills.push({
        id: 'golem-fire',
        name: '守卫火球',
        kind: 'damage',
        scope: 'all',
        power: 10,
        element: 'fire',
        inflicts: 'burn',
      })
      c.enemies.golem.attack = 4
      c.enemies.golem.skills = ['golem-fire']
    },
    input => {
      const activity = (input.context as Json).activity
      if (input.continuation || activity?.game.turn !== CHENG) return { decision: 'abstain' }
      return {
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'character', id: CHENG },
          bindingId: activity.id,
          definitionRef: { id: 'activity:guard', version: 1 },
          arguments: { activityId: activity.id, revision: activity.revision },
        },
      }
    },
  )
  await f.runtime.submit('/status take@entity:iron-sword {}')
  await f.runtime.submit('/status rpg-equip@entity:iron-sword {}')
  if (!held) await f.runtime.submit('/status drop@entity:iron-sword {}')
  await f.move(RUIN1)
  const from = f.events().at(-1)!.seq
  await press(f, 'skill', { skill: '普通攻击', target: '遗迹守卫' })
  expect(battle(f).game.public.units.find((unit: Json) => unit.id === PLAYER).hp).toBe(hp)
  expect(battle(f).game.public['状态']).toContain('灼烧（剩余 3 回合）')
  const before = battle(f)
  await f.runtime.submit('澄，先稳住。')
  expect(battle(f)).toEqual(before)
  await expect(press(f, 'skill', { skill: '普通攻击', target: '玩家' })).rejects.toThrow()
  expect(battle(f)).toEqual(before)
  await press(f, 'guard')
  const results = observed(f, PLAYER, from)
    .map(row => row.resultDescription)
    .join(' ')
  expect(results).toContain(`灼烧造成 ${hp - afterBurn} 点伤害，玩家生命 ${hp} → ${afterBurn}`)
  expect(JSON.stringify(observed(f, ARU, from))).not.toMatch(/灼烧|守卫火球/u)
  const chengInputs = f.inputs.filter(input => (input.context as Json).activity)
  expect(chengInputs.length).toBeGreaterThan(0)
  expect(JSON.stringify(chengInputs)).not.toMatch(/participantHeldItems|iron-sword/u)
})

it('restores remaining burn turns in a story branch and commits its killing tick with loot', async () => {
  const f = await fixture(c => {
    delete c.characters[CHENG]
    for (const map of c.maps) map.scripted = []
    c.combatStatuses = { burn: { name: '灼烧', turns: 3, damage: 3, element: 'fire' } }
    Object.assign(
      c.skills.find((skill: Json) => skill.id === 'fire'),
      { element: 'fire', inflicts: 'burn', power: 10 },
    )
    c.enemies.golem.skills = []
    c.enemies.golem.hp = 19
  })
  await f.move(RUIN1)
  await press(f, 'skill', { skill: '火球术', target: '遗迹守卫' })
  const initial = battle(f)
  expect(initial.game.internal.conditions).toEqual([{ unitId: 'golem', statusId: 'burn', remaining: 2 }])
  const node = await f.runtime.saveNode('灼烧中')
  const forkDir = join(f.data, '..', 'burn-branch')
  restoreStoryNode(f.data, node.id, forkDir, node.packHash)
  const fork = await openRpgWorld(f.pack, forkDir)
  try {
    expect(battle(fork)).toEqual(initial)
    for (const line of [f, fork]) {
      await press(line, 'guard')
      expect(battle(line).game.internal.conditions[0].remaining).toBe(1)
      await press(line, 'guard')
      const events = line.events()
      const victory = events.findLast(e => e.eventType === 'activity.updated')!
      expect(battle(line).game).toMatchObject({ phase: 'victory', internal: { conditions: [] } })
      const drops = events.filter(e => e.eventType === 'entity.transferred' && data(e).entityId === 'entity:iron-key')
      expect(drops.map(e => e.transactionId)).toEqual([victory.transactionId])
      expect(data(victory).description).toContain('灼烧造成 3 点伤害')
    }
  } finally {
    await fork.close()
  }
})
/** Both came home in the action's commit, and Ah-Ru, who stayed there, sees only that they arrived. */
function expectOnlyArrivals(f: RpgFixture, from: number) {
  const moved = f.events().filter(e => e.seq > from && e.eventType === 'character.moved')
  expect(moved.map(e => [data(e).characterId, data(e).toLocationId])).toEqual([
    [PLAYER, HOME],
    [CHENG, HOME],
  ])
  const seen = observed(f, ARU, from)
  expect(seen.map(o => [o.actorId, o.actionType]).sort()).toEqual([
    [CHENG, 'moved'],
    [PLAYER, 'moved'],
  ])
  for (const o of seen)
    expect(o).toEqual({
      actorId: o.actorId,
      actionType: 'moved',
      status: 'accepted',
      movement: { characterId: o.actorId, toLocationId: HOME },
    })
  // The player knows her own route home.
  expect(observed(f, PLAYER, from).filter(o => o.actorId === PLAYER && o.actionType === 'moved')).toEqual([
    expect.objectContaining({ movement: { characterId: PLAYER, fromLocationId: RUIN1, toLocationId: HOME } }),
  ])
}

it('a defeat on the player turn sent as a world action tells those at home only that the party arrived', async () => {
  const f = await fixture(c => {
    c.maps[0].scripted = []
    c.skills.push({ id: 'quake', name: '震地', kind: 'damage', scope: 'all', power: 100, cost: {} })
    c.enemies.golem.skills = ['quake']
    c.enemies.golem.speed = 25
  })
  await f.move(RUIN1)
  const from = f.events().at(-1)!.seq
  await press(f, 'guard')
  expectOnlyArrivals(f, from)
  expect(JSON.stringify(observed(f, ARU, from))).not.toMatch(/遗迹守卫|震地|生命|战斗|防御/u)
})

// Real-model play 2026-11-08: the winning blow's loot drop was shown to the player as "铁钥匙 已解除个人保管，留在
// 当前场所" in place of the victory text, and every witness's record said the player moved the key out of the vault.
it('a victory loot drop is not the player putting the item down, and nobody learns the hidden store', async () => {
  const f = await fixture(c => {
    c.maps[0].scripted = []
    c.enemies.golem.hp = 1
  })
  await f.move(RUIN1)
  const from = f.events().at(-1)!.seq
  await press(f, 'skill', { skill: '普通攻击', target: '遗迹守卫' })
  const dropped = f.events().find(e => e.seq > from && e.eventType === 'entity.transferred')
  expect(data(dropped!)).toMatchObject({ entityId: 'entity:iron-key', toLocationId: RUIN1 })
  for (const observer of [PLAYER, CHENG]) {
    const seen = observed(f, observer, from)
    expect(seen.some(o => typeof o.resultDescription === 'string' && o.resultDescription.includes('战斗胜利'))).toBe(
      true,
    )
    expect(seen.some(o => o.interaction !== undefined)).toBe(false)
    expect(JSON.stringify(seen)).not.toContain('location:vault')
  }
  const transcript = (await f.runtime.state()).transcript.filter(line => line.seq > from).map(line => line.text)
  expect(transcript.some(text => text.includes('战斗胜利'))).toBe(true)
  expect(transcript.some(text => text.includes('解除个人保管'))).toBe(false)
})

it('fleeing back sent as a world action tells those at home only that the party arrived', async () => {
  const f = await fixture(c => {
    c.maps[0].scripted = []
    c.retreat = 'back'
  })
  await f.move(RUIN1)
  const from = f.events().at(-1)!.seq
  await press(f, 'flee')
  expectOnlyArrivals(f, from)
  expect(JSON.stringify(observed(f, ARU, from))).not.toMatch(/撤退|遗迹守卫|战斗/u)
})
