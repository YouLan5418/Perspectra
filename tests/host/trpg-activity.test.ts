import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { ActivityScript } from '@harness-world/official-activities'
import { officialTrpgContent } from '@harness-world/official-trpg'
import { openRpgWorld } from '../support/rpg-fixture.ts'

// The TRPG activity on the real host runtime. The host is an AI character played by the fake model: each host
// operation goes through the NPC-turn path (CharacterTurn commits the resolution's events, private notes included).

const FIXTURE = resolve('tests/fixtures/trpg-pack')
const PLAYER = 'character:player',
  ARU = 'character:aru',
  CHENG = 'character:cheng',
  MEI = 'character:mei'
const NPCS = [ARU, CHENG, MEI]
type Json = Record<string, any>
/** What a character does when the model is asked for a fresh decision; continuations always pass. */
type Move = (activity: Json) => unknown

const roots: string[] = []
const worlds: Awaited<ReturnType<typeof openRpgWorld>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const world of worlds.splice(0)) await world.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

const perform = (me: string, activity: Json, operation: string, args: Json = {}) => ({
  decision: 'perform',
  actionType: 'interact',
  parameters: {
    targetRef: { kind: 'character', id: me },
    bindingId: activity.id,
    definitionRef: { id: 'activity:' + operation, version: 1 },
    arguments: { activityId: activity.id, revision: activity.revision, ...args },
  },
})

async function open() {
  const root = mkdtempSync(join(tmpdir(), 'trpg-activity-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(FIXTURE, pack, { recursive: true })
  mkdirSync(data)
  /** Planned moves per character, used one per fresh decision. */
  const plans: Record<string, Move[]> = {}
  const world = await openRpgWorld(pack, data, {
    decide: input => {
      const context = input.context as Json
      const me = context.character.characterId as string
      const next = plans[me]?.[0]
      if (input.continuation || !next || !context.activity) return { decision: 'abstain' }
      plans[me]!.shift()
      return next(context.activity) ?? { decision: 'abstain' }
    },
  })
  worlds.push(world)
  const read = <T>(use: (store: WorldStore) => T) => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return use(store)
    } finally {
      store.close()
    }
  }
  const state = () =>
    (world.events().findLast(e => e.eventType === 'activity.updated')?.data as Json | undefined)?.state as
      | { id: string; revision: number; participants: string[]; game: Json }
      | undefined
  const observations = (characterId: string, after = 0) =>
    read(store =>
      new CharacterViewBuilder(store).rebuildAt(
        world.runtime.address,
        brandId(characterId, 'CharacterId'),
        store.head(world.runtime.address).headSeq,
      ),
    )
      .observations.filter(o => o.sourceSeq > after)
      .map(o => JSON.stringify(o.value))
      .join('\n')
  const head = () => world.events().at(-1)!.seq
  const act = (operation: string, parameters: Json = {}) => {
    const current = state()
    return world.runtime.activityAction({
      activityKey: 'trpg',
      activityId: operation === 'start' ? null : current!.id,
      revision: operation === 'start' ? 0 : current!.revision,
      operation,
      parameters,
      requestId: randomUUID(),
    })
  }
  /** The host plays `moves` on its next chances. */
  const host = (id: string, ...moves: [string, Json][]) => {
    plans[id] = moves.map(
      ([operation, args]) =>
        activity =>
          perform(id, activity, operation, args),
    )
  }
  const begin = () => act('start', { npcIds: NPCS })
  return { ...world, plans, state, observations, head, act, host, begin }
}
type World = Awaited<ReturnType<typeof open>>

/** Aru hosts the authored scenario; the game is playing afterwards. */
async function playing(hostId = ARU) {
  const f = await open()
  await f.begin()
  f.host(hostId, ['respond', { accept: true }])
  await f.act('setup', { hostId, scenario: 'rainy-manor' })
  expect(f.state()!.game.phase).toBe('playing')
  return f
}
/** Activity operations committed after the first `from` events, apart from the host being given a chance. */
const operationsSince = (f: World, from: number) =>
  f
    .events()
    .slice(from)
    .filter(e => e.eventType === 'activity.updated' && (e.data as Json).operation !== 'published')
    .map(e => (e.data as Json).operation)
const rolls = (f: World, id: string) => f.state()!.game.private[id].rolls as Json[]

