import type { Api, AssistantMessage, Message, Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { WorldJsonValue } from '@harness-world/contracts'
import { piModel, usesDeepSeekThinking, type ModelTarget } from './pi-model.ts'
import { providerProtocol, type ProviderProtocol } from './protocol.ts'
import type { PresetOrigin, RequestInspector } from './request-inspector.ts'
import { rolePreset, type RolePreset } from './preset.ts'
import type { ThinkingLevel } from './thinking.ts'
import { objectValue, textValue } from './value.ts'
import { intentCall, type ChatCall, type ChatMessage } from './wire.ts'

/** What one call did, for a caller that shows or budgets its own provider traffic. Never content. */
export interface ChatCallObservation {
  readonly kind: 'character' | 'intent'
  readonly model: string
  readonly durationMs: number
  readonly status: 'ok' | 'failed'
  /** HTTP status when the endpoint answered at all. Absent for transport failures, so a refusal stays distinguishable from an unreachable service. */
  readonly httpStatus?: number
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
  /** Defaults to OpenAI-compatible, the protocol most gateways speak. */
  readonly protocol?: ProviderProtocol
  /** The full request address, as the connection stores it. */
  readonly endpoint: URL
  readonly model: string
  /** The Host's Secret. It is used for one header and never stored, hashed, echoed or reported. */
  readonly apiKey?: string
  readonly timeoutMs?: number
  readonly preset?: RolePreset
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly toolName?: string
  readonly thinkingLevel?: ThinkingLevel
  /** Injected so the transport can be tested; the Google adapter cannot take one and always uses the platform's. */
  readonly fetch?: typeof globalThis.fetch
  readonly inspector?: RequestInspector
  readonly presetOrigin?: PresetOrigin
  readonly onCall?: (observation: ChatCallObservation) => void
}

/** A call the endpoint did not answer with a payload at all. That is a provider failure, not a proposal. */
export class ChatTransportError extends Error {}

const APIS: Record<ProviderProtocol, () => ProviderStreams> = {
  openai: openAICompletionsApi,
  anthropic: anthropicMessagesApi,
  google: googleGenerativeAIApi,
}
const THINKING_FLOOR = { low: 8192, medium: 16384, high: 32768 } as const
const NOT_STREAMED = '模型接口未返回流式响应（SSE）；请确认接口支持 stream。'

/**
 * The request shape this adapter sent before pi-ai, kept for an endpoint the catalog does not describe on this
 * host: system messages stay `system` and in place, the output cap is `max_tokens`, and nothing vendor-specific
 * such as `store` or eager tool streaming is added. Preset system nodes keep their place on every OpenAI-compatible
 * endpoint, catalog-described or not, because their position is part of how the author shapes the character.
 */
function callModel(target: ModelTarget): Model<Api> {
  const model = piModel(target)
  if (model.compat !== undefined)
    return target.protocol === 'openai'
      ? ({ ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } } as Model<Api>)
      : model
  if (target.protocol === 'openai')
    return {
      ...model,
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        maxTokensField: 'max_tokens',
        supportsMidConvoSystemMessages: true,
      },
    } as Model<Api>
  if (target.protocol === 'anthropic')
    return { ...model, compat: { supportsEagerToolInputStreaming: false } } as Model<Api>
  return model
}

interface DecisionTool {
  readonly name: string
  readonly description: string
  readonly schema: ChatCall['schema']
}

function context(messages: readonly ChatMessage[], protocol: ProviderProtocol, model: string, tool?: DecisionTool) {
  if (
    protocol !== 'openai' &&
    messages.filter(m => m.role === 'user' || m.role === 'assistant').at(-1)?.role !== 'user'
  )
    throw new TypeError('原生协议请求须以 user 消息结束；请调整末尾 assistant 预设节点。')
  const converted = messages.map((message): Message => {
    if (message.role === 'system' || message.role === 'developer')
      return { role: 'system', content: message.content, timestamp: 0 }
    if (message.role === 'user') return { role: 'user', content: message.content, timestamp: 0 }
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: [{ type: 'text', text: message.content }],
        api: 'prefill',
        provider: 'prefill',
        model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 0,
      } as AssistantMessage
    throw new TypeError('此协议不支持消息身份：' + message.role)
  })
  return normalizeContext({
    messages: converted,
    ...(tool === undefined
      ? {}
      : { tools: [{ name: tool.name, description: tool.description, parameters: tool.schema as never }] }),
  })
}

/**
 * An unset level means no thinking field at all, as before pi-ai: pi-ai writes its own "disabled" otherwise,
 * which a model that cannot turn thinking off refuses. The one exception is the DeepSeek wire format's
 * character decision, which this adapter always sent with thinking disabled.
 */
