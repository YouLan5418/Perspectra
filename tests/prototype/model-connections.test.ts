import { describe, expect, it } from 'vitest'
import { instanceModels, listModels, migrateModels, modelConnection, modelEnvironment, modelPage, modelsListUrl, resolveRoleModels, type ModelConnection } from '../../desktop/model-connections.ts'

const id = '6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10'
const openai: ModelConnection = { id, name: '本地', protocol: 'openai', endpoint: 'http://127.0.0.1:8046/v1/chat/completions' }
const anthropic: ModelConnection = { id, name: 'A', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages' }
const google: ModelConnection = { id, name: 'G', protocol: 'google', endpoint: 'https://g.test/v1beta/models/x:generateContent' }

describe('model connections', () => {
  it('validates connections with the existing endpoint rules', () => {
    expect(modelConnection({ ...openai, name: ' 本地 ' }).name).toBe('本地')
    for (const bad of [{ ...openai, id: 'local' }, { ...openai, name: ' ' }, { ...openai, name: 'x'.repeat(81) },
      { ...openai, endpoint: 'http://127.0.0.1:8046/v1/chat/completions?key=1' }, { ...openai, endpoint: 'http://127.0.0.1:8046/v1/messages' },
      { ...openai, protocol: 'other' }, { ...openai, extra: true }]) expect(() => modelConnection(bad)).toThrow()
  })

  it('derives the model list address from the full request address', () => {
    expect(modelsListUrl(openai).href).toBe('http://127.0.0.1:8046/v1/models')
    expect(modelsListUrl(anthropic).href).toBe('https://api.anthropic.com/v1/models')
    expect(modelsListUrl(google).href).toBe('https://g.test/v1beta/models')
  })

  it('reads one page of each protocol and keeps only chat-capable Google models', () => {
    expect(modelPage('openai', { data: [{ id: 'b' }, { id: 'a' }] })).toEqual({ models: ['b', 'a'] })
    expect(modelPage('anthropic', { data: [{ id: 'claude-x' }], has_more: true, last_id: 'claude-x' })).toEqual({ models: ['claude-x'], next: 'claude-x' })
    expect(modelPage('google', { models: [
      { name: 'models/gemini-3', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
    ], nextPageToken: 't' })).toEqual({ models: ['gemini-3'], next: 't' })
    expect(() => modelPage('openai', { choices: [] })).toThrow('模型列表')
  })

  it('follows pages, merges and sorts, and sends the connection key', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const pages = [{ data: [{ id: 'claude-b' }], has_more: true, last_id: 'claude-b' }, { data: [{ id: 'claude-a' }, { id: 'claude-b' }], has_more: false }]
    const fetcher = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify(pages[seen.length - 1]))
    }) as unknown as typeof fetch
    expect(await listModels(anthropic, 'K', fetcher)).toEqual(['claude-a', 'claude-b'])
    expect(seen[1]!.url).toContain('after_id=claude-b')
    expect(seen[0]!.headers['x-api-key']).toBe('K')
    const bearer: string[] = []
    await listModels(openai, 'K', (async (_url: URL, init: RequestInit) => { bearer.push((init.headers as Record<string, string>).authorization!); return new Response(JSON.stringify({ data: [] })) }) as unknown as typeof fetch)
    expect(bearer).toEqual(['Bearer K'])
    const tokens: string[] = []
    await listModels(google, 'K', (async (url: URL) => { tokens.push(String(url)); return new Response(JSON.stringify(tokens.length === 1 ? { models: [], nextPageToken: 't' } : { models: [] })) }) as unknown as typeof fetch)
    expect(tokens[1]).toContain('pageToken=t')
  })

  it('explains failures without leaking the key or the provider response', async () => {
    const respond = (response: Response | Error) => (async () => { if (response instanceof Error) throw response; return response }) as unknown as typeof fetch
    const cases: [Response | Error, string][] = [
      [new Response('PRIVATE_PROVIDER_TEXT', { status: 401 }), '认证'],
      [new Response('<html>PRIVATE_PROVIDER_TEXT</html>', { status: 404 }), '不提供模型列表'],
      [new Error('PRIVATE_NETWORK K-SECRET'), '连接失败'],
    ]
    for (const [response, expected] of cases) {
      const error = await listModels(openai, 'K-SECRET', respond(response)).then(() => undefined, (caught: Error) => caught)
      expect(error?.message).toContain(expected)
      expect(error?.message).not.toContain('K-SECRET')
      expect(error?.message).not.toContain('PRIVATE')
    }
  })
})

