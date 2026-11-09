import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { partyList, partyMembers, unlockedDoors } from '../../packages/official-rpg/src/rules.ts'
import { openRpgFixture, type RpgFixture, type RpgFixtureOptions } from '../support/rpg-fixture.ts'

const PLAYER = 'character:player',
  CHENG = 'character:cheng',
  ARU = 'character:aru'
const HOME = 'location:living-room',
  BEDROOM = 'location:bedroom',
  RUIN1 = 'location:ruin-1',
  RUIN2 = 'location:ruin-2'

const open: RpgFixture[] = []
afterEach(async () => {
  for (const f of open.splice(0)) await f.close()
})
async function fixture(options: RpgFixtureOptions = {}) {
  const f = await openRpgFixture(options)
  open.push(f)
  return f
}
type Json = Record<string, any>
const data = (event: { data: unknown }) => event.data as Json
const where = (f: RpgFixture, id: string) => currentLocation(f.events(), id)
const offered = (f: RpgFixture, id: string) => JSON.stringify(f.runtime.characterAffordances(id))
const statusAction = (operation: string) => ({
  decision: 'perform',
  actionType: 'interact',
  parameters: {
    targetRef: { kind: 'character', id: CHENG },
    bindingId: 'status',
    definitionRef: { id: 'status:' + operation, version: 1 },
    arguments: {},
  },
})
const moveAction = (locationId: string) => ({ decision: 'perform', actionType: 'move', parameters: { locationId } })
/** Cheng's answers on her own fresh turns, one each, in order; then she abstains. An answer given as a function
 * waits: she abstains until it returns something. */
const chengPlays = (...answers: unknown[]) => {
  const queue = [...answers]
  return (input: WorldJsonObject) => {
    const me = ((input.context as Json).character as Json).characterId
    if (me !== CHENG || input.continuation || !queue.length) return { decision: 'abstain' }
    const next = typeof queue[0] === 'function' ? (queue[0] as () => unknown)() : queue[0]
    if (next === undefined) return { decision: 'abstain' }
    queue.shift()
    return next
  }
}
const say = (f: RpgFixture, text: string) =>
  f.runtime.submit('/act speak ' + JSON.stringify({ text, scope: 'scene_public' }))
/** How the observer saw `mover` move, one entry per observed move. */
const seenMoves = (f: RpgFixture, observer: string, mover: string) => {
  const store = new WorldStore(join(f.data, 'world.sqlite'))
  try {
    return new CharacterViewBuilder(store)
      .rebuildAt(f.runtime.address, brandId(observer, 'CharacterId'), store.head(f.runtime.address).headSeq)
      .observations.map(entry => (entry.value as { content?: { movement?: Json } }).content?.movement)
      .filter(movement => movement?.characterId === mover)
  } finally {
    store.close()
  }
}

