import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { WorldHostCore } from '../../desktop/host/world-runtime.ts'
import { playSettings } from '../../desktop/play-settings.ts'

type Game = {
  active: boolean
  phase: string
  turn: string | null
  round: number
  public: Record<string, unknown>
  private: Record<string, Record<string, unknown>>
  internal: Record<string, unknown>
}
type State = { participants: string[]; game: Game }
type Resolved = { game?: Game; description?: string; audience?: string; rejectReason?: string }

const PLAYER = 'character:player'
const NPCS = [
  'character:gpt',
  'character:claude',
  'character:deepseek',
  'character:glm',
  'character:gemini',
  'character:qwen',
]
const EVERYONE = [PLAYER, ...NPCS]
const NAME: Record<string, string> = {
  [PLAYER]: '玩家',
  'character:gpt': 'GPT',
  'character:claude': 'Claude',
  'character:deepseek': 'DeepSeek',
  'character:glm': 'GLM',
  'character:gemini': 'Gemini',
  'character:qwen': 'Qwen',
}
const SCRIPT = resolve('examples/world-packs/model-girls-werewolf/scripts/activities/werewolf.js')

/** The pack script runs as plain JS; results cross the vm realm through JSON like the host's own bridge. */
function table() {
  const context = createContext({})
  new Script(readFileSync(SCRIPT, 'utf8')).runInContext(context)
  const script = context.activityScript
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const game = plain(script.initialize({ playerId: PLAYER, npcIds: NPCS }) as Game)
  const t = {
    state: { participants: EVERYONE, game } as State,
    roleOf: (id: string): string => (t.state.game.internal['身份表'] as Record<string, string>)[id]!,
    who: (role: string): string[] => EVERYONE.filter(id => t.roleOf(id) === role),
    alive: (): string[] => (t.state.game.public['存活'] as string[]).map(n => EVERYONE.find(id => NAME[id] === n)!),
    good: (): string[] => t.alive().filter(id => t.roleOf(id) !== '狼人'),
    /** Resolve as whoever holds the turn (or `actor`); a refusal returns the reason and keeps the state. */
    try(operation: string, parameters: Record<string, unknown>, actor?: string): Resolved {
      const r = plain(script.resolve(t.state, actor ?? t.state.game.turn, operation, parameters, {}, {}) as Resolved)
      if (r.game) t.state = { ...t.state, game: r.game }
      return r
    },
    act(operation: string, parameters: Record<string, unknown>, actor?: string): Resolved {
      const r = t.try(operation, parameters, actor)
      if (r.rejectReason) throw new Error(r.rejectReason)
      return r
    },
    /** The host hands policy a scoped view: `private` is already the actor's own record. */
    policy(actor: string): { speech: string; narration: boolean; operations: string[] } {
      const g = t.state.game
      const view = { participants: EVERYONE, game: { ...g, private: g.private[actor], internal: undefined } }
      return plain(script.policy(view, actor))
    },
    speak(): Game | null {
      const next = plain(script.onPublished(t.state, t.state.game.turn, null) as Game | null)
      if (next) t.state = { ...t.state, game: next }
      return next
    },
    /** One night with fixed choices; unspecified roles do the least they can. */
    night(choice: { kill: string; potion?: Record<string, unknown>; check?: string }): Resolved[] {
      const results: Resolved[] = []
      while (t.state.game.phase === 'night') {
        const role = t.roleOf(t.state.game.turn!)
        if (role === '狼人') results.push(t.act('kill', { target: NAME[choice.kill] }))
        else if (role === '女巫') results.push(t.act('potion', choice.potion ?? { choice: 'none' }))
        else if (role === '预言家') {
          const target = choice.check ?? t.alive().find(id => id !== t.state.game.turn)!
          results.push(t.act('check', { target: NAME[target] }))
        } else throw new Error('unexpected night turn: ' + role)
      }
      return results
    },
    day(vote: (voter: string) => string): Resolved[] {
      while (t.state.game.phase === 'day-speak') expect(t.speak()).not.toBeNull()
      const results: Resolved[] = []
      while (t.state.game.phase === 'vote') results.push(t.act('vote', { target: vote(t.state.game.turn!) }))
      return results
    },
  }
  return t
}

