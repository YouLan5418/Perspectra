import { recordExecutionModelSend } from '@perspectra/core'
import type { CharacterTurnRequest } from '@perspectra/core'
import { isJsonObject } from '@perspectra/sdk/contracts'
import type { CharacterId, WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import type {
  DecisionInstance,
  KnowledgeInstance,
  LlmInstance,
  LlmTransportInstance,
  MemoryInstance,
  MemoryRequest,
} from '@perspectra/sdk'
import { CharacterPresetError } from '@perspectra/core'
import { characterTurnCall, type ChatCall } from '@perspectra/providers/chat'
import { decideWithFormatRetry } from './decision-format.ts'
import {
  callPluginForValue,
  callPluginForValueAsync,
  hostCapabilityAsync,
  invalidPluginResult,
  isPluginFault,
  type PluginCallContext,
} from './plugin-runtime.ts'

export interface DecisionParts {
  readonly llm: LlmInstance
  readonly memory?: MemoryInstance | undefined
  /** Whether a failed prompt can only be a preset's fault, which is true of the official channel alone. */
  readonly presetsPrepare: boolean
  /** An author's scripted line for this request, which takes the place of a model call. */
  readonly simulate: (request: CharacterTurnRequest) => unknown
  /** Called before each model call; throws when the round has no calls left. */
  readonly spendCall: () => void
  readonly trace: (characterId: string, request: CharacterTurnRequest, source: 'model' | 'script', raw: unknown) => void
}

/** From a finished request to a raw decision: prompt, model call or script, and one format retry. */
export async function runDecision(
  parts: DecisionParts,
  request: CharacterTurnRequest,
  signal: AbortSignal,
  reserveFormatRetry?: () => boolean,
): Promise<unknown> {
  const { llm, memory } = parts
  const characterId = String((request.context.character as WorldJsonObject).characterId)
  let prepared: ChatCall
  try {
    prepared = llm.prepare
      ? ((await llm.prepare(characterId, request, signal)) as ChatCall)
      : characterTurnCall(request)
  } catch (error) {
    signal.throwIfAborted()
    if (!parts.presetsPrepare) throw error
    throw new CharacterPresetError('角色预设准备失败。', { cause: error })
  }
  memory?.observeContext?.(
    request,
    prepared.messages.map(message => message.content).join('\n') +
      JSON.stringify(prepared.schema) +
      (llm.promptText?.(characterId) ?? ''),
  )
  const simulated = parts.simulate(request)
  // Preset output rules clean up model text. A scripted line is the author's exact text, which activity hooks
  // check verbatim on publication, so it bypasses them.
  const decide = async (call: ChatCall) => {
    if (simulated !== undefined) return simulated as WorldJsonValue
    signal.throwIfAborted()
    parts.spendCall()
    return (await llm.send(characterId, call, request, signal)) as WorldJsonValue
  }
  const raw = await decideWithFormatRetry(
    prepared,
    decide,
    signal,
    characterTurnCall(request).schema,
    request.context.activity === undefined && simulated === undefined
      ? (reserveFormatRetry ?? (() => false))
      : undefined,
  )
  parts.trace(characterId, request, simulated === undefined ? 'model' : 'script', raw)
  memory?.recordDecision?.(request, raw)
  signal.throwIfAborted()
  return raw
}

/** How a plugin's failure reaches the log and the player's notice. */
export type ReportPluginFailure = (pluginId: string, characterId: string, error: unknown) => void

/** Knowledge selection is synchronous. Its boundary owns both the request copy and the selected JSON copy. */
export function guardedKnowledge(
  instance: KnowledgeInstance,
  id: string,
  context: PluginCallContext,
  report: ReportPluginFailure,
): KnowledgeInstance {
  const { select } = instance
  return {
    select: input => {
      const character = input.character
      const characterId =
        isJsonObject(character) && typeof character.characterId === 'string' ? character.characterId : 'gameplay'
      try {
        return callPluginForValue(context, id, 'select', () => {
          const value = select.call(instance, structuredClone(input))
          if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value)))
            throw invalidPluginResult(context, id, 'select')
          return value
        })
      } catch (error) {
        if (isPluginFault(error)) report(id, characterId, error)
        throw error
      }
    },
  }
}

