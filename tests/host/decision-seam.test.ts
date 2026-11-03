import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DecisionInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { WorldStore } from '@harness-world/store-sqlite'
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
const speech = (text: string) => ({ decision: 'publish', segments: [{ type: 'speech', text }] })

function provider(instance: DecisionInstance, id = 'test-decision'): SeamProvider<DecisionInstance> {
  return { id, version: '1.0.0', open: async () => instance }
}

async function start(decisions: readonly SeamProvider<DecisionInstance>[], extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-decision-seam-'))
  roots.push(root)
  const contexts: Record<string, unknown>[] = []
  const timing = { active: 0, peak: 0 }
  const server = createChatServer((request, response) => {
    let body = ''
    timing.active++
    timing.peak = Math.max(timing.peak, timing.active)
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      contexts.push(JSON.parse(JSON.parse(body).messages.at(-1).content).context)
      setTimeout(() => {
        timing.active--
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(speech('模型说的。')) } }))
      }, 20)
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models: fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions'),
    timeoutMs: 5000,
    plugins: { decisions },
    ...extra,
  })
  runtimes.push(runtime)
  return { runtime, contexts, root, timing }
}

it('adds to the context a character decides on, in load order', async () => {
  let seen: unknown
  const { runtime, contexts } = await start([
    provider({ context: async request => ({ ...request, context: { ...request.context, weather: '下雨' } }) }, 'a'),
    provider(
      {
        context: async request => {
          seen = request.context.weather
          return { ...request, context: { ...request.context, mood: '安静' } }
        },
      },
      'b',
    ),
  ])
  await runtime.submit(MOVE)
  expect(seen).toBe('下雨')
  expect(contexts[0]).toMatchObject({ weather: '下雨', mood: '安静' })
})

it('wraps the decision and can decide again with a revised request', async () => {
  const { runtime, contexts } = await start(
    [
      provider({
        decide: async (request, next) => {
          await next(request)
          return next({ ...request, context: { ...request.context, revised: true } })
        },
      }),
    ],
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(contexts.length).toBeGreaterThan(1)
  expect(contexts[1]).toMatchObject({ revised: true })
  expect(state.transcript.some(line => line.text.includes('模型说的'))).toBe(true)
})

it('can answer without calling the model, and the turn still validates the answer', async () => {
  const good = await start([provider({ decide: async () => speech('插件替角色说的。') })], { serialScheduling: true })
  const state = await good.runtime.submit('你好')
  expect(good.contexts).toHaveLength(0)
  expect(state.transcript.some(line => line.text.includes('插件替角色说的'))).toBe(true)

  const bad = await start(
    [
      provider({
        decide: async () => ({
          decision: 'perform',
          actionType: 'move',
          parameters: { locationId: 'location:nowhere' },
        }),
      }),
    ],
    { serialScheduling: true },
  )
  await bad.runtime.submit('你好')
  const store = new WorldStore(join(bad.root, 'world.sqlite'))
  const moves = store
    .readEvents(bad.runtime.address)
    .filter(event => JSON.stringify(event.data).includes('location:nowhere') && event.eventType !== 'action.rejected')
  store.close()
  expect(moves.filter(event => (event.data as { status?: string }).status === 'accepted')).toEqual([])
  expect(moves.filter(event => event.eventType === 'character.moved')).toEqual([])
})

it('fails the round when a decision implementation throws, and keeps the input', async () => {
  let fail = true
  const { runtime } = await start([
    provider({
      context: async request => {
        if (fail) throw new Error('decision bug')
        return request
      },
    }),
  ])
  const failed = await runtime.submit(MOVE)
  expect(failed.error).toBe(true)
  expect(failed.transcript.some(line => line.player)).toBe(true)
  fail = false
  expect((await runtime.submit('你好')).error).toBe(false)
})

it('closes the instances already open when a later one cannot open', async () => {
  const close = vi.fn()
  await expect(
    start([
      provider({ close }, 'first'),
      {
        id: 'broken-decision',
        version: '1.0.0',
        open: async () => {
          throw new Error('cannot open')
        },
      },
    ]),
  ).rejects.toThrow('broken-decision')
  expect(close).toHaveBeenCalledTimes(1)
})

it('opens and closes implementations for each regeneration candidate', async () => {
  let opened = 0,
    closed = 0
  const { runtime } = await start([
    {
      id: 'counting',
      version: '1.0.0',
      open: async () => {
        opened++
        return { close: () => void closed++ }
      },
    },
  ])
  const state = await runtime.submit(MOVE)
  const before = opened
  await runtime.regenerate(state.tailRound!.id!, 'decision-seam-regeneration')
  expect(opened).toBeGreaterThan(before)
  await runtime.close()
  runtimes.length = 0
  expect(closed).toBe(opened)
})

it('schedules serially while an implementation declares serial', async () => {
  const free = await start([provider({})])
  await free.runtime.submit(MOVE)
  expect(free.timing.peak).toBeGreaterThan(1)
  const serial = await start([provider({ serial: true })])
  await serial.runtime.submit(MOVE)
  expect(serial.timing.peak).toBe(1)
})

it('reports commits and debug state', async () => {
  const heads: number[] = []
  const { runtime } = await start([
    provider({ committed: head => void heads.push(head), debug: () => ({ testDecision: { heads: heads.length } }) }),
  ])
  await runtime.submit(MOVE)
  expect(heads.length).toBeGreaterThan(0)
  expect(heads).toEqual([...heads].sort((a, b) => a - b))
  expect((await runtime.state()).debug.testDecision).toMatchObject({ heads: heads.length })
})

it('names the implementation and logs when it fails, but not for a failure inside next', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime } = await start(
    [
      provider(
        {
          decide: async () => {
            throw new Error('decide bug')
          },
        },
        'buggy-decision',
      ),
    ],
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('buggy-decision')
  expect(log.mock.calls.flat().map(String).join(' ')).toContain('decide bug')
})
