import { addCard, addZone, finish, move, request, type RulePack } from '../engine.ts'
import { option } from './shared.ts'
export const auctionRule: RulePack = {
  id: 'auction',
  version: 1,
  title: '三席密封竞价',
  initialize(s) {
    if (s.seats.length !== 3) throw new Error('AUCTION_REQUIRES_THREE')
    addZone(s, 'lot', 'public')
    addZone(s, 'awarded', 'public')
    addCard(s, { id: 'lantern', title: '纸灯 · 本轮拍品', tags: ['lot'] }, 'lot:1', 'lot')
    s.data = { revealed: {} }
    request(
      s,
      'sealed-bid',
      s.seats.map(row => row.id),
      true,
    )
    // No sequential owner exists in this rule pack.
    s.turnOwner = null
  },
  choices: () => Array.from({ length: 10 }, (_, value) => option(`bid:${value}`, `密封报价 ${value}`, value)),
  apply(s) {
    const pending = s.pending!
    s.log.push('一席已密封提交。')
    if (Object.keys(pending.answers).length !== pending.seats.length) return
    const bids = pending.answers as Record<string, number>
    s.data.revealed = { ...bids }
    const high = Math.max(...Object.values(bids))
    // Ties follow declared seat order, independent of submission order.
    const winner = s.seats.find(seat => bids[seat.id] === high)!.id
    move(s, [...s.zones.lot!.cards], 'lot', 'awarded')
    finish(s, [winner], `揭晓报价，${winner}以 ${high} 获得纸灯；同价按席位顺序。`)
  },
  publicData: s => ({ revealed: s.data.revealed! }),
  privateData: (s, seat) => ({ ownBid: s.pending?.answers[seat] ?? null }),
  validate(s) {
    if (s.seats.length !== 3) throw new Error('AUCTION_REQUIRES_THREE')
    if (
      s.pending &&
      (s.pending.kind !== 'sealed-bid' ||
        !s.pending.sealed ||
        s.pending.seats.join() !== s.seats.map(row => row.id).join())
    )
      throw new Error('AUCTION_REQUEST_INVALID')
    for (const bid of Object.values(s.pending?.answers ?? {}))
      if (typeof bid !== 'number' || !Number.isInteger(bid) || bid < 0 || bid > 9)
        throw new Error('AUCTION_BID_INVALID')
  },
}
