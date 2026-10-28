import {
  providerHeaders,
  providerProtocol,
  supportedThinkingLevels,
  type ProviderProtocol,
  thinkingLevel,
  type ThinkingLevel,
} from '@harness-world/provider-chat'
import { randomUUID } from 'node:crypto'

/** One remembered provider address. Its key lives in the OS credential store, never here. */
export interface ModelConnection {
  id: string
  name: string
  protocol: ProviderProtocol
  endpoint: string
}
export interface ModelTarget {
  connectionId: string
  model: string
}
export interface DecisionTarget extends ModelTarget {
  thinkingLevel?: ThinkingLevel
}
export interface CharacterModels {
  decision?: DecisionTarget
  memory?: ModelTarget
}
export interface InstanceModels {
  decision: DecisionTarget
  memory?: ModelTarget
  characters?: Record<string, CharacterModels>
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

/** Full request address; key material never belongs in it. */
export function modelEndpoint(endpoint: string, protocol: ProviderProtocol): URL {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('请使用不含认证参数的 HTTP/HTTPS 地址。')
  if (protocol === 'openai' && !url.pathname.endsWith('/chat/completions'))
    throw new Error('接口地址须包含 /chat/completions。')
  if (protocol === 'anthropic' && !url.pathname.endsWith('/v1/messages'))
    throw new Error('Anthropic 接口须以 /v1/messages 结尾。')
  if (protocol === 'google' && !/\/models\/[^/]+:generateContent$/.test(url.pathname))
    throw new Error('Google 接口须为 /models/模型:generateContent。')
  return url
}

export function modelConnection(value: unknown): ModelConnection {
  const data = record(value, '连接无效。')
  if (Object.keys(data).some(key => !['id', 'name', 'protocol', 'endpoint'].includes(key)))
    throw new Error('连接包含不支持的字段。')
  if (typeof data.id !== 'string' || !/^[a-f0-9-]{36}$/.test(data.id)) throw new Error('连接标识无效。')
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80)
    throw new Error('连接名称无效。')
  if (typeof data.endpoint !== 'string' || data.endpoint.length > 4096) throw new Error('接口地址无效。')
  const protocol = providerProtocol(data.protocol)
  return { id: data.id, name: data.name.trim(), protocol, endpoint: modelEndpoint(data.endpoint, protocol).href }
}

export function modelsListUrl(connection: ModelConnection): URL {
  const url = new URL(connection.endpoint)
  url.pathname =
    connection.protocol === 'openai'
      ? url.pathname.replace(/\/chat\/completions$/, '/models')
      : connection.protocol === 'anthropic'
        ? url.pathname.replace(/\/messages$/, '/models')
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
  const next =
    protocol === 'anthropic'
      ? data.has_more === true && typeof data.last_id === 'string'
        ? data.last_id
        : undefined
      : protocol === 'google' && typeof data.nextPageToken === 'string' && data.nextPageToken
        ? data.nextPageToken
        : undefined
  return next === undefined ? { models } : { models, next }
}

/** Lists the provider's models. Errors never echo the key or the provider's response. */
export async function listModels(
  connection: ModelConnection,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const found = new Set<string>()
  let next: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = modelsListUrl(connection)
    if (next !== undefined) url.searchParams.set(connection.protocol === 'anthropic' ? 'after_id' : 'pageToken', next)
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        headers: providerHeaders(connection.protocol, apiKey),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new Error('模型列表连接失败或超过 15 秒；请检查接口地址、服务是否启动和网络。')
    }
    if (response.status === 401 || response.status === 403)
      throw new Error('模型接口拒绝认证；请检查 API Key 与访问权限。')
    if (response.status === 404 || response.status === 405)
      throw new Error('此接口不提供模型列表；可直接输入模型标识。')
    if (response.status === 429) throw new Error('模型接口限流或额度不足，请稍后重试。')
    if (!response.ok) throw new Error('模型列表返回 HTTP ' + response.status + '。')
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('模型列表不是有效 JSON；此接口可能不提供模型列表。')
    }
    const result = modelPage(connection.protocol, body)
    for (const model of result.models) found.add(model)
    if (result.next === undefined) break
    next = result.next
  }
  return [...found].sort()
}

function modelId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('模型标识无效。')
  return value.trim()
}
function only(data: Record<string, unknown>, keys: readonly string[], message: string): void {
  if (Object.keys(data).some(key => !keys.includes(key))) throw new Error(message)
}
function storedTarget(value: unknown, withThinking: boolean): DecisionTarget {
  const data = record(value, '模型选择无效。')
  only(
    data,
    withThinking ? ['connectionId', 'model', 'thinkingLevel'] : ['connectionId', 'model'],
    '模型选择包含不支持的字段。',
  )
  if (typeof data.connectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.connectionId))
    throw new Error('连接标识无效。')
  return {
    connectionId: data.connectionId,
    model: modelId(data.model),
    ...(data.thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel(data.thinkingLevel) }),
  }
}