describe('the TRPG activity', () => {
  it('the player picks a host and a theme, the host accepts, and the opening is public', async () => {
    const f = await open()
    await f.begin()
    expect(f.state()!.game).toMatchObject({ phase: 'setup', turn: PLAYER })
    f.host(ARU, ['respond', { accept: true }])
    await f.act('setup', { hostId: ARU, theme: '深夜的废弃医院' })
    const game = f.state()!.game
    expect(game).toMatchObject({ phase: 'playing', public: { hostId: ARU, title: '深夜的废弃医院' } })
    expect(game.public.opening).toBe('题目：深夜的废弃医院')
    // Only a theme: no authored secret, and the host is told to write one in its private notes.
    expect(game.private[ARU].secret).toBeNull()
    expect(game.private[ARU].instructions).toContain('私密笔记')
    expect(Object.keys(game.public.sheets).sort()).toEqual([PLAYER, CHENG, MEI].sort())
    expect(game.public.sheets[CHENG].skills.agility.modifier).toBe(2)
    expect(game.public.sheets[MEI].stats.sanity).toEqual({ label: '理智', value: 8, max: 10 })
    for (const id of [PLAYER, CHENG, MEI]) expect(f.observations(id)).toContain('开场：题目：深夜的废弃医院')
    for (const id of [PLAYER, ...NPCS]) expect(f.observations(id)).toContain('阿茹接受了主持邀请')
  })

  it('a declined invitation returns to setup and the player can pick someone else', async () => {
    const f = await open()
    await f.begin()
    f.host(ARU, ['respond', { accept: false }])
    await f.act('setup', { hostId: ARU, scenario: 'rainy-manor' })
    let game = f.state()!.game
    expect(game).toMatchObject({ phase: 'setup', turn: PLAYER, public: { hostId: null, content: [] } })
    expect(game.private[ARU]).toEqual({ rolls: [] })
    expect(f.observations(PLAYER)).toContain('阿茹婉拒了主持邀请')
    // Cheng is not on the hosts list.
    await expect(f.act('setup', { hostId: CHENG, scenario: 'rainy-manor' })).rejects.toThrow('主持人候选')
    f.host(MEI, ['respond', { accept: true }])
    await f.act('setup', { hostId: MEI, scenario: 'rainy-manor' })
    game = f.state()!.game
    expect(game).toMatchObject({ phase: 'playing', public: { hostId: MEI, title: '雨夜古宅' } })
    expect(game.public.content.map((c: Json) => c.name)).toEqual(['门厅', '书房', '管家'])
    expect(game.private[MEI].hiddenContent.map((c: Json) => c.name)).toEqual(['账本'])
    expect(game.private[MEI].secret.truth).toContain('管家')
    expect(JSON.stringify(game.private[ARU])).not.toMatch(/账本|管家/u)
    expect(f.observations(PLAYER)).toContain('雨夜，你们的车坏在一座古宅门口')
    expect(f.observations(CHENG)).not.toMatch(/账本|害死/u)
  })

  it('a proposal before the host accepted is refused and nothing commits', async () => {
    const f = await open()
    await f.begin()
    await f.act('setup', { hostId: ARU, scenario: 'rainy-manor' })
    expect(f.state()!.game.phase).toBe('invited')
    const before = f.events()
    await expect(f.act('propose', { text: '我想撬开书房的门。' })).rejects.toThrow()
    expect(f.events()).toEqual(before)
  })

  it('a check shows its total only to the target and the host, and the others see that a check happened', async () => {
    const f = await playing()
    const from = f.head()
    f.host(
      ARU,
      ['check', { targetId: CHENG, skill: 'agility', difficulty: 12, hidden: false }],
      ['announce', { text: '澄踮着脚靠近了楼梯。' }],
    )
    await f.act('propose', { text: '让澄去看看楼梯。' })
    const [roll] = rolls(f, ARU)
    expect(rolls(f, CHENG)).toEqual([roll])
    expect(rolls(f, PLAYER)).toEqual([])
    expect(roll).toMatchObject({ targetId: CHENG, skill: 'agility', modifier: 2, difficulty: 12, hidden: false })
    expect(roll!.total).toBe(roll!.dice[0] + 2)
    const line = `澄的敏捷检定：${roll!.dice[0]}+2=${roll!.total}，难度12，${roll!.total >= 12 ? '成功' : '失败'}`
    expect(f.observations(CHENG, from)).toContain(line)
    expect(f.observations(ARU, from)).toContain(line)
    for (const other of [PLAYER, MEI]) {
      const seen = f.observations(other, from)
      expect(seen).toContain('澄进行了一次敏捷检定。')
      expect(seen).toContain('澄踮着脚靠近了楼梯。')
      expect(seen).not.toContain('敏捷检定：')
    }
    expect(JSON.stringify(f.state()!.game.public)).not.toContain(String(roll!.total) + '，难度')
    // The proposal was handled by the announcement.
    expect(f.state()!.game.public.pending).toEqual([])
  })

  it('a hidden roll leaves no trace for anyone but the host', async () => {
    const f = await playing()
    let before: { public: unknown; seq: number } | undefined
    f.plans[ARU] = [
      activity => {
        before = { public: activity.game.public, seq: f.head() }
        return perform(ARU, activity, 'check', { skill: 'observe', difficulty: 15, hidden: true })
      },
    ]
    await f.runtime.submit('大家小心点。')
    const game = f.state()!.game
    expect(game.public).toEqual(before!.public)
    const [roll] = rolls(f, ARU)
    expect(roll).toMatchObject({ targetId: null, skill: 'observe', hidden: true })
    expect(f.observations(ARU, before!.seq)).toContain(`暗骰的观察检定：${roll!.dice[0]}+0=${roll!.total}，难度15`)
    for (const other of [PLAYER, CHENG, MEI]) {
      expect(rolls(f, other)).toEqual([])
      expect(f.observations(other, before!.seq)).toBe('')
    }
  })

  it('the host announcing an outcome does not change any recorded roll', async () => {
    const f = await playing()
    f.host(ARU, ['check', { targetId: PLAYER, skill: 'agility', difficulty: 12, hidden: false }])
    await f.act('propose', { text: '我想撬开书房的门。' })
    const recorded = { host: rolls(f, ARU), player: rolls(f, PLAYER) }
    expect(recorded.player).toHaveLength(1)
    // Announcing success whatever the dice said: the script does not check the host's verdict.
    f.host(ARU, ['announce', { text: '门开了。' }])
    await f.runtime.submit('怎么样？')
    expect(f.state()!.game.public.lastResult).toBe('门开了。')
    expect({ host: rolls(f, ARU), player: rolls(f, PLAYER) }).toEqual(recorded)
  })

  it('set-stat refuses unknown stats and values outside 0..max', async () => {
    const f = await playing()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Not on the sheet template: the offered operation's schema refuses it as invalid output, and nothing commits.
    let before = f.events().length
    f.host(ARU, ['set-stat', { targetId: PLAYER, stat: 'luck', value: 3 }])
    await f.runtime.submit('继续。')
    expect(operationsSince(f, before)).toEqual([])
    for (const [args, reason] of [
      [{ targetId: PLAYER, stat: 'hp', value: 11 }, '生命需要在 0 到 10 之间。'],
      [{ targetId: PLAYER, stat: 'hp', value: -1 }, '生命需要在 0 到 10 之间。'],
      // The host has no sheet.
      [{ targetId: ARU, stat: 'hp', value: 3 }, '没有这名参与者的角色卡'],
    ] as const) {
      before = f.events().length
      f.host(ARU, ['set-stat', args])
      await expect(f.runtime.submit('继续。')).rejects.toThrow(reason)
      expect(operationsSince(f, before)).toEqual([])
    }
    f.host(ARU, ['set-stat', { targetId: PLAYER, stat: 'hp', value: 0 }])
    await f.runtime.submit('继续。')
    expect(f.state()!.game.public.sheets[PLAYER].stats.hp.value).toBe(0)
  })

  it('a note that would pass 6000 characters is refused with the reason', async () => {
    const f = await playing()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.host(ARU, ['note', { scope: 'private', text: '记'.repeat(5996), mode: 'append' }])
    await f.runtime.submit('开始吧。')
    expect(f.state()!.game.private[ARU].notes).toHaveLength(5996)
    f.host(ARU, ['note', { scope: 'private', text: '多出来的话', mode: 'append' }])
    // The host's operation is refused on its own turn; the player's line before it stays committed.
    const before = f.events().length
    await expect(f.runtime.submit('然后呢？')).rejects.toThrow(
      '私密笔记将超过 6000 字（现有 5996 字），请用 replace 把整段改写整理后再写入。',
    )
    expect(operationsSince(f, before)).toEqual([])
    expect(f.state()!.game.private[ARU].notes).toHaveLength(5996)
    f.host(ARU, ['note', { scope: 'private', text: '整理后的笔记', mode: 'replace' }])
    await f.runtime.submit('再然后呢？')
    expect(f.state()!.game.private[ARU].notes).toBe('整理后的笔记')
  })

  it('host operations are offered only to the host, and none after end', async () => {
    const f = await playing()
    const operations = (input: WorldJsonObject) =>
      (((input.context as Json).affordances ?? []) as Json[])
        .flatMap(a => (a.interactions ?? []) as Json[])
        .map(i => String(i.definitionRef.id))
        .filter(id => id.startsWith('activity:'))
    const of = (id: string) => f.inputs.filter(input => (input.context as Json).character.characterId === id)
    f.inputs.length = 0
    await f.runtime.submit('我们开始吧。')
    const hostOps = new Set(of(ARU).flatMap(operations))
    expect([...hostOps].sort()).toEqual(
      [
        'activity:announce',
        'activity:check',
        'activity:content',
        'activity:end',
        'activity:note',
        'activity:set-stat',
      ].sort(),
    )
    // Cheng and Mei get no turn from this activity (see the generated-script test for what they would be offered).
    const playerOps = ((await f.runtime.state()).activity!.options as Json[]).map(o => o.definitionRef.id)
    expect(playerOps.sort()).toEqual(['activity:end', 'activity:propose'])
    await f.act('end', { ending: '天亮了。' })
    expect(f.state()!.game).toMatchObject({ active: false, phase: 'ended' })
    expect(f.observations(CHENG)).toContain('跑团结束：天亮了。')
    f.inputs.length = 0
    await f.runtime.submit('玩得开心。')
    expect(f.inputs.flatMap(operations)).toEqual([])
    expect((await f.runtime.state()).activity?.options ?? []).toEqual([])
  })

  it('nothing the host does changes a main-world status or item', async () => {
    const world = (f: World) =>
      f
        .events()
        .filter(e => /^(entity|status|character\.moved)/u.test(e.eventType))
        .map(e => ({ eventType: e.eventType, data: e.data }))
    const f = await open()
    const before = world(f)
    expect(JSON.stringify(f.events())).toContain('entity:teacup')
    await f.begin()
    f.host(ARU, ['respond', { accept: true }])
    await f.act('setup', { hostId: ARU, scenario: 'rainy-manor' })
    f.host(
      ARU,
      ['content', { kind: 'item', name: '茶杯', description: '局内的茶杯。', public: true }],
      ['set-stat', { targetId: PLAYER, stat: 'hp', value: 3 }],
      ['note', { scope: 'public', text: '玩家拿走了茶杯。', mode: 'append' }],
      ['check', { targetId: PLAYER, skill: 'observe', difficulty: 10, hidden: false }],
      ['announce', { text: '玩家把茶杯揣进了口袋。' }],
    )
    await f.act('propose', { text: '我拿起茶杯。' })
    await f.act('end', {})
    expect(world(f)).toEqual(before)
    expect(f.state()!.game.public.sheets[PLAYER].stats.hp.value).toBe(3)
  })

  it('regenerating the last round replays the same roll', async () => {
    const f = await playing()
    const check: [string, Json] = ['check', { targetId: PLAYER, skill: 'agility', difficulty: 12, hidden: false }]
    f.host(ARU, check)
    const proposed = await f.act('propose', { text: '我想撬开书房的门。' })
    const [first] = rolls(f, ARU)
    expect(first).toBeDefined()
    // Three regenerations, each running the host's check again: a fresh d20 would differ by chance 1 in 8000.
    let tail = proposed.tailRound!.id!
    for (let i = 0; i < 3; i++) {
      f.host(ARU, check)
      tail = (await f.runtime.regenerate(tail, randomUUID())).tailRound!.id!
      expect(f.plans[ARU]).toEqual([])
      expect(rolls(f, ARU)).toEqual([first])
      expect(rolls(f, PLAYER)).toEqual([first])
    }
  })
})

