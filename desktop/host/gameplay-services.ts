import type { AutonomyInstance, CommunicationInstance, StatusInstance } from '@harness-world/plugin-sdk'

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
