export type ProviderProtocol = 'openai' | 'anthropic' | 'google'
export function providerProtocol(value: unknown): ProviderProtocol {
  if (value === undefined) return 'openai'
  if (value === 'openai' || value === 'anthropic' || value === 'google') return value
  throw new TypeError('模型协议须为 openai、anthropic 或 google。')
}
export function providerHeaders(protocol: ProviderProtocol, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  if (apiKey)
    headers[protocol === 'anthropic' ? 'x-api-key' : protocol === 'google' ? 'x-goog-api-key' : 'authorization'] =
      protocol === 'openai' ? `Bearer ${apiKey}` : apiKey
  return headers
}
