import type { ContentPackFacts } from './content.ts'

export type Witness = 'scene' | 'global' | { readonly holds: string }
export interface PackTimeThreshold {
  readonly dayKey: string
  readonly slotKey: string
  readonly slots: readonly string[]
  readonly at: { readonly day: number; readonly slot: string }
}
export type EventRule = (
  | { readonly round: number; readonly crossesPackTime?: never }
  | { readonly round?: never; readonly crossesPackTime: PackTimeThreshold }
) & {
  readonly id: string
  readonly type: string
  readonly trigger?: 'hard' | 'paced'
  readonly duringActivity?: boolean
  readonly location: string
  readonly witnesses: readonly Witness[]
  readonly sceneNotices?: readonly SceneNotice[]
  readonly observation: string
  readonly set: BooleanWrite
}
export interface SceneNotice {
  readonly locations: readonly string[]
  readonly text: string
  readonly fromOperation?: string
}
export interface BooleanWrite {
  readonly key: string
  readonly value: boolean
}
export interface EventGrant {
  readonly plugin: string
  readonly type: string
  readonly mode: 'live' | 'durable'
  readonly effect?: BooleanWrite
}
export interface EventBook {
  readonly rules: readonly EventRule[]
  readonly grants: readonly EventGrant[]
}
export interface WorldEventEnvelope {
  readonly type: string
  readonly occurrenceId: string
}
export interface WorldEventConsumerScope {
  readonly signal: AbortSignal
}
export type EventSubscription =
  | {
      readonly mode: 'live'
      readonly type: string
      open(scope: WorldEventConsumerScope): (event: WorldEventEnvelope) => void
    }
  | {
      readonly mode: 'durable'
      readonly type: string
      open(scope: WorldEventConsumerScope): (event: WorldEventEnvelope) => 'ack' | 'apply'
    }
export interface WorldEventsApi {
  subscribe(subscription: EventSubscription): () => void
}

