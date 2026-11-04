import { loadHostPlugins } from '../../desktop/host-plugins.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  DecisionInstance,
  LlmCall,
  LlmInstance,
  LlmTransportCall,
  LlmTransportInstance,
  SeamProvider,
  WorldServices,
} from '@harness-world/plugin-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MOVE = '/act move {"locationId":"location:front-room"}'
const SPEAK = { decision: 'publish', segments: [{ type: 'speech', text: '走另一条路。' }] }

function provider(instance: LlmInstance, id = 'test-llm', version = '1.0.0'): SeamProvider<LlmInstance> {
  return { id, version, open: async () => instance }
}

async function start(llm: SeamProvider<LlmInstance> | undefined, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-llm-seam-'))
  roots.push(root)
  const original = { calls: 0 }
  const server = createChatServer((request, response) => {
    original.calls++
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'abstain' }) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const models = fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions')
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models,
    timeoutMs: 5000,
    ...extra,
    plugins: { ...(llm ? { llm } : {}), ...(extra.plugins as object) },
  })
  runtimes.push(runtime)
  return { runtime, root, models, original }
}

it('sends the default call through a third-party model channel', async () => {
  const calls: { characterId: string; call: LlmCall }[] = []
  const { runtime, original } = await start(
    provider({
      send: async (characterId, call) => {
        calls.push({ characterId, call })
        return SPEAK
      },
    }),
  )
  const state = await runtime.submit(MOVE)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0]!.characterId).toMatch(/^character:/)
  expect(calls[0]!.call.messages.length).toBeGreaterThan(0)
  expect(calls[0]!.call.schema).toHaveProperty('oneOf')
  expect(original.calls).toBe(0)
  expect(state.transcript.some(line => line.text.includes('走另一条路'))).toBe(true)
})

it('keeps player input when send throws and continues the next round', async () => {
  let fail = true
  const { runtime } = await start(
    provider({
      send: async () => {
        if (fail) throw new Error('channel down')
        return SPEAK
      },
    }),
  )
  const failed = await runtime.submit(MOVE)
  expect(failed.error).toBe(true)
  fail = false
  const next = await runtime.submit('你好')
  expect(next.error).toBe(false)
  expect(next.transcript.some(line => line.player && line.text === '你好')).toBe(true)
})

