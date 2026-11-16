import { addCard, finish, move, request, shuffle, type RulePack, type Table } from '../engine.ts'
import {
  commonZones,
  draw,
  hand,
  cardKind,
  nextSeat,
  option,
  takeTurn,
  seatLabel,
  validateCommonZones,
} from './shared.ts'
const colors = ['red', 'blue', 'green', 'gold']
interface Colors {
  color: string
  direction: number
  turns: number
}
const data = (s: Table) => s.data as unknown as Colors
export const colorRule: RulePack = {
  id: 'colors',
  version: 1,
  title: '四色接龙',
  initialize(s) {
    commonZones(s)
    s.data = { color: 'red', direction: 1, turns: 0 }
    for (let copy = 0; copy < 3; copy++)
      for (const color of colors)
        for (const kind of ['plain', 'reverse'])
          addCard(
            s,
            {
              id: `${color}-${kind}`,
              title: `${color} · ${kind === 'reverse' ? '折返' : '连色'}`,
              tags: [color, kind],
            },
            `${copy}:${color}:${kind}`,
            'deck',
          )
    for (let i = 0; i < 3; i++)
      addCard(s, { id: 'wild', title: '映彩 · 自选颜色', tags: ['wild'] }, `wild:${i}`, 'deck')
    shuffle(s, 'deck')
    for (const seat of s.seats) draw(s, seat.id, 3)
    takeTurn(s, s.seats[0]!.id)
  },
  choices(s, seat) {
    if (s.pending!.kind === 'color') return colors.map(c => option(c, `选 ${c}`))
    const choices = s.zones[hand(seat)]!.cards.filter(
      id => cardKind(s, id) === 'wild' || cardKind(s, id).startsWith(data(s).color),
    ).map(id => option(id, `打出 ${s.definitions[cardKind(s, id)]!.title}`))
    return [...choices, option('draw', '抽一张并过牌')]
  },
  apply(s, seat, choice) {
    const d = data(s)
    if (s.pending!.kind === 'color') {
      d.color = String(choice.value)
      advance(s, seat)
      return
    }
    if (choice.id === 'draw') {
      if (!s.zones.deck!.cards.length && s.zones.discard!.cards.length) {
        move(s, [...s.zones.discard!.cards], 'discard', 'deck')
        shuffle(s, 'deck')
      }
      draw(s, seat)
      s.log.push(`${seatLabel(s, seat)}抽牌。`)
    } else {
      move(s, [choice.id], hand(seat), 'discard')
      const kind = cardKind(s, choice.id)
      s.log.push(`${seatLabel(s, seat)}打出${s.definitions[kind]!.title}。`)
      if (kind === 'wild') {
        request(s, 'color', [seat])
        return
      }
      d.color = kind.split('-')[0]!
      if (kind.endsWith('reverse')) d.direction *= -1
    }
    advance(s, seat)
  },
  publicData: s => ({ color: data(s).color, direction: data(s).direction }),
  privateData: () => ({}),
  validate(s) {
    validateCommonZones(s)
    if (s.pending && (s.pending.seats.join() !== s.turnOwner || !['action', 'color'].includes(s.pending.kind)))
      throw new Error('COLOR_REQUEST')
    if (!colors.includes(data(s).color) || ![1, -1].includes(data(s).direction)) throw new Error('COLOR_STATE')
  },
}
function advance(s: Table, seat: string): void {
  if (!s.zones[hand(seat)]!.cards.length) {
    finish(s, [seat], '手牌出尽，接龙获胜。')
    return
  }
  if (++data(s).turns >= 40) {
    const least = Math.min(...s.seats.map(row => s.zones[hand(row.id)]!.cards.length))
    finish(
      s,
      s.seats.filter(row => s.zones[hand(row.id)]!.cards.length === least).map(row => row.id),
      '四十步后手牌最少者获胜。',
    )
    return
  }
  s.round++
  takeTurn(s, nextSeat(s, seat, data(s).direction))
}
