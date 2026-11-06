import Ajv, { type ValidateFunction } from 'ajv'
import {
  canonicalizeWorldJson,
  STATUS_CALL_LIMIT as CALL_LIMIT,
  STATUS_VALUE_LIMIT as VALUE_LIMIT,
  type StatusValue,
  type StatusDefinition,
  type StatusOperation,
  type StatusEventData,
  type StatusChange,
  type StatusReveal,
  type StatusTruth,
  type KnownStatus,
  type PlayerTruthStatus,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
const NAME = /^[a-z][a-z0-9-]{0,40}$/u
const RESERVED = ['start', 'retry', 'suspend', 'resume', 'abandon']
export function statusObject(value: unknown, what = '状态数据'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(what + '必须是对象')
  return value as Record<string, unknown>
}
export function statusExact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const keys = Object.keys(value)
  if (required.some(k => !Object.hasOwn(value, k)) || keys.some(k => !required.includes(k) && !optional.includes(k))) {
    throw new TypeError('状态定义字段不合法：' + keys.join(','))
  }
}
export function statusStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v) || new Set(value).size !== value.length) {
    throw new TypeError(what + '必须是互不重复的字符串列表')
  }
  return value as string[]
}
export function statusText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new TypeError(what + '无效')
  return value
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new TypeError('状态显示名称无效')
  return value
}
const slot = (holderId: string | null, key: string) => (holderId ?? '') + '\0' + key

export function statusData(event: RulebookEvent): StatusEventData {
  const data = statusObject(event.data)
  if (!Array.isArray(data.changes) || !Array.isArray(data.reveals)) throw new TypeError('状态事件损坏')
  return data as unknown as StatusEventData
}

const object = statusObject,
  exact = statusExact,
  strings = statusStrings
export const KNOWN_STATUS_NOTE = '这是你上次确认的状态值；current=false 表示之后可能已经改变，你并不知道现在的值。'
/** One public status a character knows that changed since her own last committed action. */
export interface PublicStatusChange {
  key: string
  label: string
  from: StatusValue
  to: StatusValue
}
/** Public statuses (time, power, …) whose known value differs from what the character knew at her own last
 * committed action, or at the world's initial status when she has never acted. Derived from committed events
 * only, so a restart or a regenerated round tells her the same thing. */
export function publicStatusChanges(
  status: Pick<StatusState, 'known'>,
  updates: readonly (RulebookEvent & { readonly seq: number })[],
  events: readonly (RulebookEvent & { readonly seq: number })[],
  actorId: string,
  known: readonly KnownStatus[],
): PublicStatusChange[] {
  const own = events.findLast(
    event => event.eventType === 'action.resolved' && object(event.data, '行动结果').actorId === actorId,
  )
  const baseline = own ? updates.filter(event => event.seq <= own.seq) : updates.slice(0, 1)
  const before = new Map(
    status
      .known(baseline, actorId)
      .filter(entry => entry.holderId === null)
      .map(entry => [entry.key, entry]),
  )
  return known.flatMap(entry => {
    const previous = before.get(entry.key)
    if (
      entry.holderId !== null ||
      !entry.current ||
      !previous ||
      JSON.stringify(previous.value) === JSON.stringify(entry.value)
    )
      return []
    return [{ key: entry.key, label: entry.label, from: previous.value, to: entry.value }]
  })
}
/** The rounds the player let pass, by the seq of their round record. They carry no secret: only that time passed. */
export function pauseRounds(events: readonly (RulebookEvent & { seq: number })[]): { seq: number; round: number }[] {
  return events.flatMap(event => {
    if (event.eventType !== 'status.updated') return []
    const source = statusData(event).source
    return source.kind === 'round' && source.pause === true ? [{ seq: event.seq, round: source.round }] : []
  })
}