it('retries once on an invalid answer, then executes nothing', async () => {
  let sends = 0
  const { runtime } = await start(
    provider({
      send: async () => {
        sends++
        return { decision: 'publish', segments: 'not a list' }
      },
    }),
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(sends).toBeGreaterThan(1)
  expect(state.transcript.some(line => !line.player && line.text.includes('not a list'))).toBe(false)
})

it('refuses to open the world when the model channel cannot open', async () => {
  await expect(
    start({
      id: 'broken-llm',
      version: '1.0.0',
      open: async () => {
        throw new Error('cannot open')
      },
    }),
  ).rejects.toThrow('broken-llm')
})

it('uses prepare when the channel provides it', async () => {
  const sent: LlmCall[] = []
  const { runtime } = await start(
    provider({
      prepare: async (_characterId, request) => ({
        messages: [{ role: 'user', content: '自己的提示 ' + String(Object.keys(request.context).length > 0) }],
        schema: { type: 'object' },
      }),
      send: async (_characterId, call) => {
        sent.push(call)
        return { decision: 'abstain' }
      },
    }),
  )
  await runtime.submit(MOVE)
  expect(sent[0]!.messages).toEqual([{ role: 'user', content: '自己的提示 true' }])
})

it('gives a model channel no model configuration', async () => {
  let services: WorldServices | undefined
  await start({
    id: 'nosy-llm',
    version: '1.0.0',
    open: async world => {
      services = world
      return { send: async () => ({ decision: 'abstain' }) }
    },
  })
  expect(Object.keys(services!).sort()).toEqual([
    'address',
    'candidate',
    'cast',
    'contextSources',
    'dataDirectory',
    'instanceDirectory',
    'world',
    'worldVersion',
  ])
  expect(services!.cast.characterIds.length).toBeGreaterThan(0)
  expect(services!.cast.characterIds).not.toContain(services!.cast.playerId)
  expect(JSON.stringify(services!.cast, (_k, v) => (v instanceof Map ? [...v] : v))).not.toContain('fixture')
})

it('closes the channel with the world', async () => {
  const close = vi.fn()
  const { runtime } = await start(provider({ send: async () => ({ decision: 'abstain' }), close }))
  await runtime.close()
  runtimes.length = 0
  expect(close).toHaveBeenCalled()
})

it('refuses to regenerate a round after the model channel changed', async () => {
  const original = provider({ send: async () => SPEAK }, 'llm-a')
  const { runtime, root, models } = await start(original)
  const state = await runtime.submit(MOVE)
  await runtime.close()
  runtimes.length = 0
  const reopen = (llm: SeamProvider<LlmInstance>) => start(llm, { dataDirectory: root, models })
  const { runtime: changed } = await reopen(provider({ send: async () => SPEAK }, 'llm-b'))
  await expect(changed.regenerate(state.tailRound!.id!, 'llm-seam-changed')).rejects.toThrow('环境')
  await changed.close()
  runtimes.length = 0
  const { runtime: same } = await reopen(original)
  await expect(same.regenerate(state.tailRound!.id!, 'llm-seam-same')).resolves.toBeDefined()
})

it('retries once when send hands back text it could not parse', async () => {
  let sends = 0
  const { runtime } = await start(
    provider({
      send: async () => {
        sends++
        return sends === 1 ? '我想先说几句，不是 JSON。' : SPEAK
      },
    }),
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(sends).toBeGreaterThan(1)
  expect(state.error).toBe(false)
  expect(state.transcript.some(line => line.text.includes('走另一条路'))).toBe(true)
})

it('ends the round when send ignores the signal and never returns', { timeout: 30_000 }, async () => {
  const { runtime } = await start(provider({ send: () => new Promise(() => {}) }), {
    playSettings: { activationTimeoutSeconds: 5 },
    serialScheduling: true,
  })
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('打断或超时')
})

it('names the plugin and logs the error when the channel fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime } = await start(
    provider(
      {
        send: async () => {
          throw new Error('模型服务返回 401')
        },
      },
      'broken-channel',
    ),
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('broken-channel')
  expect(state.notice).not.toContain('模型服务')
  expect(log.mock.calls.flat().map(String).join(' ')).toContain('模型服务返回 401')
})

it('does not blame presets when a third-party prepare fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime } = await start(
    provider(
      {
        prepare: async () => {
          throw new Error('bad prompt')
        },
        send: async () => SPEAK,
      },
      'broken-prepare',
    ),
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('broken-prepare')
  expect(state.notice).not.toContain('预设')
})

it('marks only an unselected candidate, not the world the player keeps playing', async () => {
  const seen: boolean[] = []
  const channel: SeamProvider<LlmInstance> = {
    id: 'watching-llm',
    version: '1.0.0',
    open: async world => {
      seen.push(world.candidate)
      return { send: async () => SPEAK }
    },
  }
  const { runtime, root, models } = await start(channel)
  expect(seen).toEqual([false])
  const state = await runtime.submit(MOVE)
  await runtime.regenerate(state.tailRound!.id!, 'llm-seam-candidate')
  expect(seen).toContain(true)
  await runtime.close()
  runtimes.length = 0
  seen.length = 0
  await start(channel, { dataDirectory: root, models })
  expect(seen).toEqual([false])
})

const adapter = (instance: LlmTransportInstance): SeamProvider<LlmTransportInstance> => ({
  id: 'test-transport',
  version: '1.0.0',
  identity: { route: 'alternate' },
  open: async () => instance,
})
const textRule = (stage: 'output' | 'display', pattern: string, replacement: string) => ({
  id: stage,
  name: stage,
  enabled: true,
  stage,
  target: 'speech',
  pattern,
  replacement,
  flags: 'g',
})

