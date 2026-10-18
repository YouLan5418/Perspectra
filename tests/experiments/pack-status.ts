import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import type { WorldEventDraft, WorldJsonObject } from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

export type StatusValue = number | string | boolean
export interface StatusChange { holderId: string | null; key: string; value: StatusValue }
export interface StatusReveal { observerId: string; holderId: string | null; key: string; value: StatusValue }
export type StatusSource = { kind: 'initial' } | { kind: 'operation'; operation: string; actorId: string }
  | { kind: 'activity'; activityKey: string; actorId: string } | { kind: 'round'; round: number }
export interface StatusEventData { source: StatusSource; changes: StatusChange[]; reveals: StatusReveal[] }
export interface StatusTruth { public: Record<string, StatusValue>; characters: Record<string, Record<string, StatusValue>> }
export interface KnownStatus { key: string; label: string; holderId: string | null; value: StatusValue; current: boolean }

export interface StatusDefinition {
  readonly key: string; readonly label: string; readonly type: 'number' | 'string' | 'boolean'
  readonly owner: 'public' | 'character'; readonly alwaysKnown: boolean; readonly activities?: readonly string[]
}
export interface StatusOperation {
  readonly id: string; readonly label: string; readonly schema: WorldJsonObject
  readonly characterParameters: readonly string[]; readonly actors: 'player' | 'npc' | 'any'
  readonly activities?: readonly string[]
}

const ENTRY = 'scripts/status.js'
const LIMIT = 64 * 1024
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
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new TypeError('状态显示名称无效')
  return value
}
const slot = (holderId: string | null, key: string) => (holderId ?? '') + '\0' + key

function statusData(event: RulebookEvent): StatusEventData {
  const data = object(event.data)
  if (!Array.isArray(data.changes) || !Array.isArray(data.reveals)) throw new TypeError('状态事件损坏')
  return data as unknown as StatusEventData
}

/** Trusted author rules for adjudicated statuses. True values live only in `status.updated` events;
 * truth and known values are pure folds over the event list, never a separate store. */
export class PackStatus {
  readonly #script: Script
  readonly #characterIds: readonly string[]
  readonly statuses: readonly StatusDefinition[]
  readonly operations: readonly StatusOperation[]

  private constructor(source: string, pack: CompiledWorldPackV5) {
    if (Buffer.byteLength(source) > LIMIT) throw new RangeError('状态脚本过长')
    this.#script = new Script(source + '\nJSON.stringify(__method === "definition" ? statusScript.definition'
      + ' : __method === "onRoundEnd" && typeof statusScript.onRoundEnd !== "function" ? null'
      + ' : statusScript[__method](...JSON.parse(__args)))', { filename: ENTRY })
    this.#characterIds = pack.content.characters.map(c => c.characterId)
    const definition = object(this.#call('definition', []), '状态定义')
    exact(definition, ['statuses', 'operations'])
    if (!Array.isArray(definition.statuses) || definition.statuses.length > 64
      || !Array.isArray(definition.operations) || definition.operations.length > 32) throw new TypeError('状态或操作数量无效')
    this.statuses = definition.statuses.map(value => {
      const s = object(value, '状态声明')
      exact(s, ['key', 'label', 'type', 'owner'], ['alwaysKnown', 'activities'])
      if (typeof s.key !== 'string' || !NAME.test(s.key)) throw new TypeError('状态键无效')
      if (!['number', 'string', 'boolean'].includes(String(s.type))) throw new TypeError('状态值类型无效：' + s.key)
      if (!['public', 'character'].includes(String(s.owner))) throw new TypeError('状态归属无效：' + s.key)
      if (Object.hasOwn(s, 'alwaysKnown') && typeof s.alwaysKnown !== 'boolean') throw new TypeError('alwaysKnown 必须是布尔值')
      return { key: s.key, label: label(s.label), type: s.type as StatusDefinition['type'],
        owner: s.owner as StatusDefinition['owner'], alwaysKnown: s.alwaysKnown === true,
        ...(Object.hasOwn(s, 'activities') ? { activities: strings(s.activities, '状态适用活动') } : {}) }
    })
    if (new Set(this.statuses.map(s => s.key)).size !== this.statuses.length) throw new TypeError('重复的状态键')
    const ajv = new Ajv({ strict: true, allErrors: false })
    this.operations = definition.operations.map(value => {
      const op = object(value, '操作声明')
      exact(op, ['id', 'label', 'schema'], ['characterParameters', 'actors', 'activities'])
      if (typeof op.id !== 'string' || !NAME.test(op.id)) throw new TypeError('操作 ID 无效')
      if (RESERVED.includes(op.id)) throw new TypeError('操作 ID 与宿主活动控制冲突：' + op.id)
      const schema = object(op.schema, '操作参数')
      if (schema.type !== 'object' || schema.additionalProperties !== false) throw new TypeError('操作必须声明封闭对象参数')
      const properties = object(schema.properties ?? {}, '操作参数属性')
      const characterParameters = Object.hasOwn(op, 'characterParameters') ? strings(op.characterParameters, '角色参数') : []
      if (characterParameters.some(name => (properties[name] as { type?: unknown } | undefined)?.type !== 'string')) {
        throw new TypeError('角色参数必须是声明过的字符串参数')
      }
      const actors = op.actors ?? 'any'
      if (!['player', 'npc', 'any'].includes(String(actors))) throw new TypeError('操作执行者无效')
      ajv.compile(schema)
      return { id: op.id, label: label(op.label), schema: schema as WorldJsonObject, characterParameters,
        actors: actors as StatusOperation['actors'],
        ...(Object.hasOwn(op, 'activities') ? { activities: strings(op.activities, '操作适用活动') } : {}) }
    })
    if (new Set(this.operations.map(o => o.id)).size !== this.operations.length) throw new TypeError('重复的操作 ID')
  }