function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k)))
    throw new TypeError('world-events: unexpected field or invalid object (' + keys.join(', ') + ')')
  return raw as Record<string, unknown>
}
function list(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) throw new TypeError('world-events: invalid list')
  return raw
}
function id(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9.:-]{0,95}$/.test(raw)) throw new TypeError('world-events: invalid ID')
  return raw
}
export function worldEventType(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9.-]{0,63}@[1-9][0-9]{0,3}$/.test(raw))
    throw new TypeError('world-events: expected versioned event type')
  return raw
}
function write(raw: unknown): BooleanWrite {
  const row = object(raw, ['key', 'value'])
  if (typeof row.value !== 'boolean') throw new TypeError('world-events: expected boolean effect')
  return { key: id(row.key), value: row.value }
}
function timing(rule: Record<string, unknown>) {
  if (rule.when === undefined) {
    if (typeof rule.round !== 'number' || !Number.isSafeInteger(rule.round) || rule.round < 1)
      throw new TypeError('world-events: expected a positive round or when.crossesPackTime')
    return { round: rule.round }
  }
  if (rule.round !== undefined || rule.trigger === 'paced')
    throw new TypeError('world-events: crossesPackTime is a hard trigger and excludes round')
  const clock = object(object(rule.when, ['crossesPackTime']).crossesPackTime, ['dayKey', 'slotKey', 'slots', 'at'])
  const dayKey = id(clock.dayKey),
    slotKey = id(clock.slotKey)
  const slots = list(clock.slots, 32).map(slot => {
    if (typeof slot !== 'string' || !slot.trim() || slot.length > 64)
      throw new TypeError('world-events: invalid calendar slot')
    return slot
  })
  const at = object(clock.at, ['day', 'slot'])
  if (
    dayKey === slotKey ||
    new Set(slots).size !== slots.length ||
    typeof at.day !== 'number' ||
    !Number.isSafeInteger(at.day) ||
    at.day < 0 ||
    typeof at.slot !== 'string' ||
    !slots.includes(at.slot)
  )
    throw new TypeError('world-events: invalid calendar keys, slots or threshold')
  return { crossesPackTime: { dayKey, slotKey, slots, at: { day: at.day, slot: at.slot } } }
}
function sceneNotices(rule: Record<string, unknown>, pack: ContentPackFacts): SceneNotice[] {
  if (!rule.when || (rule.audience !== undefined && rule.audience !== 'scene'))
    throw new TypeError('world-events: sceneNotices require a calendar rule with scene audience')
  const used = new Set([rule.location])
  return list(rule.sceneNotices, 4).map(entry => {
    const group = object(entry, ['locations', 'text', 'fromOperation'])
    const text = group.text === undefined ? rule.observation : group.text
    if (typeof text !== 'string' || !text.trim() || text.length > 512)
      throw new TypeError('world-events: invalid scene notice')
    const locations = list(group.locations, 16).map(loc => {
      if (typeof loc !== 'string' || !pack.locationIds.includes(loc) || used.has(loc))
        throw new TypeError('world-events: unknown or duplicate notice location')
      used.add(loc)
      return loc
    })
    if (!locations.length) throw new TypeError('world-events: empty notice locations')
    return { locations, text, ...(group.fromOperation === undefined ? {} : { fromOperation: id(group.fromOperation) }) }
  })
}
export function parseEventBook(raw: unknown, pack: ContentPackFacts): EventBook {
  const book = object(raw, ['rules', 'grants'])
  const rules = list(book.rules, 32).map((entry): EventRule => {
    const rule = object(entry, [
      'id',
      'type',
      'round',
      'when',
      'location',
      'audience',
      'observation',
      'set',
      'trigger',
      'duringActivity',
      'sceneNotices',
    ])
    if (
      typeof rule.location !== 'string' ||
      !pack.locationIds.includes(rule.location) ||
      typeof rule.observation !== 'string' ||
      !rule.observation.trim() ||
      rule.observation.length > 512
    )
      throw new TypeError('world-events: invalid round, location or observation')
    if (rule.trigger !== undefined && rule.trigger !== 'hard' && rule.trigger !== 'paced')
      throw new TypeError('world-events: trigger must be hard or paced')
    if (rule.duringActivity !== undefined && (rule.trigger !== 'paced' || typeof rule.duringActivity !== 'boolean'))
      throw new TypeError('world-events: duringActivity requires a paced rule and a boolean')
    const audience = rule.audience === undefined ? 'scene' : rule.audience
    const members =
      typeof audience === 'object' && audience && 'anyOf' in audience
        ? list(object(audience, ['anyOf']).anyOf, 4)
        : [audience]
    if (!members.length) throw new TypeError('world-events: empty anyOf')
    const witnesses = members.map((raw): Witness => {
      if (raw === 'scene' || raw === 'global') return raw
      const item = object(raw, ['holds']).holds
      if (typeof item !== 'string' || !pack.entityIds.includes(item))
        throw new TypeError('world-events: unknown held item')
      return { holds: item }
    })
    return {
      id: id(rule.id),
      type: worldEventType(rule.type),
      ...timing(rule),
      location: rule.location,
      ...(rule.trigger === 'paced' ? { trigger: 'paced' as const, duringActivity: rule.duringActivity === true } : {}),
      witnesses,
      ...(rule.sceneNotices === undefined ? {} : { sceneNotices: sceneNotices(rule, pack) }),
      observation: rule.observation,
      set: write(rule.set),
    }
  })
  const grants = list(book.grants ?? [], 64).map((entry): EventGrant => {
    const grant = object(entry, ['plugin', 'type', 'mode', 'effect'])
    if ((grant.mode !== 'durable' && grant.mode !== 'live') || (grant.effect !== undefined && grant.mode !== 'durable'))
      throw new TypeError('world-events: invalid subscription grant')
    return {
      plugin: id(grant.plugin),
      type: worldEventType(grant.type),
      mode: grant.mode,
      ...(grant.effect === undefined ? {} : { effect: write(grant.effect) }),
    }
  })
  if (
    new Set(rules.map(r => r.id)).size !== rules.length ||
    new Set(grants.map(g => JSON.stringify([g.plugin, g.type, g.mode]))).size !== grants.length
  )
    throw new TypeError('world-events: duplicate rule or grant')
  return { rules, grants }
}
