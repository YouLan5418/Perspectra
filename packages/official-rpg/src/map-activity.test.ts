import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities, mapActivityKey } from './map-activity.ts'
import { referenceJson, referencePack } from './fixtures/reference.ts'

type Json = Record<string, any>
const PLAYER = 'character:player',
  CHENG = 'character:cheng'
const names = { [PLAYER]: '玩家', [CHENG]: '澄', 'location:ruin-1': '遗迹一层', 'location:ruin-2': '遗迹二层' }
const generate = (change: (c: Json) => void = () => {}) => {
  const value = referenceJson()
  change(value)
  return generateMapActivities(parseRpgConfig(value, referencePack), { names })
}
/** Run one generated script like the host does and hand back its hooks. */
const hooks = (source: string): Json => {
  const context = createContext({})
  new Script(source).runInContext(context)
  return new Script('globalThis.activityScript').runInContext(context) as Json
}
const world = (locationId: string, arrivedAtSeq: number, characterIds = [PLAYER, CHENG], items: Json[] = []) => ({
  locationId,
  arrivedAtSeq,
  characterIds,
  items: { current: items, lastObserved: [] },
})
const truth = (own: Json = {}) => ({
  public: {},
  characters: {
    [PLAYER]: { 'rpg-hp': 40, 'rpg-hp-max': 40, 'rpg-mp': 8, 'rpg-mp-max': 8, 'rpg-equipment': {} },
    [CHENG]: { 'rpg-hp': 30, 'rpg-hp-max': 30, 'rpg-mp': 12, 'rpg-mp-max': 12, 'rpg-equipment': {}, ...own },
  },
})
const scoped = (game: Json, actorId: string, id = 'activity:1', revision = 1) => ({
  id,
  revision,
  participants: [PLAYER, CHENG],
  game: { ...game, private: game.private[actorId] },
})
const request = (game: Json, actorId: string, extra: Json = {}) => ({
  context: { character: { characterId: actorId }, activity: scoped(game, actorId) },
  continuation: false,
  ...extra,
})

