import { canonicalizeWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import type { SchedulerCycle, SchedulerResult, SchedulerRound, SchedulerInstance } from '@harness-world/plugin-sdk'
import {
  hostCallback,
  hostCallbackAsync,
  callPluginForValueAsync,
  callPluginSync,
  isPluginFault,
  publicPluginFailure,
  PluginFaultError,
  type PluginCallContext,
} from '@harness-world/runtime-cordis'

/** These are host reads, even while a scheduler invokes them. Their authority ends with this round. */
export function guardSchedulerReads(
  round: SchedulerRound,
  context: PluginCallContext,
  active: () => boolean,
): SchedulerRound {
  const read =
    <A extends unknown[], T>(work: (...args: A) => T): ((...args: A) => T) =>
    (...args) => {
      context.scope.assertActive()
      if (!active()) throw new Error('scheduler round has ended')
      round.signal.throwIfAborted()
      return hostCallback(context.callbacks, () => structuredClone(work(...structuredClone(args))))
    }
  return {
    ...round,
    characterIds: [...round.characterIds],
    limits: structuredClone(round.limits),
    ...(round.initialCounts === undefined ? {} : { initialCounts: new Map(round.initialCounts) }),
    ...(round.opportunityLimits === undefined ? {} : { opportunityLimits: structuredClone(round.opportunityLimits) }),
    headSeq: read(round.headSeq),
    observationsSince: read(round.observationsSince),
    observationSeqs: read(round.observationSeqs),
    presentCharacterIds: read(round.presentCharacterIds),
    locationOf: read(round.locationOf),
    world: {
      readEvents: read(round.world.readEvents),
      characterObservations: read(round.world.characterObservations),
      head: read(round.world.head),
      eventTicks: read(round.world.eventTicks),
      authorizedSources: read(round.world.authorizedSources),
    },
    ...(round.wakeups === undefined ? {} : { wakeups: read(round.wakeups) }),
    ...(round.activity === undefined
      ? {}
      : {
          activity: {
            ...round.activity,
            next: read(round.activity.next),
            resultUnknown: read(round.activity.resultUnknown),
          },
        }),
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? (value as Record<string, unknown>)
    : undefined
function jsonObject(value: unknown): boolean {
  if (!record(value)) return false
  try {
    canonicalizeWorldJson(value as WorldJsonValue)
    return true
  } catch {
    return false
  }
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
function activations(value: unknown): value is SchedulerCycle['activations'] {
  return (
    Array.isArray(value) &&
    Array.from(value).every(entry => {
      const row = record(entry),
        result = record(row?.result)
      return (
        typeof row?.characterId === 'string' &&
        row.characterId.length > 0 &&
        result !== undefined &&
        typeof result.status === 'string' &&
        ['published', 'abstained', 'budget_exhausted', 'interrupted', 'inactive', 'stale', 'failed'].includes(
          result.status,
        ) &&
        count(result.calls) &&
        (result.asOfWorldSeq === undefined || count(result.asOfWorldSeq)) &&
        (result.performResult === undefined || jsonObject(result.performResult)) &&
        (result.failure === undefined ||
          (typeof result.failure === 'string' &&
            ['provider_failed', 'invalid_output', 'preset_failed'].includes(result.failure)))
      )
    })
  )
}
function cycle(value: unknown): SchedulerCycle | undefined {
  const row = record(value)
  if (
    !row ||
    typeof row.terminalReason !== 'string' ||
    !row.terminalReason.trim() ||
    !count(row.calls) ||
    !count(row.wave) ||
    !activations(row.activations)
  )
    return undefined
  return { calls: row.calls, wave: row.wave, terminalReason: row.terminalReason, activations: row.activations }
}

/** Validate every declared result before it can grant normal-cycle settlement. */
export function normalizeSchedulerResult(value: unknown, pluginId = 'scheduler'): SchedulerResult {
  const result = cycle(value)
  const invalid = () => new PluginFaultError(pluginId, 'run', true)
  if (!result) throw invalid()
  const autonomy = record(value)!.autonomy
  if (autonomy === undefined) return result
  const own = record(autonomy)
  if (
    !own ||
    !activations(own.activations) ||
    !count(own.autonomousCalls) ||
    !count(own.reactionCalls) ||
    typeof own.terminalReason !== 'string' ||
    !own.terminalReason.trim()
  )
    throw invalid()
  const reactions = own.reactions === undefined ? undefined : cycle(own.reactions)
  if (own.reactions !== undefined && !reactions) throw invalid()
  return {
    ...result,
    autonomy: {
      activations: own.activations,
      autonomousCalls: own.autonomousCalls,
      reactionCalls: own.reactionCalls,
      terminalReason: own.terminalReason,
      ...(reactions ? { reactions } : {}),
    },
  }
}

/** The official scheduler waits for its own turns; a plugin may not. `settle` cancels and waits for whatever
 * is still running, and turns started after that are refused. */
export function trackSchedulerTurns(round: SchedulerRound): { round: SchedulerRound; settle(): Promise<void> } {
  const controller = new AbortController()
  const running: Promise<unknown>[] = []
  let open = true
  // Marked as handled here so a plugin that drops the promise cannot take the process down with it.
  const handled = <T>(turn: Promise<T>) => {
    turn.catch(() => undefined)
    return turn
  }
  return {
    round: {
      ...round,
      signal: AbortSignal.any([round.signal, controller.signal]),
      turn: (id, options) => {
        if (!open) return handled(Promise.reject(new TypeError('this round has ended')))
        const turn = handled(
          round.turn(id, { ...options, signal: AbortSignal.any([options.signal, round.signal, controller.signal]) }),
        )
        running.push(turn)
        return turn
      },
    },
    settle: async () => {
      open = false
      controller.abort()
      const settled = Promise.allSettled(running).then(() => undefined)
      await Promise.race([settled, new Promise<void>(done => queueMicrotask(done))])
    },
  }
}

import type { ExecutionCycleControl } from './execution-engine.ts'
import type { ExecutionSchedulerRound } from './scheduler-round.ts'

/** Runs an installed scheduler against qualified, budgeted CharacterTurn capabilities. */
export async function executeSchedulerRound(input: {
  readonly round: ExecutionSchedulerRound
  readonly scheduler: SchedulerInstance
  readonly pluginId: string
  readonly context: PluginCallContext
  readonly control: ExecutionCycleControl
}): Promise<SchedulerResult> {
  const { scheduler, pluginId, context, control } = input
  const { validateTurn, forReactions: _forReactions, ...capabilities } = input.round
  const round = { ...capabilities, signal: AbortSignal.any([input.round.signal, control.signal]) }
  let open = true
  const tracked = trackSchedulerTurns({
    ...guardSchedulerReads(round, context, () => open),
    turn: (id, options) => {
      const { beforeModelCall, onCommitted } = options
      return hostCallbackAsync(context, options.signal, operationSignal => {
        validateTurn(id, options)
        return control.activate(id, (activationSignal, onProgress) =>
          round.turn(id, {
            ...options,
            signal: AbortSignal.any([operationSignal, activationSignal]),
            onProgress,
            ...(onCommitted
              ? {
                  onCommitted: (asOfWorldSeq: number, headSeq: number) => {
                    context.scope.assertActive(operationSignal)
                    if (!open) throw new Error('scheduler round has ended')
                    return callPluginSync(context, pluginId, 'onCommitted', () => onCommitted(asOfWorldSeq, headSeq))
                  },
                }
              : {}),
            ...(beforeModelCall
              ? {
                  beforeModelCall: () => {
                    context.scope.assertActive(operationSignal)
                    // This callback belongs to the scheduler, even when invoked through decision.next.
                    return callPluginSync(context, pluginId, 'beforeModelCall', beforeModelCall)
                  },
                }
              : {}),
          }),
        )
      })
    },
  })
  try {
    const result = await callPluginForValueAsync(
      context,
      pluginId,
      'run',
      tracked.round.signal,
      async operationSignal =>
        scheduler.run({
          ...tracked.round,
          signal: operationSignal,
        }),
    )
    const normalized = callPluginSync(context, pluginId, 'run', () => normalizeSchedulerResult(result, pluginId))
    control.observe(normalized.terminalReason)
    return normalized
  } catch (error) {
    if (context.callbacks.has(error)) throw error
    if (round.signal.aborted) {
      control.observe('interrupted')
      return {
        calls: 0,
        wave: 0,
        terminalReason: 'interrupted',
        activations: [],
      }
    }
    if (!context.scope.active || !isPluginFault(error)) throw error
    control.observe('failed')
    console.error(`[调度器插件] ${publicPluginFailure(error) ?? '本轮调度失败。'}`)
    return {
      calls: 0,
      wave: 0,
      terminalReason: error.invalidResult ? 'plugin_invalid' : 'plugin_failed',
      activations: [],
    }
  } finally {
    // Revoke delayed turns, then give already-settled work one microtask without waiting on ignored cancellation.
    open = false
    await tracked.settle()
  }
}
