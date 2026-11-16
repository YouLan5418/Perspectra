import {
  addCard,
  addZone,
  finish,
  move,
  request,
  random,
  shuffle,
  type RulePack,
  type Table,
  type Data,
} from '../engine.ts'
import {
  cardKind,
  commonZones,
  draw,
  hand,
  nextSeat,
  option,
  takeTurn,
  seatLabel,
  validateCommonZones,
} from './shared.ts'
interface Identity {
  hp: Record<string, number>
  roles: Record<string, string>
  ward: Record<string, boolean>
  turns: number
  lastTrace: string[]
}
const data = (s: Table) => s.data as unknown as Identity
export const identityRule: RulePack = {
  id: 'identity',
  version: 1,
  title: '灯塔守望 · 身份对战',
  initialize(s) {
    if (s.seats.length < 3) throw new Error('IDENTITY_REQUIRES_THREE')
    commonZones(s)
    addZone(s, 'paid', 'public')
    const d: Identity = { hp: {}, roles: {}, ward: {}, turns: 0, lastTrace: [] }
    const roles: string[] = s.seats.map((_, i) => (i === 0 ? '守灯人' : i === 1 ? '逐影者' : '旅人'))
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(random(s) * (i + 1))
      ;[roles[i], roles[j]] = [roles[j]!, roles[i]!]
    }
    for (const [index, seat] of s.seats.entries()) {
      d.hp[seat.id] = 2
      d.roles[seat.id] = roles[index]!
      d.ward[seat.id] = true
      // One public starter attack; all other cards are dealt from the hidden shuffled deck.
      for (const kind of ['attack']) {
        const n = Object.keys(s.cards).length
        addCard(
          s,
          { id: kind, title: { attack: '光矢', defend: '折光', aid: '续灯' }[kind]!, tags: [kind] },
          `card:${n}`,
          hand(seat.id),
        )
      }
    }
    for (let i = 0; i < 36; i++) {
      const kind = i % 4 === 0 ? 'aid' : i % 4 === 1 ? 'defend' : 'attack'
      addCard(
        s,
        { id: kind, title: kind === 'attack' ? '光矢' : kind === 'defend' ? '折光' : '续灯', tags: [kind] },
        `deck:${i}`,
        'deck',
      )
    }
    shuffle(s, 'deck')
    for (const seat of s.seats) draw(s, seat.id, 3)
    s.data = d as unknown as Data
    takeTurn(s, s.seats[0]!.id)
  },
  choices(s, seat) {
    const cards = s.zones[hand(seat)]!.cards
    if (s.pending!.kind === 'defense')
      return [
        ...cards
          .filter(id => cardKind(s, id) === 'defend')
          .map(id => option(`defend:${id}`, '支付折光，取消攻击', { card: id })),
        option('pass', '放弃防御，进入求援'),
      ]
    if (s.pending!.kind === 'aid')
      return [
        ...cards
          .filter(id => cardKind(s, id) === 'aid')
          .map(id => option(`aid:${id}`, '支付续灯，援助目标', { card: id })),
        option('pass', '放弃求援'),
      ]
    return [
      ...cards
        .filter(id => cardKind(s, id) === 'attack')
        .flatMap(card =>
          s.seats
            .filter(target => target.id !== seat && data(s).hp[target.id]! > 0)
            .map(target =>
              option(`attack:${card}:${target.id}`, `光矢 → ${target.label}`, { card, target: target.id }),
            ),
        ),
      option('draw', '抽一张并结束回合'),
    ]
  },
  apply(s, seat, choice) {
    const kind = s.pending!.kind
    if (kind === 'action') {
      if (choice.id === 'draw') {
        draw(s, seat)
        endTurn(s)
        return
      }
      const value = choice.value as { card: string; target: string }
      move(s, [value.card], hand(seat), 'paid')
      s.frames.push({
        kind: 'attack',
        source: seat,
        targets: [value.target],
        cost: [value.card],
        amount: 2,
        cancelled: false,
        trace: [],
      })
      s.log.push(`${seatLabel(s, seat)}声明光矢并支付费用，等待${seatLabel(s, value.target)}防御。`)
      request(s, 'defense', [value.target])
      return
    }
    const frame = s.frames.at(-1)!
    if (kind === 'defense' && choice.id !== 'pass') {
      payResponse(s, seat, choice.value as { card: string })
      frame.cancelled = true
      frame.trace = ['10:defense-cancel']
      data(s).lastTrace = ['10:defense-cancel']
      s.log.push('折光取消攻击；已支付的攻击与响应费用均进入弃牌，不退款。')
      cleanup(s)
      endTurn(s)
      return
    }
    if (kind === 'defense') {
      const helpers = s.seats
        .filter(
          row => row.id !== frame.source && !(frame.targets as string[]).includes(row.id) && data(s).hp[row.id]! > 0,
        )
        .map(row => row.id)
      if (helpers.length) {
        request(s, 'aid', helpers)
        return
      }
    }
    if (kind === 'aid' && choice.id !== 'pass') {
      payResponse(s, seat, choice.value as { card: string })
      frame.amount = Math.max(0, Number(frame.amount) - 1)
      ;(frame.trace as string[]).push('20:aid-reduce')
      s.log.push(`${seatLabel(s, seat)}应答求援，伤害减一。`)
    }
    if (kind === 'aid' && Object.keys(s.pending!.answers).length < s.pending!.seats.length) return
    const target = (frame.targets as string[])[0]!
    // Explicit deterministic modifier order: aid(20), ward(30), damage(40).
    if (data(s).ward[target]) {
      data(s).ward[target] = false
      frame.amount = Math.max(0, Number(frame.amount) - 1)
      ;(frame.trace as string[]).push('30:ward-reduce')
    }
    ;(frame.trace as string[]).push('40:damage')
    data(s).hp[target] = Math.max(0, data(s).hp[target]! - Number(frame.amount))
    data(s).lastTrace = [...(frame.trace as string[])]
    s.log.push(
      `依次结算${(frame.trace as string[]).map(step => ({ '20:aid-reduce': '援助', '30:ward-reduce': '护光', '40:damage': '伤害' })[step]).join('、')}，${seatLabel(s, target)}受到 ${frame.amount} 伤害。`,
    )
    cleanup(s)
    if (data(s).hp[target] === 0 && data(s).roles[target] !== '旅人') {
      const winningRole = data(s).roles[target] === '守灯人' ? '逐影者' : '守灯人'
      finish(
        s,
        s.seats.filter(row => data(s).roles[row.id] === winningRole).map(row => row.id),
        '身份对战结束。',
      )
      return
    }
    endTurn(s)
  },
  publicData: s => ({
    hp: { ...data(s).hp },
    ward: { ...data(s).ward },
    frame: s.frames.map(f => ({ kind: f.kind!, source: f.source!, targets: f.targets!, amount: f.amount! })),
  }),
  privateData: (s, seat) => ({ role: data(s).roles[seat]! }),
  validate(s) {
    validateCommonZones(s, ['paid'])
    if (s.pending && !['action', 'defense', 'aid'].includes(s.pending.kind)) throw new Error('IDENTITY_REQUEST')
    if (s.pending?.kind === 'action' && (s.frames.length || s.zones.paid!.cards.length))
      throw new Error('IDENTITY_UNSETTLED_COST')
    if (
      s.pending &&
      s.pending.kind !== 'action' &&
      (s.frames.length !== 1 ||
        s.frames[0]!.kind !== 'attack' ||
        !Array.isArray(s.frames[0]!.cost) ||
        !s.zones.paid!.cards.length)
    )
      throw new Error('IDENTITY_FRAME')
    if (s.pending) {
      const frame = s.frames[0]
      const expected =
        s.pending.kind === 'action'
          ? [s.turnOwner]
          : s.pending.kind === 'defense'
            ? (frame!.targets as string[])
            : s.seats
                .filter(
                  row =>
                    row.id !== frame!.source &&
                    !(frame!.targets as string[]).includes(row.id) &&
                    data(s).hp[row.id]! > 0,
                )
                .map(row => row.id)
      if (s.pending.seats.join() !== expected.join()) throw new Error('IDENTITY_REQUEST_SEATS')
      if (
        frame &&
        (frame.source !== s.turnOwner ||
          !Array.isArray(frame.targets) ||
          frame.targets.length !== 1 ||
          !s.seats.some(row => row.id === (frame.targets as string[])[0]) ||
          frame.targets[0] === frame.source ||
          !Number.isInteger(frame.amount) ||
          Number(frame.amount) < 0 ||
          Number(frame.amount) > 2 ||
          (frame.cost as string[]).length !== 1 ||
          (frame.cost as string[]).some(id => !s.zones.paid!.cards.includes(id) || cardKind(s, id) !== 'attack'))
      )
        throw new Error('IDENTITY_FRAME_BINDING')
    }
    if (
      s.seats.some(
        row =>
          !Number.isInteger(data(s).hp[row.id]) ||
          data(s).hp[row.id]! < 0 ||
          data(s).hp[row.id]! > 2 ||
          !['守灯人', '逐影者', '旅人'].includes(data(s).roles[row.id]!) ||
          typeof data(s).ward[row.id] !== 'boolean',
      )
    )
      throw new Error('IDENTITY_HP')
  },
}
function payResponse(s: Table, seat: string, value: { card: string }): void {
  move(s, [value.card], hand(seat), 'paid')
}
function cleanup(s: Table): void {
  move(s, [...s.zones.paid!.cards], 'paid', 'discard')
  s.frames.pop()
}
function endTurn(s: Table): void {
  if (++data(s).turns >= 20) {
    finish(
      s,
      s.seats.filter(row => data(s).roles[row.id] === '守灯人').map(row => row.id),
      '守灯人坚持二十回合。',
    )
    return
  }
  s.round++
  let next = nextSeat(s, s.turnOwner!)
  while (data(s).hp[next] === 0) next = nextSeat(s, next)
  takeTurn(s, next)
}
