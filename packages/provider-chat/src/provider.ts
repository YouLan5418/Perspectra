import type { RequestInspector } from './request-inspector.ts'
import { rolePreset, type RolePreset } from './preset.ts'
import type { WorldJsonValue } from '@harness-world/contracts'
import { objectValue, textValue } from './value.ts'
import { actionGroupCall, intentCall, type ChatCall, type ExactProviderRequest } from './wire.ts'

/**
 * How the endpoint takes a schema. `tool` is the OpenAI-shaped forced tool call, which is what the spec
 * asks for where the provider supports it; `format` is the same request expressed as a vendor-side output
 * format, for local endpoints that have no tools at all.
 */
export type ChatStyle = 'tool' | 'format'

/** What one call did, for a caller that shows or budgets its own provider traffic. Never content. */
export interface ChatCallObservation {
  readonly kind: 'character' | 'intent'
  readonly model: string
  readonly durationMs: number
  readonly status: 'ok' | 'failed'
}

/**
 * The per-call limits the Host states in its interpretation profile. It is declared here structurally
 * rather than imported from the application: an adapter may not depend on who calls it, and the profile
 * the Host passes - which carries more than this - still satisfies it.
 */
export interface ChatCallProfile {
  readonly modelId: string
  readonly timeoutMs: number
  readonly maxOutputTokens?: number
}

export interface ChatProviderOptions {
  readonly endpoint: URL
  readonly model: string
  /** The Host's Secret. It is used for one header and never stored, hashed, echoed or reported. */
  readonly apiKey?: string
  readonly style?: ChatStyle
  readonly timeoutMs?: number
  readonly preset?: RolePreset
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly toolName?: string
  /**
   * A forced tool call and the endpoint's reasoning mode are mutually exclusive - it answers
   * "thinking mode does not support this tool_choice" and refuses the call - so a `tool` call states that
   * reasoning is off. A caller that wants reasoning says `unspecified` and accepts that the answer may not
   * be bound to the schema it was handed.
   */
  readonly thinking?: 'disabled' | 'unspecified'
  /** Injected so the transport can be tested against a local endpoint instead of a vendor. */
  readonly fetch?: typeof globalThis.fetch
  readonly inspector?: RequestInspector
  readonly onCall?: (observation: ChatCallObservation) => void
}

/** A call the endpoint did not answer with a payload at all. That is a provider failure, not a proposal. */
export class ChatTransportError extends Error {}

function payloadOf(value: unknown, style: ChatStyle): WorldJsonValue {
  const root = objectValue(value)
  const message = style === 'tool'
    ? objectValue(objectValue(Array.isArray(root?.choices) ? root.choices[0] : undefined)?.message)
    : objectValue(root?.message)
  const call = objectValue(Array.isArray(message?.tool_calls) ? message.tool_calls[0] : undefined)
  const fn = objectValue(call?.function)
  // Some endpoints hand the arguments over already parsed; the ones that hand over a string are the ones
  // whose payload this adapter parses.
  const stated = fn?.arguments ?? message?.content
  if (stated === undefined || stated === null) throw new ChatTransportError('chat endpoint returned no payload')
  if (typeof stated !== 'string') return stated as WorldJsonValue
  try {
    return JSON.parse(stated) as WorldJsonValue
  } catch {
    // Prose is valid World JSON. Returning it lets the world classify the answer as invalid model output -
    // with what the model actually said kept in the durable call - instead of the adapter turning it into a
    // transport failure, which is a different fact about a different thing.
    return stated
  }
}

export interface ChatProvider {
  /** One already prepared prototype decision; no tool orchestration or implicit retries. */
  decide(request: ChatCall, signal: AbortSignal): Promise<WorldJsonValue>
  /** A character call: the Host's exact assembled request, rendered for one endpoint. */
  propose(context: unknown): Promise<WorldJsonValue>
  /** An interpretation call, with the Host's own profile limits. */
  dispatch(request: WorldJsonValue, profile: ChatCallProfile, signal: AbortSignal): Promise<WorldJsonValue>
}

/**
 * One adapter from the Host's assembled provider requests to a chat-completions endpoint, and back.
 *
 * It renders and transports; it never judges. What comes back is returned as the model stated it, so the
 * world's own validator and resolution decide it - a payload the protocol refuses stays a refused
 * proposal rather than becoming an adapter-side error. Failures that belong to the endpoint - a non-OK
 * response, an answer with no payload, an aborted call - throw, which is how the Host's availability and
 * output-quality policies see them.
 */
