import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { brandId, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { CharacterViewBuilder, WorldStore } from '@perspectra/core/store'
import { openRpgFixture, type RpgFixture, type RpgFixtureOptions } from '../support/rpg-fixture.ts'

const PLAYER = 'character:player',
  CHENG = 'character:cheng',
  ARU = 'character:aru'
const HOME = 'location:living-room',
  RUIN1 = 'location:ruin-1',
  RUIN2 = 'location:ruin-2'

const open: RpgFixture[] = []
afterEach(async () => {
  for (const f of open.splice(0)) await f.close()
})
async function fixture(options: RpgFixtureOptions = {}) {
  const f = await openRpgFixture({ places: { [CHENG]: RUIN1 }, ...options })
  open.push(f)
  return f
}
type Json = Record<string, any>
const data = (event: { data: unknown }) => event.data as Json
const updates = (f: RpgFixture, key: string) =>
  f.events().filter(e => e.eventType === 'activity.updated' && data(e).activityKey === key)
const latest = (f: RpgFixture, key: string) => data(updates(f, key).at(-1)!).state as Json
/** What the observer was told, as plain text, from sequence `from` on. */
const observed = (f: RpgFixture, observerId: string, from = 0) => {
  const store = new WorldStore(join(f.data, 'world.sqlite'))
  try {
    const view = new CharacterViewBuilder(store).rebuildAt(
      f.runtime.address,
      brandId(observerId, 'CharacterId'),
      store.head(f.runtime.address).headSeq,
    )
    return view.observations.filter(o => o.sourceSeq >= from).map(o => (o.value as WorldJsonObject).content as Json)
  } finally {
    store.close()
  }
}
/** The player's battle action through the activity's own operation. */
const act = async (f: RpgFixture, operation: string, parameters: WorldJsonObject = {}) => {
  const state = latest(f, 'rpg-map-ruin-1')
  return f.runtime.activityAction({
    activityKey: 'rpg-map-ruin-1',
    activityId: state.id,
    revision: state.revision,
    operation,
    parameters,
    requestId: 'r-' + Math.random(),
  })
}
/** The model's answer for Cheng: on her battle turn, the given skill on the guard; otherwise abstain. */
const chengUses =
  (skill: string, target = '遗迹守卫') =>
  (input: WorldJsonObject) => {
    const context = input.context as Json
    const activity = context.activity as Json | undefined
    if (input.continuation || !activity || activity.game.turn !== CHENG || activity.game.phase === 'enter')
      return { decision: 'abstain' }
    return {
      decision: 'perform',
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'character', id: CHENG },
        bindingId: activity.id,
        definitionRef: { id: 'activity:skill', version: 1 },
        arguments: { activityId: activity.id, revision: activity.revision, skill, target },
      },
    }
  }

