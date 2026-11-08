import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { openRpgFixture, type RpgFixture, type RpgFixtureOptions } from '../support/rpg-fixture.ts'

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
async function fixture(config: NonNullable<RpgFixtureOptions['config']>) {
  const f = await openRpgFixture({ places: { [CHENG]: RUIN1 }, config })
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
async function press(f: RpgFixture, operation: string) {
  const state = data(
    f.events().findLast(e => e.eventType === 'activity.updated' && data(e).activityKey === 'rpg-map-ruin-1')!,
  ).state as Json
  expect(state.game.turn).toBe(PLAYER)
  await f.runtime.perform({
    actionType: 'interact',
    parameters: {
      targetRef: { kind: 'character', id: PLAYER },
      bindingId: state.id,
      definitionRef: { id: 'activity:' + operation, version: 1 },
      arguments: { activityId: state.id, revision: state.revision },
    },
  })
}
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