/** Shape only: used when loading, so a deleted connection never blocks opening the Launcher. */
export function storedModels(value: unknown): InstanceModels {
  const data = record(value, '实例模型配置无效。')
  only(data, ['decision', 'memory', 'characters'], '实例模型配置包含不支持的字段。')
  const characters =
    data.characters === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(record(data.characters, '角色模型配置无效。')).map(([id, entry]) => {
            if (!id || id.length > 200) throw new Error('角色 ID 无效。')
            const item = record(entry, '角色模型配置无效。')
            only(item, ['decision', 'memory'], '角色模型配置包含不支持的字段。')
            return [
              id,
              {
                ...(item.decision === undefined ? {} : { decision: storedTarget(item.decision, true) }),
                ...(item.memory === undefined ? {} : { memory: storedTarget(item.memory, false) }),
              },
            ]
          }),
        )
  return {
    decision: storedTarget(data.decision, true),
    ...(data.memory === undefined ? {} : { memory: storedTarget(data.memory, false) }),
    ...(characters === undefined ? {} : { characters }),
  }
}

/** Write-time check: every choice names an existing connection and every override a callable character. */
export function instanceModels(
  value: unknown,
  connections: readonly ModelConnection[],
  characterIds: readonly string[],
): InstanceModels {
  const models = storedModels(value)
  const check = (target: DecisionTarget) => {
    const connection = connections.find(c => c.id === target.connectionId)
    if (!connection) throw new Error('所选模型连接不存在。')
    if (
      target.thinkingLevel !== undefined &&
      !supportedThinkingLevels({
        protocol: connection.protocol,
        endpoint: new URL(connection.endpoint),
        model: target.model,
      }).includes(target.thinkingLevel)
    )
      throw new Error('所选模型不支持该思考强度，请在模型配置中重新选择。')
  }
  check(models.decision)
  if (models.memory) check(models.memory)
  for (const [id, entry] of Object.entries(models.characters ?? {})) {
    if (!characterIds.includes(id)) throw new Error('模型配置引用了此包之外或不可调用的角色。')
    if (entry.decision) check(entry.decision)
    if (entry.memory) check(entry.memory)
  }
  return models
}

export function brokenModels(models: InstanceModels, connections: readonly ModelConnection[]): boolean {
  const targets = [
    models.decision,
    models.memory,
    ...Object.values(models.characters ?? {}).flatMap(c => [c.decision, c.memory]),
  ]
  return targets.some(target => target !== undefined && !connections.some(c => c.id === target.connectionId))
}

export interface ResolvedModel {
  connectionId: string
  protocol: ProviderProtocol
  endpoint: string
  model: string
  thinkingLevel?: ThinkingLevel
}
export interface RoleModels {
  default: { decision: ResolvedModel; memory: ResolvedModel }
  characters: Record<string, { decision: ResolvedModel; memory: ResolvedModel }>
}

function resolved(
  target: DecisionTarget,
  connections: readonly ModelConnection[],
  withThinking: boolean,
): ResolvedModel {
  const connection = connections.find(c => c.id === target.connectionId)
  if (!connection) throw new Error('模型连接已删除，请在模型配置中重新选择。')
  return {
    connectionId: connection.id,
    protocol: connection.protocol,
    endpoint: connection.endpoint,
    model: target.model,
    ...(withThinking && target.thinkingLevel !== undefined ? { thinkingLevel: target.thinkingLevel } : {}),
  }
}

/** Memory follows the decision it sits beside unless chosen explicitly; overrides fall back to the default layer. */
export function resolveRoleModels(models: InstanceModels, connections: readonly ModelConnection[]): RoleModels {
  const base = {
    decision: resolved(models.decision, connections, true),
    memory: resolved(models.memory ?? models.decision, connections, false),
  }
  const characters = Object.fromEntries(
    Object.entries(models.characters ?? {})
      .filter(([, entry]) => entry.decision || entry.memory)
      .map(([id, entry]) => {
        const decision = entry.decision ? resolved(entry.decision, connections, true) : base.decision
        const memory = entry.memory
          ? resolved(entry.memory, connections, false)
          : entry.decision
            ? resolved(entry.decision, connections, false)
            : base.memory
        return [id, { decision, memory }]
      }),
  )
  return { default: base, characters }
}

/** Resolved targets travel as JSON without keys; only the keys those targets reference travel beside them. */
export function modelEnvironment(
  models: InstanceModels,
  connections: readonly ModelConnection[],
  apiKeys: Readonly<Record<string, string>>,
): { PERSPECTRA_ROLE_MODELS: string; PERSPECTRA_MODEL_KEYS: string } {
  const roles = resolveRoleModels(models, connections)
  const used = new Set(
    [roles.default, ...Object.values(roles.characters)].flatMap(role => [
      role.decision.connectionId,
      role.memory.connectionId,
    ]),
  )
  const keys = Object.fromEntries([...used].flatMap(id => (apiKeys[id] ? [[id, apiKeys[id]]] : [])))
  return { PERSPECTRA_ROLE_MODELS: JSON.stringify(roles), PERSPECTRA_MODEL_KEYS: JSON.stringify(keys) }
}

