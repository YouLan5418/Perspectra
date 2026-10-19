import Ajv, { type ValidateFunction } from 'ajv'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createContext, Script } from 'node:vm'
import { brandId, type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import type { ActionAffordance, CompiledWorldManifest, RulebookEvent, RulebookResolution, RulebookResolver } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'
import { actorWorldView } from './pack-activity.ts'

export type StatusValue = number | string | boolean
export interface StatusChange { holderId: string | null; key: string; value: StatusValue }
export interface StatusReveal { observerId: string; holderId: string | null; key: string; value: StatusValue }
export type StatusSource = { kind: 'initial' } | { kind: 'operation'; operation: string; actorId: string; activityKey?: string }
  | { kind: 'activity'; activityKey: string; actorId: string } | { kind: 'round'; round: number }
/** `description` is the author's result text for an operation; round and initial events have none. */
export interface StatusEventData { source: StatusSource; changes: StatusChange[]; reveals: StatusReveal[]; description?: string }
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

export const KNOWN_STATUS_NOTE = '这是你上次确认的状态值；current=false 表示之后可能已经改变，你并不知道现在的值。'
const ENTRY = 'scripts/status.js'
const PREFIX = 'status:'
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
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new TypeError(what + '无效')
  return value
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new TypeError('状态显示名称无效')
  return value
}
const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
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
  readonly #validators = new Map<string, ValidateFunction>()
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
      this.#validators.set(op.id, ajv.compile(schema))
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

  #slots(events: readonly RulebookEvent[]): Map<string, StatusValue> {
    const truth = this.truth(events), values = new Map<string, StatusValue>()
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
    if (Object.hasOwn(value, 'description') && (typeof value.description !== 'string' || value.description.length > 2000)) {
      throw new TypeError('状态结果描述无效')
    }
    const source = object(data.source, '状态来源')
    if (source.kind === 'initial') exact(source, ['kind'])
    else if (source.kind === 'operation') exact(source, ['kind', 'operation', 'actorId'], ['activityKey'])
    else if (source.kind === 'activity') exact(source, ['kind', 'activityKey', 'actorId'])
    else if (source.kind === 'round') exact(source, ['kind', 'round'])
    else throw new TypeError('状态来源无效')
    // The initial event carries every value of every character, so only results are bounded.
    if (!Array.isArray(data.changes) || !Array.isArray(data.reveals)
      || (source.kind !== 'initial' && (data.changes.length > 64 || data.reveals.length > 64))) {
      throw new TypeError('状态变化或告知数量无效')
    }
    const next = this.#slots(events)
    for (const change of data.changes) {
      exact(object(change, '状态变化'), ['holderId', 'key', 'value'])
      const status = this.#status(change.key), holderId = this.#holder(status, change.holderId)
      // Scope-on-change: an activity-scoped status changes only inside one of its own activities,
      // through that activity's resolve or a status.js operation recorded with that activityKey.
      if (status.activities && source.kind !== 'initial'
        && (typeof source.activityKey !== 'string' || !status.activities.includes(source.activityKey))) {
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

  /** Host adjudication of one status operation on a commit prefix. NPC rulebook turns and player
   * operations share it; the caller commits the returned event, or nothing when this throws. */
  #adjudicate(input: { readonly worldPath: string; readonly address: WorldAddress; readonly playerId: string
    readonly manifest: CompiledWorldManifest; readonly events: readonly RulebookEvent[]; readonly asOfWorldSeq: number | undefined
    readonly actorId: string; readonly operationId: string; readonly parameters: unknown }): {
    event: WorldEventDraft; description: string; observationScope: NonNullable<RulebookResolution['observationScope']> } {
    const { events, actorId } = input
    const op = this.operations.find(o => o.id === input.operationId)
    if (!op) throw new TypeError('未声明的状态操作：' + input.operationId)
    // Activity-scoped operations need activity-aware gating, which this host does not offer yet.
    if (op.activities) throw new TypeError('这个状态操作只能在指定活动中执行')
    if (!this.#validators.get(op.id)!(input.parameters)) throw new TypeError('状态操作参数无效')
    const parameters = input.parameters as Record<string, unknown>
    if (op.actors === 'player' ? actorId !== input.playerId : op.actors === 'npc' && actorId === input.playerId) {
      throw new TypeError('当前角色不能执行这个状态操作')
    }
    const world = actorWorldView(input.worldPath, input.address, input.manifest, events, actorId, input.asOfWorldSeq)
    const sceneIds = [...new Set([actorId, ...world.characterIds as string[]])]
    for (const name of op.characterParameters) {
      if (!Object.hasOwn(parameters, name)) continue
      const id = parameters[name]
      if (typeof id !== 'string' || !this.#characterIds.includes(id)) throw new TypeError('引用的角色不存在：' + String(id))
      if (!sceneIds.includes(id)) throw new TypeError('引用的角色不在当前场景：' + id)
    }
    const result = object(this.#call('resolve', [this.truth(events), actorId, op.id, parameters, world]), '状态操作结果')
    if (Object.hasOwn(result, 'rejectReason')) {
      exact(result, ['rejectReason'])
      throw new TypeError(text(result.rejectReason, '状态操作拒绝说明'))
    }
    exact(result, ['changes', 'reveals', 'description', 'audience'])
    if (typeof result.description !== 'string' || result.description.length > 2000) throw new TypeError('状态操作结果描述无效')
    if (!Array.isArray(result.changes) || !Array.isArray(result.reveals)) throw new TypeError('状态变化或告知必须是列表')
    const changes = result.changes as StatusChange[]
    // Reveals carry the value as of this event; the host fills it in and never trusts an author value.
    const after = this.#slots(events)
    for (const change of changes) after.set(slot(object(change, '状态变化').holderId as string | null, String(change.key)), change.value)
    const reveal = (observerId: unknown, holderId: unknown, key: unknown) =>
      ({ observerId, holderId, key, value: after.get(slot(holderId as string | null, String(key))) }) as StatusReveal
    const reveals = result.reveals.map(value => {
      const r = object(value, '状态告知')
      exact(r, ['observerId', 'holderId', 'key'])
      return reveal(r.observerId, r.holderId, r.key)
    })
    // The actor always learns the new value of its own statuses that this operation changed.
    for (const change of changes) {
      if (change.holderId === actorId && !reveals.some(r => r.observerId === actorId && r.holderId === actorId && r.key === change.key)) {
        reveals.push(reveal(actorId, actorId, change.key))
      }
    }
    const data: StatusEventData = { source: { kind: 'operation', operation: op.id, actorId }, changes, reveals,
      description: result.description }
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
    return { event: { eventType: 'status.updated', eventVersion: 1, data: data as unknown as WorldJsonObject },
      description: result.description, observationScope }
  }

  /** Wraps a rulebook: offers this actor's status operations and adjudicates `status:` interactions. */
  resolver(base: RulebookResolver, worldPath: string, address: WorldAddress, playerId: string): RulebookResolver {
    return {
      affordances: context => {
        const values = base.affordances(context), actor = String(context.characterId)
        const choices: WorldJsonObject[] = this.operations
          .filter(op => !op.activities && (op.actors === 'any' || (op.actors === 'player') === (actor === playerId)))
          .map(op => ({ label: op.label, targetRef: { kind: 'character', id: actor }, bindingId: 'status',
            definitionRef: { id: PREFIX + op.id, version: 1 }, arguments: {}, argumentSchema: op.schema }))
        if (!choices.length) return values
        // One interact entry: wire builders select a single affordance per action type.
        const interact = values.find(a => a.actionType === 'interact')
        const merged: ActionAffordance = { ...interact ?? { actionType: 'interact', actionVersion: 2 },
          interactions: [...interact?.interactions ?? [], ...choices] }
        return [...values.filter(a => a.actionType !== 'interact'), merged]
      },
      resolve: context => {
        const p = record(context.action.parameters) ?? {}, definition = record(p.definitionRef)
        if (typeof definition?.id !== 'string' || !definition.id.startsWith(PREFIX)) return base.resolve(context)
        if (context.action.actionType !== 'interact') throw new TypeError('状态操作必须使用 interact')
        exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
        exact(definition, ['id', 'version'])
        const actorId = String(context.characterId), target = object(p.targetRef, '状态操作目标')
        exact(target, ['kind', 'id'])
        if (p.bindingId !== 'status' || target.kind !== 'character' || target.id !== actorId || definition.version !== 1) {
          throw new TypeError('状态操作绑定无效')
        }
        const result = this.#adjudicate({ worldPath, address, playerId, manifest: context.manifest, events: context.events,
          asOfWorldSeq: context.asOfWorldSeq, actorId, operationId: definition.id.slice(PREFIX.length), parameters: p.arguments })
        return { status: 'accepted', events: [result.event], observationScope: result.observationScope }
      },
    }
  }

  /** Result text for `status:` operations only; anything else is left to the next handler. */
  executionResult = (input: Parameters<typeof characterExecutionResult>[0]): ReturnType<typeof characterExecutionResult> | undefined => {
    const id = record(record(input.action.parameters)?.definitionRef)?.id
    if (typeof id !== 'string' || !id.startsWith(PREFIX)) return undefined
    const latest = input.status === 'accepted' ? input.events.findLast(e => e.eventType === 'status.updated') : undefined
    const description = latest === undefined ? undefined : object(latest.data).description
    return typeof description === 'string' ? { status: 'accepted', description } : characterExecutionResult(input)
  }

  /** Commits the initial values once, as their own round, when the world has no status event yet. */
  async ensureInitial(worldPath: string, address: WorldAddress, playerId: string): Promise<void> {
    const store = new WorldStore(worldPath), leases = new WriterLeaseService(worldPath), owner = 'status-initial:' + randomUUID()
    let lease: ReturnType<WriterLeaseService['acquire']> | undefined
    try {
      lease = leases.acquire(address, owner, 180000)
      const head = store.head(address)
      if (store.readEventsRange(address, 0, head.headSeq, ['status.updated']).length) return
      await store.commitRound({ address, transactionId: brandId(owner, 'TransactionId'), roundId: brandId(owner, 'InteractionRoundId'),
        expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
        events: [this.initialEvent(), { eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1 } }],
        outbox: [], writerFencingToken: lease.fencingToken, correlationId: owner,
        authority: { actorId: playerId, source: 'status-initial', status: 'accepted' } })
    } finally { if (lease) leases.release(address, owner, lease.fencingToken); leases.close(); store.close() }
  }
}