describe('the generated script', () => {
  // The refusals the host meets, read straight from the script: the host runtime only reports that it was refused.
  const config = JSON.parse(readFileSync(join(FIXTURE, 'trpg.json'), 'utf8'))
  const names = { [PLAYER]: '玩家', [ARU]: '阿茹', [CHENG]: '澄', [MEI]: '梅' }
  const pack = {
    characterIds: Object.keys(names),
    locationIds: ['location:living-room'],
    entityIds: [],
    entityLocations: {},
    playerId: PLAYER,
    names,
  }
  const [entry] = officialTrpgContent.generate(config, pack).activities!
  const script = new ActivityScript({ key: 'trpg', entry: 'trpg', source: entry!.source } as never)
  const participants = [PLAYER, ...NPCS]
  const run = (game: Json, actorId: string, operation: string, parameters: Json) =>
    script.resolve(
      { id: 'a', revision: 1, participants, game } as never,
      actorId,
      operation,
      parameters,
      {},
      null,
      () => ({
        expression: 'd20',
        dice: [9],
        modifier: 0,
        total: 9,
      }),
    ) as Json
  const started = () => {
    let game = script.initialize({ playerId: PLAYER, npcIds: NPCS }, Math.random) as Json
    game = run(game, PLAYER, 'setup', { hostId: ARU, scenario: 'rainy-manor' }).game
    return run(game, ARU, 'respond', { accept: true }).game
  }

  it('names the 6000-character limit and replace when a note would pass it', () => {
    const game = run(started(), ARU, 'note', { scope: 'public', text: '记'.repeat(5996), mode: 'append' }).game
    const refused = run(game, ARU, 'note', { scope: 'public', text: '多出来的话', mode: 'append' })
    expect(refused.rejectReason).toContain('6000')
    expect(refused.rejectReason).toContain('replace')
  })

  it('offers host tools to the host alone and propose to the other participants', () => {
    const game = started()
    const offered = (id: string) =>
      (script.policy({ game: { ...game, private: game.private[id] } } as never, id) as Json).operations
    expect(offered(ARU)).toEqual(['check', 'announce', 'note', 'set-stat', 'content', 'end'])
    expect(offered(PLAYER)).toEqual(['propose', 'end'])
    expect(offered(CHENG)).toEqual(['propose'])
    expect(offered(MEI)).toEqual(['propose'])
    const ended = run(game, PLAYER, 'end', {}).game
    expect(ended).toMatchObject({ active: false, phase: 'ended', turn: null })
    for (const id of participants)
      expect(run(ended, id, 'note', { scope: 'public', text: 'x', mode: 'append' })).toHaveProperty('rejectReason')
  })

  it('names the range a stat must stay in', () => {
    expect(run(started(), ARU, 'set-stat', { targetId: PLAYER, stat: 'hp', value: 11 }).rejectReason).toBe(
      '生命需要在 0 到 10 之间。',
    )
  })

  it('formats a check with the skill modifier and keeps a hidden roll out of public', () => {
    const game = started()
    const visible = run(game, ARU, 'check', { targetId: CHENG, skill: 'agility', difficulty: 12, hidden: false })
    expect(visible.description).toBe('澄进行了一次敏捷检定。')
    expect(visible.privateNotes).toEqual({
      [CHENG]: '澄的敏捷检定：9+2=11，难度12，失败',
      [ARU]: '澄的敏捷检定：9+2=11，难度12，失败',
    })
    const hidden = run(game, ARU, 'check', { targetId: MEI, skill: 'observe', difficulty: 10, hidden: true })
    expect(hidden.audience).toBe('self')
    expect(hidden.game.public).toEqual(game.public)
    expect(hidden.privateNotes).toEqual({ [ARU]: '暗骰·梅的观察检定：9+3=12，难度10，成功' })
    expect(hidden.game.private[MEI].rolls).toEqual([])
  })
})

it('the package fixture and the test pack share one trpg.json', () => {
  expect(readFileSync(resolve('packages/official-trpg/src/fixtures/rainy-manor.trpg.json'))).toEqual(
    readFileSync(join(FIXTURE, 'trpg.json')),
  )
})
