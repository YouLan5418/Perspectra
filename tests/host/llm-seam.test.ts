import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LlmCall, LlmInstance, SeamProvider, WorldServices } from '@harness-world/plugin-sdk'
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

async function start(llm: SeamProvider<LlmInstance>, extra: Record<string, unknown> = {}) {
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
    plugins: { llm },
    ...extra,
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
