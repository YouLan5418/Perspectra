import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { getAllBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ProviderProtocol } from './protocol.ts'
import type { ThinkingLevel } from './thinking.ts'

/** One call target as the connection states it: the full request address, never a key. */
export interface ModelTarget {
  readonly protocol: ProviderProtocol
  readonly endpoint: URL
  readonly model: string
}

const API = { openai: 'openai-completions', anthropic: 'anthropic-messages', google: 'google-generative-ai' } as const
const LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** SDK-style base address: each protocol's SDK appends its own operation path. */
export function piBaseUrl(endpoint: URL, protocol: ProviderProtocol): string {
  const url = new URL(endpoint)
  const path = url.pathname
  if (protocol === 'anthropic' && !path.endsWith('/v1/messages'))
    throw new TypeError('Anthropic 接口须以 /v1/messages 结尾。')
  url.pathname =
    protocol === 'openai'
      ? path.replace(/\/chat\/completions$/, '')
      : protocol === 'anthropic'
        ? path.replace(/\/v1\/messages$/, '')
        : path.replace(/\/models\/[^/]+:generateContent$/, '')
  return url.href.replace(/\/$/, '')
}

let catalog: Map<string, Model<Api>[]> | undefined
function entries(id: string): Model<Api>[] {
  if (!catalog) {
    catalog = new Map()
    for (const provider of getBuiltinProviders())
      for (const model of getAllBuiltinModels(provider)) {
        if (model.type !== undefined && model.type !== 'chat') continue
        const list = catalog.get(model.id) ?? []
        list.push(model as Model<Api>)
        catalog.set(model.id, list)
      }
  }
  return catalog.get(id) ?? []
}

/**
 * The pi-ai model for one target. Capabilities follow any catalog entry of the same id - preferring one that
 * declares its thinking levels, since a gateway usually serves the vendor's model under another protocol - while
 * wire-format declarations are inherited only from an entry with the same API on the same host.
 */
export function piModel(target: ModelTarget): Model<Api> {
  const api = API[target.protocol]
  const host = target.endpoint.hostname
  const found = entries(target.model)
  const capability = [...found].sort(
    (a, b) =>
      Number(!a.thinkingLevelMap) - Number(!b.thinkingLevelMap) || Number(a.api !== api) - Number(b.api !== api),
  )[0]
  const wire = found.find(model => model.api === api && new URL(model.baseUrl).hostname === host)
  const unsupported = Object.entries(capability?.thinkingLevelMap ?? {}).filter(([, value]) => value === null)
  const thinkingLevelMap: ThinkingLevelMap | undefined =
    wire?.thinkingLevelMap ?? (unsupported.length ? (Object.fromEntries(unsupported) as ThinkingLevelMap) : undefined)
  return {
    id: target.model,
    name: target.model,
    api,
    provider: host,
    baseUrl: piBaseUrl(target.endpoint, target.protocol),
    input: capability ? [...capability.input] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: capability?.reasoning ?? true,
    contextWindow: capability?.contextWindow ?? 1_000_000,
    maxTokens: capability?.maxTokens ?? 128_000,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(wire?.compat === undefined ? {} : { compat: wire.compat }),
  } as Model<Api>
}

/** The thinking levels the Launcher may offer for this target, in escalation order. */
export function supportedThinkingLevels(target: ModelTarget): ThinkingLevel[] {
  const model = piModel(target)
  if (!model.reasoning) return ['off']
  return LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null)
}

export function usesDeepSeekThinking(model: Model<Api>): boolean {
  return (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat === 'deepseek'
}