  static parse(source: string, pack: CompiledWorldPackV5): PackStatus { return new PackStatus(source, pack) }

  static load(packPath: string, pack: CompiledWorldPackV5): PackStatus | undefined {
    const lock = pack.assets.find(asset => asset.path === ENTRY)
    if (!lock) return undefined // Undeclared local files are never executed.
    const file = resolve(packPath, ENTRY)
    if (!lstatSync(file).isFile() || relative(realpathSync(packPath), realpathSync(file)) !== ENTRY.split('/').join(sep)) {
      throw new TypeError('状态脚本必须位于包内')
    }
    const bytes = readFileSync(file)
    if (bytes.length > LIMIT || bytes.length !== lock.size
      || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash) {
      throw new TypeError('状态脚本与已编译的包不一致')
    }
    return new PackStatus(bytes.toString('utf8'), pack)
  }

  #call(method: 'definition' | 'initialize' | 'resolve' | 'onRoundEnd', args: unknown[]): unknown {
    const input = JSON.stringify(args)
    if (input.length > LIMIT) throw new RangeError('状态脚本输入过长')
    const context = createContext(Object.assign(Object.create(null), { __method: method, __args: input }),
      { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
    let output: unknown
    try { output = this.#script.runInContext(context, { timeout: 100 }) }
    catch (error) { throw new TypeError('状态脚本执行失败或超时：' + (error instanceof Error ? error.message : String(error))) }
    if (typeof output !== 'string' || output.length > LIMIT) throw new TypeError('状态脚本必须返回有限 JSON')
    return JSON.parse(output)
  }

  #status(key: unknown): StatusDefinition {
    const status = this.statuses.find(s => s.key === key)
    if (!status) throw new TypeError('未声明的状态：' + String(key))
    return status
  }

  #value(status: StatusDefinition, value: unknown): StatusValue {
    if (typeof value !== status.type || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && value.length > 200)) throw new TypeError('状态值类型不匹配：' + status.key)
    return value as StatusValue
  }

  #holder(status: StatusDefinition, holderId: unknown): string | null {
    if (status.owner === 'public' ? holderId !== null
      : typeof holderId !== 'string' || !this.#characterIds.includes(holderId)) throw new TypeError('状态归属不匹配：' + status.key)
    return holderId as string | null
  }

  truth(events: readonly RulebookEvent[]): StatusTruth {
    const truth: StatusTruth = { public: {}, characters: {} }
    for (const event of events) {
      if (event.eventType !== 'status.updated') continue
      for (const { holderId, key, value } of statusData(event).changes) {
        if (holderId === null) truth.public[key] = value
        else (truth.characters[holderId] ??= {})[key] = value
      }
    }
    return truth
  }

  known(events: readonly RulebookEvent[], observerId: string): KnownStatus[] {
    const lastChange = new Map<string, number>(), lastReveal = new Map<string, { index: number; value: StatusValue }>()
    events.forEach((event, index) => {
      if (event.eventType !== 'status.updated') return
      const data = statusData(event)
      for (const change of data.changes) lastChange.set(slot(change.holderId, change.key), index)
      for (const reveal of data.reveals) {
        if (reveal.observerId === observerId) lastReveal.set(slot(reveal.holderId, reveal.key), { index, value: reveal.value })
      }
    })
    const truth = this.truth(events), result: KnownStatus[] = []
    for (const status of this.statuses) {
      for (const holderId of status.owner === 'public' ? [null] : this.#characterIds) {
        const real = holderId === null ? truth.public[status.key] : truth.characters[holderId]?.[status.key]
        const base = { key: status.key, label: status.label, holderId }
        if (status.alwaysKnown) {
          if (real !== undefined) result.push({ ...base, value: real, current: true })
          continue
        }
        const reveal = lastReveal.get(slot(holderId, status.key))
        if (reveal === undefined) continue
        result.push({ ...base, value: reveal.value, current: (lastChange.get(slot(holderId, status.key)) ?? -1) <= reveal.index })
      }
    }
    return result
  }

  initialEvent(): WorldEventDraft {
    const initial = object(this.#call('initialize', [this.#characterIds]), '状态初始值')
    exact(initial, ['public', 'characters'], ['reveals'])
    const publicValues = object(initial.public, '公共状态'), characters = object(initial.characters, '角色状态')
    const changes: StatusChange[] = [], reveals: StatusReveal[] = []
    const complete = (values: Record<string, unknown>, owner: StatusDefinition['owner']) => {
      const declared = this.statuses.filter(s => s.owner === owner).map(s => s.key)
      if (Object.keys(values).sort().join(',') !== [...declared].sort().join(',')) throw new TypeError('初始状态必须恰好包含声明的状态')
    }
    complete(publicValues, 'public')
    for (const status of this.statuses.filter(s => s.owner === 'public')) {
      changes.push({ holderId: null, key: status.key, value: this.#value(status, publicValues[status.key]) })
    }
    if (Object.keys(characters).sort().join('\0') !== [...this.#characterIds].sort().join('\0')) throw new TypeError('初始状态的角色不匹配')
    for (const holderId of this.#characterIds) {
      const values = object(characters[holderId], '角色状态')
      complete(values, 'character')
      for (const status of this.statuses.filter(s => s.owner === 'character')) {
        const value = this.#value(status, values[status.key])
        changes.push({ holderId, key: status.key, value })
        reveals.push({ observerId: holderId, holderId, key: status.key, value })
      }
    }
    for (const value of initial.reveals === undefined ? [] : initial.reveals as unknown[]) {
      const reveal = object(value, '初始告知')
      exact(reveal, ['observerId', 'holderId', 'key'])
      const status = this.#status(reveal.key), holderId = this.#holder(status, reveal.holderId)
      const found = changes.find(c => c.holderId === holderId && c.key === status.key)!
      reveals.push({ observerId: String(reveal.observerId), holderId, key: status.key, value: found.value })
    }
    const data: StatusEventData = { source: { kind: 'initial' }, changes, reveals }
    // Initial reveals have no acting scene: any declared character may be told.
    this.validate([], data, this.#characterIds)
    return { eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject }
  }

  /** Rejects a whole candidate status event; nothing is partially accepted. */
  validate(events: readonly RulebookEvent[], data: StatusEventData, sceneIds: readonly string[]): void {
    const value = object(data)
    exact(value, ['source', 'changes', 'reveals'])
    const source = object(data.source, '状态来源')
    if (source.kind === 'initial') exact(source, ['kind'])
    else if (source.kind === 'operation') exact(source, ['kind', 'operation', 'actorId'])
    else if (source.kind === 'activity') exact(source, ['kind', 'activityKey', 'actorId'])
    else if (source.kind === 'round') exact(source, ['kind', 'round'])
    else throw new TypeError('状态来源无效')
    // The initial event carries every value of every character, so only results are bounded.
    if (!Array.isArray(data.changes) || !Array.isArray(data.reveals)
      || (source.kind !== 'initial' && (data.changes.length > 64 || data.reveals.length > 64))) {
      throw new TypeError('状态变化或告知数量无效')
    }
    const truth = this.truth(events), next = new Map<string, StatusValue>()
    for (const [key, v] of Object.entries(truth.public)) next.set(slot(null, key), v)
    for (const [holderId, values] of Object.entries(truth.characters)) {
      for (const [key, v] of Object.entries(values)) next.set(slot(holderId, key), v)
    }
    for (const change of data.changes) {
      exact(object(change, '状态变化'), ['holderId', 'key', 'value'])
      const status = this.#status(change.key), holderId = this.#holder(status, change.holderId)
      // Scope-on-change: an activity-scoped status changes only through one of its own activities.
      if (status.activities && source.kind !== 'initial'
        && (source.kind !== 'activity' || !status.activities.includes(String(source.activityKey)))) {
        throw new TypeError('状态 ' + status.key + ' 只能由指定活动改变')
      }
      next.set(slot(holderId, status.key), this.#value(status, change.value))
    }
    for (const reveal of data.reveals) {
      exact(object(reveal, '状态告知'), ['observerId', 'holderId', 'key', 'value'])
      const status = this.#status(reveal.key), holderId = this.#holder(status, reveal.holderId)
      this.#value(status, reveal.value)
      if (!sceneIds.includes(reveal.observerId)) throw new TypeError('告知对象不在当前场景：' + String(reveal.observerId))
      // A reveal tells the observer the value as of this event, never an invented one.
      if (next.get(slot(holderId, status.key)) !== reveal.value) throw new TypeError('告知的值与真实值不一致：' + status.key)
    }
  }
}