describe('generateMapActivities', () => {
  it('makes one activity per map, keyed by location, within the host size limit', () => {
    const activities = generate()
    expect(activities.map(a => a.key)).toEqual(['rpg-map-ruin-1', 'rpg-map-ruin-2'])
    expect(mapActivityKey('location:ruin-1')).toBe('rpg-map-ruin-1')
    for (const { source } of activities) expect(Buffer.byteLength(source)).toBeLessThan(256 * 1024)
    const definition = hooks(activities[0]!.source).definition
    expect(definition).toMatchObject({ title: '遗迹一层', npcIds: [CHENG] })
    expect(definition.operations.map((op: Json) => op.id)).toEqual(['skill', 'guard', 'flee'])
  })

  it('rejects a map whose generated script would exceed 256 KiB, naming the map', () => {
    expect(() => generate(c => (c.maps[1].narration.first = '长'.repeat(100_000)))).toThrow(/^maps\[1\]：/u)
  })

  it('starts on a fresh arrival with the party present, never while staying, and picks first or again', () => {
    const script = hooks(generate()[0]!.source)
    const fresh = script.autoStart(truth(), world('location:ruin-1', 7), null)
    expect(fresh.when.every(([, met]: [string, boolean]) => met)).toBe(true)
    expect(fresh.notice).toBe('潮湿的石廊，尽头有一扇铁门。 遗迹守卫说：「擅入者，止步。」')
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 7),
      previous: null,
    })
    const ended = { ...scoped({ ...game, active: false, turn: null }, PLAYER) }
    expect(script.autoStart(truth(), world('location:ruin-1', 7), ended).when[1][1]).toBe(false)
    const back = script.autoStart(truth(), world('location:ruin-1', 12), ended)
    expect(back.when[1][1]).toBe(true)
    expect(back.notice).toContain('石廊里只剩守卫的残骸。')
    expect(script.autoStart(truth(), world('location:ruin-1', 12, [PLAYER]), ended).when[2][1]).toBe(false)
  })

  it('a map without enemies or scripted lines starts and ends at once', () => {
    const script = hooks(generate(c => delete c.maps[1].scripted)[1]!.source)
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-2', 3),
      previous: null,
    })
    expect(game).toMatchObject({ active: false, phase: 'done', turn: null })
  })

  it('returns null wherever the author scripted nothing', () => {
    const script = hooks(generate(c => (c.maps[0].scripted = []))[0]!.source)
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 1),
      previous: null,
    })
    expect(game).toMatchObject({ phase: 'fighting', turn: PLAYER })
    const theirs = { ...game, turn: CHENG }
    expect(script.simulate(request(theirs, CHENG))).toBeNull()
  })

  it('a turn cue for round 2 performs its skill on her second turn and publishes the line after the result', () => {
    const script = hooks(
      generate(
        c => (c.maps[0].scripted = [{ when: 'turn', round: 2, characterId: CHENG, say: '再来！', skill: 'fire' }]),
      )[0]!.source,
    )
    let game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 1),
      previous: null,
    })
    const step = (actorId: string, operation: string, parameters: Json = {}) => {
      const result = script.resolve(
        { id: 'activity:1', revision: 1, participants: [PLAYER, CHENG], game },
        actorId,
        operation,
        parameters,
        world('location:ruin-1', 1),
        truth(),
      )
      expect(result.rejectReason).toBeUndefined()
      game = result.game
      return result
    }
    step(PLAYER, 'guard')
    expect(game).toMatchObject({ turn: CHENG, round: 1 })
    expect(script.simulate(request(game, CHENG))).toBeNull()
    step(CHENG, 'guard')
    step(PLAYER, 'guard')
    expect(game).toMatchObject({ turn: CHENG, round: 2 })
    const decision = script.simulate(request(game, CHENG))
    expect(decision).toMatchObject({
      decision: 'perform',
      parameters: { arguments: { skill: '火球术', target: '遗迹守卫' } },
    })
    step(CHENG, 'skill', { skill: '火球术', target: '遗迹守卫' })
    const follow = script.simulate(
      request(game, CHENG, { continuation: true, result: { status: 'accepted', action: decision } }),
    )
    expect(follow).toEqual({ decision: 'publish', segments: [{ type: 'speech', text: '再来！' }] })
  })

  it('an enemy-defeated line plays after victory, then the activity ends', () => {
    const script = hooks(
      generate(c => {
        c.enemies.golem.hp = 5
        c.maps[0].scripted = [{ when: 'enemy-defeated', characterId: CHENG, say: '赢了！' }]
      })[0]!.source,
    )
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 1),
      previous: null,
    })
    const won = script.resolve(
      { id: 'activity:1', revision: 1, participants: [PLAYER, CHENG], game },
      PLAYER,
      'skill',
      { skill: '普通攻击', target: '遗迹守卫' },
      world('location:ruin-1', 1),
      truth(),
    )
    expect(won.game).toMatchObject({ active: true, phase: 'aftermath', turn: CHENG })
    expect(won.items).toEqual([{ entityId: 'entity:iron-key', to: { locationId: 'location:ruin-1' } }])
    expect(script.simulate(request(won.game, CHENG))).toEqual({
      decision: 'publish',
      segments: [{ type: 'speech', text: '赢了！' }],
    })
    const after = script.onPublished(
      { id: 'activity:1', revision: 2, participants: [PLAYER, CHENG], game: won.game },
      CHENG,
    )
    expect(after).toMatchObject({ active: false, phase: 'victory', turn: null })
  })

  it('an optional fight waits for the player to engage or leave', () => {
    const script = hooks(
      generate(c => {
        c.maps[0].engage = 'optional'
        c.maps[0].scripted = []
      })[0]!.source,
    )
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 1),
      previous: null,
    })
    expect(game).toMatchObject({ phase: 'standby', turn: PLAYER })
    expect(script.policy(scoped(game, PLAYER), PLAYER)).toMatchObject({ move: false, operations: ['engage', 'leave'] })
    const state = { id: 'activity:1', revision: 1, participants: [PLAYER, CHENG], game }
    const left = script.resolve(state, PLAYER, 'leave', {}, world('location:ruin-1', 1), truth())
    expect(left.game).toMatchObject({ active: false, phase: 'left' })
    const fight = script.resolve(state, PLAYER, 'engage', {}, world('location:ruin-1', 1), truth())
    expect(fight.game).toMatchObject({ active: true, phase: 'fighting', turn: PLAYER })
    expect(fight.description).toContain('遗迹守卫说：「擅入者，止步。」')
  })

  it('mid-fight the party can be left only without lockDuringBattle; outside a fight joining and leaving stay open', () => {
    const battle = (lock: boolean) => {
      const script = hooks(
        generate(c => {
          c.maps[0].scripted = []
          c.party.lockDuringBattle = lock
        })[0]!.source,
      )
      const game = script.initialize({
        playerId: PLAYER,
        npcIds: [CHENG],
        world: world('location:ruin-1', 1),
        previous: null,
      })
      expect(game.phase).toBe('fighting')
      return script.policy(scoped(game, CHENG), CHENG).interactions
    }
    expect(battle(true)).toEqual([])
    expect(battle(false)).toEqual(['status:rpg-leave'])
    const calm = hooks(generate()[1]!.source)
    const game = calm.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-2', 1),
      previous: null,
    })
    expect(calm.policy(scoped(game, CHENG), CHENG).interactions).toEqual(
      expect.arrayContaining(['status:rpg-join', 'status:rpg-leave']),
    )
  })

  it('a battle that starts after a faster companion left hands the first turn to someone still here', () => {
    const script = hooks(
      generate(c => {
        c.maps[0].engage = 'optional'
        c.maps[0].scripted = []
        c.characters[CHENG].speed = 99
      })[0]!.source,
    )
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 1),
      previous: null,
    })
    const state = { id: 'activity:1', revision: 1, participants: [PLAYER, CHENG], game }
    expect(script.resolve(state, PLAYER, 'engage', {}, world('location:ruin-1', 1), truth()).game.turn).toBe(CHENG)
    const alone = script.resolve(state, PLAYER, 'engage', {}, world('location:ruin-1', 1, [PLAYER]), truth())
    expect(alone.game).toMatchObject({ phase: 'fighting', turn: PLAYER })
  })

  it('a party member who is not at the battle gets no turn, is not targeted and does not count against defeat', () => {
    const script = hooks(generate(c => (c.maps[0].scripted = []))[0]!.source)
    const game = script.initialize({
      playerId: PLAYER,
      npcIds: [CHENG],
      world: world('location:ruin-1', 1),
      previous: null,
    })
    const alone = world('location:ruin-1', 1, [PLAYER])
    const state = { id: 'activity:1', revision: 1, participants: [PLAYER, CHENG], game }
    const guarded = script.resolve(state, PLAYER, 'guard', {}, alone, truth())
    expect(guarded.game).toMatchObject({ active: true, turn: PLAYER, round: 2 })
    expect(guarded.description).toContain('遗迹守卫使用普通攻击，玩家生命')
    expect(guarded.description).not.toContain('澄')
    expect(script.resolve(state, PLAYER, 'skill', { skill: '治疗术', target: '澄' }, alone, truth()).rejectReason).toBe(
      '这个技能不能对该目标使用。',
    )
    const weak = truth()
    weak.characters[PLAYER]!['rpg-hp'] = 1
    const lost = script.resolve(state, PLAYER, 'guard', {}, alone, weak)
    expect(lost.game).toMatchObject({ active: false, phase: 'defeat' })
    expect(lost.moves).toEqual([{ characterId: PLAYER, locationId: 'location:living-room' }])
  })
})