/** One fully resolved call target as the game process uses it; the key is only ever held in memory. */
export interface RuntimeModel {
  readonly protocol: ProviderProtocol
  readonly endpoint: string
  readonly model: string
  readonly thinkingLevel?: ThinkingLevel
  readonly apiKey?: string
}
export interface RuntimeRole {
  readonly decision: RuntimeModel
  readonly memory: RuntimeModel
}
/** Every call target the game process uses; characters absent from `characters` use `default`. */
export interface RuntimeRoleModels {
  readonly default: RuntimeRole
  readonly characters: Readonly<Record<string, RuntimeRole>>
}

/** Game-process side of `modelEnvironment`: rejoins each target with its connection key. */
export function runtimeRoleModels(roles: unknown, apiKeys: unknown): RuntimeRoleModels {
  const keys = record(apiKeys, '模型凭证无效。')
  const target = (value: unknown, withThinking: boolean): RuntimeModel => {
    const data = record(value, '角色模型配置无效。')
    const protocol = providerProtocol(data.protocol),
      key = typeof data.connectionId === 'string' ? keys[data.connectionId] : undefined
    return {
      protocol,
      endpoint: modelEndpoint(String(data.endpoint), protocol).href,
      model: modelId(data.model),
      ...(withThinking && data.thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel(data.thinkingLevel) } : {}),
      ...(typeof key === 'string' && key ? { apiKey: key } : {}),
    }
  }
  const data = record(roles, '角色模型配置无效。'),
    base = record(data.default, '角色模型配置无效。')
  return {
    default: { decision: target(base.decision, true), memory: target(base.memory, false) },
    characters: Object.fromEntries(
      Object.entries(record(data.characters, '角色模型配置无效。')).map(([id, value]) => {
        const role = record(value, '角色模型配置无效。')
        return [id, { decision: target(role.decision, true), memory: target(role.memory, false) }]
      }),
    ),
  }
}

/** The source entry's single target, for developers running the game process without the Launcher. */
export function environmentRoleModels(env: Readonly<Record<string, string | undefined>>): RuntimeRoleModels {
  const endpoint = env.PERSPECTRA_MODEL_ENDPOINT?.trim(),
    model = env.PERSPECTRA_MODEL?.trim()
  if (!endpoint || !model)
    throw new Error('未配置模型：请设置 PERSPECTRA_MODEL_ENDPOINT 与 PERSPECTRA_MODEL，或由 Launcher 启动。')
  const protocol = providerProtocol(env.PERSPECTRA_MODEL_PROTOCOL?.trim() || undefined)
  const apiKey = env.PERSPECTRA_MODEL_API_KEY?.trim()
  const memory: RuntimeModel = {
    protocol,
    endpoint: modelEndpoint(endpoint, protocol).href,
    model: modelId(model),
    ...(apiKey ? { apiKey } : {}),
  }
  const level = env.PERSPECTRA_THINKING_LEVEL?.trim()
  const decision: RuntimeModel = { ...memory, ...(level ? { thinkingLevel: thinkingLevel(level) } : {}) }
  return { default: { decision, memory }, characters: {} }
}

/** One-time move from the single-endpoint index: one connection per distinct protocol + address. */
export function migrateModels(parsed: Record<string, unknown>): {
  connections: ModelConnection[]
  instanceModels: Record<string, InstanceModels>
  lastModels: InstanceModels | undefined
} {
  const connections: ModelConnection[] = []
  const choose = (value: unknown): InstanceModels => {
    const old = record(value, '旧模型配置无效。')
    const protocol = providerProtocol(old.protocol)
    const url = modelEndpoint(String(old.endpoint), protocol)
    let connection = connections.find(c => c.protocol === protocol && c.endpoint === url.href)
    if (!connection) {
      connection = { id: randomUUID(), name: url.host, protocol, endpoint: url.href }
      connections.push(connection)
    }
    return {
      decision: {
        connectionId: connection.id,
        model: modelId(old.model),
        ...(old.thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel(old.thinkingLevel) }),
      },
    }
  }
  const lastModels = parsed.defaults === undefined ? undefined : choose(parsed.defaults)
  const instances = Array.isArray(parsed.instances) ? parsed.instances : []
  const instanceModels = Object.fromEntries(
    instances.flatMap(value => {
      const instance = record(value, '旧实例无效。')
      return instance.model === undefined ? [] : [[String(instance.id), choose(instance.model)]]
    }),
  )
  return { connections, instanceModels, lastModels }
}