export function thinkingPayload(
  model: Model<Api>,
  protocol: ProviderProtocol,
  payload: Record<string, unknown>,
  level: ThinkingLevel | undefined,
  kind: 'character' | 'intent',
): Record<string, unknown> {
  if (level !== undefined) return payload
  const next = { ...payload }
  if (protocol === 'openai') {
    for (const key of ['thinking', 'reasoning_effort', 'enable_thinking', 'chat_template_kwargs']) delete next[key]
    if (kind === 'character' && usesDeepSeekThinking(model)) next.thinking = { type: 'disabled' }
  } else if (protocol === 'anthropic') delete next.thinking
  else if (objectValue(next.config)) {
    const { thinkingConfig: _thinking, ...config } = next.config as Record<string, unknown>
    next.config = config
  }
  return next
}

function decisionPayload(
  model: Model<Api>,
  protocol: ProviderProtocol,
  payload: Record<string, unknown>,
  toolName: string,
  enabled: boolean,
  generation: RolePreset,
): Record<string, unknown> {
  const next = { ...payload }
  if (protocol === 'openai') {
    next.tool_choice =
      enabled && usesDeepSeekThinking(model) ? 'auto' : { type: 'function', function: { name: toolName } }
  } else if (protocol === 'anthropic') {
    next.tool_choice = { type: 'auto', disable_parallel_tool_use: true }
    const instruction = '\n请使用 ' + toolName + ' 工具返回本次决策；不要执行其他工具。'
    next.system = Array.isArray(next.system)
      ? [...next.system, { type: 'text', text: instruction }]
      : String(next.system ?? '') + instruction
    if (generation.topP !== undefined) next.top_p = generation.topP
    if (generation.stop?.length) next.stop_sequences = generation.stop
    if (enabled) {
      delete next.temperature
      delete next.top_p
    }
  } else {
    next.config = {
      ...(next.config as Record<string, unknown>),
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolName] } },
      ...(generation.topP === undefined ? {} : { topP: generation.topP }),
      ...(generation.frequencyPenalty === undefined ? {} : { frequencyPenalty: generation.frequencyPenalty }),
      ...(generation.presencePenalty === undefined ? {} : { presencePenalty: generation.presencePenalty }),
      ...(generation.stop?.length ? { stopSequences: generation.stop } : {}),
    }
  }
  return next
}

/** Shapes the assembled answer as content blocks the request inspector already reads; signatures are not kept. */
function inspected(message: AssistantMessage): Record<string, unknown> {
  return {
    content: message.content.flatMap((block): Record<string, unknown>[] =>
      block.type === 'text'
        ? [{ type: 'text', text: block.text }]
        : block.type === 'toolCall'
          ? [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments }]
          : block.redacted
            ? []
            : [{ type: 'thinking', thinking: block.thinking }],
    ),
    stop_reason: message.rawStopReason ?? message.stopReason,
    usage: {
      input_tokens: message.usage.input,
      output_tokens: message.usage.output,
      total_tokens: message.usage.totalTokens,
    },
  }
}

function payloadOf(message: AssistantMessage, toolName: string): WorldJsonValue {
  const calls = message.content.filter(block => block.type === 'toolCall')
  if (calls.length) {
    if (calls.length !== 1 || calls[0]!.name !== toolName) throw new ChatTransportError('模型须返回一次指定工具调用。')
    // Arguments that are not JSON reach the world as the model wrote them, so the refusal keeps its evidence.
    const broken = calls[0]!.argumentsError
    if (broken !== undefined) return broken.split('\n\nReceived arguments:\n').at(-1) ?? broken
    return calls[0]!.arguments as WorldJsonValue
  }
  const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  if (!text.trim()) throw new ChatTransportError('模型接口未返回有效文本。')
  try {
    return JSON.parse(text) as WorldJsonValue
  } catch {
    // Prose is valid World JSON. Returning it lets the world classify the answer as invalid model output.
    return text
  }
}

interface Exchange {
  httpStatus?: number
  detail?: string
  notStreamed?: boolean
}

/** Wraps the transport so the HTTP status and the endpoint's own words survive pi-ai's error normalisation. */
function observingFetch(base: typeof globalThis.fetch, exchange: Exchange): typeof globalThis.fetch {
  return (async (input, init) => {
    // A redirect could carry the key to another host; the old adapter refused them and so does this one.
    const response = await base(input, { ...init, redirect: 'error' })
    exchange.httpStatus = response.status
    if (!response.ok) exchange.detail = (await response.clone().text()).slice(0, 512)
    else if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      exchange.notStreamed = true
      throw new ChatTransportError(NOT_STREAMED)
    }
    return response
  }) as typeof globalThis.fetch
}

