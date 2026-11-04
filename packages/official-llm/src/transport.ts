import type { LlmTransportCall, LlmTransportInstance } from '@harness-world/plugin-sdk'
import type { ChatCall, RequestInspector, RolePreset, ChatCallObservation } from '@harness-world/provider-chat'

/** Wait for cancellation even if a trusted adapter forgets to observe it. */
async function sent<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(work), cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function transportSend(options: {
  readonly id: string
  readonly instance: LlmTransportInstance
  readonly inspector: RequestInspector
  readonly timeoutMs: number
  readonly onCall: (observation: ChatCallObservation) => void
  readonly failure: (characterId: string, error: unknown) => void
}) {
  return async (characterId: string, prepared: ChatCall, preset: RolePreset, signal: AbortSignal) => {
    const generation = Object.fromEntries(
      ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens', 'stop']
        .filter(key => preset[key as keyof RolePreset] !== undefined)
        .map(key => [key, preset[key as keyof RolePreset]]),
    )
    const messages = preset.prompt?.trim()
      ? [
          ...prepared.messages.slice(0, 1),
          { role: 'system', content: '角色表现预设：' + preset.prompt },
          ...prepared.messages.slice(1),
        ]
      : prepared.messages
    const sources = [...(prepared.inspection?.sources ?? [])]
    if (preset.prompt?.trim()) sources.splice(1, 0, { source: 'preset', name: '附加角色提示', original: preset.prompt })
    const call: LlmTransportCall = { messages, schema: prepared.schema, generation: structuredClone(generation) }
    const inspection = prepared.inspection ? { ...prepared.inspection, sources } : undefined
    const id = options.inspector.begin(
      { transport: options.id, model: options.instance.model, ...call },
      inspection,
      call.messages,
      options.instance.model,
    )
    const started = performance.now()
    const limited = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
    try {
      const reply = await sent(() => options.instance.send(characterId, call, limited), limited)
      if (!reply || !Object.hasOwn(reply, 'value')) throw new TypeError('transport must return a value envelope')
      const durationMs = performance.now() - started
      options.inspector.finish(
        id,
        'ok',
        durationMs,
        reply.value,
        reply.httpStatus === undefined ? {} : { httpStatus: reply.httpStatus },
      )
      options.onCall({
        kind: 'character',
        model: options.instance.model,
        status: 'ok',
        durationMs,
        ...(reply.httpStatus === undefined ? {} : { httpStatus: reply.httpStatus }),
      })
      return reply.value
    } catch (error) {
      const status = (error as { httpStatus?: unknown } | null)?.httpStatus
      const httpStatus = typeof status === 'number' && Number.isInteger(status) ? status : undefined
      const durationMs = performance.now() - started
      options.inspector.finish(id, 'failed', durationMs, undefined, {
        failure: limited.aborted ? 'cancelled' : httpStatus === undefined ? 'transport' : 'http',
        ...(httpStatus === undefined ? {} : { httpStatus }),
      })
      options.onCall({
        kind: 'character',
        model: options.instance.model,
        status: 'failed',
        durationMs,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      })
      if (!signal.aborted) options.failure(characterId, error)
      throw error
    }
  }
}
