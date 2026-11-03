import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { MemoryInstance, SeamProvider, WorldServices } from '@harness-world/plugin-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
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
  const models = fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions')
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models,
    timeoutMs: 5000,
    plugins: { memory },
    ...extra,
  })
  runtimes.push(runtime)
  return { runtime, contexts, root, models }
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

it('carries the data of a plugin into a regeneration candidate', async () => {
  const seen: { candidate: boolean; content: string | null }[] = []
  const { runtime } = await start({
    id: 'file-memory',
    version: '1.0.0',
    open: async world => {
      const index = join(world.dataDirectory, 'nested', 'index.txt')
      seen.push({
        candidate: world.dataDirectory.includes('.tail'),
        content: existsSync(index) ? readFileSync(index, 'utf8') : null,
      })
      mkdirSync(join(world.dataDirectory, 'nested'), { recursive: true })
      if (!existsSync(index)) writeFileSync(index, '妹妹怕黑')
      return passthrough
    },
  })
  const state = await runtime.submit(MOVE)
  await runtime.regenerate(state.tailRound!.id!, 'memory-seam-data')
  expect(seen[0]!.content).toBeNull()
  const candidates = seen.filter(open => open.candidate)
  expect(candidates.length).toBeGreaterThan(0)
  for (const open of candidates) expect(open.content).toBe('妹妹怕黑')
})

/** Saves a node under one memory and opens a new story line from it under another. */
async function reopenNode(
  writer: SeamProvider<MemoryInstance>,
  reader: SeamProvider<MemoryInstance>,
  edit?: (target: string) => void,
) {
  const { runtime, root } = await start(writer)
  await runtime.submit(MOVE)
  const node = await runtime.saveNode('节点')
  await runtime.close()
  runtimes.length = 0
  const target = mkdtempSync(join(tmpdir(), 'perspectra-memory-node-'))
  roots.push(target)
  restoreStoryNode(root, node.id, target, node.packHash)
  edit?.(target)
  return { ...(await start(reader, { dataDirectory: target })), target }
}

const archiving = (id: string, received: unknown[]): SeamProvider<MemoryInstance> =>
  provider(
    {
      ...passthrough,
      snapshotArchives: () => ({ owner: id }),
      restoreArchives: archives => void received.push(archives),
    },
    id,
  )

it('opens a story line from a node under a provider without archives', async () => {
  const { runtime, target } = await reopenNode(provider(passthrough), provider(passthrough))
  expect(existsSync(join(target, 'rebuild-memory.json'))).toBe(false)
  await expect(runtime.submit('你好')).resolves.toMatchObject({ error: false })
})

it('restores archives only into the provider that wrote them', async () => {
  const same: unknown[] = [],
    other: unknown[] = []
  await reopenNode(archiving('memory-a', []), archiving('memory-a', same))
  await reopenNode(archiving('memory-a', []), archiving('memory-b', other))
  expect(same).toEqual([{ owner: 'memory-a' }])
  expect(other).toEqual([{}])
})

it('treats a node without a recorded writer as written by Core', async () => {
  const received: unknown[] = []
  await reopenNode(archiving('memory-a', []), archiving('memory-b', received), target => {
    const path = join(target, 'rebuild-memory.json')
    const { memoryProvider: _writer, ...marker } = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify(marker))
  })
  expect(received).toEqual([{}])
})

it('shares a node saved under a third-party memory with its archives', async () => {
  const pack = resolve('examples/world-packs/dynamic-scheduling')
  const { runtime, root } = await start(archiving('memory-a', []))
  await runtime.submit(MOVE)
  const node = await runtime.saveNode('节点')
  await runtime.close()
  runtimes.length = 0
  const receiver = mkdtempSync(join(tmpdir(), 'perspectra-memory-share-'))
  roots.push(receiver)
  const file = join(receiver, 'node.perspectra-story')
  await exportStoryNode(root, node.id, file, pack)
  const { id } = await importStoryNode(file, receiver, pack, node.packHash)
  const received: unknown[] = []
  await start(archiving('memory-a', received), { dataDirectory: join(receiver, id) })
  expect(received).toEqual([{ owner: 'memory-a' }])
})

it('refuses to regenerate a round after the memory provider changed', async () => {
  const original = provider(passthrough, 'memory-a')
  const { runtime, root, models } = await start(original)
  const state = await runtime.submit(MOVE)
  await runtime.close()
  runtimes.length = 0
  const reopen = (memory: SeamProvider<MemoryInstance>) => start(memory, { dataDirectory: root, models })
  const { runtime: changed } = await reopen(provider(passthrough, 'memory-b'))
  await expect(changed.regenerate(state.tailRound!.id!, 'memory-seam-changed')).rejects.toThrow('环境')
  await changed.close()
  runtimes.length = 0
  const { runtime: same } = await reopen(original)
  await expect(same.regenerate(state.tailRound!.id!, 'memory-seam-same')).resolves.toBeDefined()
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
    'cast',
    'dataDirectory',
    'instanceDirectory',
    'world',
    'worldVersion',
  ])
  expect(JSON.stringify(services)).not.toContain('apiKey')
})
