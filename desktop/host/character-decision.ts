import type { CharacterTurnRequest } from '@harness-world/application'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { DecisionInstance, LlmInstance, MemoryInstance } from '@harness-world/plugin-sdk'
import { CharacterPresetError } from '@harness-world/application'
import { characterTurnCall, type ChatCall } from '@harness-world/provider-chat'
import { decideWithFormatRetry } from './decision-format.ts'

export interface DecisionParts {
  readonly llm: LlmInstance
  readonly memory?: MemoryInstance | undefined
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