describe('werewolf rules', () => {
  it('policy reads the role from the scoped view and lets only the turn holder act', () => {
    const t = table()
    const wolf = t.state.game.turn!
    expect(t.policy(wolf).speech).toBe('free')
    expect(t.policy(wolf).operations).toContain('kill')
    const villager = t.who('村民').find(id => id !== PLAYER)!
    expect(t.policy(villager)).toMatchObject({ speech: 'none', operations: [] })
    expect(t.policy(PLAYER).operations).toContain('quit')
  })

  it('night actions report to the actor only, so nobody learns who acted last', () => {
    const t = table()
    const round = t.state.game.round
    const results = t.night({ kill: t.who('村民')[0]!, potion: { choice: 'none' } })
    expect(t.state.game.phase).toBe('day-speak')
    expect(results.every(r => r.audience === 'self')).toBe(true)
    // The dawn still reaches everyone, through the public state rather than an observation.
    expect(String(t.state.game.public['lastResult'])).toContain('天亮了')
    // The visible round must not count how many role holders acted.
    expect(t.state.game.round).toBe(round)
  })

  it('wolves cannot narrate at night and are told that any public word gives them away', () => {
    const t = table()
    const wolf = t.state.game.turn!
    expect(t.policy(wolf)).toMatchObject({ speech: 'free', narration: false })
    expect(String(t.state.game.private[wolf]!['提醒'])).toContain('暴露')
  })

  it('witch saving the kill target means nobody dies at dawn', () => {
    const t = table()
    const victim = t.good().find(id => t.roleOf(id) !== '女巫')!
    t.night({ kill: victim, potion: { choice: 'save' } })
    expect(t.state.game.phase).toBe('day-speak')
    expect(t.state.game.public['死讯']).toBe('平安夜')
    expect(t.alive()).toHaveLength(7)
  })

  it('poison and kill on different people both die; same person dies once', () => {
    const a = table()
    const [victim, poisoned] = a.good().filter(id => a.roleOf(id) === '村民')
    a.night({ kill: victim!, potion: { choice: 'poison', target: NAME[poisoned!] } })
    expect(a.alive()).toHaveLength(5)
    expect(a.alive()).not.toContain(victim)
    expect(a.alive()).not.toContain(poisoned)

    const b = table()
    const same = b.who('村民')[0]!
    b.night({ kill: same, potion: { choice: 'poison', target: NAME[same] } })
    expect(b.alive()).toHaveLength(6)
  })

  it('witch cannot save herself and cannot use both potions in one night', () => {
    const t = table()
    const witch = t.who('女巫')[0]!
    while (t.roleOf(t.state.game.turn!) === '狼人') t.act('kill', { target: NAME[witch] })
    expect(t.state.game.turn).toBe(witch)
    expect(t.try('potion', { choice: 'save' }).rejectReason).toBeTruthy()
    t.act('potion', { choice: 'poison', target: NAME[t.who('村民')[0]!] })
    expect(t.state.game.turn).not.toBe(witch)
  })

  it('seer killed on night one still checks that night, is skipped on night two', () => {
    const t = table()
    const seer = t.who('预言家')[0]!
    const results = t.night({ kill: seer })
    expect(results.some(r => r.audience === 'self')).toBe(true)
    expect(t.alive()).not.toContain(seer)
    expect(t.state.game.private[seer]!['验人记录']).toHaveLength(1)
    t.day(() => '弃票')
    expect(t.state.game.phase).toBe('night')
    expect(t.state.game.internal['夜序']).not.toContain(seer)
  })

  it('ballots stay hidden until the last vote; a tie exiles nobody', () => {
    const t = table()
    t.night({ kill: t.who('村民')[0]!, potion: { choice: 'save' } })
    const [x, y] = t.alive()
    // x and y vote for each other; of the other five, two pick x, two pick y and one abstains: 3 to 3.
    let others = 0
    const results = t.day(voter => {
      if (voter === x) return NAME[y!]!
      if (voter === y) return NAME[x!]!
      const n = others++
      return n === 4 ? '弃票' : NAME[n % 2 ? y! : x!]!
    })
    const tally = results.slice(0, -1)
    expect(tally.every(r => r.audience === 'self')).toBe(true)
    expect(tally.every(r => r.game!.public['票型'] === undefined)).toBe(true)
    expect(results.at(-1)!.audience).toBe('participants')
    expect(t.state.game.public['票型']).toBeDefined()
    expect(t.alive()).toHaveLength(7)
  })

  it('refuses invalid votes: self, the dead and unknown names', () => {
    const t = table()
    const victim = t.who('村民')[0]!
    t.night({ kill: victim })
    t.day(() => '弃票')
    t.night({ kill: t.who('村民')[1]! })
    while (t.state.game.phase === 'day-speak') t.speak()
    const voter = t.state.game.turn!
    expect(t.try('vote', { target: NAME[voter] }).rejectReason).toBeTruthy()
    expect(t.try('vote', { target: NAME[victim] }).rejectReason).toBeTruthy()
    expect(t.try('vote', { target: '路人' }).rejectReason).toBeTruthy()
    expect(t.try('vote', { target: '弃票' }, t.alive().find(id => id !== voter)!).rejectReason).toBeTruthy()
  })

  it('wolves win when alive wolves >= alive villagers', () => {
    const t = table()
    const [a, b, c] = t.who('村民')
    t.night({ kill: a!, potion: { choice: 'poison', target: NAME[b!] } })
    // Exiling c leaves 2 wolves against 2 good; c herself abstains.
    t.day(voter => (voter === c ? '弃票' : NAME[c!]!))
    expect(t.state.game.phase).toBe('finished')
    expect(String(t.state.game.public['lastResult'])).toContain('狼人获胜')
  })

  it('villagers win when no wolf is left', () => {
    const t = table()
    const [w1, w2] = t.who('狼人')
    t.night({ kill: t.who('村民')[0]!, potion: { choice: 'poison', target: NAME[w1!] } })
    t.day(voter => NAME[voter === w2 ? t.alive().find(id => id !== w2)! : w2!]!)
    expect(t.state.game.phase).toBe('finished')
    expect(String(t.state.game.public['lastResult'])).toContain('好人获胜')
  })

  it('the finished game reveals every role in public and nothing about the nights', () => {
    const t = table()
    const [w1, w2] = t.who('狼人')
    t.night({ kill: t.who('村民')[0]!, potion: { choice: 'poison', target: NAME[w1!] } })
    t.day(voter => NAME[voter === w2 ? t.alive().find(id => id !== w2)! : w2!]!)
    const reveal = t.state.game.public['身份公布'] as Record<string, string>
    expect(Object.keys(reveal)).toHaveLength(7)
    expect(reveal[NAME[w1!]!]).toBe('狼人')
    const pub = JSON.stringify(t.state.game.public)
    // The rules text mentions these words; only the night records themselves must stay out.
    expect(pub).not.toMatch(/"(验人记录|今晚被刀|同伴提议|夜间|身份表)"|查验了/)
  })
})

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const find = (value: unknown, test: (o: WorldJsonObject) => boolean): WorldJsonObject | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  if (!Array.isArray(value) && test(value as WorldJsonObject)) return value as WorldJsonObject
  for (const child of Object.values(value)) {
    const hit = find(child, test)
    if (hit) return hit
  }
  return undefined
}
const idOfName = (name: string) => EVERYONE.find(id => NAME[id] === name)!
const WHISPER = '悄悄说：今晚就动手吧'
/** On the host every view is scoped: `private` is the viewer's own record. */
const mine = (game: Game) => game.private as unknown as Record<string, unknown>