/** Existing declared status facts, schemas and authorized projections. No script VM or database. */
export class StatusState {
  readonly #characterIds: readonly string[]
  readonly #entityNames: ReadonlyMap<string, string>
  readonly #validators = new Map<string, ValidateFunction>()
  readonly #valueValidators = new Map<string, ValidateFunction>()
  readonly statuses: readonly StatusDefinition[]
  readonly operations: readonly StatusOperation[]
  constructor(
    rawDefinition: unknown,
    characterIds: readonly string[],
    entities: readonly { entityId: string; name?: string }[],
  ) {
    this.#characterIds = [...characterIds]
    this.#entityNames = new Map(entities.map(e => [e.entityId, e.name ?? e.entityId]))
    const definition = object(structuredClone(rawDefinition), '状态定义')
    exact(definition, ['statuses', 'operations'])
    if (
      !Array.isArray(definition.statuses) ||
      definition.statuses.length > 64 ||
      !Array.isArray(definition.operations) ||
      definition.operations.length > 32
    )
      throw new TypeError('状态或操作数量无效')
    const ajv = new Ajv({ strict: true, allErrors: false })
    this.statuses = definition.statuses.map(value => {
      const s = object(value, '状态声明')
      exact(s, ['key', 'label', 'type', 'owner'], ['alwaysKnown', 'activities', 'schema', 'playerTruth', 'bar'])
      if (typeof s.key !== 'string' || !NAME.test(s.key)) throw new TypeError('状态键无效')
      if (!['number', 'string', 'boolean', 'object', 'array', 'null'].includes(String(s.type)))
        throw new TypeError('状态值类型无效：' + s.key)
      if (['object', 'array'].includes(String(s.type)) && !Object.hasOwn(s, 'schema'))
        throw new TypeError('对象和数组状态必须声明 schema：' + s.key)
      const schema = Object.hasOwn(s, 'schema')
        ? object(s.schema, '状态 schema')
        : { type: s.type, ...(s.type === 'string' ? { maxLength: 200 } : {}) }
      if (schema.type !== s.type) throw new TypeError('状态 schema 类型不匹配：' + s.key)
      this.#valueValidators.set(s.key, ajv.compile(schema))
      if (!['public', 'character'].includes(String(s.owner))) throw new TypeError('状态归属无效：' + s.key)
      if (Object.hasOwn(s, 'alwaysKnown') && typeof s.alwaysKnown !== 'boolean')
        throw new TypeError('alwaysKnown 必须是布尔值')
      if (Object.hasOwn(s, 'playerTruth') && typeof s.playerTruth !== 'boolean')
        throw new TypeError('playerTruth 必须是布尔值')
      if (Object.hasOwn(s, 'bar') && typeof s.bar !== 'boolean') throw new TypeError('bar 必须是布尔值')
      return {
        key: s.key,
        label: label(s.label),
        type: s.type as StatusDefinition['type'],
        schema: schema as WorldJsonObject,
        owner: s.owner as StatusDefinition['owner'],
        alwaysKnown: s.alwaysKnown === true,
        playerTruth: s.playerTruth === true,
        bar: s.bar === true,
        ...(Object.hasOwn(s, 'activities') ? { activities: strings(s.activities, '状态适用活动') } : {}),
      }
    })
    if (new Set(this.statuses.map(s => s.key)).size !== this.statuses.length) throw new TypeError('重复的状态键')
    this.operations = definition.operations.map(value => {
      const op = object(value, '操作声明')
      exact(op, ['id', 'label', 'schema'], ['characterParameters', 'actors', 'activities', 'targets'])
      if (typeof op.id !== 'string' || !NAME.test(op.id)) throw new TypeError('操作 ID 无效')
      if (RESERVED.includes(op.id)) throw new TypeError('操作 ID 与宿主活动控制冲突：' + op.id)
      const schema = object(op.schema, '操作参数')
      if (schema.type !== 'object' || schema.additionalProperties !== false)
        throw new TypeError('操作必须声明封闭对象参数')
      const properties = object(schema.properties ?? {}, '操作参数属性')
      const characterParameters = Object.hasOwn(op, 'characterParameters')
        ? strings(op.characterParameters, '角色参数')
        : []
      if (characterParameters.some(name => (properties[name] as { type?: unknown } | undefined)?.type !== 'string')) {
        throw new TypeError('角色参数必须是声明过的字符串参数')
      }
      const actors = op.actors ?? 'any'
      if (!['player', 'npc', 'any'].includes(String(actors))) throw new TypeError('操作执行者无效')
      const targets = Object.hasOwn(op, 'targets') ? strings(op.targets, '操作物品') : undefined
      if (targets !== undefined && (!targets.length || targets.some(id => !this.#entityNames.has(id))))
        throw new TypeError('操作物品必须是包里登记的物品：' + op.id)
      this.#validators.set(op.id, ajv.compile(schema))
      return {
        id: op.id,
        label: label(op.label),
        schema: schema as WorldJsonObject,
        characterParameters,
        actors: actors as StatusOperation['actors'],
        ...(Object.hasOwn(op, 'activities') ? { activities: strings(op.activities, '操作适用活动') } : {}),
        ...(targets === undefined ? {} : { targets }),
      }
    })
    if (new Set(this.operations.map(o => o.id)).size !== this.operations.length) throw new TypeError('重复的操作 ID')
  }
  validArguments(operation: string, parameters: unknown): boolean {
    return this.#validators.get(operation)?.(parameters) === true
  }
  #status(key: unknown): StatusDefinition {
    const status = this.statuses.find(s => s.key === key)
    if (!status) throw new TypeError('未声明的状态：' + String(key))
    return status
  }

  #value(status: StatusDefinition, value: unknown): StatusValue {
    let nodes = 0
    const visit = (part: unknown, depth: number): void => {
      if (++nodes > 4096 || depth > 16) throw new RangeError('状态值嵌套或元素过多：' + status.key)
      if (part !== null && typeof part === 'object') for (const child of Object.values(part)) visit(child, depth + 1)
    }
    visit(value, 0)
    // Reuse the event log's JSON profile, including safe integer numbers, before anything is committed.
    if (canonicalizeWorldJson(value as StatusValue).length > VALUE_LIMIT)
      throw new RangeError('状态值过长：' + status.key)
    if (!this.#valueValidators.get(status.key)!(value)) throw new TypeError('状态值不符合类型或 schema：' + status.key)
    return value as StatusValue
  }

  #holder(status: StatusDefinition, holderId: unknown): string | null {
    if (
      status.owner === 'public'
        ? holderId !== null
        : typeof holderId !== 'string' || !this.#characterIds.includes(holderId)
    )
      throw new TypeError('状态归属不匹配：' + status.key)
    return holderId as string | null
  }

  truth(events: readonly RulebookEvent[]): StatusTruth {
    const truth: StatusTruth = { public: {}, characters: {} }
    for (const event of events) {
      if (event.eventType !== 'status.updated') continue
      for (const { holderId, key, value } of statusData(event).changes) {
        if (holderId === null) truth.public[key] = structuredClone(value)
        else (truth.characters[holderId] ??= {})[key] = structuredClone(value)
      }
    }
    return truth
  }

  /** Current true values of statuses declared `playerTruth`, for the player's frontend only. */
  playerTruth(events: readonly RulebookEvent[]): PlayerTruthStatus[] {
    const truth = this.truth(events),
      rows: PlayerTruthStatus[] = []
    for (const status of this.statuses) {
      if (!status.playerTruth) continue
      if (status.owner === 'public') {
        if (Object.hasOwn(truth.public, status.key))
          rows.push({ key: status.key, label: status.label, holderId: null, value: truth.public[status.key]! })
        continue
      }
      for (const [holderId, values] of Object.entries(truth.characters)) {
        if (Object.hasOwn(values, status.key))
          rows.push({ key: status.key, label: status.label, holderId, value: values[status.key]! })
      }
    }
    return rows
  }

  known(events: readonly RulebookEvent[], observerId: string): KnownStatus[] {
    const lastChange = new Map<string, number>(),
      lastReveal = new Map<string, { index: number; value: StatusValue }>()
    events.forEach((event, index) => {
      if (event.eventType !== 'status.updated') return
      const data = statusData(event)
      for (const change of data.changes) lastChange.set(slot(change.holderId, change.key), index)
      for (const reveal of data.reveals) {
        if (reveal.observerId === observerId)
          lastReveal.set(slot(reveal.holderId, reveal.key), { index, value: reveal.value })
      }
    })
    const truth = this.truth(events),
      result: KnownStatus[] = []
    for (const status of this.statuses) {
      for (const holderId of status.owner === 'public' ? [null] : this.#characterIds) {
        const real = holderId === null ? truth.public[status.key] : truth.characters[holderId]?.[status.key]
        const base = { key: status.key, label: status.label, holderId }
        if (status.alwaysKnown) {
          if (real !== undefined) result.push({ ...base, value: structuredClone(real), current: true })
          continue
        }
        const reveal = lastReveal.get(slot(holderId, status.key))
        if (reveal === undefined) continue
        result.push({
          ...base,
          value: structuredClone(reveal.value),
          current: (lastChange.get(slot(holderId, status.key)) ?? -1) <= reveal.index,
        })
      }
    }
    return result
  }

  initialEvent(initialValue: unknown): WorldEventDraft {
    const initial = object(initialValue, '状态初始值')
    exact(initial, ['public', 'characters'], ['reveals'])
    const publicValues = object(initial.public, '公共状态'),
      characters = object(initial.characters, '角色状态')
    const changes: StatusChange[] = [],
      reveals: StatusReveal[] = []
    const complete = (values: Record<string, unknown>, owner: StatusDefinition['owner']) => {
      const declared = this.statuses.filter(s => s.owner === owner).map(s => s.key)
      if (Object.keys(values).sort().join(',') !== [...declared].sort().join(','))
        throw new TypeError('初始状态必须恰好包含声明的状态')
    }
    complete(publicValues, 'public')
    for (const status of this.statuses.filter(s => s.owner === 'public')) {
      changes.push({ holderId: null, key: status.key, value: this.#value(status, publicValues[status.key]) })
    }
    if (Object.keys(characters).sort().join('\0') !== [...this.#characterIds].sort().join('\0'))
      throw new TypeError('初始状态的角色不匹配')
    for (const holderId of this.#characterIds) {
      const values = object(characters[holderId], '角色状态')
      complete(values, 'character')
      for (const status of this.statuses.filter(s => s.owner === 'character')) {
        const value = this.#value(status, values[status.key])
        changes.push({ holderId, key: status.key, value })
        reveals.push({ observerId: holderId, holderId, key: status.key, value })
      }
    }
    for (const value of initial.reveals === undefined ? [] : (initial.reveals as unknown[])) {
      const reveal = object(value, '初始告知')
      exact(reveal, ['observerId', 'holderId', 'key'])
      const status = this.#status(reveal.key),
        holderId = this.#holder(status, reveal.holderId)
      const found = changes.find(c => c.holderId === holderId && c.key === status.key)!
      reveals.push({ observerId: String(reveal.observerId), holderId, key: status.key, value: found.value })
    }
    const data: StatusEventData = { source: { kind: 'initial' }, changes, reveals }
    // Initial reveals have no acting scene: any declared character may be told.
    this.validate([], data, this.#characterIds)
    return { eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }
  }

  #slots(events: readonly RulebookEvent[]): Map<string, StatusValue> {
    const truth = this.truth(events),
      values = new Map<string, StatusValue>()
    for (const [key, v] of Object.entries(truth.public)) values.set(slot(null, key), v)
    for (const [holderId, own] of Object.entries(truth.characters)) {
      for (const [key, v] of Object.entries(own)) values.set(slot(holderId, key), v)
    }
    return values
  }

  /** Rejects a whole candidate status event; nothing is partially accepted. */
  validate(events: readonly RulebookEvent[], data: StatusEventData, sceneIds: readonly string[]): void {
    const value = object(data)
    exact(value, ['source', 'changes', 'reveals'], ['description'])
    if (
      Object.hasOwn(value, 'description') &&
      (typeof value.description !== 'string' || value.description.length > 2000)
    ) {
      throw new TypeError('状态结果描述无效')
    }
    const source = object(data.source, '状态来源')
    if (source.kind === 'initial') exact(source, ['kind'])
    else if (source.kind === 'operation') exact(source, ['kind', 'operation', 'actorId'], ['activityKey'])
    else if (source.kind === 'activity') exact(source, ['kind', 'activityKey', 'actorId'])
    else if (source.kind === 'round') {
      exact(source, ['kind', 'round'], ['pause'])
      if (Object.hasOwn(source, 'pause') && source.pause !== true) throw new TypeError('状态来源无效')
    } else if (source.kind === 'beat') {
      exact(source, ['kind', 'beatId'])
      if (typeof source.beatId !== 'string' || !source.beatId) throw new TypeError('状态来源无效')
    } else throw new TypeError('状态来源无效')
    // The initial event carries every value of every character, so only results are bounded.
    if (
      !Array.isArray(data.changes) ||
      !Array.isArray(data.reveals) ||
      (source.kind !== 'initial' && (data.changes.length > 64 || data.reveals.length > 64))
    ) {
      throw new TypeError('状态变化或告知数量无效')
    }
    const next = this.#slots(events)
    for (const change of data.changes) {
      exact(object(change, '状态变化'), ['holderId', 'key', 'value'])
      const status = this.#status(change.key),
        holderId = this.#holder(status, change.holderId)
      // Scope-on-change: an activity-scoped status changes only inside one of its own activities,
      // through that activity's resolve or a status.js operation recorded with that activityKey.
      if (
        status.activities &&
        source.kind !== 'initial' &&
        (typeof source.activityKey !== 'string' || !status.activities.includes(source.activityKey))
      ) {
        throw new TypeError('状态 ' + status.key + ' 只能由指定活动改变')
      }
      next.set(slot(holderId, status.key), this.#value(status, change.value))
    }
    // Every later resolve, policy and hook call carries the truth: keep it well inside the call limit,
    // or one accepted result would lock the world out of its own script.
    let total = 0
    for (const v of next.values()) total += canonicalizeWorldJson(v).length
    if (total > CALL_LIMIT / 2)
      throw new RangeError('状态总量过长：所有状态值合计不能超过 ' + CALL_LIMIT / 2 / 1024 + ' KiB')
    for (const reveal of data.reveals) {
      exact(object(reveal, '状态告知'), ['observerId', 'holderId', 'key', 'value'])
      const status = this.#status(reveal.key),
        holderId = this.#holder(status, reveal.holderId)
      this.#value(status, reveal.value)
      if (!sceneIds.includes(reveal.observerId))
        throw new TypeError('告知对象不在当前场景：' + String(reveal.observerId))
      // A reveal tells the observer the value as of this event, never an invented one.
      const actual = next.get(slot(holderId, status.key))
      if (
        actual === undefined ||
        !Buffer.from(canonicalizeWorldJson(actual)).equals(Buffer.from(canonicalizeWorldJson(reveal.value)))
      ) {
        throw new TypeError('告知的值与真实值不一致：' + status.key)
      }
    }
  }

  /** Reveals carry the value as of this event; the host fills it in and never trusts an author value. */
  #revealAfter(events: readonly RulebookEvent[], changes: readonly StatusChange[]) {
    const after = this.#slots(events)
    for (const change of changes)
      after.set(slot(object(change, '状态变化').holderId as string | null, String(change.key)), change.value)
    return (observerId: unknown, holderId: unknown, key: unknown) =>
      ({ observerId, holderId, key, value: after.get(slot(holderId as string | null, String(key))) }) as StatusReveal
  }

  /** Author reveals name what to tell, never a value; the host fills the value as of this event. The actor
   * always learns the new value of its own statuses that this result changed. */
  reveals(
    events: readonly RulebookEvent[],
    changes: readonly StatusChange[],
    values: readonly unknown[],
    actorId: string,
  ): StatusReveal[] {
    const reveal = this.#revealAfter(events, changes)
    const reveals = values.map(value => {
      const r = object(value, '状态告知')
      exact(r, ['observerId', 'holderId', 'key'])
      return reveal(r.observerId, r.holderId, r.key)
    })
    for (const change of changes) {
      if (
        change.holderId === actorId &&
        !reveals.some(r => r.observerId === actorId && r.holderId === actorId && r.key === change.key)
      ) {
        reveals.push(reveal(actorId, actorId, change.key))
      }
    }
    return reveals
  }

  /** An activity resolve's optional `status` result as one event, which the activity commits together with its
   * `activity.updated`. A malformed or out-of-bounds result is the author's fault and throws. */
  activityEvent(
    events: readonly RulebookEvent[],
    activityKey: string,
    actorId: string,
    value: unknown,
    sceneIds: readonly string[],
  ): WorldEventDraft {
    const result = object(value, '活动状态结果')
    exact(result, ['changes', 'reveals'])
    if (!Array.isArray(result.changes) || !Array.isArray(result.reveals))
      throw new TypeError('状态变化或告知必须是列表')
    const changes = result.changes as StatusChange[]
    const data: StatusEventData = {
      source: { kind: 'activity', activityKey, actorId },
      changes,
      reveals: this.reveals(events, changes, result.reveals, actorId),
    }
    this.validate(events, data, sceneIds)
    return { eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }
  }

  /** A beat has no actor and so no scene: it may tell any declared character. The host fills the values. */
  beatResult(
    events: readonly RulebookEvent[],
    beatId: string,
    changes: readonly StatusChange[],
    reveals: readonly unknown[],
  ): StatusEventData {
    const reveal = this.#revealAfter(events, changes)
    const data: StatusEventData = {
      source: { kind: 'beat', beatId },
      changes: [...changes],
      reveals: reveals.map(value => {
        const r = object(value, '状态告知')
        exact(r, ['observerId', 'holderId', 'key'])
        return reveal(r.observerId, r.holderId, r.key)
      }),
    }
    this.validate(events, data, this.#characterIds)
    return data
  }

  roundResult(events: readonly RulebookEvent[], output: unknown, round: number): StatusEventData | undefined {
    if (output === null) return undefined
    const result = object(output, '每轮结果')
    exact(result, ['changes', 'reveals'])
    if (!Array.isArray(result.changes) || !Array.isArray(result.reveals))
      throw new TypeError('状态变化或告知必须是列表')
    const changes = result.changes as StatusChange[],
      reveal = this.#revealAfter(events, changes)
    const reveals = result.reveals.map(value => {
      const r = object(value, '状态告知')
      exact(r, ['observerId', 'holderId', 'key'])
      // The hook has no actor and so no scene: it may tell only the owner of a status it changed here.
      if (r.observerId !== r.holderId || !changes.some(c => c.holderId === r.holderId && c.key === r.key)) {
        throw new TypeError('每轮钩子只能告知被改状态的归属者本人')
      }
      return reveal(r.observerId, r.holderId, r.key)
    })
    const data: StatusEventData = { source: { kind: 'round', round }, changes, reveals }
    // The owner rule above replaces the scene rule; activity-scoped statuses are refused by validate.
    this.validate(events, data, this.#characterIds)
    return data
  }
}
