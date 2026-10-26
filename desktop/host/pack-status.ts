import Ajv, { type ValidateFunction } from 'ajv'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import {
  brandId,
  canonicalizeWorldJson,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentEntityState,
  currentLocation,
  rejectRulebookResolution,
  type ActionAffordance,
  type CompiledWorldManifest,
  type RulebookEvent,
  type RulebookResolution,
  type RulebookResolver,
} from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { characterExecutionResult } from '@harness-world/application'
import { activityProgress, actorWorldView } from './pack-activity.ts'
import { CAPABILITY_PENDING, type CapabilityOutcome } from '../host-capabilities.ts'
import type { ExternalStatusInput } from './pack-modules.ts'
import type { RulebookResolutionContext } from '@harness-world/kernel'

export type StatusValue = WorldJsonValue
export interface StatusChange {
  holderId: string | null
  key: string
  value: StatusValue
}
export interface StatusReveal {
  observerId: string
  holderId: string | null
  key: string
  value: StatusValue
}
export type StatusSource =
  | { kind: 'initial' }
  | { kind: 'operation'; operation: string; actorId: string; activityKey?: string }
  | { kind: 'activity'; activityKey: string; actorId: string }
  /** `pause` marks a round the player let pass without saying or doing anything. */
  | { kind: 'round'; round: number; pause?: true }
/** `description` is the author's result text for an operation; round and initial events have none. */
export interface StatusEventData {
  source: StatusSource
  changes: StatusChange[]
  reveals: StatusReveal[]
  description?: string
}
export interface StatusTruth {
  public: Record<string, StatusValue>
  characters: Record<string, Record<string, StatusValue>>
}
export interface KnownStatus {
  key: string
  label: string
  holderId: string | null
  value: StatusValue
  current: boolean
}
/** True value the author chose to hand to the player's frontend; never part of any character's context. */
export interface PlayerTruthStatus {
  key: string
  label: string
  holderId: string | null
  value: StatusValue
}

export interface StatusDefinition {
  readonly key: string
  readonly label: string
  readonly type: 'number' | 'string' | 'boolean' | 'object' | 'array' | 'null'
  readonly schema: WorldJsonObject
  readonly owner: 'public' | 'character'
  readonly alwaysKnown: boolean
  readonly activities?: readonly string[]
  /** Author opt-in: the true value is delivered to the player's frontend, which decides whether to show it. */
  readonly playerTruth: boolean
  /** Author opt-in: pinned to the player's status bar; every known status is in the status drawer anyway. */
  readonly bar: boolean
}
export interface StatusOperation {
  readonly id: string
  readonly label: string
  readonly schema: WorldJsonObject
  readonly characterParameters: readonly string[]
  readonly actors: 'player' | 'npc' | 'any'
  readonly activities?: readonly string[]
  /** The items this operation is done to; each one within reach is its own choice. Absent: the actor itself. */
  readonly targets?: readonly string[]
}

/** The author's policy result: the operations an actor may perform, some narrowed to listed items. */
interface Offers {
  readonly operations: readonly string[]
  readonly targets?: Readonly<Record<string, readonly string[]>>
}

/** One status operation's outcome. A rejection names the actor's own mistake or the author's
 * `rejectReason`; it commits nothing and reveals no value. Author or host faults throw instead. */
export type Adjudication =
  | { status: 'rejected'; reason: string }
  | {
      status: 'accepted'
      /** The status event first, then any item changes the author asked for, in order. */
      events: WorldEventDraft[]
      description: string
      observationScope: NonNullable<RulebookResolution['observationScope']>
      /** The actor and the characters in its authorized scene: who a `scene` audience reaches. */
      sceneIds: readonly string[]
    }

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
  status: PackStatus,
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
const ENTRY = 'scripts/status.js'
const PREFIX = 'status:'
const REJECTED = 'STATUS_OPERATION_REJECTED'
const LIMIT = 64 * 1024
const CALL_LIMIT = 1024 * 1024,
  VALUE_LIMIT = 16 * 1024
const NAME = /^[a-z][a-z0-9-]{0,40}$/u
// Activity control names are host-owned; a status operation may not shadow them.
const RESERVED = ['start', 'retry', 'suspend', 'resume', 'abandon']

function object(value: unknown, what = '状态数据'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(what + '必须是对象')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const keys = Object.keys(value)
  if (required.some(k => !Object.hasOwn(value, k)) || keys.some(k => !required.includes(k) && !optional.includes(k))) {
    throw new TypeError('状态定义字段不合法：' + keys.join(','))
  }
}
function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v) || new Set(value).size !== value.length) {
    throw new TypeError(what + '必须是互不重复的字符串列表')
  }
  return value as string[]
}
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new TypeError(what + '无效')
  return value
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new TypeError('状态显示名称无效')
  return value
}
const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const slot = (holderId: string | null, key: string) => (holderId ?? '') + '\0' + key

