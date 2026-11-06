import type {
  ActivitiesInstance,
  AutonomyInstance,
  CommunicationInstance,
  PacingCandidate,
  PacingInstance,
  StatusInstance,
} from '@harness-world/plugin-sdk'

/** Names the failing mechanism and keeps the error class: a TypeError or RangeError refuses this one request and
 * reaches the player with its message, anything else is an internal failure. */
export function mechanismFailure(label: string, cause: unknown): Error {
  const message = `${label} 执行失败：${cause instanceof Error ? cause.message : String(cause)}`
  if (cause instanceof TypeError) return new TypeError(message, { cause })
  if (cause instanceof RangeError) return new RangeError(message, { cause })
  return new Error(message, { cause })
}

/** Native mechanisms are trusted, but computation receives copies rather than host-owned objects. */
function computationGuard(id: string, report: (id: string, actorId: string, error: unknown) => void) {
  return <A extends unknown[], R>(work: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return structuredClone(work(...structuredClone(args)))
      } catch (cause) {
        report(id, 'gameplay', cause)
        throw mechanismFailure(`机制 ${id}`, cause)
      }
    }
}
function instruction(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError('机制指引必须是有限文本')
  return value
}
export function guardedCommunication(
  instance: CommunicationInstance,
  hasSource: boolean,
  id: string,
  report: (id: string, actorId: string, error: unknown) => void,
): CommunicationInstance {
  for (const method of ['parameters', 'options', 'prepare', 'describeDelivery'] as const)
    if (typeof instance[method] !== 'function') throw new TypeError('communication requires ' + method)
  if ((instance.definition !== undefined) !== hasSource) throw new TypeError('通信机制必须匹配声明的配置')
  const wrap = computationGuard(id, report),
    describe = wrap(instance.describeDelivery.bind(instance))
  return {
    definition: structuredClone(instance.definition),
    instruction: instruction(instance.instruction),
    parameters: wrap(instance.parameters.bind(instance)),
    options: wrap(instance.options.bind(instance)),
    prepare: wrap(instance.prepare.bind(instance)),
    describeDelivery: status => {
      const value = describe(status)
      if (typeof value !== 'string' || value.length > 2000) throw new TypeError('通信结果描述无效')
      return value
    },
    ...(instance.close ? { close: () => instance.close!() } : {}),
  }
}
export function guardedAutonomy(
  instance: AutonomyInstance,
  hasSource: boolean,
  id: string,
  report: (id: string, actorId: string, error: unknown) => void,
): AutonomyInstance {
  if (
    !Array.isArray(instance.roles) ||
    (!hasSource && instance.roles.length) ||
    typeof instance.due !== 'function' ||
    typeof instance.permits !== 'function'
  )
    throw new TypeError('自主机制需要合法声明、due 与 permits')
  const wrap = computationGuard(id, report),
    permits = wrap(instance.permits.bind(instance))
  return {
    roles: structuredClone(instance.roles),
    instruction: instruction(instance.instruction),
    due: wrap(instance.due.bind(instance)),
    permits: input => {
      const value = permits(input)
      if (typeof value !== 'boolean') throw new TypeError('自主许可必须是布尔值')
      return value
    },
    ...(instance.close ? { close: () => instance.close!() } : {}),
  }
}
export function guardedStatus(
  instance: StatusInstance,
  hasSource: boolean,
  id: string,
  playerId: string,
  report: (id: string, actorId: string, error: unknown) => void,
): StatusInstance {
  for (const method of ['initialize', 'policy', 'resolve', 'endRound', 'prepareModule'] as const)
    if (typeof instance[method] !== 'function') throw new TypeError('status requires ' + method)
  if (!Array.isArray(instance.moduleDefinitions) || typeof instance.hasRoundHook !== 'boolean')
    throw new TypeError('status metadata is invalid')
  if (hasSource === (instance.definition === undefined))
    throw new TypeError('status implementation must match the world declared source')
  const guard = <T>(actorId: string, work: () => T): T => {
    try {
      return structuredClone(work())
    } catch (cause) {
      report(id, actorId, cause)
      throw mechanismFailure(`状态机制 ${id}`, cause)
    }
  }
  return {
    definition: structuredClone(instance.definition),
    hasRoundHook: instance.hasRoundHook,
    moduleDefinitions: structuredClone(instance.moduleDefinitions),
    initialize: ids => guard(playerId, () => instance.initialize(ids)),
    policy: (known, actorId, place) => guard(actorId, () => instance.policy(known, actorId, place)),
    resolve: input => guard(input.actorId, () => instance.resolve(input)),
    endRound: (truth, round) => guard(playerId, () => instance.endRound(truth, round)),
    prepareModule: (...args) => guard(args[2], () => instance.prepareModule(...args)),
    ...(instance.close ? { close: () => instance.close!() } : {}),
  }
}
/** Checks what a pacing mechanism claims against what the world actually declares, then copies its inputs and outputs. */
export function guardedPacing(
  instance: PacingInstance,
  world: {
    readonly hasSource: boolean
    readonly id: string
    readonly hasStatus: boolean
    readonly statusKeys: readonly string[]
    readonly activities: ActivitiesInstance | undefined
    readonly report: (id: string, actorId: string, error: unknown) => void
  },
): PacingInstance {
  for (const method of ['intensity', 'checks', 'choose', 'apply'] as const)
    if (typeof instance[method] !== 'function') throw new TypeError('pacing requires ' + method)
  const { id, report, activities } = world
  if (!world.hasSource && (instance.managedActivities.length || instance.beats.length))
    throw new TypeError('节奏机制必须匹配世界声明的脚本')
  if (instance.beats.length && !world.hasStatus) throw new TypeError('写了节拍的世界包需要状态声明')
  for (const key of [...instance.managedActivities, ...instance.progress.activities]) {
    const entry = activities?.entries.find(row => row.key === key)
    if (!entry) throw new TypeError('节奏配置列出了未声明的活动：' + key)
    if (instance.managedActivities.includes(key) && !entry.hasAutoStart)
      throw new TypeError('节奏管理的活动必须写 autoStart：' + key)
  }
  for (const key of instance.progress.statuses)
    if (!world.statusKeys.includes(key)) throw new TypeError('节奏配置列出了未声明的状态：' + key)
  const guard = <T>(work: () => T): T => {
    try {
      return structuredClone(work())
    } catch (cause) {
      report(id, 'pacing', cause)
      throw mechanismFailure(`节奏机制 ${id}`, cause)
    }
  }
  return {
    managedActivities: [...instance.managedActivities],
    beats: [...instance.beats],
    progress: structuredClone(instance.progress),
    intensity: (candidate: PacingCandidate) => guard(() => instance.intensity(candidate)),
    checks: (beatId, input) => guard(() => instance.checks(beatId, structuredClone(input))),
    choose: input =>
      guard(() =>
        instance.choose({
          candidates: structuredClone(input.candidates),
          history: structuredClone(input.history),
          random: input.random,
        }),
      ),
    apply: (beatId, input, random) => guard(() => instance.apply(beatId, structuredClone(input), random)),
    ...(instance.close ? { close: () => instance.close!() } : {}),
  }
}
