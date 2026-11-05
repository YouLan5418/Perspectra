import Ajv from 'ajv'
import {
  canonicalizeWorldJson,
  type ActivityGame as Game,
  type ActivityState,
  type ActivityPolicy as Policy,
  type ActivityOperation as Operation,
  type WorldJsonObject,
  type AutoStartCheck,
} from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
export function activityObject(value: unknown): WorldJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('活动数据必须是对象')
  return value as WorldJsonObject
}
export function activityExact(value: WorldJsonObject, keys: string[]): void {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new TypeError('活动字段不合法')
}
export function activityStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string') || new Set(value).size !== value.length) {
    throw new TypeError('活动列表必须是互不重复的字符串')
  }
  return value as string[]
}
export function activityJson(value: WorldJsonObject): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}
const AUTO_START_CONDITIONS = '自动开始条件必须是 1–32 个布尔值或 [标签, 布尔值]'
function autoStartCheck(value: unknown): AutoStartCheck {
  if (typeof value === 'boolean') return { label: null, met: value }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    value[0].length >= 1 &&
    value[0].length <= 80 &&
    typeof value[1] === 'boolean'
  )
    return { label: value[0], met: value[1] }
  throw new TypeError(AUTO_START_CONDITIONS)
}

const object = activityObject,
  exact = activityExact,
  strings = activityStrings,
  json = activityJson
/** Latest committed progress for each script; paused activities do not occupy the foreground. */
export function activityProgress(events: readonly RulebookEvent[]): Map<string, ActivityState> {
  const progress = new Map<string, ActivityState>()
  for (const event of events)
    if (event.eventType === 'activity.updated') {
      const data = object(event.data),
        key = data.activityKey ?? 'default'
      if (typeof key !== 'string') throw new TypeError('活动标识损坏')
      progress.set(key, object(data.state) as ActivityState)
    }
  if ([...progress.values()].filter(state => object(state.game).active === true).length > 1)
    throw new TypeError('不能同时运行多个活动')
  return progress
}

