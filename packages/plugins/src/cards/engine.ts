/** Host-free deterministic card table. Rule packs own all timing, choices and outcomes. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Data = { [key: string]: Json }
export interface Seat {
  id: string
  controller: string
  label: string
}
export interface CardDefinition {
  id: string
  title: string
  tags: string[]
}
export interface CardInstance {
  id: string
  definition: string
}
export interface Zone {
  visibility: 'public' | 'owner' | 'hidden'
  owner: string | null
  cards: string[]
}
export interface Choice {
  id: string
  label: string
  value: Json
}
export interface PendingRequest {
  id: string
  kind: string
  seats: string[]
  sealed: boolean
  answers: Record<string, Json>
}
export interface AcceptedInput {
  request: string
  seat: string
  choice: string
  actor: string
}
export interface Table {
  schema: 1
  rule: string
  version: number
  seats: Seat[]
  definitions: Record<string, CardDefinition>
  cards: Record<string, CardInstance>
  zones: Record<string, Zone>
  data: Data
  frames: Data[]
  pending: PendingRequest | null
  nextRequest: number
  turnOwner: string | null
  round: number
  rng: number
  /** Recorded uint32 draws keep Host WorldJson integer-only. */
  draws: number[]
  exposure: number
  accepted: AcceptedInput[]
  log: string[]
  result: { winners: string[]; reason: string } | null
}
export interface RulePack {
  id: string
  version: number
  title: string
  initialize(table: Table): void
  choices(table: Table, seat: string): Choice[]
  apply(table: Table, seat: string, choice: Choice): void
  publicData(table: Table): Data
  privateData(table: Table, seat: string): Data
  validate(table: Table): void
}
export function assertCompatible(table: Table, rule: RulePack): void {
  if (table.schema !== 1 || table.rule !== rule.id || table.version !== rule.version)
    throw new Error('CARD_VERSION_INCOMPATIBLE')
}
export function validate(table: Table, rule: RulePack): void {
  assertCompatible(table, rule)
  if (!table.seats.length || new Set(table.seats.map(s => s.id)).size !== table.seats.length)
    throw new Error('CARD_SEATS_INVALID')
  const seen = new Set<string>()
  for (const zone of Object.values(table.zones)) {
    if (zone.owner !== null && !table.seats.some(s => s.id === zone.owner)) throw new Error('CARD_ZONE_OWNER')
    for (const id of zone.cards) {
      if (!table.cards[id] || seen.has(id)) throw new Error('CARD_UNIQUE_ZONE')
      seen.add(id)
    }
  }
  if (seen.size !== Object.keys(table.cards).length) throw new Error('CARD_UNIQUE_ZONE')
  for (const [id, card] of Object.entries(table.cards))
    if (id !== card.id || !table.definitions[card.definition]) throw new Error('CARD_DEFINITION_INVALID')
  const pending = table.pending
  if (
    pending &&
    (pending.id !== `q${table.nextRequest}` ||
      pending.seats.length === 0 ||
      new Set(pending.seats).size !== pending.seats.length ||
      pending.seats.some(id => !table.seats.some(s => s.id === id)) ||
      Object.keys(pending.answers).some(id => !pending.seats.includes(id)))
  )
    throw new Error('CARD_REQUEST_INVALID')
  if (table.result && (table.pending || table.frames.length)) throw new Error('CARD_UNSETTLED_RESULT')
  rule.validate(table)
}
export function createTable(rule: RulePack, seats: Seat[], seed: number): Table {
  const table: Table = {
    schema: 1,
    rule: rule.id,
    version: rule.version,
    seats: structuredClone(seats),
    definitions: {},
    cards: {},
    zones: {},
    data: {},
    frames: [],
    pending: null,
    nextRequest: 0,
    turnOwner: null,
    round: 1,
    rng: seed >>> 0 || 1,
    draws: [],
    exposure: 0,
    accepted: [],
    log: [],
    result: null,
  }
  rule.initialize(table)
  validate(table, rule)
  return table
}
export function random(table: Table): number {
  let x = table.rng
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  table.rng = x >>> 0
  const draw = table.rng / 0x100000000
  table.draws.push(table.rng)
  return draw
}
export function shuffle(table: Table, zoneId: string): void {
  table.exposure++
  const zone = table.zones[zoneId]
  if (!zone) throw new Error('CARD_ZONE_MISSING')
  for (let i = zone.cards.length - 1; i > 0; i--) {
    const j = Math.floor(random(table) * (i + 1))
    ;[zone.cards[i], zone.cards[j]] = [zone.cards[j]!, zone.cards[i]!]
  }
}
export function addZone(table: Table, id: string, visibility: Zone['visibility'], owner: string | null = null): void {
  if (table.zones[id]) throw new Error('CARD_ZONE_EXISTS')
  table.zones[id] = { visibility, owner, cards: [] }
}
export function addCard(table: Table, definition: CardDefinition, id: string, zone: string): void {
  if (table.cards[id] || !table.zones[zone]) throw new Error('CARD_INSTANCE_INVALID')
  table.definitions[definition.id] = structuredClone(definition)
  table.cards[id] = { id, definition: definition.id }
  table.zones[zone]!.cards.push(id)
}
/** Validates the entire move before touching either zone. */
export function move(table: Table, ids: string[], from: string, to: string): void {
  const source = table.zones[from],
    target = table.zones[to]
  if (
    !source ||
    !target ||
    from === to ||
    new Set(ids).size !== ids.length ||
    ids.some(id => !source.cards.includes(id))
  )
    throw new Error('CARD_MOVE_INVALID')
  table.exposure++
  source.cards = source.cards.filter(id => !ids.includes(id))
  target.cards.push(...ids)
}
export function request(table: Table, kind: string, seats: string[], sealed = false): void {
  table.pending = { id: `q${++table.nextRequest}`, kind, seats: [...seats], sealed, answers: {} }
}
export function finish(table: Table, winners: string[], reason: string): void {
  table.pending = null
  table.frames = []
  table.result = { winners, reason }
  table.log.push(reason)
}
export function legalChoices(table: Table, rule: RulePack, seat: string): Choice[] {
  assertCompatible(table, rule)
  if (!table.pending?.seats.includes(seat) || Object.hasOwn(table.pending.answers, seat) || table.result) return []
  return structuredClone(rule.choices(structuredClone(table), seat))
}
/** All player and NPC inputs enter here. Rejections leave the original table byte-for-byte unchanged. */
export function submit(table: Table, rule: RulePack, input: AcceptedInput): Table {
  validate(table, rule)
  if (table.seats.find(s => s.id === input.seat)?.controller !== input.actor) throw new Error('CARD_UNAUTHORIZED')
  if (table.pending?.id !== input.request) throw new Error('CARD_STALE_REQUEST')
  const choice = legalChoices(table, rule, input.seat).find(c => c.id === input.choice)
  if (!choice) throw new Error('CARD_ILLEGAL_CHOICE')
  const next = structuredClone(table)
  next.pending!.answers[input.seat] = choice.value
  next.accepted.push(structuredClone(input))
  rule.apply(next, input.seat, choice)
  validate(next, rule)
  return next
}
/** No stable instance ID crosses a public zone. Hidden zones reveal counts, never order/definitions. */
export function project(table: Table, rule: RulePack, actor: string): Data {
  validate(table, rule)
  const ownSeats = table.seats.filter(s => s.controller === actor).map(s => s.id)
  const visibleZones: Data = {}
  for (const [id, zone] of Object.entries(table.zones)) {
    const visible = zone.visibility === 'public' || (zone.visibility === 'owner' && ownSeats.includes(zone.owner ?? ''))
    visibleZones[id] = {
      count: zone.cards.length,
      ...(visible
        ? {
            cards: zone.cards.map((card, index) => ({
              handle: `view:${table.exposure}:${id}:${index}`,
              title: table.definitions[table.cards[card]!.definition]!.title,
              definition: table.cards[card]!.definition,
            })),
          }
        : {}),
    }
  }
  const pending = table.pending
  return {
    rule: rule.id,
    title: rule.title,
    round: table.round,
    turnOwner: table.turnOwner,
    seats: table.seats.map(s => ({ id: s.id, label: s.label, controller: s.controller })),
    zones: visibleZones,
    details: rule.publicData(structuredClone(table)),
    log: [...table.log],
    result: table.result ? structuredClone(table.result) : null,
    request: pending
      ? {
          id: pending.id,
          kind: pending.kind,
          seats: [...pending.seats],
          sealed: pending.sealed,
          submitted: Object.keys(pending.answers),
        }
      : null,
    own: ownSeats.map(seat => ({
      seat,
      ...rule.privateData(structuredClone(table), seat),
      choices: legalChoices(table, rule, seat).map(c => ({ id: c.id, label: c.label })),
    })),
  }
}
export function replay(rule: RulePack, seats: Seat[], seed: number, inputs: AcceptedInput[]): Table {
  return inputs.reduce((state, input) => submit(state, rule, input), createTable(rule, seats, seed))
}