export function guardedMemory(
  instance: MemoryInstance,
  id: string,
  context: PluginCallContext,
  report: ReportPluginFailure,
): MemoryInstance {
  const asyncGuard = async <T>(
    operation: string,
    actorId: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T> => {
    try {
      return await callPluginForValueAsync(context, id, operation, signal, work)
    } catch (error) {
      if (isPluginFault(error)) report(id, actorId, error)
      throw error
    }
  }
  const syncGuard = <T>(operation: string, actorId: string, work: () => T): T => {
    try {
      return callPluginForValue(context, id, operation, work)
    } catch (error) {
      if (isPluginFault(error)) report(id, actorId, error)
      throw error
    }
  }
  const { observeContext, recordDecision, shortTermAfterSeq, startPending, cancelBackground, waitForBackground } =
      instance,
    {
      backgroundState,
      startRefresh,
      inspect,
      snapshotAliases,
      snapshotArchives,
      restoreArchives,
      holdInstallation,
      releaseInstallation,
    } = instance
  return {
    project: <T extends MemoryRequest>(request: T, signal: AbortSignal) =>
      asyncGuard(
        'project',
        String((request.context.character as WorldJsonObject).characterId),
        signal,
        operationSignal => instance.project(structuredClone(request), operationSignal),
      ),
    ...(observeContext
      ? {
          observeContext: (request: MemoryRequest, promptText: string) =>
            syncGuard('observeContext', String((request.context.character as WorldJsonObject).characterId), () =>
              observeContext.call(instance, structuredClone(request), promptText),
            ),
        }
      : {}),
    ...(recordDecision
      ? {
          recordDecision: (request: MemoryRequest, response: unknown) =>
            syncGuard('recordDecision', String((request.context.character as WorldJsonObject).characterId), () =>
              recordDecision.call(instance, structuredClone(request), structuredClone(response)),
            ),
        }
      : {}),
    ...(shortTermAfterSeq
      ? {
          shortTermAfterSeq: (characterId: CharacterId) =>
            syncGuard('shortTermAfterSeq', String(characterId), () => shortTermAfterSeq.call(instance, characterId)),
        }
      : {}),
    ...(startPending
      ? { startPending: () => syncGuard('startPending', 'gameplay', () => startPending.call(instance)) }
      : {}),
    ...(cancelBackground
      ? {
          cancelBackground: () => syncGuard('cancelBackground', 'gameplay', () => cancelBackground.call(instance)),
        }
      : {}),
    ...(waitForBackground
      ? {
          waitForBackground: () =>
            asyncGuard('waitForBackground', 'gameplay', context.scope.signal, () => waitForBackground.call(instance)),
        }
      : {}),
    ...(backgroundState
      ? {
          backgroundState: () => syncGuard('backgroundState', 'gameplay', () => backgroundState.call(instance)),
        }
      : {}),
    ...(startRefresh
      ? {
          startRefresh: (characterIds: readonly CharacterId[]) =>
            syncGuard('startRefresh', 'gameplay', () => startRefresh.call(instance, structuredClone(characterIds))),
        }
      : {}),
    ...(inspect
      ? {
          inspect: (characterId: string, offset: number, limit: number) =>
            syncGuard('inspect', characterId, () => inspect.call(instance, characterId, offset, limit)),
        }
      : {}),
    ...(snapshotAliases
      ? {
          snapshotAliases: (characterIds: readonly CharacterId[]) =>
            syncGuard('snapshotAliases', 'gameplay', () =>
              snapshotAliases.call(instance, structuredClone(characterIds)),
            ),
        }
      : {}),
    ...(snapshotArchives
      ? {
          snapshotArchives: (characterIds: readonly CharacterId[]) =>
            syncGuard('snapshotArchives', 'gameplay', () =>
              snapshotArchives.call(instance, structuredClone(characterIds)),
            ),
        }
      : {}),
    ...(restoreArchives
      ? {
          restoreArchives: (archives: WorldJsonObject, characterIds: readonly CharacterId[]) =>
            syncGuard('restoreArchives', 'gameplay', () =>
              restoreArchives.call(instance, structuredClone(archives), structuredClone(characterIds)),
            ),
        }
      : {}),
    ...(holdInstallation
      ? {
          holdInstallation: () => syncGuard('holdInstallation', 'gameplay', () => holdInstallation.call(instance)),
        }
      : {}),
    ...(releaseInstallation
      ? {
          releaseInstallation: () =>
            syncGuard('releaseInstallation', 'gameplay', () => releaseInstallation.call(instance)),
        }
      : {}),
  }
}

function guard(context: PluginCallContext, id: string, report: ReportPluginFailure) {
  return async <T>(
    operation: string,
    actorId: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => T | PromiseLike<T>,
  ) => {
    try {
      return await callPluginForValueAsync(context, id, operation, signal, work)
    } catch (error) {
      if (isPluginFault(error)) report(id, actorId, error)
      throw error
    }
  }
}

/** A third-party channel, with its failures named and its calls bounded by the signal. */
export function guardedLlm(
  instance: LlmInstance,
  id: string,
  context: PluginCallContext,
  report: ReportPluginFailure,
): LlmInstance {
  const guarded = guard(context, id, report),
    prompt = (characterId: string) => {
      try {
        return callPluginForValue(context, id, 'promptText', () => instance.promptText!(characterId))
      } catch (error) {
        if (isPluginFault(error)) report(id, characterId, error)
        throw error
      }
    }
  const { prepare, promptText, display, dispatch } = instance
  return {
    send: (characterId, call, request, signal) =>
      guarded('send', characterId, signal, operationSignal => {
        recordExecutionModelSend()
        return instance.send(characterId, structuredClone(call), structuredClone(request), operationSignal)
      }),
    ...(prepare
      ? {
          prepare: (characterId: string, request: MemoryRequest, signal: AbortSignal) =>
            guarded('prepare', characterId, signal, operationSignal =>
              prepare.call(instance, characterId, structuredClone(request), operationSignal),
            ),
        }
      : {}),
    ...(promptText ? { promptText: prompt } : {}),
    ...(display
      ? {
          display: <T>(view: T) =>
            guarded<T>('display', 'gameplay', context.scope.signal, () => display<T>(structuredClone(view))),
        }
      : {}),
    ...(dispatch
      ? {
          dispatch: (request: WorldJsonValue, profile: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonValue> =>
            guarded('dispatch', 'gameplay', signal, operationSignal => {
              recordExecutionModelSend()
              return dispatch.call(instance, structuredClone(request), structuredClone(profile), operationSignal)
            }),
        }
      : {}),
  }
}

function isTransportResponse(value: unknown): value is { readonly value: unknown; readonly httpStatus?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'value'))
    return false
  const status = Reflect.get(value, 'httpStatus')
  return status === undefined || (typeof status === 'number' && Number.isInteger(status))
}