describe('RPG locked exits and party', () => {
  // Stage check 2026-11-08: "前往 遗迹宝库" was offered at home, so the loot could be taken before any fight.
  it('nobody is offered the vault or can walk into it', async () => {
    const f = await fixture()
    expect(offered(f, PLAYER)).not.toContain('location:vault')
    expect(offered(f, CHENG)).not.toContain('location:vault')
    const before = f.events().length
    await f.move('location:vault').catch(() => undefined)
    expect(where(f, PLAYER)).toBe(HOME)
    expect(
      f
        .events()
        .slice(before)
        .map(e => e.eventType),
    ).not.toContain('character.moved')
  })

  // Real-model play 2026-11-08: Cheng picked the key up, the player was refused at the door, and Cheng walked
  // through alone. The key changes the door's state instead: unlocked once, it lets anyone through.
  it('the iron door stays locked until someone unlocks it with the key, then lets anyone through', async () => {
    const unlock = {
      decision: 'perform',
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:iron-key' },
        bindingId: 'status',
        definitionRef: { id: 'status:rpg-unlock', version: 1 },
        arguments: {},
      },
    }
    let f!: RpgFixture
    f = await fixture({
      places: { [CHENG]: RUIN1 },
      config: c => {
        c.maps[0].scripted = []
        c.enemies.golem.hp = 5
      },
      // Cheng waits until the key is in her hands, then unlocks the door.
      decide: chengPlays(() =>
        f.events().some(e => e.eventType === 'entity.transferred' && data(e).toHolderId === CHENG) ? unlock : undefined,
      ),
    })
    await f.move(RUIN1)
    const latest = data(f.events().findLast(e => e.eventType === 'activity.updated')!).state as Json
    await f.runtime.activityAction({
      activityKey: 'rpg-map-ruin-1',
      activityId: latest.id,
      revision: latest.revision,
      operation: 'skill',
      parameters: { skill: '普通攻击', target: '遗迹守卫' },
      requestId: 'strike',
    })
    // The key lies on the floor: the door still shows, and walking through it is refused with the author's words.
    expect(offered(f, PLAYER)).toContain(RUIN2)
    const before = f.events().length
    const refused = await f.move(RUIN2)
    expect(refused.notice).toContain('铁门锁着，需要钥匙。')
    // Only the round's record of the refusal is written; nobody moves and no scene changes.
    const written = f.events().slice(before)
    expect(written.map(e => e.eventType)).not.toContain('character.moved')
    expect(written.filter(e => e.eventType.startsWith('scene.'))).toEqual([])
    expect(written.find(e => e.eventType === 'action.resolved')!.data).toMatchObject({
      accepted: false,
      reason: 'plugin:铁门锁着，需要钥匙。',
    })
    expect(where(f, PLAYER)).toBe(RUIN1)

    // Holding the key does not open the door by itself.
    await f.runtime.submit('/status take@entity:iron-key {}')
    expect((await f.move(RUIN2)).notice).toContain('铁门锁着，需要钥匙。')
    expect(where(f, PLAYER)).toBe(RUIN1)
    expect(offered(f, PLAYER)).toContain('status:rpg-unlock')

    // Whoever holds it unlocks the door: the player hands the key over, and Cheng uses it on her own turn.
    await f.runtime.submit(`/status give@entity:iron-key {"recipientId":"${CHENG}"}`)
    expect(offered(f, PLAYER)).not.toContain('status:rpg-unlock')
    if (!unlockedDoors(f.events()).length) await say(f, '澄，钥匙给你，开门吧。')
    expect(unlockedDoors(f.events())).toEqual([[RUIN1, RUIN2]])
    // Now open, the door is no longer something to unlock for anyone.
    expect(offered(f, CHENG)).not.toContain('status:rpg-unlock')
    // The player, who saw it happen, reads the door by its places, not by ids.
    const bar = (await f.runtime.state()).statusBar ?? []
    expect(bar.find(entry => entry.key === 'rpg-unlocked')?.valueText).toBe('遗迹一层 → 遗迹二层')

    // The player, without the key, now walks through.
    await f.move(RUIN2)
    expect(where(f, PLAYER)).toBe(RUIN2)
  })

  it('Cheng joins only through her own action; the player has no join operation targeting her', async () => {
    const f = await fixture({ decide: chengPlays(statusAction('rpg-join')) })
    expect(offered(f, PLAYER)).not.toContain('status:rpg-join')
    expect(offered(f, CHENG)).toContain('status:rpg-join')
    // The leader has no way to sign someone up, herself included.
    await expect(f.runtime.submit('/status rpg-join {}')).rejects.toThrow('当前已知条件不允许这个操作')
    expect(partyList(f.events())).toEqual([])

    await say(f, '澄，要不要一起去遗迹？')
    expect(partyList(f.events())).toEqual([CHENG])
    expect(partyMembers(f.events(), PLAYER)).toEqual([CHENG])
    const joined = f.events().findLast(e => e.eventType === 'status.updated')!
    expect(data(joined).source).toMatchObject({ operation: 'rpg-join', actorId: CHENG })
    // Once in, she is offered leaving too.
    expect(offered(f, CHENG)).toContain('status:rpg-leave')
  })

  it('lets the key holder unlock an exit while an optional battle is on standby', async () => {
    const f = await fixture({
      places: { [CHENG]: RUIN1 },
      config: c => {
        c.maps[0].engage = 'optional'
        c.maps[0].exits[0].requires.holds = 'entity:potion'
      },
    })
    await f.runtime.submit('/status take@entity:potion {}')
    await f.move(RUIN1)
    expect(offered(f, PLAYER)).toContain('status:rpg-unlock')
    await f.runtime.submit('/status rpg-unlock@entity:potion {}')
    expect(unlockedDoors(f.events())).toEqual([[RUIN1, RUIN2]])
    expect(data(f.events().findLast(e => e.eventType === 'activity.updated')!).state.game.phase).toBe('standby')
  })

  it('when the player moves, Cheng follows in the same commit and Ah-Ru at home sees both leave', async () => {
    const f = await fixture({ decide: chengPlays(statusAction('rpg-join')) })
    await say(f, '澄，跟我来。')
    await f.move(BEDROOM)
    expect(where(f, PLAYER)).toBe(BEDROOM)
    expect(where(f, CHENG)).toBe(BEDROOM)
    expect(where(f, ARU)).toBe(HOME)
    const moves = f.events().filter(e => e.eventType === 'character.moved')
    expect(moves.map(e => data(e).characterId)).toEqual([PLAYER, CHENG])
    expect(moves[0]!.transactionId).toBe(moves[1]!.transactionId)
    expect(data(moves[1]!)).toEqual({ characterId: CHENG, fromLocationId: HOME, toLocationId: BEDROOM })
    // Ah-Ru stays home: she sees each of them go, not where to.
    expect(seenMoves(f, ARU, PLAYER)).toEqual([{ characterId: PLAYER, fromLocationId: HOME }])
    expect(seenMoves(f, ARU, CHENG)).toEqual([{ characterId: CHENG, fromLocationId: HOME }])
    expect(seenMoves(f, CHENG, CHENG)).toEqual([{ characterId: CHENG, fromLocationId: HOME, toLocationId: BEDROOM }])
  })

  it('a member who is elsewhere when the leader moves does not follow and no longer counts as in the party', async () => {
    let step = 0
    const f = await fixture({
      decide: chengPlays(
        () => (step === 1 ? statusAction('rpg-join') : undefined),
        () => (step === 2 ? moveAction(BEDROOM) : undefined),
        () => (step === 3 ? statusAction('rpg-join') : undefined),
      ),
    })
    await f.runtime.submit('/status take@entity:iron-sword {}')
    step = 1
    await say(f, '澄，一起去吗？')
    expect(partyList(f.events())).toEqual([CHENG])
    step = 2
    await say(f, '你要去哪？')
    expect(where(f, CHENG)).toBe(BEDROOM)
    // Still listed, but not with the leader: she is not in the party and stays behind.
    expect(partyMembers(f.events(), PLAYER)).toEqual([])
    await f.move(RUIN1)
    expect(where(f, PLAYER)).toBe(RUIN1)
    expect(where(f, CHENG)).toBe(BEDROOM)
    // The leader's next RPG operation drops her from the list.
    await f.runtime.submit('/status rpg-equip@entity:iron-sword {}')
    const update = f.events().findLast(e => e.eventType === 'status.updated')!
    expect(data(update).changes).toEqual(expect.arrayContaining([{ holderId: null, key: 'rpg-party', value: [] }]))
    expect(partyList(f.events())).toEqual([])

    // She did not see that; when they meet again she can still join, and does.
    await f.move(BEDROOM)
    expect(partyMembers(f.events(), PLAYER)).toEqual([])
    expect(offered(f, CHENG)).toContain('status:rpg-join')
    step = 3
    await say(f, '澄，还一起走吗？')
    expect(partyList(f.events())).toEqual([CHENG])
    expect(partyMembers(f.events(), PLAYER)).toEqual([CHENG])
  })

  it('leave is refused during a battle when lockDuringBattle is set, and allowed after', async () => {
    let wantsOut = false
    const tries: string[] = []
    const f = await fixture({
      config: c => {
        c.maps[0].scripted = []
        c.enemies.golem.hp = 5
      },
      decide: input => {
        const context = input.context as Json
        if (context.character.characterId !== CHENG || input.continuation) return { decision: 'abstain' }
        const activity = context.activity as Json | undefined
        if (!tries.includes('join')) return (tries.push('join'), statusAction('rpg-join'))
        // In the fight she first tries to walk out of the party, then guards.
        if (activity?.game.active && activity.game.turn === CHENG) {
          if (!tries.includes('battle-leave')) return (tries.push('battle-leave'), statusAction('rpg-leave'))
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
        }
        if (wantsOut && !activity?.game.active) return ((wantsOut = false), statusAction('rpg-leave'))
        return { decision: 'abstain' }
      },
    })
    const current = () => data(f.events().findLast(e => e.eventType === 'activity.updated')!).state as Json
    const battleAct = (operation: string, parameters: WorldJsonObject = {}) =>
      f.runtime.activityAction({
        activityKey: 'rpg-map-ruin-1',
        activityId: current().id,
        revision: current().revision,
        operation,
        parameters,
        requestId: 'r-' + operation,
      })
    await say(f, '澄，出发了。')
    await f.move(RUIN1)
    expect(where(f, CHENG)).toBe(RUIN1)
    expect(current().game).toMatchObject({ active: true, phase: 'fighting' })
    expect(offered(f, CHENG)).not.toContain('status:rpg-leave')

    // On her battle turn she tries to leave anyway: the option is not hers mid-fight, nothing about the party is
    // written, and she guards instead.
    const before = f.events().length
    await battleAct('guard')
    expect(tries).toContain('battle-leave')
    const written = f.events().slice(before)
    expect(written.filter(e => e.eventType === 'status.updated' && data(e).source.operation === 'rpg-leave')).toEqual(
      [],
    )
    expect(partyList(f.events())).toEqual([CHENG])
    expect(written.some(e => e.eventType === 'activity.updated' && data(e).actorId === CHENG)).toBe(true)

    await battleAct('skill', { skill: '普通攻击', target: '遗迹守卫' })
    expect(current().game.active).toBe(false)
    expect(offered(f, CHENG)).toContain('status:rpg-leave')
    wantsOut = true
    await say(f, '打完了。')
    expect(partyList(f.events())).toEqual([])

    // Without the lock the option stays open mid-fight.
    const loose = await fixture({
      config: c => {
        c.maps[0].scripted = []
        c.party.lockDuringBattle = false
      },
      decide: chengPlays(statusAction('rpg-join')),
    })
    await say(loose, '澄，出发了。')
    await loose.move(RUIN1)
    expect(offered(loose, CHENG)).toContain('status:rpg-leave')
  })
})