describe('RPG map activities', () => {
  it('entering ruin-1 shows the first narration and starts the battle; re-entering shows the again text', async () => {
    const f = await fixture({ config: c => (c.maps[0].scripted = []) })
    await f.move(RUIN1)
    const state = latest(f, 'rpg-map-ruin-1')
    expect(state.game).toMatchObject({ active: true, phase: 'fighting', turn: PLAYER })
    const started = data(updates(f, 'rpg-map-ruin-1')[0]!)
    expect(started.source).toMatchObject({ kind: 'cycle' })
    const narration = observed(f, PLAYER).map(o => JSON.stringify(o))
    expect(narration.some(text => text.includes('潮湿的石廊') && text.includes('擅入者，止步。'))).toBe(true)
    // Cheng was already here and reads the narration as a scene notice.
    expect(observed(f, CHENG).some(o => JSON.stringify(o).includes('潮湿的石廊'))).toBe(true)

    // Staying put does not restart it; leaving and coming back does, with the other text.
    await f.runtime.activityAction({
      activityKey: 'rpg-map-ruin-1',
      activityId: state.id,
      revision: state.revision,
      operation: 'flee',
      parameters: {},
      requestId: 'flee',
    })
    expect(latest(f, 'rpg-map-ruin-1').game.active).toBe(false)
    await f.runtime.submit('/act speak {"text":"先歇一下。"}')
    expect(updates(f, 'rpg-map-ruin-1').filter(e => data(e).source?.kind === 'cycle')).toHaveLength(1)
    await f.move(HOME)
    await f.move(RUIN1)
    const again = updates(f, 'rpg-map-ruin-1').filter(e => data(e).source?.kind === 'cycle')
    expect(again).toHaveLength(2)
    expect(JSON.stringify(observed(f, PLAYER, again[1]!.seq))).toContain('石廊里只剩守卫的残骸。')
  })

  it('a scripted encounter line makes Cheng cast fire with her line, and a scripted skill she cannot afford falls back to the model with the reason recorded', async () => {
    const f = await fixture()
    await f.move(RUIN1)
    const events = f.events()
    const fire = events.find(e => e.eventType === 'activity.updated' && data(e).actorId === CHENG)!
    expect(data(fire).description).toContain('澄使用火球术，遗迹守卫生命 50 → 36。')
    const line = events.find(e => e.eventType === 'character.speak' && data(e).characterId === CHENG)
    expect(line && line.seq > fire.seq).toBe(true)
    expect(JSON.stringify(line!.data)).toContain('小心，它的护甲很硬！')
    // Her decision and her line came from the author's script, not the model.
    expect(f.inputs.filter(input => (input.context as Json).activity)).toHaveLength(0)
    expect(latest(f, 'rpg-map-ruin-1').game).toMatchObject({ phase: 'fighting', turn: PLAYER })

    const poor = await fixture({
      config: c => (c.characters[CHENG].stats.mp = 0),
      decide: chengUses('普通攻击'),
    })
    await poor.move(RUIN1)
    const asked = poor.inputs.filter(input => (input.context as Json).activity)
    expect(asked.length).toBeGreaterThan(0)
    const results = updates(poor, 'rpg-map-ruin-1').map(e => String(data(e).state.game.public.lastResult))
    expect(results.some(text => text.includes('写死的技能不可用：魔力不足'))).toBe(true)
    expect(results.at(-1)).toContain('澄使用普通攻击')
    expect(latest(poor, 'rpg-map-ruin-1').game).toMatchObject({ phase: 'fighting', turn: PLAYER })
    expect(poor.events().some(e => e.eventType === 'character.speak' && data(e).characterId === CHENG)).toBe(false)
  })

  it('skips a fallen companion when opening a fight, including her encounter skill', async () => {
    const f = await fixture({
      config: c => {
        c.characters[CHENG].stats.hp = 0
        c.characters[CHENG].speed = 100
      },
    })
    await f.move(RUIN1)
    expect(latest(f, 'rpg-map-ruin-1').game).toMatchObject({ phase: 'fighting', turn: PLAYER })
    expect(f.inputs.filter(input => (input.context as Json).activity)).toHaveLength(0)
    await act(f, 'flee')
    expect(latest(f, 'rpg-map-ruin-1').game).toMatchObject({ active: false, phase: 'fled' })
  })

  it('records a scripted heal refused at full health and lets Cheng choose another action', async () => {
    const f = await fixture({
      config: c => {
        c.maps[0].scripted = [{ when: 'encounter', characterId: CHENG, skill: 'heal', say: '治疗一下。' }]
      },
      decide: chengUses('普通攻击'),
    })
    await f.move(RUIN1)
    const results = updates(f, 'rpg-map-ruin-1').map(e => String(data(e).description))
    expect(results.some(text => text.includes('写死的技能不可用：目标生命已满'))).toBe(true)
    expect(results.at(-1)).toContain('澄使用普通攻击')
    expect(latest(f, 'rpg-map-ruin-1').game).toMatchObject({ phase: 'fighting', turn: PLAYER })
    expect(
      f.events().some(e => e.eventType === 'character.speak' && JSON.stringify(e.data).includes('治疗一下。')),
    ).toBe(false)
  })

  it('victory drops the iron key on the floor and anyone can pick it up', async () => {
    const f = await fixture({
      config: c => {
        c.maps[0].scripted = []
        c.enemies.golem.hp = 5
      },
    })
    await f.move(RUIN1)
    await act(f, 'skill', { skill: '普通攻击', target: '遗迹守卫' })
    const state = latest(f, 'rpg-map-ruin-1')
    expect(state.game).toMatchObject({ active: false, phase: 'victory' })
    expect(state.game.public.lastResult).toContain('遗迹守卫说：「你们……终究还是来了。」')
    const update = f.events().findLast(e => e.eventType === 'activity.updated')!
    const drop = f.events().find(e => e.eventType === 'entity.transferred' && data(e).entityId === 'entity:iron-key')!
    expect(drop.transactionId).toBe(update.transactionId)
    expect(data(drop)).toMatchObject({ toHolderId: null, toLocationId: RUIN1 })
    // Both can reach it; the player takes it with the pack's own take.
    expect(JSON.stringify(f.runtime.characterAffordances(CHENG))).toContain('entity:iron-key')
    await f.runtime.submit('/status take@entity:iron-key {}')
    const taken = f.events().findLast(e => e.eventType === 'entity.transferred')!
    expect(data(taken)).toMatchObject({ entityId: 'entity:iron-key', toHolderId: PLAYER })
    // Coming back later: the guard stays beaten and nothing drops twice.
    await f.move(HOME)
    await f.move(RUIN1)
    expect(latest(f, 'rpg-map-ruin-1').game).toMatchObject({ active: false, phase: 'done' })
  })

  it('the ruin-2 potion lies on the floor and the first character to take it keeps it', async () => {
    // The iron door is not what this is about: open it.
    const f = await fixture({ places: { [CHENG]: RUIN2 }, config: c => delete c.maps[0].exits })
    await f.move(RUIN2)
    // Cheng's scripted line for entering plays, then the map activity ends and leaves the floor to everyone.
    const line = f.events().find(e => e.eventType === 'character.speak' && data(e).characterId === CHENG)
    expect(JSON.stringify(line?.data)).toContain('这里好像没人来过。')
    expect(latest(f, 'rpg-map-ruin-2').game).toMatchObject({ active: false, phase: 'done' })
    await f.runtime.submit('/status take@entity:potion-2 {}')
    const taken = f.events().findLast(e => e.eventType === 'entity.transferred')!
    expect(data(taken)).toMatchObject({ entityId: 'entity:potion-2', toHolderId: PLAYER })
    expect(JSON.stringify(f.runtime.characterAffordances(CHENG))).not.toContain('entity:potion-2')
  })

  it('defeat moves every participant home with hp 1; a party member who had left stays where she is and sees no battle detail', async () => {
    const f = await fixture({
      config: c => {
        c.maps[0].scripted = []
        c.skills.push({ id: 'quake', name: '震地', kind: 'damage', scope: 'all', power: 100, cost: {} })
        c.enemies.golem.skills = ['quake']
      },
      decide: chengUses('普通攻击'),
    })
    await f.move(RUIN1)
    const from = f.events().at(-1)!.seq
    // The player guards; Cheng's own turn ends in the guard's quake, which ends the battle on her turn.
    await act(f, 'guard')
    const state = latest(f, 'rpg-map-ruin-1')
    expect(state.game).toMatchObject({ active: false, phase: 'defeat' })
    const update = f.events().findLast(e => e.eventType === 'activity.updated')!
    expect(data(update).actorId).toBe(CHENG)
    const commit = f.events().filter(e => e.transactionId === update.transactionId)
    expect(
      commit.filter(e => e.eventType === 'character.moved').map(e => [data(e).characterId, data(e).toLocationId]),
    ).toEqual([
      [PLAYER, HOME],
      [CHENG, HOME],
    ])
    expect(commit.filter(e => e.eventType === 'scene.member_joined').map(e => data(e).characterId)).toEqual([
      PLAYER,
      CHENG,
    ])
    const status = commit.find(e => e.eventType === 'status.updated')!
    expect(data(status).changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ holderId: PLAYER, key: 'rpg-hp', value: 1 }),
        expect.objectContaining({ holderId: CHENG, key: 'rpg-hp', value: 1 }),
      ]),
    )
    expect((await f.runtime.state()).world.currentScene?.locationName).toBe('客厅')
    // Ah-Ru stayed home: she sees the two arrive, and nothing of the fight.
    const seen = observed(f, ARU, from)
    expect(seen.map(o => [o.actionType, o.actorId])).toEqual(
      expect.arrayContaining([
        ['moved', PLAYER],
        ['moved', CHENG],
      ]),
    )
    expect(JSON.stringify(seen)).not.toMatch(/遗迹守卫|震地|生命|战斗/u)
  })

  it('an item given away mid-dungeon no longer adds its attack', async () => {
    const strike = async (giveAway: boolean) => {
      const f = await fixture({ config: c => (c.maps[0].scripted = []) })
      await f.runtime.submit('/status take@entity:iron-sword {}')
      await f.runtime.submit('/status rpg-equip@entity:iron-sword {}')
      if (giveAway) await f.runtime.submit('/status give@entity:iron-sword {"recipientId":"character:aru"}')
      await f.move(RUIN1)
      await act(f, 'skill', { skill: '普通攻击', target: '遗迹守卫' })
      return String(
        data(f.events().findLast(e => e.eventType === 'activity.updated' && data(e).actorId === PLAYER)!).description,
      )
    }
    expect(await strike(false)).toContain('玩家使用普通攻击，遗迹守卫生命 50 → 39。')
    expect(await strike(true)).toContain('玩家使用普通攻击，遗迹守卫生命 50 → 42。')
  })

  it('her line follows only the scripted skill: once when it ends the battle, never after her own matching skill', async () => {
    const lines = (f: RpgFixture) =>
      f.events().filter(e => e.eventType === 'character.speak' && data(e).characterId === CHENG)
    // The scripted fire finishes the guard: the battle stays open for her line, then ends.
    const finishing = await fixture({ config: c => (c.enemies.golem.hp = 10) })
    await finishing.move(RUIN1)
    expect(lines(finishing).map(e => JSON.stringify(e.data))).toEqual([expect.stringContaining('小心，它的护甲很硬！')])
    expect(latest(finishing, 'rpg-map-ruin-1').game).toMatchObject({ active: false, phase: 'victory' })

    // The scripted fire leaves the guard standing; later her own fire ends the battle and nothing scripted follows.
    const own = await fixture({ config: c => (c.enemies.golem.hp = 28), decide: chengUses('火球术') })
    await own.move(RUIN1)
    expect(lines(own)).toHaveLength(1)
    await act(own, 'guard')
    const state = latest(own, 'rpg-map-ruin-1')
    expect(state.game).toMatchObject({ active: false, phase: 'victory' })
    expect(state.game.public.lastResult).toContain('澄使用火球术，遗迹守卫生命 14 → 0。')
    expect(lines(own)).toHaveLength(1)
  })

  it('a character knows her own battle numbers only in the dungeon, and they match the battle summary', async () => {
    const known = (input: WorldJsonObject, key: string) =>
      ((input.context as Json).knownStatus as Json[] | undefined)?.find(e => e.holderId === CHENG && e.key === key)
    const home = await fixture({ places: { [CHENG]: HOME }, config: c => (c.maps[0].scripted = []) })
    await home.runtime.submit('/act speak {"text":"澄，在吗？","scope":"scene_public"}')
    const atHome = home.inputs.filter(i => ((i.context as Json).character as Json).characterId === CHENG)
    expect(atHome.length).toBeGreaterThan(0)
    for (const input of atHome) expect(known(input, 'rpg-hp')).toBeUndefined()

    const f = await fixture({ config: c => (c.maps[0].scripted = []), decide: chengUses('普通攻击') })
    await f.move(RUIN1)
    await act(f, 'guard') // Cheng strikes; the guard then hits her, the lowest.
    await act(f, 'guard')
    const asked = f.inputs.filter(i => (i.context as Json).activity && !i.continuation)
    const last = asked.at(-1)!
    expect(known(last, 'rpg-hp')).toMatchObject({ value: 22, current: true })
    expect(((last.context as Json).activity as Json).game.public['队伍']).toContain('澄：生命 22/30')
  })
})
