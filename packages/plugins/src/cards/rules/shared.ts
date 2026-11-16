import { addZone, move, request, type Table, type Choice } from '../engine.ts'
export const hand = (seat: string) => `hand:${seat}`
export const cardKind = (table: Table, id: string) => table.cards[id]!.definition
export function commonZones(table: Table): void {
  addZone(table, 'deck', 'hidden')
  addZone(table, 'discard', 'public')
  for (const seat of table.seats) addZone(table, hand(seat.id), 'owner', seat.id)
}
export function draw(table: Table, seat: string, count = 1): void {
  const ids = table.zones.deck!.cards.slice(0, count)
  if (ids.length) move(table, ids, 'deck', hand(seat))
}
export function nextSeat(table: Table, from: string, direction = 1): string {
  const index = table.seats.findIndex(s => s.id === from)
  return table.seats[(index + direction + table.seats.length) % table.seats.length]!.id
}
export function takeTurn(table: Table, seat: string): void {
  table.turnOwner = seat
  request(table, 'action', [seat])
}
export const option = (id: string, label: string, value: Choice['value'] = id): Choice => ({ id, label, value })

export const seatLabel = (table: Table, seat: string) => table.seats.find(row => row.id === seat)?.label ?? seat
/** Visibility/ownership is rule policy, never a restored save's authority to disclose cards. */
export function validateCommonZones(table: Table, extra: string[] = []): void {
  const expected = ['deck', 'discard', ...table.seats.map(seat => hand(seat.id)), ...extra].sort()
  if (Object.keys(table.zones).sort().join() !== expected.join()) throw new Error('CARD_ZONE_POLICY')
  for (const [id, zone] of Object.entries(table.zones)) {
    const seat = table.seats.find(seat => hand(seat.id) === id)
    if (zone.visibility !== (seat ? 'owner' : id === 'deck' ? 'hidden' : 'public') || zone.owner !== (seat?.id ?? null))
      throw new Error('CARD_ZONE_POLICY')
  }
}
