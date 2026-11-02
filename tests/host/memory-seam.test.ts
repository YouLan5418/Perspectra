import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { MemoryInstance, SeamProvider, WorldServices } from '@harness-world/plugin-sdk'
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

function provider(instance: MemoryInstance, id = 'test-memory'): SeamProvider<MemoryInstance> {
  return { id, version: '1.0.0', open: async () => instance }
}

async function start(memory: SeamProvider<MemoryInstance>, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-memory-seam-'))
  roots.push(root)
  const contexts: Record<string, unknown>[] = []
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      contexts.push(JSON.parse(JSON.parse(body).messages.at(-1).content).context)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'abstain' }) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models: fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions'),
    timeoutMs: 5000,
    plugins: { memory },
    ...extra,
  })
  runtimes.push(runtime)
  return { runtime, contexts, root }
}

const passthrough: MemoryInstance = { project: async request => request }

it('calls the configured memory provider around each decision and closes it', async () => {
  let closed = 0
  const { runtime, contexts } = await start(
    provider({
      project: async request => ({ ...request, context: { ...request.context, testMemory: '记得雨天' } }),
      close: () => void closed++,
    }),
  )
  await runtime.submit(MOVE)
  expect(contexts.length).toBeGreaterThan(0)
  expect(JSON.stringify(contexts[0])).toContain('记得雨天')
  await runtime.close()
  runtimes.length = 0
  expect(closed).toBe(1)
})

it('opens a separate instance for each regeneration candidate', async () => {
  let opened = 0,
    closed = 0
  const { runtime } = await start({
    id: 'test-memory',
    version: '1.0.0',
    open: async () => {
      opened++
      return { ...passthrough, close: () => void closed++ }
    },
  })
  const state = await runtime.submit(MOVE)
  const before = opened
  await runtime.regenerate(state.tailRound!.id!, 'memory-seam-regeneration')
  expect(opened).toBeGreaterThan(before)
  await runtime.close()
  runtimes.length = 0
  expect(closed).toBe(opened)
})

it('keeps player input and continues the next round when project throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let fail = true
  const { runtime } = await start(
    provider({
      project: async request => {
        if (fail) throw new Error('memory bug')
        return request
      },
    }),
  )
  const failed = await runtime.submit(MOVE)
  expect(failed.error).toBe(true)
  expect(failed.transcript.some(line => line.player)).toBe(true)
  fail = false
  const next = await runtime.submit('还在吗？')
  expect(next.error).toBeFalsy()
  expect(next.transcript.some(line => line.player && line.text === '还在吗？')).toBe(true)
})

it('refuses to open the world when a third-party memory provider cannot open', async () => {
  await expect(
    start({
      id: 'broken-memory',
      version: '1.0.0',
      open: async () => {
        throw new Error('cannot open')
      },
    }),
  ).rejects.toThrow('broken-memory')
})

it('saves a story node under a provider without archives', async () => {
  const { runtime } = await start(provider(passthrough))
  await runtime.submit(MOVE)
  await expect(runtime.saveNode('节点')).resolves.toMatchObject({ title: '节点' })
})

it('gives a third-party provider no model configuration', async () => {
  let services: WorldServices | undefined
  await start({
    id: 'nosy-memory',
    version: '1.0.0',
    open: async world => {
      services = world
      return passthrough
    },
  })
  expect(Object.keys(services!).sort()).toEqual([
    'address',
    'dataDirectory',
    'instanceDirectory',
    'world',
    'worldVersion',
  ])
  expect(JSON.stringify(services)).not.toContain('apiKey')
})
