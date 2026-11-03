import type { CharacterTurnRequest } from '@harness-world/application'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { DecisionInstance, LlmInstance, MemoryInstance, MemoryRequest } from '@harness-world/plugin-sdk'
import { CharacterPresetError } from '@harness-world/application'
import { characterTurnCall, type ChatCall } from '@harness-world/provider-chat'
import { decideWithFormatRetry } from './decision-format.ts'

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

/** Stops waiting when the signal fires, so a plugin that ignores it cannot hold the round open. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', stop))
}

function guard(id: string, report: ReportPluginFailure) {
  return async <T>(request: MemoryRequest, signal: AbortSignal, work: () => Promise<T>, passedOn?: () => unknown) => {
    try {
      return await untilAborted(work(), signal)
    } catch (error) {
      if (!signal.aborted && error !== passedOn?.())
        report(id, String((request.context.character as WorldJsonObject).characterId), error)
      throw error
    }
  }
}

/** A third-party channel, with its failures named and its calls bounded by the signal. */
export function guardedLlm(instance: LlmInstance, id: string, report: ReportPluginFailure): LlmInstance {
  const guarded = guard(id, report)
  const { prepare, promptText, display, dispatch, close } = instance
  return {
    send: (characterId, call, request, signal) =>
      guarded(request, signal, () => instance.send(characterId, call, request, signal)),
    ...(prepare
      ? {
          prepare: (characterId: string, request: MemoryRequest, signal: AbortSignal) =>
            guarded(request, signal, () => prepare.call(instance, characterId, request, signal)),
        }
      : {}),
    ...(promptText ? { promptText: promptText.bind(instance) } : {}),
    ...(display ? { display: display.bind(instance) } : {}),
    ...(dispatch ? { dispatch: dispatch.bind(instance) } : {}),
    ...(close ? { close: close.bind(instance) } : {}),
  }
}

/** A plugin's decision implementation, with its own failures named. A failure inside `next` is not the plugin's. */
export function guardedDecision(instance: DecisionInstance, id: string, report: ReportPluginFailure): DecisionInstance {
  const guarded = guard(id, report)
  const { serial, committed, debug, close } = instance
  return {
    ...(instance.context
      ? {
          context: <T extends MemoryRequest>(request: T, signal: AbortSignal) =>
            guarded(request, signal, () => instance.context!(request, signal)),
        }
      : {}),
    ...(instance.decide
      ? {
          decide: <T extends MemoryRequest>(
            request: T,
            next: (request: T) => Promise<unknown>,
            signal: AbortSignal,
          ) => {
            let passedOn: unknown
            const onward = (revised: T) =>
              next(revised).catch((error: unknown) => {
                passedOn = error
                throw error
              })
            return guarded(
              request,
              signal,
              () => instance.decide!(request, onward, signal),
              () => passedOn,
            )
          },
        }
      : {}),
    ...(serial ? { serial } : {}),
    ...(committed ? { committed: committed.bind(instance) } : {}),
    ...(debug ? { debug: debug.bind(instance) } : {}),
    ...(close ? { close: close.bind(instance) } : {}),
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