/** An adapter's own call boundary. The envelope is rebuilt so private fields or raw causes cannot reach the player. */
export function guardedLlmTransport(
  instance: LlmTransportInstance,
  id: string,
  context: PluginCallContext,
  report: ReportPluginFailure,
): LlmTransportInstance {
  return {
    model: instance.model,
    schemaMode: instance.schemaMode,
    send: async (characterId, call, signal) => {
      try {
        return await callPluginForValueAsync(context, id, 'send', signal, async operationSignal => {
          const response = await instance.send(characterId, structuredClone(call), operationSignal)
          if (!isTransportResponse(response)) throw invalidPluginResult(context, id, 'send')
          return {
            value: response.value,
            ...(response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus }),
          }
        })
      } catch (error) {
        if (isPluginFault(error)) report(id, characterId, error)
        throw error
      }
    },
  }
}

/** A plugin's decision implementation, with its own failures named. A failure inside `next` is not the plugin's. */
export function guardedDecision(
  instance: DecisionInstance,
  id: string,
  context: PluginCallContext,
  report: ReportPluginFailure,
): DecisionInstance {
  const guarded = guard(context, id, report),
    reportSync = <T>(operation: string, work: () => T): T => {
      try {
        return callPluginForValue(context, id, operation, work)
      } catch (error) {
        if (isPluginFault(error)) report(id, 'gameplay', error)
        throw error
      }
    }
  const { serial, committed, debug, shortTermAfterSeq } = instance
  return {
    ...(instance.context
      ? {
          context: <T extends MemoryRequest>(request: T, signal: AbortSignal) =>
            guarded(
              'context',
              String((request.context.character as WorldJsonObject).characterId),
              signal,
              operationSignal => instance.context!(structuredClone(request), operationSignal),
            ),
        }
      : {}),
    ...(instance.decide
      ? {
          decide: <T extends MemoryRequest>(request: T, next: (request: T) => Promise<unknown>, signal: AbortSignal) =>
            guarded(
              'decide',
              String((request.context.character as WorldJsonObject).characterId),
              signal,
              operationSignal =>
                instance.decide!(
                  structuredClone(request),
                  hostCapabilityAsync(context, operationSignal, revised => next(structuredClone(revised))),
                  operationSignal,
                ),
            ),
        }
      : {}),
    ...(shortTermAfterSeq
      ? {
          shortTermAfterSeq: (characterId: CharacterId) =>
            reportSync('shortTermAfterSeq', () => shortTermAfterSeq.call(instance, characterId)),
        }
      : {}),
    ...(serial ? { serial } : {}),
    ...(committed
      ? { committed: (headSeq: number) => reportSync('committed', () => committed.call(instance, headSeq)) }
      : {}),
    ...(debug ? { debug: () => reportSync('debug', () => debug.call(instance)) } : {}),
  }
}

/** Wraps `inner` with each implementation's `decide`; the first registered is outermost. */
export function wrapDecision(
  decisions: readonly DecisionInstance[],
  inner: (request: CharacterTurnRequest) => Promise<unknown>,
  signal: AbortSignal,
): (request: CharacterTurnRequest) => Promise<unknown> {
  return decisions.reduceRight(
    (next, decision) => (decision.decide ? request => decision.decide!(request, next, signal) : next),
    inner,
  )
}
