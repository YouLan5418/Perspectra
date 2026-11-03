import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LlmInstance, MemoryInstance, RulesInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { afterEach, expect, it } from 'vitest'
import { pluginSetChanges } from '../../desktop/host/plugin-set.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MOVE = '/act move {"locationId":"location:front-room"}'
const memory = (id: string, version = '1.0.0'): SeamProvider<MemoryInstance> => ({
  id,
  version,
  open: async () => ({ project: async request => request }),
})

async function serve() {
  const server = createChatServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify({ decision: 'abstain' }) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions')
}
function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-plugin-set-'))
  roots.push(root)
  return root
}
async function open(root: string, models: Awaited<ReturnType<typeof serve>>, plugins: object = {}) {
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models,
    timeoutMs: 5000,
    plugins,
  })
  runtimes.push(runtime)
  return runtime
}
async function shut() {
  for (const runtime of runtimes.splice(0)) await runtime.close()
}
const record = (root: string) => JSON.parse(readFileSync(join(root, 'plugin-set.json'), 'utf8'))

it('records the modules in force when a world opens', async () => {
  const root = newRoot()
  const rules: SeamProvider<RulesInstance> = { id: 'my-rules', version: '0.1.0', open: async () => ({}) }
  await open(root, await serve(), { memory: memory('my-memory'), rules: [rules] })
  expect(record(root).seams).toMatchObject({
    memory: [{ id: 'my-memory', version: '1.0.0' }],
    rules: [{ id: 'my-rules', version: '0.1.0' }],
    llm: [{ id: 'official-llm' }],
    scheduler: [{ id: expect.any(String) }],
  })
})

it('says nothing the first time, or when nothing changed', async () => {
  const root = newRoot()
  const models = await serve()
  const first = await open(root, models, { memory: memory('my-memory') })
  expect((await first.state()).notice).not.toContain('my-memory')
  await shut()
  const again = await open(root, models, { memory: memory('my-memory') })
  expect((await again.state()).notice).not.toContain('my-memory')
})

it('tells the player which module changed, and opens the world anyway', async () => {
  const root = newRoot()
  const models = await serve()
  const first = await open(root, models, { memory: memory('my-memory') })
  await first.submit(MOVE)
  const before = (await first.state()).debug.headSeq
  await shut()
  const changed = await open(root, models, { memory: memory('other-memory') })
  const state = await changed.state()
  expect(state.notice).toContain('长期记忆')
  expect(state.notice).toContain('my-memory')
  expect(state.notice).toContain('other-memory')
  expect(state.debug.headSeq).toBe(before)
  expect(state.transcript.some(line => line.player)).toBe(true)
  expect(record(root).seams.memory).toEqual([{ id: 'other-memory', version: '1.0.0' }])
})

it('notices a new version of the same plugin', () => {
  const before = { seams: { memory: [{ id: 'a', version: '1.0.0' }] } }
  expect(pluginSetChanges(before, { seams: { memory: [{ id: 'a', version: '1.1.0' }] } })).toEqual([
    '长期记忆：a 1.0.0 → a 1.1.0',
  ])
  expect(pluginSetChanges(before, before)).toEqual([])
  expect(pluginSetChanges(undefined, before)).toEqual([])
})

it('treats a damaged record as no record', async () => {
  const root = newRoot()
  const models = await serve()
  await open(root, models, { memory: memory('my-memory') })
  await shut()
  writeFileSync(join(root, 'plugin-set.json'), '{not json')
  const reopened = await open(root, models, { memory: memory('other-memory') })
  expect((await reopened.state()).notice).not.toContain('长期记忆')
  expect(record(root).seams.memory[0].id).toBe('other-memory')
  await shut()
  writeFileSync(join(root, 'plugin-set.json'), JSON.stringify({ seams: { memory: 'wrong' } }))
  const again = await open(root, models, { memory: memory('third-memory') })
  expect((await again.state()).notice).not.toContain('长期记忆')
})

it('leaves the record alone for a regeneration candidate', async () => {
  const root = newRoot()
  const models = await serve()
  const opened: boolean[] = []
  const watching: SeamProvider<LlmInstance> = {
    id: 'watching-llm',
    version: '1.0.0',
    open: async world => {
      opened.push(world.candidate)
      return { send: async () => ({ decision: 'abstain' }) }
    },
  }
  const runtime = await open(root, models, { llm: watching })
  const state = await runtime.submit(MOVE)
  const before = readFileSync(join(root, 'plugin-set.json'), 'utf8')
  const regenerated = await runtime.regenerate(state.tailRound!.id!, 'plugin-set-candidate')
  expect(opened).toContain(true)
  expect(readFileSync(join(root, 'plugin-set.json'), 'utf8')).toBe(before)
  expect(regenerated.notice ?? '').not.toContain('模型通道')
})

it('reopens a save after its plugin was removed', async () => {
  const root = newRoot()
  const models = await serve()
  const rules: SeamProvider<RulesInstance> = { id: 'my-rules', version: '0.1.0', open: async () => ({}) }
  const first = await open(root, models, { rules: [rules] })
  await first.submit(MOVE)
  const before = await first.state()
  await shut()
  const reopened = await open(root, models)
  const state = await reopened.state()
  expect(state.notice).toContain('世界规则')
  expect(state.debug.headSeq).toBe(before.debug.headSeq)
  expect(state.transcript).toEqual(before.transcript)
  expect((await reopened.submit('你好')).error).toBe(false)
})