/** Existing activity event shape and authorized projections; never evaluates a script. */
export class ActivityStateRules {
  readonly #validators = new Map<string, ReturnType<Ajv['compile']>>()
  readonly operations: Operation[]
  readonly title: string
  readonly opening: string | undefined
  readonly npcIds: string[]
  readonly participantSelection?: { min: number; max: number; candidates?: string[] }
  constructor(
    rawDefinition: unknown,
    readonly playerId: string,
    readonly key: string,
  ) {
    const definition = object(structuredClone(rawDefinition))
    exact(definition, [
      'title',
      Object.hasOwn(definition, 'participants') ? 'participants' : 'npcIds',
      'operations',
      ...(Object.hasOwn(definition, 'opening') ? ['opening'] : []),
    ])
    if (
      typeof definition.title !== 'string' ||
      definition.title.length > 80 ||
      !Array.isArray(definition.operations) ||
      definition.operations.length > 16
    )
      throw new TypeError('活动定义无效')
    if (
      Object.hasOwn(definition, 'opening') &&
      (typeof definition.opening !== 'string' || !definition.opening.trim() || definition.opening.length > 500)
    )
      throw new TypeError('活动开场文案必须是 1–500 字符')
    this.title = definition.title
    this.opening = typeof definition.opening === 'string' ? definition.opening : undefined
    if (Object.hasOwn(definition, 'participants')) {
      const selection = object(definition.participants)
      exact(selection, ['mode', 'min', 'max', ...(Object.hasOwn(selection, 'candidates') ? ['candidates'] : [])])
      if (
        selection.mode !== 'player-select' ||
        !Number.isSafeInteger(selection.min) ||
        !Number.isSafeInteger(selection.max) ||
        Number(selection.min) < 1 ||
        Number(selection.max) > 8 ||
        Number(selection.min) > Number(selection.max)
      )
        throw new TypeError('活动参与者选择无效')
      const candidates = selection.candidates === undefined ? undefined : strings(selection.candidates)
      if (candidates?.includes(playerId)) throw new TypeError('候选 NPC 不能包含玩家')
      this.participantSelection = {
        min: Number(selection.min),
        max: Number(selection.max),
        ...(candidates ? { candidates } : {}),
      }
      this.npcIds = []
    } else this.npcIds = strings(definition.npcIds)
    if (this.npcIds.length > 8 || this.npcIds.includes(playerId)) throw new TypeError('活动 NPC 列表无效')
    const ajv = new Ajv({ strict: true, allErrors: false })
    this.operations = definition.operations.map(value => {
      const op = object(value)
      exact(op, ['id', 'label', 'requiresTurn', 'schema', ...(Object.hasOwn(op, 'quick') ? ['quick'] : [])])
      if (
        typeof op.id !== 'string' ||
        !/^[a-z][a-z0-9-]{0,40}$/u.test(op.id) ||
        typeof op.label !== 'string' ||
        typeof op.requiresTurn !== 'boolean' ||
        (Object.hasOwn(op, 'quick') && typeof op.quick !== 'boolean')
      )
        throw new TypeError('操作定义无效')
      if (['start', 'retry', 'suspend', 'resume', 'abandon'].includes(op.id))
        throw new TypeError('操作 ID 与宿主活动控制冲突')
      const schema = object(op.schema)
      if (schema.type !== 'object' || schema.additionalProperties !== false)
        throw new TypeError('操作必须声明封闭对象参数')
      const properties = object(schema.properties ?? {})
      if (Object.hasOwn(properties, 'activityId') || Object.hasOwn(properties, 'revision'))
        throw new TypeError('活动参数不得覆盖宿主版本字段')
      // A quick operation starts a player-only activity and applies itself in one player action.
      if (
        op.quick === true &&
        (this.participantSelection !== undefined || this.npcIds.length > 0 || Object.keys(properties).length > 0)
      )
        throw new TypeError('快捷操作只适用于仅玩家参与、无参数的活动操作')
      if (this.#validators.has(op.id)) throw new TypeError('重复的活动操作')
      this.#validators.set(op.id, ajv.compile(schema))
      return { id: op.id, label: op.label, requiresTurn: op.requiresTurn, schema, quick: op.quick === true }
    })
  }
  game(value: unknown, participants: string[]): Game {
    const game = object(value)
    exact(game, ['active', 'phase', 'turn', 'round', 'public', 'private', 'internal'])
    if (
      typeof game.active !== 'boolean' ||
      typeof game.phase !== 'string' ||
      game.phase.length > 80 ||
      !Number.isSafeInteger(game.round) ||
      Number(game.round) < 1 ||
      (game.active ? !participants.includes(String(game.turn)) : game.turn !== null)
    )
      throw new TypeError('活动阶段或轮次无效')
    object(game.public)
    object(game.internal)
    const owners = object(game.private)
    if (Object.keys(owners).sort().join(',') !== [...participants].sort().join(','))
      throw new TypeError('私有变量角色无效')
    for (const value of Object.values(owners)) object(value)
    if (json(game).length > 65536) throw new RangeError('活动状态过长')
    return game as Game
  }
  validParticipants(participants: string[]): boolean {
    const selected = participants.slice(1),
      selection = this.participantSelection
    return (
      participants[0] === this.playerId &&
      !selected.includes(this.playerId) &&
      (selection
        ? selected.length >= selection.min &&
          selected.length <= selection.max &&
          selected.every(id => !selection.candidates || selection.candidates.includes(id))
        : json({ participants }) === json({ participants: [this.playerId, ...this.npcIds] }))
    )
  }
  state(events: readonly RulebookEvent[]): ActivityState | undefined {
    const event = events.findLast(
      e => e.eventType === 'activity.updated' && (object(e.data).activityKey ?? 'default') === this.key,
    )
    if (!event) return undefined
    const state = object(object(event.data).state)
    exact(state, [
      'id',
      'revision',
      'participants',
      'game',
      ...(Object.hasOwn(state, 'suspendedTurn') ? ['suspendedTurn'] : []),
    ])
    const participants = strings(state.participants)
    if (
      typeof state.id !== 'string' ||
      !Number.isSafeInteger(state.revision) ||
      Number(state.revision) < 1 ||
      !this.validParticipants(participants)
    )
      throw new TypeError('活动存档损坏')
    this.game(state.game, participants)
    if (
      Object.hasOwn(state, 'suspendedTurn') &&
      (object(state.game).active !== false || !participants.includes(String(state.suspendedTurn)))
    )
      throw new TypeError('暂停活动状态损坏')
    return state as ActivityState
  }
  scoped(state: ActivityState, actorId: string): WorldJsonObject {
    if (!state.participants.includes(actorId)) throw new TypeError('不是活动参与者')
    return {
      activityKey: this.key,
      id: state.id,
      revision: state.revision,
      participants: state.participants,
      game: {
        active: state.game.active,
        phase: state.game.phase,
        turn: state.game.turn,
        round: state.game.round,
        public: state.game.public,
        private: object(state.game.private[actorId]),
      },
    }
  }
  policy(value: unknown): Policy {
    const policy = object(value)
    exact(policy, ['speech', 'speechChoices', 'narration', 'move', 'interactions', 'operations'])
    if (
      !['free', 'none', 'choices'].includes(String(policy.speech)) ||
      typeof policy.narration !== 'boolean' ||
      typeof policy.move !== 'boolean'
    )
      throw new TypeError('活动许可无效')
    strings(policy.speechChoices)
    strings(policy.interactions)
    if (strings(policy.operations).some(id => !this.#validators.has(id))) throw new TypeError('脚本请求了未安装的操作')
    return policy as Policy
  }

  validArguments(operation: string, parameters: unknown): boolean {
    return this.#validators.get(operation)?.(parameters) === true
  }
}

/** The author's "when" list, shared by automatic activities and pacing beats. */
export function parseAutoStartConditions(when: unknown): AutoStartCheck[] {
  if (!Array.isArray(when) || when.length === 0 || when.length > 32) throw new TypeError(AUTO_START_CONDITIONS)
  return when.map(autoStartCheck)
}

export function parseActivityAutoStart(output: unknown, selection: ActivityStateRules['participantSelection']) {
  if (output === null) return undefined
  const result = object(output)
  exact(result, ['when', ...['npcIds', 'notice', 'sceneNotice'].filter(key => Object.hasOwn(result, key))])
  const checks = parseAutoStartConditions(result.when)
  if (Object.hasOwn(result, 'npcIds') !== !!selection)
    throw new TypeError(selection ? '玩家选人活动自动开始须指定 npcIds' : '固定参与者活动自动开始不能指定 npcIds')
  if (
    Object.hasOwn(result, 'notice') &&
    (typeof result.notice !== 'string' || !result.notice.trim() || result.notice.length > 500)
  )
    throw new TypeError('自动开始提示必须是 1–500 字符')
  if (
    Object.hasOwn(result, 'sceneNotice') &&
    (typeof result.sceneNotice !== 'string' || !result.sceneNotice.trim() || result.sceneNotice.length > 500)
  )
    throw new TypeError('自动开始的在场提示必须是 1–500 字符')
  return {
    conditions: checks.length,
    met: checks.every(check => check.met),
    checks,
    parameters: selection ? { npcIds: strings(result.npcIds) } : {},
    ...(typeof result.notice === 'string' ? { notice: result.notice } : {}),
    ...(typeof result.sceneNotice === 'string' ? { sceneNotice: result.sceneNotice } : {}),
  }
}
