import { providerHeaders, providerProtocol, type ProviderProtocol } from '../packages/provider-chat/src/protocol.ts'
import type { ThinkingLevel } from '../packages/provider-chat/src/thinking.ts'

/** One remembered provider address. Its key lives in the OS credential store, never here. */
export interface ModelConnection { id: string; name: string; protocol: ProviderProtocol; endpoint: string }
export interface ModelTarget { connectionId: string; model: string }
export interface DecisionTarget extends ModelTarget { thinkingLevel?: ThinkingLevel }
export interface CharacterModels { decision?: DecisionTarget; memory?: ModelTarget }
export interface InstanceModels { decision: DecisionTarget; memory?: ModelTarget; characters?: Record<string, CharacterModels> }

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

/** Full request address; key material never belongs in it. */
export function modelEndpoint(endpoint: string, protocol: ProviderProtocol): URL {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请使用不含认证参数的 HTTP/HTTPS 地址。')
  if (protocol === 'openai' && !url.pathname.endsWith('/chat/completions')) throw new Error('接口地址须包含 /chat/completions。')
  if (protocol === 'anthropic' && !url.pathname.endsWith('/messages')) throw new Error('Anthropic 接口须以 /messages 结尾。')
  if (protocol === 'google' && !/\/models\/[^/]+:generateContent$/.test(url.pathname)) throw new Error('Google 接口须为 /models/模型:generateContent。')
  return url
}

export function modelConnection(value: unknown): ModelConnection {
  const data = record(value, '连接无效。')
  if (Object.keys(data).some(key => !['id', 'name', 'protocol', 'endpoint'].includes(key))) throw new Error('连接包含不支持的字段。')
  if (typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) throw new Error('连接标识无效。')
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) throw new Error('连接名称无效。')
  if (typeof data.endpoint !== 'string' || data.endpoint.length > 4096) throw new Error('接口地址无效。')
  const protocol = providerProtocol(data.protocol)
  return { id: data.id, name: data.name.trim(), protocol, endpoint: modelEndpoint(data.endpoint, protocol).href }
}

export function modelsListUrl(connection: ModelConnection): URL {
  const url = new URL(connection.endpoint)
  url.pathname = connection.protocol === 'openai' ? url.pathname.replace(/\/chat\/completions$/, '/models')
    : connection.protocol === 'anthropic' ? url.pathname.replace(/\/messages$/, '/models')
      : url.pathname.replace(/\/models\/[^/]+:generateContent$/, '/models')
  return url
}

export function modelPage(protocol: ProviderProtocol, body: unknown): { models: string[]; next?: string } {
  const data = record(body, '模型列表格式无效。')
  const entries = protocol === 'google' ? data.models : data.data
  if (!Array.isArray(entries)) throw new Error('模型列表格式无效。')
  const models = entries.flatMap(entry => {
    const item = record(entry, '模型列表格式无效。')
    if (protocol !== 'google') return typeof item.id === 'string' ? [item.id] : []
    const methods = item.supportedGenerationMethods
    if (typeof item.name !== 'string' || (Array.isArray(methods) && !methods.includes('generateContent'))) return []
    return [item.name.replace(/^models\//, '')]
  })
  const next = protocol === 'anthropic' ? (data.has_more === true && typeof data.last_id === 'string' ? data.last_id : undefined)
    : protocol === 'google' && typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined
  return next === undefined ? { models } : { models, next }
}

/** Lists the provider's models. Errors never echo the key or the provider's response. */
export async function listModels(connection: ModelConnection, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<string[]> {
  const found = new Set<string>()
  let next: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = modelsListUrl(connection)
    if (next !== undefined) url.searchParams.set(connection.protocol === 'anthropic' ? 'after_id' : 'pageToken', next)
    let response: Response
    try { response = await fetcher(url, { method: 'GET', redirect: 'error', headers: providerHeaders(connection.protocol, apiKey), signal: AbortSignal.timeout(15000) }) }
    catch { throw new Error('模型列表连接失败或超过 15 秒；请检查接口地址、服务是否启动和网络。') }
    if (response.status === 401 || response.status === 403) throw new Error('模型接口拒绝认证；请检查 API Key 与访问权限。')
    if (response.status === 404 || response.status === 405) throw new Error('此接口不提供模型列表；可直接输入模型标识。')
    if (response.status === 429) throw new Error('模型接口限流或额度不足，请稍后重试。')
    if (!response.ok) throw new Error('模型列表返回 HTTP ' + response.status + '。')
    let body: unknown
    try { body = await response.json() } catch { throw new Error('模型列表不是有效 JSON；此接口可能不提供模型列表。') }
    const result = modelPage(connection.protocol, body)
    for (const model of result.models) found.add(model)
    if (result.next === undefined) break
    next = result.next
  }
  return [...found].sort()
}