/**
 * Every NPC is a fake model that plays from its own scoped view only: a wolf whispers once to its partner and
 * then kills the first living non-wolf; the seer checks, the witch passes, everyone speaks once and votes for
 * the next living seat. `talkOnly` makes wolves whisper forever without submitting a kill.
 */
async function host(options: { talkOnly?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-girls-werewolf-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, 'data')
  const seen: { self: string; text: string }[] = []
  const whispered = new Set<string>()
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += String(chunk)))
    request.on('end', () => {
      const user = (JSON.parse(body).messages as { role: string; content: string }[]).findLast(m => m.role === 'user')
      const input = user?.content.startsWith('{') ? JSON.parse(user.content) : {}
      const activity = find(input, o => o.activityKey === 'werewolf' && typeof o.game === 'object')
      const game = activity?.game as Game | undefined
      const self = String(find(input.context, o => typeof o.characterId === 'string')?.characterId ?? '')
      seen.push({ self, text: JSON.stringify(input) })
      const perform = (operation: string, parameters: WorldJsonObject): WorldJsonObject => ({
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'character', id: self },
          bindingId: String(activity!.id),
          definitionRef: { id: 'activity:' + operation, version: 1 },
          arguments: { activityId: String(activity!.id), revision: Number(activity!.revision), ...parameters },
        },
      })
      let decision: WorldJsonObject = { decision: 'abstain' }
      if (input.result === undefined && game?.active && game.turn === self) {
        const own = mine(game)
        const living = game.public['存活'] as string[]
        const seats = game.public['座位'] as string[]
        const others = living.filter(n => n !== NAME[self])
        if (game.phase === 'night' && own['身份'] === '狼人') {
          const key = self + ':' + String(game.public['第几天'])
          if (options.talkOnly || !whispered.has(key)) {
            whispered.add(key)
            decision = {
              decision: 'publish',
              segments: [{ type: 'speech', text: WHISPER }],
              scope: 'direct',
              addresseeIds: [idOfName(String(own['狼同伴']))],
            }
          } else decision = perform('kill', { target: others.find(n => n !== own['狼同伴'])! })
        } else if (game.phase === 'night' && own['身份'] === '预言家')
          decision = perform('check', { target: others[0]! })
        else if (game.phase === 'night' && own['身份'] === '女巫') decision = perform('potion', { choice: 'none' })
        else if (game.phase === 'day-speak')
          decision = {
            decision: 'publish',
            segments: [{ type: 'speech', text: `我是${NAME[self]}，我先说说我的看法。` }],
          }
        else if (game.phase === 'vote') {
          const at = seats.indexOf(NAME[self]!)
          const next = [...seats.slice(at + 1), ...seats.slice(0, at)].find(n => living.includes(n))!
          decision = perform('vote', { target: next })
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { tool_calls: [{ function: { name: 'submit_actions', arguments: JSON.stringify(decision) } }] },
            },
          ],
        }),
      )
    })
  })
  cleanup.push(() => new Promise<void>(done => (server.closeAllConnections(), server.close(() => done()))))
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostCore.create({
    packPath: resolve('examples/world-packs/model-girls-werewolf'),
    dataDirectory: data,
    provider: 'local',
    model: 'fixture',
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions',
    timeoutMs: 5000,
    playSettings: playSettings({ activityOpportunities: 20, activityDeadlineSeconds: 600 }),
  })
  cleanup.push(() => runtime.close())
  const withStore = <T>(read: (store: WorldStore) => T): T => {
    const store = new WorldStore(join(data, 'world.sqlite'))
    try {
      return read(store)
    } finally {
      store.close()
    }
  }
  const events = () => withStore(store => store.readEvents(runtime.address))
  const observations = (characterId: string) =>
    withStore(store =>
      JSON.stringify(
        new CharacterViewBuilder(store).rebuildAt(
          runtime.address,
          brandId(characterId, 'CharacterId'),
          store.head(runtime.address).headSeq,
        ).observations,
      ),
    )
  const current = async () =>
    ((await runtime.state()).activities as WorldJsonObject[]).find(a => a.activityKey === 'werewolf')!
  const game = async () => (await current()).game as unknown as Game
  let requests = 0
  const request = async (operation: string, parameters: WorldJsonObject = {}) => {
    const a = operation === 'start' ? undefined : await current()
    return runtime.activityAction({
      activityKey: 'werewolf',
      activityId: a && a.id !== null ? String(a.id) : null,
      revision: a && a.id !== null ? Number(a.revision) : 0,
      operation,
      parameters,
      requestId: 'werewolf-' + requests++,
    })
  }
  /** Start games until the player holds `role` (any role when omitted). */
  const start = async (role?: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await request('start')
      if (role === undefined || mine(await game())['身份'] === role) return
      await request('quit')
    }
    throw new Error('never dealt ' + role)
  }
  /** The player passes as much as the rules allow; NPCs get their opportunities through retry. */
  const playToEnd = async () => {
    for (let step = 0; step < 300; step++) {
      const g = await game()
      if (!g.active) return g
      if (g.turn !== PLAYER) await request('retry')
      else if (g.phase === 'day-speak') await runtime.submit('我是玩家，我先听听大家的。')
      else if (g.phase === 'vote') await request('vote', { target: '弃票' })
      else {
        const role = String(mine(g)['身份'])
        const living = (g.public['存活'] as string[]).filter(n => n !== '玩家' && n !== mine(g)['狼同伴'])
        if (role === '狼人') await request('kill', { target: living[0]! })
        else if (role === '预言家') await request('check', { target: living[0]! })
        else await request('potion', { choice: 'none' })
      }
    }
    throw new Error('game did not finish')
  }
  return { runtime, seen, events, observations, game, request, start, playToEnd }
}