it('retains official presets, generation, output/display and inspection around an independent transport', async () => {
  const calls: LlmTransportCall[] = []
  let seen: WorldServices | undefined
  const selected: SeamProvider<LlmTransportInstance> = {
    id: 'test-transport',
    version: '1.0.0',
    open: async world => {
      seen = world
      return {
        model: 'alternate-model',
        schemaMode: 'native',
        send: async (_id, call) => {
          calls.push(call)
          return { value: SPEAK, httpStatus: 200 }
        },
      }
    },
  }
  const { runtime, original } = await start(undefined, {
    serialScheduling: true,
    plugins: { llmTransport: selected },
    // The unused official target is deliberately unreachable and has a different protocol.
    models: fakeModels('http://127.0.0.1:9/v1beta/models/unused:generateContent', 'google'),
    preset: {
      prompt: 'TRANSPORT_PRESET',
      temperature: 0.25,
      maxOutputTokens: 300,
      textRules: [textRule('output', '走另一条路', '输出处理'), textRule('display', '输出处理', '展示处理')],
    },
  })
  runtime.requestInspection(true)
  const state = await runtime.submit('你好')
  expect(state.error).toBe(false)
  expect(original.calls).toBe(0)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0]!.messages.some(message => message.content.includes('TRANSPORT_PRESET'))).toBe(true)
  expect(calls[0]!.generation).toMatchObject({ temperature: 0.25, maxOutputTokens: 300 })
  expect(calls[0]!.schema).toHaveProperty('oneOf')
  expect(Object.keys(calls[0]!).sort()).toEqual(['generation', 'messages', 'schema'])
  expect(JSON.stringify(seen)).not.toContain('apiKey')
  expect(state.transcript.some(line => line.text.includes('展示处理'))).toBe(true)
  const log = runtime.requestInspection().requests
  expect(log.length).toBeGreaterThan(0)
  expect(log[0]!.body).toMatchObject({ transport: 'test-transport', model: 'alternate-model' })
  expect(log[0]!.messages.map(message => ({ role: message.role, content: message.content }))).toEqual(
    calls[0]!.messages,
  )
  expect(log[0]!.status).toBe('ok')
  expect(log[0]!.httpStatus).toBe(200)
})

it('uses the adapter schema mode even when the unused official protocol is Google', async () => {
  const shapes: LlmCall['schema'][] = []
  const { runtime } = await start(undefined, {
    serialScheduling: true,
    models: fakeModels('http://127.0.0.1:9/v1beta/models/unused:generateContent', 'google'),
    plugins: {
      llmTransport: adapter({
        model: 'flat',
        schemaMode: 'gateway',
        send: async (_id, call) => {
          shapes.push(call.schema)
          return { value: { decision: 'abstain' } }
        },
      }),
    },
  })
  await runtime.submit('你好')
  expect(shapes[0]).toHaveProperty('properties')
  expect(shapes[0]).not.toHaveProperty('oneOf')
})

it('records and names an HTTP 401 from the transport without falling back', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime, original } = await start(undefined, {
    serialScheduling: true,
    plugins: {
      llmTransport: adapter({
        model: 'refused',
        schemaMode: 'native',
        send: async () => {
          throw Object.assign(new Error('refused'), { httpStatus: 401 })
        },
      }),
    },
  })
  runtime.requestInspection(true)
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('test-transport')
  expect(state.notice).toContain('HTTP 401')
  expect(state.error).toBe(true)
  expect(original.calls).toBe(0)
  expect(runtime.requestInspection().requests[0]).toMatchObject({ status: 'failed', httpStatus: 401, failure: 'http' })
})

it('does not blame the model when a decision plugin fails after a successful transport call', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const afterCheck: SeamProvider<DecisionInstance> = {
    id: 'after-check',
    version: '1.0.0',
    open: async () => ({
      decide: async (request, next) => {
        await next(request)
        throw new Error('my own bug')
      },
    }),
  }
  const { runtime } = await start(undefined, {
    serialScheduling: true,
    plugins: {
      llmTransport: adapter({
        model: 'working',
        schemaMode: 'native',
        send: async () => ({ value: { decision: 'abstain' }, httpStatus: 200 }),
      }),
      decisions: [afterCheck],
    },
  })
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('插件 after-check 出错')
  expect(state.notice).not.toContain('HTTP 200')
})

it('repairs one malformed transport response then preserves scripted publications outside output rules', async () => {
  let sends = 0
  const { runtime, original } = await start(undefined, {
    serialScheduling: true,
    plugins: {
      llmTransport: adapter({
        model: 'repair',
        schemaMode: 'native',
        send: async () => ({ value: ++sends === 1 ? 'bad JSON' : { decision: 'abstain' } }),
      }),
    },
  })
  expect((await runtime.submit('你好')).error).toBe(false)
  expect(sends).toBe(2)
  expect(original.calls).toBe(0)
  const scripted = await start(undefined, {
    packPath: resolve('examples/world-packs/scripted-performance'),
    preset: { textRules: [textRule('output', '.', '被改写')] },
    plugins: {
      llmTransport: adapter({
        model: 'never',
        schemaMode: 'native',
        send: async () => {
          throw Error('script must not send')
        },
      }),
    },
  })
  const state = await scripted.runtime.activityAction({
    activityKey: 'default',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'transport-script',
  })
  expect(state.error).toBe(false)
  expect(state.transcript.some(line => line.text.includes('被改写'))).toBe(false)
})