function failure(message: AssistantMessage, exchange: Exchange): ChatTransportError {
  if (exchange.notStreamed) return new ChatTransportError(NOT_STREAMED)
  const status = exchange.httpStatus ?? Number(/\b([45]\d\d)\b/.exec(message.errorMessage ?? '')?.[1] ?? NaN)
  if (Number.isFinite(status) && status >= 400) {
    exchange.httpStatus = status
    const detail = exchange.detail ?? message.errorMessage ?? ''
    // Requests always stream; a gateway that refuses the stream fields should say so in the player's language.
    const hint = status === 400 && /stream/i.test(detail) ? '（接口可能不支持流式响应或 stream_options）' : ''
    return new ChatTransportError(
      `chat endpoint returned HTTP ${status}${hint}${detail ? `: ${detail.slice(0, 512)}` : ''}`,
    )
  }
  return new ChatTransportError(message.errorMessage ?? 'chat endpoint failed')
}

/** Key handling shared by decisions and the connection test: a keyless connection sends no auth header. */
function credentials(protocol: ProviderProtocol, apiKey: string | undefined): Partial<SimpleStreamOptions> {
  if (apiKey) return { apiKey }
  if (protocol === 'google') throw new ChatTransportError('Google 协议需要 API Key；请在模型连接中填写。')
  return { apiKey: 'unused', headers: { authorization: null, 'x-api-key': null } }
}

/** One plain-text call for the Launcher's connection test, over the same transport the game uses. */
export async function testTextCall(
  target: ModelTarget,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const exchange: Exchange = {}
  const model = callModel(target)
  const message = await APIS[target.protocol]()
    .streamSimple(
      model,
      context(
        [{ role: 'user', content: '请只回复 OK。这是连接测试，不包含游戏内容。' }],
        target.protocol,
        target.model,
      ),
      {
        ...credentials(target.protocol, apiKey),
        signal,
        maxTokens: 128,
        maxRetries: 0,
        cacheRetention: 'none',
        ...(target.protocol === 'google' ? {} : { fetch: observingFetch(globalThis.fetch, exchange) }),
        onPayload: payload =>
          thinkingPayload(model, target.protocol, payload as Record<string, unknown>, undefined, 'intent'),
      },
    )
    .result()
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw failure(message, exchange)
  const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  if (!text.trim()) throw new ChatTransportError('模型接口未返回有效文本。')
  return text
}

export interface ChatProvider {
  /** One already prepared prototype decision; no tool orchestration or implicit retries. */
  decide(request: ChatCall, signal: AbortSignal): Promise<WorldJsonValue>
  /** An interpretation call, with the Host's own profile limits. */
  dispatch(request: WorldJsonValue, profile: ChatCallProfile, signal: AbortSignal): Promise<WorldJsonValue>
}

/**
 * One adapter from the Host's assembled provider requests to a model endpoint, through pi-ai, and back.
 *
 * It renders and transports; it never judges. What comes back is returned as the model stated it, so the
 * world's own validator and resolution decide it. Failures that belong to the endpoint - a non-OK response,
 * an answer with no payload, a truncated or aborted call - throw.
 */
