import type { ProviderProtocol } from './protocol.ts'

export const promptCacheLabels = {
  auto: '自动',
  passive: '不主动优化',
  'deepseek-user': 'DeepSeek 角色隔离',
  'prompt-key': '缓存路由标识',
  prefix: '前缀缓存标记',
  openrouter: 'OpenRouter 角色会话',
  'opencode-go': 'OpenCode Go 角色会话',
} as const
export type PromptCacheMode = keyof typeof promptCacheLabels
export type EffectivePromptCacheMode = Exclude<PromptCacheMode, 'auto'>

export function promptCacheMode(value: unknown): PromptCacheMode {
  if (value === undefined) return 'auto'
  if (typeof value === 'string' && Object.hasOwn(promptCacheLabels, value)) return value as PromptCacheMode
  throw new TypeError('未知缓存适配；请从自动、不主动优化或已支持的供应商适配中选择。')
}

/** The official OpenCode Go request paths, matched exactly. */
function openCodeGoRoute(protocol: ProviderProtocol, endpoint: URL): boolean {
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.hostname !== 'opencode.ai') return false
  const path = endpoint.pathname
  return (
    (protocol === 'openai' &&
      [
        '/inference/go/openai/v1/chat/completions',
        '/inference/go/v1/chat/completions',
        '/zen/go/v1/chat/completions',
      ].includes(path)) ||
    (protocol === 'anthropic' &&
      ['/inference/go/anthropic/v1/messages', '/inference/go/v1/messages', '/zen/go/v1/messages'].includes(path)) ||
    (protocol === 'google' && /^\/inference\/go\/google\/v1beta\/models\/[^/]+:generateContent$/.test(path))
  )
}

/** Protocol compatibility does not identify the upstream. Recognize only checked official routes. */
export function effectivePromptCacheMode(
  protocol: ProviderProtocol,
  endpoint: URL,
  mode: PromptCacheMode = 'auto',
): EffectivePromptCacheMode {
  if (mode === 'prompt-key' && protocol !== 'openai')
    throw new TypeError('缓存路由标识仅适用于确认支持 prompt_cache_key 的 OpenAI 兼容接口。')
  if ((mode === 'deepseek-user' || mode === 'prefix') && protocol === 'google')
    throw new TypeError('Google 接口暂不支持该缓存适配；请选择自动或不主动优化。')
  if (mode === 'openrouter' && protocol === 'google')
    throw new TypeError('OpenRouter 请使用 OpenAI 兼容或 Anthropic 协议。')
  // Go answers 400 MissingSessionID to any request without x-opencode-session, so its routes need that session.
  if (openCodeGoRoute(protocol, endpoint) && mode !== 'auto' && mode !== 'opencode-go')
    throw new TypeError('OpenCode Go 要求每个请求带会话标识；请选择自动或 OpenCode Go 角色会话。')
  if (mode !== 'auto') return mode
  if (endpoint.protocol !== 'https:' || endpoint.port) return 'passive'
  const host = endpoint.hostname,
    path = endpoint.pathname
  if (
    ['openrouter.ai', 'us.openrouter.ai', 'eu.openrouter.ai'].includes(host) &&
    ((protocol === 'openai' && path === '/api/v1/chat/completions') ||
      (protocol === 'anthropic' && path === '/api/v1/messages'))
  )
    return 'openrouter'
  if (openCodeGoRoute(protocol, endpoint)) return 'opencode-go'
  // DeepSeek's user_id partitions its KV cache: a fresh per-run ID would forfeit shared prefixes and any earlier
  // warm-up (regenerate, candidate switch, restart), and live A/B showed no gain, so auto leaves DeepSeek passive.
  if (protocol === 'openai') {
    if (host === 'api.openai.com' && path === '/v1/chat/completions') return 'prompt-key'
    if (host === 'ark.cn-beijing.volces.com' && path === '/api/v3/chat/completions') return 'prompt-key'
    if (
      ['dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'].includes(host) &&
      path === '/compatible-mode/v1/chat/completions'
    )
      return 'prefix'
  }
  if (protocol === 'anthropic') {
    if (host === 'api.anthropic.com' && path === '/v1/messages') return 'prefix'
    if (
      ['dashscope.aliyuncs.com', 'coding.dashscope.aliyuncs.com'].includes(host) &&
      path === '/apps/anthropic/v1/messages'
    )
      return 'prefix'
  }
  return 'passive'
}

/** Add one short-lived marker without changing text or marking the changing character-context tail. */
function markedContent(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  if (!Array.isArray(content)) return content
  const index = content.findLastIndex(block => block?.type === 'text')
  return content.map((block, i) => (i === index ? { ...block, cache_control: { type: 'ephemeral' } } : block))
}

/** Native gateway sessions are transport metadata, not a model-visible character identifier. */
export function promptCacheHeaders(
  protocol: ProviderProtocol,
  mode: EffectivePromptCacheMode,
  key: string,
): Record<string, string> | undefined {
  if (mode === 'opencode-go') return { 'x-opencode-session': key, 'User-Agent': 'Perspectra' }
  if (mode === 'openrouter' && protocol === 'anthropic') return { 'x-session-id': key }
  return undefined
}

/** This runs after SDK serialization; none of these fields enter the character's messages. */
export function promptCachePayload(
  payload: Record<string, unknown>,
  protocol: ProviderProtocol,
  mode: EffectivePromptCacheMode,
  key: string,
): Record<string, unknown> {
  if (mode === 'openrouter') {
    const routed = protocol === 'openai' ? { ...payload, session_id: key } : payload
    // These canonical OpenRouter model IDs are documented as accepting explicit cache markers.
    const model = String(payload.model)
    const explicit =
      model.startsWith('anthropic/') ||
      [
        'deepseek/deepseek-v3.2',
        'qwen/qwen3-max',
        'qwen/qwen-plus',
        'qwen/qwen3.6-plus',
        'qwen/qwen3-coder-plus',
        'qwen/qwen3-coder-flash',
      ].includes(model)
    return explicit ? promptCachePayload(routed, protocol, 'prefix', key) : routed
  }
  if (mode === 'deepseek-user')
    return protocol === 'openai'
      ? { ...payload, user_id: key }
      : { ...payload, metadata: { ...(payload.metadata as Record<string, unknown> | undefined), user_id: key } }
  if (mode === 'prompt-key') return { ...payload, prompt_cache_key: key }
  if (mode !== 'prefix') return payload
  if (protocol === 'anthropic') return { ...payload, system: markedContent(payload.system) }
  const messages = payload.messages as { role: string; content: unknown }[]
  let boundary = -1
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'system' && message.role !== 'developer') break
    boundary = index
  }
  return {
    ...payload,
    messages: messages.map((message, index) =>
      index === boundary ? { ...message, content: markedContent(message.content) } : message,
    ),
  }
}