export function createChatProvider(options: ChatProviderOptions): ChatProvider {
  const preset=rolePreset(options.preset??{})
  const post = options.fetch ?? globalThis.fetch
  const style = options.style ?? 'tool'
  const toolName = options.toolName ?? 'submit_actions'

  async function send(prepared: ChatCall, model: string, timeoutMs: number, maximum: number,
    kind: ChatCallObservation['kind'], signal?: AbortSignal): Promise<WorldJsonValue> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // The Host resolves the Secret; the adapter only carries it, and nothing here records or reports it.
    if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`
    const generation=kind==='character'?preset:{}
    const messages=kind==='character'&&generation.prompt?.trim()
      ? [...prepared.messages.slice(0,1),{role:'system',content:'角色表现预设：'+generation.prompt},...prepared.messages.slice(1)] : prepared.messages
    if(kind==='character'&&generation.maxOutputTokens!==undefined)maximum=generation.maxOutputTokens
    const body = style === 'tool'
      ? { model, messages, stream: false, temperature: generation.temperature ?? options.temperature ?? 0.3,
        max_tokens: maximum,
        ...(generation.topP===undefined?{}:{top_p:generation.topP}),
        ...(generation.frequencyPenalty===undefined?{}:{frequency_penalty:generation.frequencyPenalty}),
        ...(generation.presencePenalty===undefined?{}:{presence_penalty:generation.presencePenalty}),
        ...(generation.stop?.length?{stop:generation.stop}:{}),
        ...(options.thinking === 'unspecified' ? {} : { thinking: { type: 'disabled' } }),
        tools: [{ type: 'function', function: { name: toolName, description: prepared.description,
          parameters: prepared.schema } }],
        tool_choice: { type: 'function', function: { name: toolName } } }
      : { model, messages, stream: false, format: prepared.schema,
        options: { temperature: generation.temperature ?? options.temperature ?? 0.3, num_predict: maximum,
          ...(generation.topP===undefined?{}:{top_p:generation.topP}),
          ...(generation.frequencyPenalty===undefined?{}:{frequency_penalty:generation.frequencyPenalty}),
          ...(generation.presencePenalty===undefined?{}:{presence_penalty:generation.presencePenalty}),
          ...(generation.stop?.length?{stop:generation.stop}:{}), } }
    const sources = [...(prepared.inspection?.sources ?? [])]
    if (kind === 'character' && generation.prompt?.trim()) sources.splice(1, 0, {source:'preset',name:'附加角色提示',original:generation.prompt})
    const inspection = kind === 'character' && prepared.inspection ? {...prepared.inspection,sources} : undefined
    const inspectionId = options.inspector?.begin(body, inspection)
    const started = performance.now()
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await post(options.endpoint, { method: 'POST', redirect: 'error', headers,
        body: JSON.stringify(body), signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) })
      if (!response.ok) {
        // The endpoint's own words about what it refused are the operator's only clue, so they travel with
        // the failure rather than being replaced by a status code.
        const detail = (await response.text()).slice(0, 512)
        throw new ChatTransportError(`chat endpoint returned HTTP ${response.status}${detail.length === 0 ? '' : `: ${detail}`}`)
      }
      const responseBody: unknown = await response.json()
      const payload = payloadOf(responseBody, style)
      options.inspector?.finish(inspectionId, 'ok', Math.round(performance.now() - started), responseBody)
      options.onCall?.({ kind, model, durationMs: Math.round(performance.now() - started), status: 'ok' })
      return payload
    } catch (error: unknown) {
      options.inspector?.finish(inspectionId, 'failed', Math.round(performance.now() - started))
      options.onCall?.({ kind, model, durationMs: Math.round(performance.now() - started), status: 'failed' })
      throw error
    }
  }

  return {
    async decide(request: ChatCall, signal: AbortSignal): Promise<WorldJsonValue> {
      return await send(request, options.model, options.timeoutMs ?? 60_000,
        options.maxOutputTokens ?? 2_048, 'character', signal)
    },
    async propose(context: unknown): Promise<WorldJsonValue> {
      const exact = (context as { readonly exactProviderRequest?: ExactProviderRequest }).exactProviderRequest
      if (exact === undefined) throw new ChatTransportError('character call carries no exact provider request')
      return await send(actionGroupCall(exact), options.model, options.timeoutMs ?? 60_000,
        options.maxOutputTokens ?? 2_048, 'character')
    },
    async dispatch(request: WorldJsonValue, profile: ChatCallProfile, signal: AbortSignal): Promise<WorldJsonValue> {
      // The Host hands over its request together with the waterline it was prepared at, so the request is
      // the `body` of what arrives. A caller that passes the request alone reads the same way.
      const root = objectValue(request)
      const prepared = intentCall(objectValue(root?.body) ?? root ?? {})
      // The profile is the Host's own statement about this call: the model it asked for, and its limits.
      const model = textValue(profile.modelId) ?? options.model
      return await send(prepared, model, profile.timeoutMs,
        profile.maxOutputTokens ?? options.maxOutputTokens ?? 1_024, 'intent', signal)
    },
  }
}