function statusData(event: RulebookEvent): StatusEventData {
  const data = object(event.data)
  if (!Array.isArray(data.changes) || !Array.isArray(data.reveals)) throw new TypeError('状态事件损坏')
  return data as unknown as StatusEventData
}
/** The rounds the player let pass, by the seq of their round record. They carry no secret: only that time passed. */
export function pauseRounds(events: readonly (RulebookEvent & { seq: number })[]): { seq: number; round: number }[] {
  return events.flatMap(event => {
    if (event.eventType !== 'status.updated') return []
    const source = statusData(event).source
    return source.kind === 'round' && source.pause === true ? [{ seq: event.seq, round: source.round }] : []
  })
}

/** Both author policy and knowledge conditions read this observer's known values, never global truth.
 * A reveal covers a whole status key: split data with different audiences into different keys. */
export function knownStatusView(
  entries: readonly KnownStatus[],
  actorId: string,
): StatusTruth & { self: Record<string, StatusValue> } {
  const view: StatusTruth = { public: {}, characters: {} }
  for (const entry of entries) {
    const values = entry.holderId === null ? view.public : (view.characters[entry.holderId] ??= {})
    values[entry.key] = structuredClone(entry.value)
  }
  return { ...view, self: view.characters[actorId] ?? {} }
}

/** Trusted author rules for adjudicated statuses. True values live only in `status.updated` events;
 * truth and known values are pure folds over the event list, never a separate store. */
export class PackStatus {
  externalActions:
    | {
        has(operation: string): boolean
        outcome(input: ExternalStatusInput): CapabilityOutcome | undefined
        committed(): void
        failed(): void
        execute<T>(
          input: ExternalStatusInput,
          context: RulebookResolutionContext,
          worldPath: string,
          address: WorldAddress,
          signal: AbortSignal | undefined,
          resolve: () => T,
        ): Promise<T>
      }
    | undefined
  readonly #script: Script
  readonly #characterIds: readonly string[]
  readonly #entityNames: ReadonlyMap<string, string>
  readonly #validators = new Map<string, ValidateFunction>()
  readonly #valueValidators = new Map<string, ValidateFunction>()
  readonly #policyErrors = new Map<string, string>()
  readonly statuses: readonly StatusDefinition[]
  readonly operations: readonly StatusOperation[]