describe('instance model choices', () => {
  const other: ModelConnection = { id: '7a2d3b5f-2e1c-4d4a-8b62-1e7d2c8f3a21', name: '其他', protocol: 'openai', endpoint: 'https://other.test/v1/chat/completions' }
  const connections = [openai, other]
  const characters = ['character:companion', 'character:friend']

  it('accepts a minimal choice and rejects unknown connections, empty models, foreign characters and extra fields', () => {
    expect(instanceModels({ decision: { connectionId: id, model: 'm' } }, connections, characters)).toEqual({ decision: { connectionId: id, model: 'm' } })
    for (const bad of [
      { decision: { connectionId: '00000000-0000-4000-8000-000000000000', model: 'm' } },
      { decision: { connectionId: id, model: ' ' } },
      { decision: { connectionId: id, model: 'x'.repeat(121) } },
      { decision: { connectionId: id, model: 'm' }, extra: 1 },
      { decision: { connectionId: id, model: 'm', thinkingLevel: 'unknown' } },
    ]) expect(() => instanceModels(bad, connections, characters)).toThrow()
    expect(() => instanceModels({ decision: { connectionId: id, model: 'm' }, characters: { 'character:foreign': {} } }, connections, characters)).toThrow('此包之外')
  })

  it('resolves memory to follow decision unless a character overrides it', () => {
    const roles = resolveRoleModels({ decision: { connectionId: id, model: 'base', thinkingLevel: 'low' }, characters: {
      'character:companion': { decision: { connectionId: other.id, model: 'strong', thinkingLevel: 'high' } },
      'character:friend': { decision: { connectionId: other.id, model: 'quick' }, memory: { connectionId: id, model: 'cheap' } },
    } }, connections)
    expect(roles.default.decision).toEqual({ connectionId: id, protocol: 'openai', endpoint: openai.endpoint, model: 'base', thinkingLevel: 'low' })
    expect(roles.default.memory).toEqual({ connectionId: id, protocol: 'openai', endpoint: openai.endpoint, model: 'base' })
    expect(roles.characters['character:companion']!.memory).toEqual({ connectionId: other.id, protocol: 'openai', endpoint: other.endpoint, model: 'strong' })
    expect(roles.characters['character:friend']!.memory.model).toBe('cheap')
    expect(resolveRoleModels({ decision: { connectionId: id, model: 'base' } }, connections).characters).toEqual({})
  })

  it('migrates old defaults and instance models into connections', () => {
    const migrated = migrateModels({
      defaults: { model: 'gemini-3.7-flash', endpoint: 'http://127.0.0.1:8046/v1/chat/completions' },
      instances: [
        { id: 'a', model: { model: 'local-a', endpoint: 'http://127.0.0.1:8046/v1/chat/completions', thinkingLevel: 'medium' } },
        { id: 'b', model: { model: 'claude-x', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages' } },
      ],
    })
    expect(migrated.connections.map(c => c.name)).toEqual(['127.0.0.1:8046', 'api.anthropic.com'])
    const [local, remote] = migrated.connections
    expect(migrated.instanceModels.a).toEqual({ decision: { connectionId: local!.id, model: 'local-a', thinkingLevel: 'medium' } })
    expect(migrated.instanceModels.b).toEqual({ decision: { connectionId: remote!.id, model: 'claude-x' } })
    expect(migrated.lastModels).toEqual({ decision: { connectionId: local!.id, model: 'gemini-3.7-flash' } })
  })

  it('builds the launch environment from the default decision and its connection key only', () => {
    const env = modelEnvironment({ decision: { connectionId: other.id, model: 'm', thinkingLevel: 'low' } }, connections, { [other.id]: 'K-OTHER', [id]: 'K-LOCAL' })
    expect(env).toEqual({ HCW_LOCAL_MODEL: 'm', HCW_LOCAL_ENDPOINT: other.endpoint, HCW_MODEL_PROTOCOL: 'openai', HCW_THINKING_LEVEL: 'low', HCW_LOCAL_API_KEY: 'K-OTHER' })
  })
})
