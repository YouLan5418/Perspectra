import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createPlaytestServer, PlaytestBusyError, type PlaytestRuntime } from '../experiments/playtest-server.ts'

const token = 'a'.repeat(64)
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
})
async function start(saveNode?: (title: string) => Promise<{ id: string; title: string }>) {
  const server = createPlaytestServer({ saveNode } as PlaytestRuntime, token)
  servers.push(server)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return (title: unknown, authenticated = true, origin?: string) => fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/story-save', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-playtest-token': token } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify({ title }),
  })
}

it('saves a node with the given title', async () => {
  const save = vi.fn(async (title: string) => ({ id: 'node-1', title, internal: 'not exposed' }))
  const post = await start(save)
  const response = await post(' 晚饭后 ')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ node: { id: 'node-1', title: '晚饭后' } })
  expect(save).toHaveBeenCalledWith('晚饭后')
})
it('rejects without token and rejects cross-origin requests', async () => {
  const save = vi.fn(async (title: string) => ({ id: 'node-1', title }))
  const post = await start(save)
  expect((await post('晚饭后', false)).status).toBe(401)
  expect((await post('晚饭后', true, 'null')).status).toBe(403)
  expect(save).not.toHaveBeenCalled()
})
it('reports busy runtime', async () => {
  const post = await start(async () => { throw new PlaytestBusyError('角色仍在行动') })
  const response = await post('晚饭后')
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: '角色仍在行动' })
})
it('rejects overlong and non-string titles without saving', async () => {
  const save = vi.fn(async (title: string) => ({ id: 'node-1', title }))
  const post = await start(save)
  for (const title of ['a'.repeat(81), null, 1]) expect((await post(title)).status).toBe(400)
  expect(save).not.toHaveBeenCalled()
})
it('uses a readable default for empty titles and reports unsupported runtimes', async () => {
  const save = vi.fn(async (title: string) => ({ id: 'node-1', title }))
  const post = await start(save)
  for (const title of ['', '   ']) {
    expect((await post(title)).status).toBe(200)
    expect(save.mock.calls.at(-1)![0]).toMatch(/^保存于 \d{2}:\d{2}$/u)
  }
  expect((await (await start())('晚饭后')).status).toBe(501)
})