  private constructor(source: string, pack: CompiledWorldPackV5) {
    if (Buffer.byteLength(source) > LIMIT) throw new RangeError('状态脚本过长')
    this.#script = new Script(
      source +
        '\nJSON.stringify(__method === "definition" ? statusScript.definition' +
        ' : __method === "onRoundEnd" && typeof statusScript.onRoundEnd !== "function" ? null' +
        ' : __method === "policy" && typeof statusScript.policy !== "function" ? null' +
        ' : statusScript[__method](...JSON.parse(__args)))',
      { filename: ENTRY },
    )
    this.#characterIds = pack.content.characters.map(c => c.characterId)
    this.#entityNames = new Map((pack.content.entities ?? []).map(e => [e.entityId, e.name ?? e.entityId]))
    const definition = object(this.#call('definition', []), '状态定义')
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
  static fromSource(source: string, pack: CompiledWorldPackV5): PackStatus {
    return new PackStatus(source, pack)
  }

  /** The latest author policy failure per actor, cleared when that actor's policy next succeeds. */
  get policyErrors(): Record<string, string> {
    return Object.fromEntries(this.#policyErrors)
  }

  static parse(source: string, pack: CompiledWorldPackV5): PackStatus {
    return new PackStatus(source, pack)
  }

  static load(packPath: string, pack: CompiledWorldPackV5): PackStatus | undefined {
    const lock = pack.assets.find(asset => asset.path === ENTRY)
    if (!lock) return undefined // Undeclared local files are never executed.
    const file = resolve(packPath, ENTRY)
    if (
      !lstatSync(file).isFile() ||
      relative(realpathSync(packPath), realpathSync(file)) !== ENTRY.split('/').join(sep)
    ) {
      throw new TypeError('状态脚本必须位于包内')
    }
    const bytes = readFileSync(file)
    if (
      bytes.length > LIMIT ||
      bytes.length !== lock.size ||
      'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash
    ) {
      throw new TypeError('状态脚本与已编译的包不一致')
    }
    return new PackStatus(bytes.toString('utf8'), pack)
  }

  #call(method: 'definition' | 'initialize' | 'resolve' | 'onRoundEnd' | 'policy', args: unknown[]): unknown {
    const input = JSON.stringify(args)
    if (Buffer.byteLength(input) > CALL_LIMIT) throw new RangeError('状态脚本输入过长')
    const context = createContext(Object.assign(Object.create(null), { __method: method, __args: input }), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    })
    let output: unknown
    try {
      output = this.#script.runInContext(context, { timeout: 100 })
    } catch (error) {
      throw new TypeError('状态脚本执行失败或超时：' + (error instanceof Error ? error.message : String(error)))
    }
    if (typeof output !== 'string' || Buffer.byteLength(output) > CALL_LIMIT)
      throw new TypeError('状态脚本必须返回有限 JSON')
    return JSON.parse(output)
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

  initialEvent(): WorldEventDraft {
    const initial = object(this.#call('initialize', [this.#characterIds]), '状态初始值')
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

  /** The foreground activity's key when this actor takes part in it; status operations scoped to that
   * activity are offered and executed only then, and recorded with this key. */
  #activityKey(events: readonly RulebookEvent[], actorId: string): string | undefined {
    for (const [key, state] of activityProgress(events)) {
      if (state.game.active) return state.participants.includes(actorId) ? key : undefined
    }
    return undefined
  }

  #allowedOperations(events: readonly RulebookEvent[], actorId: string): Offers {
    return this.#policy(knownStatusView(this.known(events, actorId), actorId), actorId, this.#place(events, actorId))
  }

  /** What the actor can see and lay hands on: its location, and every item it holds or that lies there, such as
   * a cooker a recipe needs. Never an item someone else holds, which the actor may not know about. */
  #place(events: readonly RulebookEvent[], actorId: string): WorldJsonObject {
    const locationId = currentLocation(events, actorId) ?? null
    const ids = [...this.#entityNames.keys()]
    return {
      locationId,
      items: ids.flatMap(id => {
        const item = currentEntityState(events, id)
        return item !== undefined && this.#reachable(events, actorId, id, [])
          ? [{ entityId: id, kind: item.kind, holderId: item.holderId, locationId: item.locationId }]
          : []
      }),
    }
  }

  #policy(view: ReturnType<typeof knownStatusView>, actorId: string, place: WorldJsonObject): Offers {
    const result = this.#call('policy', [view, actorId, place])
    if (result === null) return { operations: this.operations.map(op => op.id) }
    const policy = object(result, '状态操作许可')
    exact(policy, ['operations'], ['targets'])
    const operations = strings(policy.operations, '状态操作许可')
    if (operations.some(id => !this.operations.some(op => op.id === id)))
      throw new TypeError('状态许可包含未声明的操作')
    if (policy.targets === undefined) return { operations }
    const narrowed = object(policy.targets, '状态许可物品')
    const targets: Record<string, readonly string[]> = {}
    for (const [id, value] of Object.entries(narrowed)) {
      const op = this.operations.find(o => o.id === id)
      if (op?.targets === undefined) throw new TypeError('只能为作用于物品的操作列出物品：' + id)
      const ids = strings(value, '状态许可物品')
      if (ids.some(entity => !op.targets!.includes(entity)))
        throw new TypeError('状态许可列出了操作没有声明的物品：' + id)
      targets[id] = ids
    }
    return { operations, targets }
  }

