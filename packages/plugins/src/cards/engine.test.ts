import { describe, expect, it } from 'vitest'
import {
  createTable,
  legalChoices,
  move,
  project,
  replay,
  shuffle,
  submit,
  validate,
  type RulePack,
  type Table,
} from './engine.ts'
import { colorRule } from './rules/colors.ts'
import { identityRule } from './rules/identity.ts'
import { auctionRule } from './rules/auction.ts'
const seats = ['a', 'b', 'c'].map((id, i) => ({ id, controller: `controller:${i}`, label: id }))
const select = (s: Table, rule: RulePack, seat: string, prefix: string) => {
  const c = legalChoices(s, rule, seat).find(c => c.id.startsWith(prefix))!
  expect(c, `missing ${prefix}`).toBeDefined()
  return submit(s, rule, {
    request: s.pending!.id,
    seat,
    choice: c.id,
    actor: s.seats.find(x => x.id === seat)!.controller,
  })
}
describe('shared deterministic card foundation', () => {
  it('runs all three rule packs to completion through one validation/submit path and replays identical state', () => {
    for (const rule of [colorRule, identityRule, auctionRule]) {
      let s = createTable(rule, seats, 41)
      for (let step = 0; step < 300 && !s.result; step++) {
        const seat = s.pending!.seats.find(seat => !Object.hasOwn(s.pending!.answers, seat))!
        const choices = legalChoices(s, rule, seat)
        const choice = rule === identityRule && s.pending!.kind !== 'action' ? choices.at(-1)! : choices[0]!
        s = submit(s, rule, {
          request: s.pending!.id,
          seat,
          choice: choice.id,
          actor: seats.find(x => x.id === seat)!.controller,
        })
      }
      expect(s.result, rule.id).not.toBeNull()
      expect(replay(rule, seats, 41, s.accepted)).toEqual(s)
      expect(JSON.parse(JSON.stringify(s))).toEqual(s)
      validate(s, rule)
    }
  })
  it('preserves unique custody, rejects illegal moves/choices and separates definition from instance', () => {
    const s = createTable(identityRule, seats, 7),
      before = JSON.stringify(s)
    expect(Object.values(s.cards).filter(c => c.definition === 'attack').length).toBeGreaterThan(1)
    expect(() => move(s, ['card:0', 'ghost'], 'hand:a', 'discard')).toThrow('CARD_MOVE_INVALID')
    expect(() =>
      submit(s, identityRule, { request: s.pending!.id, seat: 'a', actor: 'controller:0', choice: 'ghost' }),
    ).toThrow('CARD_ILLEGAL_CHOICE')
    expect(JSON.stringify(s)).toBe(before)
    const corrupt = structuredClone(s)
    corrupt.zones.discard!.cards.push(corrupt.zones['hand:a']!.cards[0]!)
    expect(() => validate(corrupt, identityRule)).toThrow('CARD_UNIQUE_ZONE')
    for (const change of [{ visibility: 'public' as const }, { owner: 'a' }]) {
      const leak = structuredClone(s)
      Object.assign(leak.zones['hand:b']!, change)
      expect(() => validate(leak, identityRule)).toThrow('CARD_ZONE_POLICY')
    }
    expect(() => validate({ ...s, version: 99 }, identityRule)).toThrow('CARD_VERSION_INCOMPATIBLE')
  })
  it('identity: paid attack survives serialized defense/aid; cancellation cleans both fees without refund; third seat responds without stealing the turn', () => {
    const seed = Array.from({ length: 100 }, (_, i) => i + 1).find(seed => {
      const table = createTable(identityRule, seats, seed)
      return (
        table.zones['hand:b']!.cards.some(id => table.cards[id]!.definition === 'defend') &&
        table.zones['hand:c']!.cards.some(id => table.cards[id]!.definition === 'aid')
      )
    })!
    const start = createTable(identityRule, seats, seed)
    const defense = select(start, identityRule, 'a', 'attack:card:0:b')
    const wrongSeat = structuredClone(defense)
    wrongSeat.pending!.seats = ['a']
    expect(() => validate(wrongSeat, identityRule)).toThrow('IDENTITY_REQUEST_SEATS')
    const lostCost = structuredClone(defense)
    move(lostCost, [...lostCost.zones.paid!.cards], 'paid', 'discard')
    expect(() => validate(lostCost, identityRule)).toThrow('IDENTITY_FRAME')
    expect(defense.turnOwner).toBe('a')
    expect(defense.zones.paid!.cards).toEqual(['card:0'])
    const cancel = select(JSON.parse(JSON.stringify(defense)), identityRule, 'b', 'defend:')
    expect(cancel.frames).toEqual([])
    expect(cancel.zones.paid!.cards).toEqual([])
    expect(cancel.zones['hand:a']!.cards).not.toContain('card:0')
    expect(cancel.zones.discard!.cards).toHaveLength(2)
    const aid = select(defense, identityRule, 'b', 'pass')
    expect(aid.turnOwner).toBe('a')
    expect(aid.pending!.seats).toEqual(['c'])
    const helped = select(JSON.parse(JSON.stringify(aid)), identityRule, 'c', 'aid:')
    const hurt = select(aid, identityRule, 'c', 'pass')
    expect((helped.data.hp as Record<string, number>).b).toBe(2)
    expect((hurt.data.hp as Record<string, number>).b).toBe(1)
    expect(helped.data.lastTrace).toEqual(['20:aid-reduce', '30:ward-reduce', '40:damage'])
    expect(hurt.data.lastTrace).toEqual(['30:ward-reduce', '40:damage'])
    expect(defense.accepted).toHaveLength(1)
    expect(() => submit(aid, identityRule, { ...defense.accepted[0]! })).toThrow('CARD_STALE_REQUEST')
    expect(() =>
      submit(aid, identityRule, { request: aid.pending!.id, seat: 'c', actor: 'controller:0', choice: 'pass' }),
    ).toThrow('CARD_UNAUTHORIZED')
  })
  it('auction: one logical sealed request, two arrival orders, restore, duplicate and unauthorized rejection, order-independent tie policy', () => {
    const final: Table[] = []
    for (const order of [
      ['a', 'b', 'c'],
      ['c', 'a', 'b'],
    ]) {
      let s = createTable(auctionRule, seats, 3)
      const requestId = s.pending!.id
      for (const [index, seat] of order.entries()) {
        const before = s
        s = select(s, auctionRule, seat, `bid:${seat === 'a' ? 9 : 7}`)
        if (index < 2) {
          expect(s.pending!.id).toBe(requestId)
          const view = project(s, auctionRule, seats.find(x => !Object.hasOwn(s.pending!.answers, x.id))!.controller)
          expect(JSON.stringify(view)).not.toContain('ownBid":9')
          expect((view.details as { revealed: unknown }).revealed).toEqual({})
          expect(() => select(s, auctionRule, seat, 'bid:')).toThrow()
          s = JSON.parse(JSON.stringify(s))
        }
        expect(before).not.toBe(s)
      }
      final.push(s)
    }
    expect(final[0]!.result).toEqual(final[1]!.result)
    expect(final[0]!.data.revealed).toEqual({ a: 9, b: 7, c: 7 })
    const s = createTable(auctionRule, seats, 3)
    expect(() =>
      submit(s, auctionRule, { request: s.pending!.id, seat: 'b', choice: 'bid:9', actor: 'controller:0' }),
    ).toThrow('CARD_UNAUTHORIZED')
  })
  it('rejects corrupt sealed answers on recovery and varies hidden identity/deck with recorded randomness', () => {
    const corrupt = createTable(auctionRule, seats, 1)
    corrupt.pending!.answers.a = 99
    expect(() => validate(corrupt, auctionRule)).toThrow('AUCTION_BID_INVALID')
    const a = createTable(identityRule, seats, 1),
      b = createTable(identityRule, seats, 98765)
    expect(
      new Set(
        Array.from({ length: 16 }, (_, i) =>
          JSON.stringify(createTable(identityRule, seats, (i + 1) * 123456789).data.roles),
        ),
      ).size,
    ).toBeGreaterThan(1)
    expect(a.zones.deck).not.toEqual(b.zones.deck)
    expect(a.draws.length).toBeGreaterThan(0)
  })
  it('colors: covers draw/discard, color choice, reverse order and victory', () => {
    let drawSeen = false,
      reverseSeen = false,
      colorSeen = false,
      discardSeen = false,
      winSeen = false
    for (let seed = 1; seed < 15; seed++) {
      let s = createTable(colorRule, seats, seed)
      for (let i = 0; i < 150 && !s.result; i++) {
        const seat = s.pending!.seats[0]!
        const choices = legalChoices(s, colorRule, seat)
        const chosen = i === 0 ? choices.at(-1)! : (choices.find(c => c.id.includes('reverse')) ?? choices[0]!)
        drawSeen ||= chosen.id === 'draw'
        colorSeen ||= s.pending!.kind === 'color'
        const old = s.data.direction
        s = submit(s, colorRule, {
          request: s.pending!.id,
          seat,
          choice: chosen.id,
          actor: seats.find(x => x.id === seat)!.controller,
        })
        reverseSeen ||= s.data.direction !== old
        discardSeen ||= s.zones.discard!.cards.length > 0
      }
      winSeen ||= s.result !== null
    }
    expect([drawSeen, reverseSeen, colorSeen, discardSeen, winSeen]).toEqual([true, true, true, true, true])
  })
  it('projection hides other hands, identities/deck order and breaks public handle correlation after show then shuffle', () => {
    const s = createTable(identityRule, seats, 5)
    const view = project(s, identityRule, 'controller:0')
    expect(view.own as { role: string }[]).toHaveLength(1)
    expect(JSON.stringify(view)).not.toContain('roles')
    expect((view.zones as Record<string, unknown>)['hand:b']).toEqual({ count: 4 })
    expect((view.zones as Record<string, unknown>).deck).toEqual({ count: 27 })
    move(s, [...s.zones['hand:a']!.cards], 'hand:a', 'discard')
    const shownView = project(s, identityRule, 'controller:1')
    const shown = JSON.stringify(shownView)
    move(s, [...s.zones.discard!.cards], 'discard', 'deck')
    shuffle(s, 'deck')
    const hidden = JSON.stringify(project(s, identityRule, 'controller:1'))
    expect(shown).toContain(':discard:')
    expect(hidden).not.toContain(':discard:')
    const oldHandles = ((shownView.zones as Record<string, { cards?: { handle: string }[] }>).discard!.cards ?? []).map(
      card => card.handle,
    )
    move(s, s.zones.deck!.cards.slice(0, 3), 'deck', 'discard')
    const newlyShown = project(s, identityRule, 'controller:1')
    expect(JSON.stringify(newlyShown)).not.toContain('"card:0"')
    expect(
      (newlyShown.zones as Record<string, { cards: { handle: string }[] }>).discard!.cards.every(
        card => !oldHandles.includes(card.handle),
      ),
    ).toBe(true)
    expect(hidden).not.toContain('"card:0"')
    expect(hidden).not.toContain('deck:')
    expect(hidden).not.toContain('"rng"')
  })
})
it('permits multi-card, non-character targets and multiple seats controlled by one actor without engine changes', () => {
  const rule: RulePack = {
    id: 'contract-probe',
    version: 1,
    title: '共同献灯',
    initialize(s) {
      s.zones = {
        reserve: { visibility: 'owner', owner: 'a', cards: [] },
        shrine: { visibility: 'public', owner: null, cards: [] },
      }
      s.definitions.light = { id: 'light', title: '灯芯', tags: [] }
      s.cards = { x: { id: 'x', definition: 'light' }, y: { id: 'y', definition: 'light' } }
      s.zones.reserve!.cards = ['x', 'y']
      s.pending = { id: 'q1', kind: 'offer', seats: ['a', 'b'], sealed: true, answers: {} }
      s.nextRequest = 1
    },
    choices: (_s, seat) => [
      { id: 'offer', label: '共同献灯', value: { cards: seat === 'a' ? ['x', 'y'] : [], target: 'altar:paper-lamp' } },
    ],
    apply(s, seat, c) {
      const value = c.value as { cards: string[]; target: string }
      if (value.cards.length) move(s, value.cards, 'reserve', 'shrine')
      if (Object.keys(s.pending!.answers).length === 2) {
        s.pending = null
        s.result = { winners: [seat], reason: value.target }
      }
    },
    publicData: () => ({}),
    privateData: () => ({}),
    validate() {},
  }
  const initial = createTable(
    rule,
    [
      { id: 'a', controller: 'shared', label: '甲' },
      { id: 'b', controller: 'shared', label: '乙' },
    ],
    1,
  )
  const first = submit(initial, rule, { request: 'q1', seat: 'a', actor: 'shared', choice: 'offer' })
  expect(first.zones.shrine!.cards).toEqual(['x', 'y'])
  expect(project(first, rule, 'shared').own as unknown[]).toHaveLength(2)
  const final = submit(first, rule, { request: 'q1', seat: 'b', actor: 'shared', choice: 'offer' })
  expect(final.result!.reason).toBe('altar:paper-lamp')
})