describe('werewolf on the host', () => {
  it('plays a full seven-player game to a winner and reveals roles to everyone', async () => {
    const f = await host()
    await f.start()
    const end = await f.playToEnd()
    expect(end.phase).toBe('finished')
    expect(Object.keys(end.public['身份公布'] as object)).toHaveLength(7)
    expect(String(end.public['lastResult'])).toMatch(/(狼人|好人)获胜/)
  }, 120000)

  it('keeps roles, wolf talk, checks and the witch report with their owners', async () => {
    const f = await host()
    await f.start()
    await f.playToEnd()
    const roleOf = (id: string) =>
      f.seen.map(s => (s.self === id ? /"身份":"([^"]+)"/.exec(s.text)?.[1] : undefined)).find(Boolean)
    for (const s of f.seen.filter(s => NPCS.includes(s.self))) {
      const role = roleOf(s.self)
      expect(role).toBeDefined()
      expect(s.text).not.toMatch(/"(身份表|夜间|夜序|票)"/)
      if (role !== '狼人') expect(s.text).not.toMatch(new RegExp(`"狼同伴"|"同伴提议"|${WHISPER}`))
      if (role !== '预言家') expect(s.text).not.toContain('"验人记录"')
      if (role !== '女巫') expect(s.text).not.toContain('"今晚被刀"')
    }
    // A dawn that does not end the game is delivered only to whoever closed the night.
    for (const id of NPCS) {
      const views = JSON.parse(f.observations(id)) as { value: { content?: WorldJsonObject; observerId?: string } }[]
      for (const o of views) {
        const description = String(o.value.content?.resultDescription ?? '')
        if (description.includes('天亮了') && !description.includes('身份公布'))
          expect(o.value.content!.actorId).toBe(id)
      }
    }
  }, 120000)

  it('refuses out-of-turn and invalid-target operations without new events', async () => {
    const f = await host()
    await f.start('村民')
    const before = f.events().length
    await expect(f.request('vote', { target: 'GPT' })).rejects.toThrow()
    await expect(f.request('kill', { target: 'GPT' })).rejects.toThrow()
    await expect(f.request('vote', { target: '路人' })).rejects.toThrow()
    expect(f.events().length).toBe(before)
  }, 120000)

  it('a wolf who only talks keeps the turn', async () => {
    const f = await host({ talkOnly: true })
    await f.start('村民')
    const wolf = (await f.game()).turn
    await f.request('retry')
    const g = await f.game()
    expect(g.phase).toBe('night')
    expect(g.turn).toBe(wolf)
  }, 120000)

  it('the player cannot speak when it is not their turn to speak', async () => {
    const f = await host({ talkOnly: true })
    await f.start('村民')
    const before = f.events().length
    await expect(f.runtime.submit('我觉得 GPT 是狼。')).rejects.toThrow()
    expect(f.events().length).toBe(before)
  }, 120000)

  it('a player wolf whispers to the partner only', async () => {
    const f = await host()
    await f.start('狼人')
    while ((await f.game()).turn !== PLAYER) await f.request('retry')
    const partner = idOfName(String(mine(await f.game())['狼同伴']))
    const text = '我们今晚刀 Qwen 吧'
    await f.runtime.submit(`/act speak ${JSON.stringify({ text, scope: 'direct', addresseeIds: [partner] })}`)
    expect(f.observations(partner)).toContain(text)
    for (const id of NPCS.filter(id => id !== partner)) expect(f.observations(id)).not.toContain(text)
  }, 120000)

  it('a second game starts fresh and everyone observed the first reveal', async () => {
    const f = await host()
    await f.start()
    const firstId = ((await f.runtime.state()).activities as WorldJsonObject[]).find(
      a => a.activityKey === 'werewolf',
    )!.id
    await f.playToEnd()
    for (const id of NPCS) expect(f.observations(id)).toContain('身份公布：')
    await f.start()
    const second = ((await f.runtime.state()).activities as WorldJsonObject[]).find(a => a.activityKey === 'werewolf')!
    expect(second.id).not.toBe(firstId)
    // NPCs may already have played on if the player died on night one, so only the deal is checked.
    expect((second.game as unknown as Game).public['座位']).toHaveLength(7)
  }, 120000)
})
