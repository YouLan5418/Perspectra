import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { jevPublicationAudit, jevShadowAudit, takeClaimKey } from '../../packages/official-jev-audit/src/index.ts'
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
const ITEMS = [{ entityId: 'entity:brass-key', name: '黄铜钥匙' }]
const classify = async () => {
  throw new Error('no publication is expected to reach the classifier')
}

async function start(decisions: NonNullable<Parameters<typeof WorldHostRuntime.create>[0]['plugins']>) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-jev-provider-'))
  roots.push(root)
  const server = createChatServer((request, response) => {
    request.resume()
    request.on('end', () => {
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
    plugins: decisions,
  })
  runtimes.push(runtime)
  return runtime
}

it('takes the classifier key out of the environment', () => {
  const environment: NodeJS.ProcessEnv = { OPENROUTER_JEV_KEY: 'secret', OTHER: 'kept' }
  expect(takeClaimKey(environment)).toBe('secret')
  expect(environment).toEqual({ OTHER: 'kept' })
  expect(takeClaimKey(environment)).toBe('')
})

it('reports shadow audit stats, and regenerates without auditing the candidate', async () => {
  let writes = 0
  const runtime = await start({
    decisions: [jevShadowAudit({ items: ITEMS, classify, write: async () => void writes++, onError: () => {} })],
  })
  expect((await runtime.state()).debug.shadowAudit).toMatchObject({ errors: 0 })
  const state = await runtime.submit(MOVE)
  await expect(runtime.regenerate(state.tailRound!.id!, 'jev-shadow-candidate')).resolves.toBeDefined()
  expect(writes).toBe(0)
})

it('refuses a shadow audit of an item the pack does not declare', async () => {
  await expect(
    start({
      decisions: [
        jevShadowAudit({
          items: [{ entityId: 'entity:nothing', name: '不存在' }],
          classify,
          write: async () => {},
          onError: () => {},
        }),
      ],
    }),
  ).rejects.toThrow('not declared')
})

it('keeps refusing to regenerate under the publication audit, and leaves the round as it was', async () => {
  const runtime = await start({
    decisions: [jevPublicationAudit({ mode: 'baseline', items: ITEMS, classify, write: () => {} })],
  })
  const state = await runtime.submit(MOVE)
  await expect(runtime.regenerate(state.tailRound!.id!, 'jev-publication-candidate')).rejects.toThrow('外部审计')
  expect((await runtime.submit('你好')).error).toBe(false)
})
