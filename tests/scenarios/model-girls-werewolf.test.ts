import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

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
    roleOf: (id: string) => (t.state.game.internal['身份表'] as Record<string, string>)[id]!,
    who: (role: string) => EVERYONE.filter(id => t.roleOf(id) === role),
    alive: () => (t.state.game.public['存活'] as string[]).map(n => EVERYONE.find(id => NAME[id] === n)!),
    good: () => t.alive().filter(id => t.roleOf(id) !== '狼人'),
    /** Resolve as whoever holds the turn (or `actor`); a refusal returns the reason and keeps the state. */
    try(operation: string, parameters: Record<string, unknown>, actor = t.state.game.turn!): Resolved {
      const r = plain(script.resolve(t.state, actor, operation, parameters, {}, {}) as Resolved)
      if (r.game) t.state = { ...t.state, game: r.game }
      return r
    },
    act(operation: string, parameters: Record<string, unknown>, actor?: string): Resolved {
      const r = t.try(operation, parameters, actor)
      if (r.rejectReason) throw new Error(r.rejectReason)
      return r
    },
    speak() {
      const next = plain(script.onPublished(t.state, t.state.game.turn, null) as Game | null)
      if (next) t.state = { ...t.state, game: next }
      return next
    },
    /** One night with fixed choices; unspecified roles do the least they can. */
    night(choice: { kill: string; potion?: Record<string, unknown>; check?: string }) {
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
    day(vote: (voter: string) => string) {
      while (t.state.game.phase === 'day-speak') expect(t.speak()).not.toBeNull()
      const results: Resolved[] = []
      while (t.state.game.phase === 'vote') results.push(t.act('vote', { target: vote(t.state.game.turn!) }))
      return results
    },
  }
  return t
}

describe('werewolf rules', () => {
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