  /** Author reveals name what to tell, never a value; the host fills the value as of this event. The actor
   * always learns the new value of its own statuses that this result changed. */
  #reveals(
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
      reveals: this.#reveals(events, changes, result.reveals, actorId),
    }
    this.validate(events, data, sceneIds)
    return { eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }
  }

  /** Host adjudication of one status operation on a commit prefix. NPC rulebook turns and player
   * operations share it; the caller commits the returned event, or nothing when this throws. */
  #adjudicate(input: {
    readonly worldPath: string
    readonly address: WorldAddress
    readonly playerId: string
    readonly manifest: CompiledWorldManifest
    readonly events: readonly RulebookEvent[]
    readonly asOfWorldSeq: number | undefined
    readonly actorId: string
    readonly operationId: string
    readonly parameters: unknown
    readonly targetId?: string
  }): Adjudication {
    const { events, actorId } = input
    const op = this.operations.find(o => o.id === input.operationId)
    if (!op) return { status: 'rejected', reason: '没有这个状态操作，什么都没有发生。' }
    if (
      (op.targets === undefined) !== (input.targetId === undefined) ||
      (input.targetId !== undefined && !op.targets!.includes(input.targetId))
    )
      return { status: 'rejected', reason: '这个操作不能对这件物品进行，什么都没有发生。' }
    const activityKey = op.activities ? this.#activityKey(events, actorId) : undefined
    if (op.activities && (activityKey === undefined || !op.activities.includes(activityKey))) {
      return { status: 'rejected', reason: '这个操作只能在指定活动中进行，什么都没有发生。' }
    }
    if (!this.#validators.get(op.id)!(input.parameters))
      return { status: 'rejected', reason: '操作缺少有效的必要信息，什么都没有发生。' }
    const parameters = input.parameters as Record<string, unknown>
    if (op.actors === 'player' ? actorId !== input.playerId : op.actors === 'npc' && actorId === input.playerId) {
      return { status: 'rejected', reason: '你不能进行这个操作，什么都没有发生。' }
    }
    const offers = this.#allowedOperations(events, actorId)
    if (
      !offers.operations.includes(op.id) ||
      (input.targetId !== undefined &&
        offers.targets?.[op.id] !== undefined &&
        !offers.targets[op.id]!.includes(input.targetId))
    ) {
      return { status: 'rejected', reason: '当前已知条件不允许这个操作，什么都没有发生。' }
    }
    const world = actorWorldView(input.worldPath, input.address, input.manifest, events, actorId, input.asOfWorldSeq)
    const sceneIds = [...new Set([actorId, ...(world.characterIds as string[])])]
    for (const name of op.characterParameters) {
      if (!Object.hasOwn(parameters, name)) continue
      const id = parameters[name]
      if (typeof id !== 'string' || !this.#characterIds.includes(id))
        return { status: 'rejected', reason: '操作指定的角色不存在，什么都没有发生。' }
      if (!sceneIds.includes(id))
        return { status: 'rejected', reason: '操作指定的角色不在你当前的场景里，什么都没有发生。' }
    }
    if (input.targetId !== undefined && !this.#reachable(events, actorId, input.targetId, sceneIds))
      return { status: 'rejected', reason: '这件物品不在你够得着的地方，什么都没有发生。' }
    const external = this.externalActions?.has(op.id)
      ? this.externalActions.outcome({
          operation: op.id,
          actorId,
          parameters: parameters as WorldJsonObject,
          asOfWorldSeq: input.asOfWorldSeq,
        })
      : undefined
    if (this.externalActions?.has(op.id) && !external) return { status: 'rejected', reason: CAPABILITY_PENDING }
    const result = object(
      external?.completion === 'queued'
        ? {
            changes: [],
            reveals: [],
            description: '外部请求已排队，尚未确认执行；没有提交所请求的世界状态变化。',
            audience: 'self',
          }
        : this.#call('resolve', [
            this.truth(events),
            actorId,
            op.id,
            parameters,
            world,
            input.targetId ?? null,
            external?.data ?? null,
          ]),
      '状态操作结果',
    )
    if (Object.hasOwn(result, 'rejectReason')) {
      exact(result, ['rejectReason'])
      return { status: 'rejected', reason: text(result.rejectReason, '状态操作拒绝说明') }
    }
    exact(result, ['changes', 'reveals', 'description', 'audience'], ['items'])
    if (typeof result.description !== 'string' || result.description.length > 2000)
      throw new TypeError('状态操作结果描述无效')
    if (!Array.isArray(result.changes) || !Array.isArray(result.reveals))
      throw new TypeError('状态变化或告知必须是列表')
    const changes = result.changes as StatusChange[]
    const data: StatusEventData = {
      source: { kind: 'operation', operation: op.id, actorId, ...(activityKey ? { activityKey } : {}) },
      changes,
      reveals: this.#reveals(events, changes, result.reveals, actorId),
      description: result.description,
    }
    this.validate(events, data, sceneIds)
    let observationScope: NonNullable<RulebookResolution['observationScope']>
    if (result.audience === 'self') observationScope = { scope: 'direct', recipientIds: [actorId] }
    else if (result.audience === 'scene') observationScope = { scope: 'scene_public' }
    else {
      const audience = object(result.audience, '结果接收者')
      exact(audience, ['characters'])
      const recipientIds = strings(audience.characters, '结果接收者')
      if (recipientIds.some(id => !sceneIds.includes(id))) throw new TypeError('结果接收者不在当前场景')
      observationScope = { scope: 'direct', recipientIds }
    }
    const items = Object.hasOwn(result, 'items') ? this.#itemEvents(events, actorId, op.id, sceneIds, result.items) : []
    return {
      status: 'accepted',
      events: [{ eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }, ...items],
      description: result.description,
      observationScope,
      sceneIds,
    }
  }

  /** An item is within reach when the actor holds it, it lies where the actor is, or someone in `present` holds it. */
  #reachable(events: readonly RulebookEvent[], actorId: string, entityId: string, present: readonly string[]): boolean {
    const item = currentEntityState(events, entityId)
    if (item === undefined) return false
    if (item.holderId !== null) return item.holderId === actorId || present.includes(item.holderId)
    return item.locationId !== null && item.locationId === currentLocation(events, actorId)
  }

  /** The author's item changes as world events: a new kind keeps the item where it is, and at most one move
   * goes to the actor or someone in its scene, or onto the floor where the actor stands. Any invalid entry
   * is the author's fault and throws, so nothing of the result commits. */
  #itemEvents(
    events: readonly RulebookEvent[],
    actorId: string,
    operationId: string,
    sceneIds: readonly string[],
    value: unknown,
  ): WorldEventDraft[] {
    if (!Array.isArray(value) || value.length > 8) throw new TypeError('物品变化必须是至多 8 项的列表')
    const drafts: WorldEventDraft[] = []
    let moved = false
    for (const entry of value) {
      const change = object(entry, '物品变化')
      exact(change, ['entityId'], ['kind', 'to'])
      const entityId = text(change.entityId, '物品')
      if (!this.#entityNames.has(entityId)) throw new TypeError('物品不存在：' + entityId)
      if (!this.#reachable([...events, ...drafts] as RulebookEvent[], actorId, entityId, sceneIds))
        throw new TypeError('物品不在行动者够得着的地方：' + entityId)
      const before = currentEntityState([...events, ...drafts] as RulebookEvent[], entityId)!
      if (Object.hasOwn(change, 'kind')) {
        if (typeof change.kind !== 'string' || change.kind.trim() === '' || change.kind.length > 500)
          throw new TypeError('物品外观必须是 1–500 字')
        drafts.push({
          eventType: 'entity.upsert',
          eventVersion: 1,
          data:
            before.holderId === null
              ? { entityId, locationId: before.locationId, kind: change.kind }
              : { entityId, locationId: null, holderId: before.holderId, kind: change.kind },
        })
      }
      if (Object.hasOwn(change, 'to')) {
        if (moved) throw new TypeError('一次结果至多移动一件物品')
        moved = true
        const to = object(change.to, '物品去向')
        let destination: { holderId: string | null; locationId: string | null }
        if (Object.hasOwn(to, 'holderId')) {
          exact(to, ['holderId'])
          if (typeof to.holderId !== 'string' || !sceneIds.includes(to.holderId))
            throw new TypeError('物品只能交给行动者或同场角色')
          destination = { holderId: to.holderId, locationId: null }
        } else {
          exact(to, ['locationId'])
          if (to.locationId !== currentLocation(events, actorId)) throw new TypeError('物品只能放在行动者所在的位置')
          destination = { holderId: null, locationId: to.locationId as string }
        }
        if (destination.holderId === before.holderId && destination.locationId === before.locationId)
          throw new TypeError('物品已经在那里')
        drafts.push({
          eventType: 'entity.transferred',
          eventVersion: 1,
          data: {
            entityId,
            characterId: actorId,
            interactionId: PREFIX + operationId,
            fromHolderId: before.holderId,
            fromLocationId: before.locationId,
            toHolderId: destination.holderId,
            toLocationId: destination.locationId,
          },
        })
      }
    }
    return drafts
  }

  /** Adds the status operations this actor may currently perform to its affordances: the actors rule and
   * activity scoping with the participant check. A running activity's policy filter is applied by its caller. */
  withOperations(
    values: readonly ActionAffordance[],
    events: readonly RulebookEvent[],
    actor: string,
    playerId: string,
  ): ActionAffordance[] {
    const activityKey = this.#activityKey(events, actor)
    // Folding stored events stays outside the catch: corrupt history must surface, not read as a policy failure.
    const view = knownStatusView(this.known(events, actor), actor)
    let allowed: Offers
    // A failing author policy only hides this actor's status operations; executing one still throws.
    try {
      allowed = this.#policy(view, actor, this.#place(events, actor))
      this.#policyErrors.delete(actor)
    } catch (cause) {
      this.#policyErrors.set(actor, cause instanceof Error ? cause.message : String(cause))
      return [...values]
    }
    const choices: WorldJsonObject[] = this.operations
      .filter(
        op =>
          allowed.operations.includes(op.id) &&
          (!op.activities || (activityKey !== undefined && op.activities.includes(activityKey))) &&
          (op.actors === 'any' || (op.actors === 'player') === (actor === playerId)),
      )
      .flatMap(op => {
        const offer = (targetRef: WorldJsonObject, name?: string) => ({
          // "{item}" in the author's label names the item; otherwise several items are told apart by a suffix.
          label:
            name === undefined
              ? op.label
              : op.label.includes('{item}')
                ? op.label.replaceAll('{item}', name)
                : op.targets!.length > 1
                  ? op.label + ' · ' + name
                  : op.label,
          targetRef,
          bindingId: 'status',
          definitionRef: { id: PREFIX + op.id, version: 1 },
          arguments: {},
          argumentSchema: op.schema,
        })
        if (op.targets === undefined) return [offer({ kind: 'character', id: actor })]
        // Offered only for what the actor holds or what lies where it is, narrowed by the author's policy.
        const narrowed = allowed.targets?.[op.id]
        return op.targets
          .filter(id => this.#reachable(events, actor, id, []) && (narrowed === undefined || narrowed.includes(id)))
          .map(id => offer({ kind: 'entity', id }, this.#entityNames.get(id)))
      })
    if (!choices.length) return [...values]
    // One interact entry: wire builders select a single affordance per action type.
    const interact = values.find(a => a.actionType === 'interact')
    const merged: ActionAffordance = {
      ...(interact ?? { actionType: 'interact', actionVersion: 2 }),
      interactions: [...(interact?.interactions ?? []), ...choices],
    }
    return [...values.filter(a => a.actionType !== 'interact'), merged]
  }

  /** Wraps a rulebook: offers this actor's status operations and adjudicates `status:` interactions. */
  resolver(base: RulebookResolver, worldPath: string, address: WorldAddress, playerId: string): RulebookResolver {
    return {
      affordances: context =>
        this.withOperations(base.affordances(context), context.events, String(context.characterId), playerId),
      resolve: context => {
        const p = record(context.action.parameters) ?? {},
          definition = record(p.definitionRef)
        if (typeof definition?.id !== 'string' || !definition.id.startsWith(PREFIX)) return base.resolve(context)
        if (context.action.actionType !== 'interact') throw new TypeError('状态操作必须使用 interact')
        exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
        exact(definition, ['id', 'version'])
        const actorId = String(context.characterId),
          target = object(p.targetRef, '状态操作目标')
        exact(target, ['kind', 'id'])
        if (
          p.bindingId !== 'status' ||
          definition.version !== 1 ||
          !(target.kind === 'entity'
            ? typeof target.id === 'string'
            : target.kind === 'character' && target.id === actorId)
        ) {
          throw new TypeError('状态操作绑定无效')
        }
        const result = this.#adjudicate({
          worldPath,
          address,
          playerId,
          manifest: context.manifest,
          events: context.events,
          asOfWorldSeq: context.asOfWorldSeq,
          actorId,
          operationId: definition.id.slice(PREFIX.length),
          parameters: p.arguments,
          ...(target.kind === 'entity' ? { targetId: target.id as string } : {}),
        })
        if (result.status === 'accepted')
          return { status: 'accepted', events: result.events, observationScope: result.observationScope }
        if (result.reason === CAPABILITY_PENDING) return { status: 'rejected', events: [], reason: CAPABILITY_PENDING }
        // The actor's own attempt failed: it learns why, and nothing about any status value.
        const rejected = rejectRulebookResolution(actorId, 'interact', REJECTED)
        return {
          ...rejected,
          events: rejected.events.map(e => ({ ...e, data: { ...object(e.data), description: result.reason } })),
          observationScope: { scope: 'direct', recipientIds: [actorId] },
        }
      },
    }
  }

  /** The actor-facing reason of this actor's latest status rejection, when `reason` is the status rejection code. */
  rejectionReason(
    events: readonly RulebookEvent[],
    actorId: string,
    reason: string | null | undefined,
  ): string | undefined {
    if (reason !== REJECTED) return undefined
    const latest = events.findLast(
      e =>
        e.eventType === 'action.rejected' &&
        record(e.data)?.characterId === actorId &&
        record(e.data)?.reason === REJECTED,
    )
    const description = latest === undefined ? undefined : object(latest.data).description
    return typeof description === 'string' ? description : undefined
  }

  /** Result text for `status:` operations only; anything else is left to the next handler. */
  executionResult = (
    input: Parameters<typeof characterExecutionResult>[0],
  ): ReturnType<typeof characterExecutionResult> | undefined => {
    const id = record(record(input.action.parameters)?.definitionRef)?.id
    if (typeof id !== 'string' || !id.startsWith(PREFIX)) return undefined
    if (input.status !== 'accepted') {
      const reason = this.rejectionReason(input.events, input.actorId, input.reason)
      if (reason === undefined) return characterExecutionResult(input)
      // The author says why; the host adds where the item still is, so a refused handover is not narrated as done.
      // Only what the actor sees anyway: in its own hands or where it stands.
      const target = record(record(input.action.parameters)?.targetRef)
      const item = target?.kind === 'entity' ? currentEntityState(input.events, String(target.id)) : undefined
      const name = item && (input.manifest.entities.find(e => e.entityId === item.entityId)?.name ?? item.entityId)
      const still =
        item?.holderId === input.actorId
          ? `${name}仍在你手里。`
          : item?.holderId === null && item.locationId === currentLocation(input.events, input.actorId)
            ? `${name}仍在原处。`
            : undefined
      if (still === undefined) return { status: input.status, description: reason }
      const sentence = /[。！？.!?]$/u.test(reason) ? reason : reason + '。'
      return { status: input.status, description: `${sentence}这次没有执行，${still}` }
    }
    const latest = input.events.findLast(e => {
      if (e.eventType !== 'status.updated') return false
      const source = statusData(e).source
      return (
        source.kind === 'operation' && source.actorId === input.actorId && source.operation === id.slice(PREFIX.length)
      )
    })
    const description = latest === undefined ? undefined : object(latest.data).description
    return typeof description === 'string' ? { status: 'accepted', description } : characterExecutionResult(input)
  }

  /** One host round under the writer lease; `build` sees the committed head and returns nothing to commit nothing.
   * Resolves to whether a round was committed. */
  async #commitRound(
    worldPath: string,
    address: WorldAddress,
    owner: string,
    build: (
      store: WorldStore,
      head: { headSeq: number; tick: number },
    ) =>
      | { events: WorldEventDraft[]; authority: WorldJsonObject }
      | undefined
      | Promise<{ events: WorldEventDraft[]; authority: WorldJsonObject } | undefined>,
  ): Promise<boolean> {
    const store = new WorldStore(worldPath),
      leases = new WriterLeaseService(worldPath)
    let lease: ReturnType<WriterLeaseService['acquire']> | undefined
    try {
      lease = leases.acquire(address, owner, 180000)
      const head = store.head(address),
        round = await build(store, head)
      if (!round) return false
      await store.commitRound({
        address,
        transactionId: brandId(owner, 'TransactionId'),
        roundId: brandId(owner, 'InteractionRoundId'),
        expectedHeadSeq: head.headSeq,
        expectedTick: head.tick,
        nextTick: head.tick + 1,
        events: [...round.events, { eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1 } }],
        outbox: [],
        writerFencingToken: lease.fencingToken,
        correlationId: owner,
        authority: round.authority,
      })
      this.externalActions?.committed()
      return true
    } catch (error) {
      this.externalActions?.failed()
      throw error
    } finally {
      if (lease) leases.release(address, owner, lease.fencingToken)
      leases.close()
      store.close()
    }
  }

  /** Commits the initial values once, as their own round, when the world has no status event yet. */
  async ensureInitial(worldPath: string, address: WorldAddress, playerId: string): Promise<void> {
    await this.#commitRound(worldPath, address, 'status-initial:' + randomUUID(), (store, head) =>
      store.readEventsRange(address, 0, head.headSeq, ['status.updated']).length
        ? undefined
        : {
            events: [this.initialEvent()],
            authority: { actorId: playerId, source: 'status-initial', status: 'accepted' },
          },
    )
  }

  /** The player's own status operation, adjudicated like an NPC's and committed as its own round with its
   * result observations. A rejection throws with the reason and commits nothing. Resolves to false when the
   * request was already committed, so a retry neither runs the operation nor ends another round. */
  apply(
    worldPath: string,
    address: WorldAddress,
    playerId: string,
    operation: string,
    parameters: WorldJsonObject,
    requestId: string,
    targetId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const owner = 'status:' + requestId,
      actionId = owner + ':action',
      request = { operation, parameters, ...(targetId === undefined ? {} : { targetId }) }
    return this.#commitRound(worldPath, address, owner, async (store, head) => {
      const prior = store.readRoundAuthority(address, brandId(owner, 'TransactionId'))
      if (prior) {
        const same = (value: unknown) => Buffer.from(canonicalizeWorldJson(value as WorldJsonObject)).toString('utf8')
        if (same(prior.authority.request) !== same(request)) throw new TypeError('同一请求不能改变内容')
        return undefined
      }
      const events = store.readEvents(address),
        manifest = store.readManifest(address)!.manifest as CompiledWorldManifest
      const input = {
        worldPath,
        address,
        playerId,
        manifest,
        events,
        asOfWorldSeq: head.headSeq,
        actorId: playerId,
        operationId: operation,
        parameters,
        ...(targetId === undefined ? {} : { targetId }),
      }
      let result = this.#adjudicate(input)
      if (result.status === 'rejected' && result.reason === CAPABILITY_PENDING) {
        const context: RulebookResolutionContext = {
          manifest,
          events,
          characterId: playerId,
          asOfWorldSeq: head.headSeq,
          action: {
            actionType: 'interact',
            parameters: {
              targetRef: { kind: 'character', id: playerId },
              bindingId: 'status',
              definitionRef: { id: PREFIX + operation, version: 1 },
              arguments: parameters,
            },
          },
        }
        result = await this.externalActions!.execute(
          { operation, actorId: playerId, parameters, asOfWorldSeq: head.headSeq },
          context,
          worldPath,
          address,
          signal,
          () => this.#adjudicate(input),
        )
      }
      if (result.status === 'rejected') throw new TypeError(result.reason)
      // Witnesses of a move keep track of who holds the item, as with the built-in rules.
      const transfer = result.events.find(event => event.eventType === 'entity.transferred')
      const scope = result.observationScope
      const observerIds = scope.scope === 'direct' ? (scope.recipientIds ?? []).map(String) : result.sceneIds
      return {
        authority: { actorId: playerId, request, status: 'accepted' },
        events: [
          ...result.events,
          ...observerIds.map(observerId => ({
            eventType: 'observation.upsert',
            eventVersion: 1,
            data: {
              id: actionId + ':' + observerId,
              value: {
                observerId,
                actionId,
                epistemicKind: 'observed_action',
                content: {
                  status: 'accepted',
                  actionType: 'interact',
                  actorId: playerId,
                  resultDescription: result.description,
                  ...(transfer === undefined ? {} : { interaction: transfer.data }),
                },
              },
            },
          })),
          {
            eventType: 'action.resolved',
            eventVersion: 1,
            data: { actorId: playerId, actionId, actionType: 'interact', accepted: true, sourceRole: 'player' },
          },
        ],
      }
    })
  }

  /** Runs the optional `onRoundEnd` hook once after an accepted player input and commits its result as the
   * round's last status event. A failing hook commits nothing and is not retried; storage faults still throw.
   * A `pause` round has no input: it always records itself, marked, so it counts as the player's turn. */
  async endRound(
    worldPath: string,
    address: WorldAddress,
    turnStartSeq: number,
    pause = false,
  ): Promise<{ ok: boolean; error?: string }> {
    let error: string | undefined
    await this.#commitRound(worldPath, address, 'status-round:' + randomUUID(), store => {
      const events = store.readEvents(address)
      // Counting starts from the latest recorded round, so a turn of several commits counted there stays one.
      const base = events.findLast(e => e.eventType === 'status.updated' && statusData(e).source.kind === 'round')
      const since = base === undefined ? 0 : base.seq,
        baseSource = base === undefined ? undefined : statusData(base).source
      const recorded = baseSource?.kind === 'round' ? baseSource.round : 0
      // Count submitted player rounds even when a previous hook returned null or failed. Multiple
      // player actions in one transaction are one input; NPC actions and hook commits do not count.
      const player = events.filter(
        e => e.seq > since && e.eventType === 'action.resolved' && record(e.data)?.sourceRole === 'player',
      )
      const playerRounds = new Set(player.filter(e => e.seq <= turnStartSeq).map(e => e.transactionId))
      // This turn is one round however many commits it took, such as a line said with an action.
      const thisTurn = new Set(player.filter(e => e.seq > turnStartSeq).map(e => e.transactionId))
      // A quick activity action starts and executes in two host commits for one player request.
      const starts = new Map<string, (typeof events)[number]>()
      for (const event of events) {
        if (event.seq <= since || event.eventType !== 'activity.updated') continue
        const data = object(event.data)
        if (typeof data.requestId !== 'string') continue
        if (data.operation === 'start') starts.set(data.requestId, event)
        else {
          const start = starts.get(data.requestId + ':start')
          if (start && object(object(start.data).state).id === object(data.state).id) {
            playerRounds.delete(start.transactionId)
            thisTurn.delete(start.transactionId)
          }
        }
      }
      const round = recorded + playerRounds.size + (pause ? 1 : Math.min(thisTurn.size, 1))
      // Folding stored events stays outside the catch: corrupt history must surface, not read as a hook failure.
      const truth = this.truth(events)
      let data: StatusEventData | undefined
      try {
        data = this.#roundResult(events, truth, round)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      // A turn whose commits cannot be told apart later, such as a line said with an action, always records
      // its round (without changes when the hook gave none), so later counts start after it.
      if (data === undefined && thisTurn.size > 1) data = { source: { kind: 'round', round }, changes: [], reveals: [] }
      if (pause) data = { ...(data ?? { changes: [], reveals: [] }), source: { kind: 'round', round, pause: true } }
      return (
        data && {
          events: [{ eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }],
          authority: { source: 'status-round', round, status: 'accepted' },
        }
      )
    })
    return error === undefined ? { ok: true } : { ok: false, error }
  }

  #roundResult(events: readonly RulebookEvent[], truth: StatusTruth, round: number): StatusEventData | undefined {
    const output = this.#call('onRoundEnd', [truth, round])
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
