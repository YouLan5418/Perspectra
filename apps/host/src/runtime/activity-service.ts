import type { ActivitiesInstance, ActivityInstance, ActivitySource } from '@perspectra/sdk'
import {
  callPluginForValue,
  hostCapability,
  invalidPluginResult,
  isPluginFault,
  type PluginCallContext,
} from './plugin-runtime.ts'

/** Copy calculation inputs and proposals; the mechanism never receives a live host state object. */
export function guardedActivities(
  instance: ActivitiesInstance,
  source: ActivitySource | undefined,
  providerId: string,
  context: PluginCallContext,
  report: (providerId: string, actorId: string, error: unknown) => void,
): ActivitiesInstance {
  if (
    !Array.isArray(instance.entries) ||
    typeof instance.select !== 'function' ||
    typeof instance.chooseAutoStart !== 'function'
  )
    throw invalidPluginResult(context, providerId, 'open')
  const declared = new Set((source?.entries ?? []).map(entry => entry.key))
  if (instance.entries.length !== declared.size) throw invalidPluginResult(context, providerId, 'open:entries')
  const guard = <T>(operation: string, key: string, work: () => T): T => {
    try {
      return callPluginForValue(context, providerId, operation, work)
    } catch (error) {
      if (isPluginFault(error)) report(providerId, key, error)
      throw error
    }
  }
  const entries = instance.entries.map((entry): ActivityInstance => {
    if (
      !declared.delete(entry.key) ||
      typeof entry.hasAutoStart !== 'boolean' ||
      (entry.canStart !== undefined && typeof entry.canStart !== 'function')
    )
      throw invalidPluginResult(context, providerId, 'open:entries')
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
      if (typeof entry[method] !== 'function')
        throw invalidPluginResult(context, providerId, `open:${entry.key}:${method}`)
    return {
      key: entry.key,
      ...(entry.phases === undefined ? {} : { phases: structuredClone(entry.phases) }),
      definition: structuredClone(entry.definition),
      hasAutoStart: entry.hasAutoStart,
      ...(entry.canStart === undefined
        ? {}
        : {
            canStart: world =>
              guard('canStart', entry.key, () => {
                const result = entry.canStart!(structuredClone(world))
                if (typeof result !== 'boolean') throw invalidPluginResult(context, providerId, 'canStart')
                return result
              }),
          }),
      hasResume: () => guard('hasResume', entry.key, entry.hasResume.bind(entry)),
      initialize: (input, random) =>
        guard('initialize', entry.key, () => entry.initialize(structuredClone(input), hostCapability(context, random))),
      policy: (scoped, actorId) => guard('policy', entry.key, () => entry.policy(structuredClone(scoped), actorId)),
      // The dice capability is a function: lend it as is, copy only the data.
      resolve: (state, actorId, operation, parameters, world, truth, roll) =>
        guard('resolve', entry.key, () =>
          entry.resolve(
            structuredClone(state),
            actorId,
            operation,
            structuredClone(parameters),
            structuredClone(world),
            structuredClone(truth),
            roll === undefined ? undefined : hostCapability(context, roll),
          ),
        ),
      published: (state, actorId, publication) =>
        guard('published', entry.key, () =>
          entry.published(structuredClone(state), actorId, structuredClone(publication)),
        ),
      resume: (scoped, world) =>
        guard('resume', entry.key, () => entry.resume(structuredClone(scoped), structuredClone(world))),
      autoStart: (truth, world, previous) =>
        guard('autoStart', entry.key, () =>
          entry.autoStart(structuredClone(truth), structuredClone(world), structuredClone(previous)),
        ),
      simulate: request => guard('simulate', entry.key, () => entry.simulate(structuredClone(request))),
      schedule: state => guard('schedule', entry.key, () => entry.schedule(structuredClone(state))),
      outcome: (result, state) =>
        guard('outcome', entry.key, () => entry.outcome(structuredClone(result), structuredClone(state))),
    }
  })
  return {
    entries,
    select: (progress, latest) => guard('select', 'select', () => instance.select(structuredClone(progress), latest)),
    chooseAutoStart: (candidates, random) =>
      guard('chooseAutoStart', 'autoStart', () =>
        instance.chooseAutoStart(structuredClone(candidates), hostCapability(context, random)),
      ),
  }
}