export function createChatProvider(options: ChatProviderOptions): ChatProvider {
  const preset = rolePreset(options.preset ?? {})
  const protocol = providerProtocol(options.protocol)
  const toolName = options.toolName ?? 'submit_actions'

  async function send(
    prepared: ChatCall,
    modelId: string,
    timeoutMs: number,
    maximum: number,
    kind: ChatCallObservation['kind'],
    signal?: AbortSignal,
  ): Promise<WorldJsonValue> {
    const generation = kind === 'character' ? preset : {}
    if (
      protocol === 'anthropic' &&
      (generation.frequencyPenalty !== undefined || generation.presencePenalty !== undefined)
    )
      throw new TypeError('Anthropic 不支持 frequencyPenalty / presencePenalty；请清空这些预设参数。')
    const messages =
      kind === 'character' && generation.prompt?.trim()
        ? [
            ...prepared.messages.slice(0, 1),
            { role: 'system', content: '角色表现预设：' + generation.prompt },
            ...prepared.messages.slice(1),
          ]
        : prepared.messages
    if (kind === 'character' && generation.maxOutputTokens !== undefined) maximum = generation.maxOutputTokens
    const level = kind === 'character' ? options.thinkingLevel : undefined
    const enabled = level !== undefined && level !== 'off'
    if (enabled) maximum = Math.max(maximum, THINKING_FLOOR[level])
    const model = callModel({ protocol, endpoint: options.endpoint, model: modelId })
    const temperature = generation.temperature ?? options.temperature ?? (protocol === 'anthropic' ? undefined : 0.3)
    const sampling = {
      ...(generation.topP === undefined ? {} : { top_p: generation.topP }),
      ...(generation.frequencyPenalty === undefined ? {} : { frequency_penalty: generation.frequencyPenalty }),
      ...(generation.presencePenalty === undefined ? {} : { presence_penalty: generation.presencePenalty }),
      ...(generation.stop?.length ? { stop: generation.stop } : {}),
    }
    const sources = [...(prepared.inspection?.sources ?? [])]
    if (kind === 'character' && generation.prompt?.trim())
      sources.splice(1, 0, { source: 'preset', name: '附加角色提示', original: generation.prompt })
    const inspection =
      kind === 'character' && prepared.inspection
        ? {
            ...prepared.inspection,
            sources,
            preset: {
              origin: options.presetOrigin ?? {
                scope: 'base' as const,
                characterId: prepared.inspection.characterId,
                name: '默认预设',
              },
              value: generation,
            },
          }
        : undefined
    const exchange: Exchange = {}
    let inspectionId: number | undefined
    let assembled: AssistantMessage | undefined
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      const streamOptions: SimpleStreamOptions = {
        ...credentials(protocol, options.apiKey),
        signal: combined,
        timeoutMs,
        maxRetries: 0,
        maxTokens: maximum,
        cacheRetention: 'none',
        ...(temperature === undefined ? {} : { temperature }),
        ...(enabled ? { reasoning: level } : {}),
        ...(protocol === 'openai' && Object.keys(sampling).length ? { samplingParams: sampling } : {}),
        ...(protocol === 'google' ? {} : { fetch: observingFetch(options.fetch ?? globalThis.fetch, exchange) }),
        onPayload: raw => {
          const payload = decisionPayload(
            model,
            protocol,
            thinkingPayload(model, protocol, raw as Record<string, unknown>, level, kind),
            toolName,
            enabled,
            generation,
          )
          inspectionId = options.inspector?.begin(payload, inspection, messages, modelId)
          return payload
        },
      }
      const message = (assembled = await APIS[protocol]()
        .streamSimple(
          model,
          context(messages, protocol, modelId, {
            name: toolName,
            description: prepared.description,
            schema: prepared.schema,
          }),
          streamOptions,
        )
        .result())
      if (message.stopReason === 'error' || message.stopReason === 'aborted') throw failure(message, exchange)
      if (message.stopReason === 'length') throw new ChatTransportError('模型输出超过 token 上限。')
      const payload = payloadOf(message, toolName)
      options.inspector?.finish(inspectionId, 'ok', elapsed(), inspected(message), {
        httpStatus: exchange.httpStatus ?? 200,
      })
      options.onCall?.({ kind, model: modelId, durationMs: elapsed(), status: 'ok' })
      return payload
    } catch (error: unknown) {
      const answered = assembled !== undefined && assembled.stopReason !== 'error' && assembled.stopReason !== 'aborted'
      options.inspector?.finish(inspectionId, 'failed', elapsed(), answered ? inspected(assembled!) : undefined, {
        ...(exchange.httpStatus === undefined ? {} : { httpStatus: exchange.httpStatus }),
        failure: signal?.aborted
          ? 'cancelled'
          : exchange.httpStatus !== undefined && exchange.httpStatus >= 400
            ? 'http'
            : answered
              ? 'invalid_envelope'
              : 'transport',
      })
      options.onCall?.({
        kind,
        model: modelId,
        durationMs: elapsed(),
        status: 'failed',
        ...(exchange.httpStatus === undefined ? {} : { httpStatus: exchange.httpStatus }),
      })
      throw error
    }
  }

  return {
    async decide(request: ChatCall, signal: AbortSignal): Promise<WorldJsonValue> {
      return await send(
        request,
        options.model,
        options.timeoutMs ?? 60_000,
        options.maxOutputTokens ?? 2_048,
        'character',
        signal,
      )
    },
    async dispatch(request: WorldJsonValue, profile: ChatCallProfile, signal: AbortSignal): Promise<WorldJsonValue> {
      const root = objectValue(request)
      const prepared = intentCall(objectValue(root?.body) ?? root ?? {})
      const model = textValue(profile.modelId) ?? options.model
      return await send(
        prepared,
        model,
        profile.timeoutMs,
        profile.maxOutputTokens ?? options.maxOutputTokens ?? 1_024,
        'intent',
        signal,
      )
    },
  }
}
