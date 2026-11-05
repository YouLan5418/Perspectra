import type { ActivitiesInstance, ActivityInstance, ActivitySource } from '@harness-world/plugin-sdk'

/** Copy calculation inputs and proposals; the mechanism never receives a live host state object. */
export function guardedActivities(
  instance: ActivitiesInstance,
  source: ActivitySource | undefined,
  providerId: string,
  report: (providerId: string, actorId: string, error: unknown) => void,
): ActivitiesInstance {
  if (
    !Array.isArray(instance.entries) ||
    typeof instance.select !== 'function' ||
    typeof instance.chooseAutoStart !== 'function'
  )
    throw new TypeError('activities requires entries, select and chooseAutoStart')
  const declared = new Set((source?.entries ?? []).map(entry => entry.key))
  if (instance.entries.length !== declared.size) throw new TypeError('活动机制必须匹配世界声明的活动')
  const guard = <T>(key: string, work: () => T): T => {
    try {
      return structuredClone(work())
    } catch (cause) {
      report(providerId, key, cause)
      const message = `活动机制 ${providerId}（${key}）执行失败：${cause instanceof Error ? cause.message : String(cause)}`
      if (cause instanceof RangeError) throw new RangeError(message, { cause })
      if (cause instanceof TypeError) throw new TypeError(message, { cause })
      throw new Error(message, { cause })
    }
  }
  const entries = instance.entries.map((entry): ActivityInstance => {
    if (!declared.delete(entry.key) || typeof entry.hasAutoStart !== 'boolean')
      throw new TypeError('未知或重复活动标识，或活动元数据无效')
    for (const method of [
      'hasResume',
      'initialize',
      'policy',
      'resolve',
      'published',
      'resume',
      'autoStart',
      'simulate',
      'schedule',
      'outcome',
    ] as const)
      if (typeof entry[method] !== 'function') throw new TypeError(`活动 ${entry.key} 缺少 ${method}`)
    const wrap =
      <A extends unknown[], R>(work: (...args: A) => R) =>
      (...args: A): R =>
        guard(entry.key, () => work(...structuredClone(args)))
    return {
      key: entry.key,
      definition: structuredClone(entry.definition),
      hasAutoStart: entry.hasAutoStart,
      hasResume: wrap(entry.hasResume.bind(entry)),
      initialize: (input, random) => guard(entry.key, () => entry.initialize(structuredClone(input), random)),
      policy: wrap(entry.policy.bind(entry)),
      resolve: wrap(entry.resolve.bind(entry)),
      published: wrap(entry.published.bind(entry)),
      resume: wrap(entry.resume.bind(entry)),
      autoStart: wrap(entry.autoStart.bind(entry)),
      simulate: wrap(entry.simulate.bind(entry)),
      schedule: wrap(entry.schedule.bind(entry)),
      outcome: wrap(entry.outcome.bind(entry)),
    }
  })
  return {
    entries,
    select: (progress, latest) => guard('select', () => instance.select(structuredClone(progress), latest)),
    chooseAutoStart: (candidates, random) =>
      guard('autoStart', () => instance.chooseAutoStart(structuredClone(candidates), random)),
    ...(instance.close ? { close: () => instance.close!() } : {}),
  }
}