it('opens and closes independent transport instances for regeneration and refuses changed transport identity', async () => {
  let opened = 0,
    closed = 0
  const identity = { route: 'a' }
  const selected: SeamProvider<LlmTransportInstance> = {
    id: 'lifecycle-transport',
    version: '1.0.0',
    identity,
    open: async () => {
      opened++
      return {
        model: 'lifecycle',
        schemaMode: 'native',
        send: async () => ({ value: { decision: 'abstain' } }),
        close: () => {
          closed++
        },
      }
    },
  }
  const { runtime } = await start(undefined, { plugins: { llmTransport: selected }, serialScheduling: true })
  const state = await runtime.submit('你好')
  const regenerated = await runtime.regenerate(state.tailRound!.id!, 'transport-candidate')
  expect(opened).toBeGreaterThan(1)
  identity.route = 'b'
  await expect(runtime.regenerate(regenerated.tailRound!.id!, 'transport-changed')).rejects.toThrow('环境')
  await runtime.close()
  expect(closed).toBe(opened)
})

it('cancels a hung transport call and does not forward official credentials', async () => {
  let entered!: () => void
  const entering = new Promise<void>(resolve => {
    entered = resolve
  })
  const { runtime } = await start(undefined, {
    serialScheduling: true,
    plugins: {
      llmTransport: adapter({
        model: 'hung',
        schemaMode: 'native',
        send: async () => {
          entered()
          return new Promise(() => {})
        },
      }),
    },
  })
  const pending = runtime.submit('你好')
  await entering
  await runtime.pause()
  await pending
  expect((await runtime.state()).busy).toBe(false)
})

it('loads the real transport example and sends preset messages with only its own credential', async () => {
  const received: Record<string, unknown>[] = []
  const keys: (string | undefined)[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      received.push(JSON.parse(body))
      keys.push(request.headers.authorization)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(SPEAK) } }] }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions'
  const session = await loadHostPlugins(
    [
      {
        id: 'simple-transport',
        path: resolve('examples/host-plugins/simple-transport.mjs'),
        enabled: true,
        config: { endpoint, model: 'alternate' },
      },
    ],
    { 'simple-transport': { apiKey: 'PLUGIN_KEY' } },
  )
  try {
    expect(session.skipped).toEqual([])
    const base = fakeModels('http://127.0.0.1:9/v1/chat/completions')
    const { runtime } = await start(undefined, {
      serialScheduling: true,
      plugins: session.seams,
      models: { ...base, default: { ...base.default, decision: { ...base.default.decision, apiKey: 'OFFICIAL_KEY' } } },
      preset: { prompt: 'EXAMPLE_PRESET', temperature: 0.4, textRules: [textRule('output', '走另一条路', '示例生效')] },
    })
    runtime.requestInspection(true)
    const state = await runtime.submit('你好')
    expect(state.error).toBe(false)
    expect(received.length).toBeGreaterThan(0)
    expect(JSON.stringify(received)).toContain('EXAMPLE_PRESET')
    expect(JSON.stringify(received)).not.toContain('OFFICIAL_KEY')
    expect(keys.every(key => key === 'Bearer PLUGIN_KEY')).toBe(true)
    expect(received[0]!.temperature).toBe(0.4)
    expect(state.transcript.some(line => line.text.includes('示例生效'))).toBe(true)
    expect(JSON.stringify(runtime.requestInspection())).not.toMatch(/PLUGIN_KEY|OFFICIAL_KEY/u)
    await runtime.close()
  } finally {
    await session.close()
  }
})

it('rejects a full channel plus transport and closes an adapter if preset assembly fails', async () => {
  await expect(
    start(provider({ send: async () => SPEAK }), {
      plugins: {
        llmTransport: adapter({
          model: 'conflict',
          schemaMode: 'native',
          send: async () => ({ value: SPEAK }),
        }),
      },
    }),
  ).rejects.toThrow('不能同时启用')
  let closed = 0
  await expect(
    start(undefined, {
      plugins: {
        llmTransport: adapter({
          model: 'bad-preset',
          schemaMode: 'native',
          send: async () => ({ value: SPEAK }),
          close: () => {
            closed++
          },
        }),
      },
      presetMapping: { characters: { 'character:nonexistent': {} } },
    }),
  ).rejects.toThrow('预设')
  expect(closed).toBe(1)
})
