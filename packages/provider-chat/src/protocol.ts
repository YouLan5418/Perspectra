import type { WorldJsonValue } from '@harness-world/contracts'
import type { ChatMessage } from './wire.ts'
import { objectValue } from './value.ts'

export type ProviderProtocol = 'openai' | 'anthropic' | 'google'
export function providerProtocol(value: unknown): ProviderProtocol {
  if (value === undefined) return 'openai'
  if (value === 'openai' || value === 'anthropic' || value === 'google') return value
  throw new TypeError('模型协议须为 openai、anthropic 或 google。')
}
/** Complete URL; Google's URL model slot follows the selected model. */
export function providerEndpoint(endpoint: URL, protocol: ProviderProtocol, model: string): URL {
  const url = new URL(endpoint)
  if (protocol === 'google') {
    if (!/\/models\/[^/]+:generateContent$/.test(url.pathname)) throw new TypeError('Google 接口须为 /models/模型:generateContent。')
    url.pathname = url.pathname.replace(/\/models\/[^/]+:generateContent$/, '/models/' + encodeURIComponent(model.replace(/^models\//, '')) + ':generateContent')
  }
  return url
}
export function providerHeaders(protocol: ProviderProtocol, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  if (apiKey) headers[protocol === 'anthropic' ? 'x-api-key' : protocol === 'google' ? 'x-goog-api-key' : 'authorization'] = protocol === 'openai' ? `Bearer ${apiKey}` : apiKey
  return headers
}
/** Native APIs separate system instructions from conversation. */
export function nativeMessages(messages: readonly ChatMessage[], protocol: 'anthropic' | 'google'): Record<string, unknown> {
  const system: string[] = []
  const conversation: { role: string; content: string }[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') system.push(message.content)
    else if (message.role === 'user' || message.role === 'assistant') conversation.push({ ...message })
    else throw new TypeError('此原生协议不支持消息身份：' + message.role)
  }
  if (conversation.at(-1)?.role !== 'user') throw new TypeError('原生协议请求须以 user 消息结束；请调整末尾 assistant 预设节点。')
  return protocol === 'anthropic'
    ? { ...(system.length ? { system: system.join('\n\n') } : {}), messages: conversation }
    : { ...(system.length ? { systemInstruction: { parts: system.map(text => ({ text })) } } : {}), contents: conversation.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }],
    })) }
}
/** Extract one decision; never execute vendor tools or expose thinking as a decision. */
export function nativePayload(value: unknown, protocol: 'anthropic' | 'google', toolName?: string): WorldJsonValue {
  const root = objectValue(value)
  const candidate = objectValue(Array.isArray(root?.candidates) ? root.candidates[0] : undefined)
  const blocks = protocol === 'anthropic' ? root?.content : objectValue(candidate?.content)?.parts
  if (root?.stop_reason === 'max_tokens' || candidate?.finishReason === 'MAX_TOKENS') throw new Error('模型输出超过 token 上限。')
  if (!Array.isArray(blocks)) throw new Error('模型接口未返回有效内容。')
  const calls = blocks.map(objectValue).flatMap(block => {
    const call = protocol === 'anthropic' ? (block?.type === 'tool_use' ? block : undefined) : objectValue(block?.functionCall)
    return call ? [call] : []
  })
  if (calls.length) {
    if (calls.length !== 1 || (toolName !== undefined && calls[0]!.name !== toolName)) throw new Error('模型须返回一次指定工具调用。')
    const payload = protocol === 'anthropic' ? calls[0]!.input : calls[0]!.args
    if (payload === undefined || payload === null) throw new Error('工具调用缺少参数。')
    return payload
  }
  const text = blocks.map(objectValue).filter(block => block?.thought !== true && (protocol !== 'anthropic' || block?.type === 'text'))
    .map(block => typeof block?.text === 'string' ? block.text : '').join('')
  if (!text.trim()) throw new Error('模型接口未返回有效文本。')
  try { return JSON.parse(text) as WorldJsonValue } catch { return text }
}
