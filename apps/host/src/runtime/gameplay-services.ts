import type {
  ActivitiesInstance,
  AutonomyInstance,
  CommunicationInstance,
  DiceInstance,
  PacingCandidate,
  PacingInstance,
  StatusInstance,
} from '@perspectra/sdk'
import {
  validateCommunicationCandidate,
  validateCommunicationOption,
  parseCommunicationRequest,
} from '@perspectra/core'
import {
  callPluginForValue,
  hostCapability,
  invalidPluginResult,
  isPluginFault,
  type PluginCallContext,
} from './plugin-runtime.ts'

function mechanismValue<T>(
  context: PluginCallContext,
  id: string,
  operation: string,
  actorId: string,
  report: (id: string, actorId: string, error: unknown) => void,
  work: () => T,
): T {
  try {
    return callPluginForValue(context, id, operation, work)
  } catch (error) {
    if (isPluginFault(error)) report(id, actorId, error)
    throw error
  }
}
function instruction(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4000) throw new TypeError('机制指引必须是有限文本')
  return value
}

export function guardedDice(instance: DiceInstance, id: string, context: PluginCallContext): DiceInstance {
  if (typeof instance.roll !== 'function') throw invalidPluginResult(context, id, 'open:roll')
  return {
    roll: (expression, random) =>
      callPluginForValue(context, id, 'roll', () => {
        const result = instance.roll(expression, hostCapability(context, random))
        if (
          !result ||
          typeof result.expression !== 'string' ||
          !Array.isArray(result.dice) ||
          result.dice.some(face => typeof face !== 'number' || !Number.isFinite(face)) ||
          !Number.isFinite(result.modifier) ||
          !Number.isFinite(result.total)
        )
          throw invalidPluginResult(context, id, 'roll')
        return result
      }),
  }
}
export function guardedCommunication(
  instance: CommunicationInstance,
  hasSource: boolean,
  id: string,
  context: PluginCallContext,
  report: (id: string, actorId: string, error: unknown) => void,
): CommunicationInstance {
  for (const method of ['parameters', 'options', 'prepare', 'describeDelivery'] as const)
    if (typeof instance[method] !== 'function') throw invalidPluginResult(context, id, `open:${method}`)
  if (instance.contacts !== undefined && typeof instance.contacts !== 'function')
    throw invalidPluginResult(context, id, 'open:contacts')
  if ((instance.definition !== undefined) !== hasSource) throw invalidPluginResult(context, id, 'open:definition')
  let instructionText: string
  try {
    instructionText = instruction(instance.instruction)
  } catch {
    throw invalidPluginResult(context, id, 'open:instruction')
  }
  return {
    definition: structuredClone(instance.definition),
    instruction: instructionText,
    ...(instance.contacts === undefined
      ? {}
      : {
          contacts: (input: Parameters<NonNullable<CommunicationInstance['contacts']>>[0]) =>
            mechanismValue(context, id, 'contacts', input.actorId, report, () => {
              const selected = instance.contacts!(structuredClone(input))
              if (
                !Array.isArray(selected) ||
                new Set(selected).size !== selected.length ||
                selected.some(recipient => !input.recipientIds.includes(recipient))
              )
                throw invalidPluginResult(context, id, 'contacts')
              return [...selected]
            }),
        }),
    parameters: (recipientId, text) =>
      mechanismValue(context, id, 'parameters', 'gameplay', report, () => {
        const value = instance.parameters(recipientId, text)
        const request = parseCommunicationRequest(value, 'interact', Infinity, true)
        if (!request || request.recipientId !== recipientId || request.text !== text)
          throw invalidPluginResult(context, id, 'parameters')
        return value
      }),
    options: input =>
      mechanismValue(context, id, 'options', input.actorId, report, () => {
        const options = instance.options(structuredClone(input))
        if (
          !Array.isArray(options) ||
          options.some(option => {
            const target = option?.targetRef
            return (
              !target ||
              typeof target !== 'object' ||
              Array.isArray(target) ||
              !input.recipientIds.includes(String((target as import('@perspectra/sdk/contracts').WorldJsonObject).id))
            )
          })
        )
          throw invalidPluginResult(context, id, 'options')
        for (const option of options) {
          try {
            validateCommunicationOption(option, input.publicationCharacters)
          } catch {
            throw invalidPluginResult(context, id, 'options')
          }
        }
        return options
      }),
    prepare: input =>
      mechanismValue(context, id, 'prepare', 'gameplay', report, () => {
        const candidate = instance.prepare(structuredClone(input))
        try {
          return validateCommunicationCandidate(candidate, input.publicationCharacters)
        } catch {
          throw invalidPluginResult(context, id, 'prepare')
        }
      }),
    describeDelivery: status =>
      mechanismValue(context, id, 'describeDelivery', 'gameplay', report, () => {
        const value = instance.describeDelivery(status)
        if (typeof value !== 'string' || value.length > 2000) throw invalidPluginResult(context, id, 'describeDelivery')
        return value
      }),
  }
}
export function guardedAutonomy(
  instance: AutonomyInstance,
  hasSource: boolean,
  id: string,
  context: PluginCallContext,
  report: (id: string, actorId: string, error: unknown) => void,
): AutonomyInstance {
  if (
    !Array.isArray(instance.roles) ||
    (!hasSource && instance.roles.length) ||
    typeof instance.due !== 'function' ||
    typeof instance.permits !== 'function'
  )
    throw invalidPluginResult(context, id, 'open')
  let instructionText: string
  try {
    instructionText = instruction(instance.instruction)
  } catch {
    throw invalidPluginResult(context, id, 'open:instruction')
  }
  return {
    roles: structuredClone(instance.roles),
    instruction: instructionText,
    due: input =>
      mechanismValue(context, id, 'due', 'gameplay', report, () => {
        const selected = instance.due(structuredClone(input))
        if (
          !Array.isArray(selected) ||
          new Set(selected).size !== selected.length ||
          selected.some(actor => !instance.roles.some(role => role.characterId === actor))
        )
          throw invalidPluginResult(context, id, 'due')
        return selected
      }),
    permits: input => {
      const value = mechanismValue(context, id, 'permits', 'gameplay', report, () =>
        instance.permits(structuredClone(input)),
      )
      if (typeof value !== 'boolean') throw invalidPluginResult(context, id, 'permits')
      return value
    },
  }
}
export function guardedStatus(
  instance: StatusInstance,
  hasSource: boolean,
  id: string,
  playerId: string,
  context: PluginCallContext,
  report: (id: string, actorId: string, error: unknown) => void,
): StatusInstance {
  for (const method of ['initialize', 'policy', 'resolve', 'endRound', 'prepareModule'] as const)
    if (typeof instance[method] !== 'function') throw invalidPluginResult(context, id, `open:${method}`)
  if (!Array.isArray(instance.moduleDefinitions) || typeof instance.hasRoundHook !== 'boolean')
    throw invalidPluginResult(context, id, 'open:metadata')
  if (hasSource === (instance.definition === undefined)) throw invalidPluginResult(context, id, 'open:definition')
  return {
    definition: structuredClone(instance.definition),
    hasRoundHook: instance.hasRoundHook,
    moduleDefinitions: structuredClone(instance.moduleDefinitions),
    initialize: ids =>
      mechanismValue(context, id, 'initialize', playerId, report, () => instance.initialize(structuredClone(ids))),
    policy: (known, actorId, place) =>
      mechanismValue(context, id, 'policy', actorId, report, () =>
        instance.policy(structuredClone(known), actorId, structuredClone(place)),
      ),
    resolve: input =>
      mechanismValue(context, id, 'resolve', input.actorId, report, () => instance.resolve(structuredClone(input))),
    endRound: (truth, round) =>
      mechanismValue(context, id, 'endRound', playerId, report, () => instance.endRound(structuredClone(truth), round)),
    prepareModule: (...args) =>
      mechanismValue(context, id, 'prepareModule', args[2], report, () =>
        instance.prepareModule(
          args[0],
          structuredClone(args[1]),
          args[2],
          args[3],
          structuredClone(args[4]),
          structuredClone(args[5]),
        ),
      ),
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
  context: PluginCallContext,
): PacingInstance {
  const { id, report, activities } = world
  for (const method of ['intensity', 'checks', 'choose', 'apply'] as const)
    if (typeof instance[method] !== 'function') throw invalidPluginResult(context, id, `open:${method}`)
  if (
    !Array.isArray(instance.managedActivities) ||
    !Array.isArray(instance.beats) ||
    !Array.isArray(instance.progress?.activities) ||
    !Array.isArray(instance.progress?.statuses)
  )
    throw invalidPluginResult(context, id, 'open:metadata')
  if (!world.hasSource && (instance.managedActivities.length || instance.beats.length))
    throw invalidPluginResult(context, id, 'open:source')
  if (instance.beats.length && !world.hasStatus) throw invalidPluginResult(context, id, 'open:status')
  for (const key of [...instance.managedActivities, ...instance.progress.activities]) {
    const entry = activities?.entries.find(row => row.key === key)
    if (!entry) throw invalidPluginResult(context, id, 'open:activities')
    if (instance.managedActivities.includes(key) && !entry.hasAutoStart)
      throw invalidPluginResult(context, id, 'open:autoStart')
  }
  for (const key of instance.progress.statuses)
    if (!world.statusKeys.includes(key)) throw invalidPluginResult(context, id, 'open:statuses')
  return {
    managedActivities: [...instance.managedActivities],
    beats: [...instance.beats],
    progress: structuredClone(instance.progress),
    intensity: (candidate: PacingCandidate) =>
      mechanismValue(context, id, 'intensity', 'pacing', report, () => instance.intensity(structuredClone(candidate))),
    checks: (beatId, input) =>
      mechanismValue(context, id, 'checks', 'pacing', report, () => instance.checks(beatId, structuredClone(input))),
    choose: input => {
      const candidates = structuredClone(input.candidates),
        history = structuredClone(input.history),
        random = hostCapability(context, input.random)
      return mechanismValue(context, id, 'choose', 'pacing', report, () =>
        instance.choose({ candidates, history, random }),
      )
    },
    apply: (beatId, input, random) =>
      mechanismValue(context, id, 'apply', 'pacing', report, () =>
        instance.apply(beatId, structuredClone(input), hostCapability(context, random)),
      ),
  }
}
