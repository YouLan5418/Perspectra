import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { KnowledgeInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  sessions: HostPlugins[] = [],
  runtimes: WorldHostRuntime[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of sessions.splice(0)) await s.close()
  for (const s of servers.splice(0)) await s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-seam-'))
  roots.push(root)
  return root
}
async function start(knowledge: SeamProvider<KnowledgeInstance>) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const runtime = await WorldHostRuntime.create({
    dataDirectory: fresh(),
    packPath: resolve('examples/world-packs/prototype-g1'),
    models: fakeModels(server.endpoint),
    plugins: { knowledge },
    serialScheduling: true,
  })
  runtimes.push(runtime)
  return { runtime, calls: server.calls }
}

it('loads an external knowledge service and uses it through the official context step', async () => {
  const path = join(fresh(), 'knowledge.mjs')
  writeFileSync(
    path,
    `export const hostApi='2.5'; export default ctx=>ctx.effect(()=>ctx.knowledge.register({id:'external-knowledge',version:'1.0.0',open:async()=>({select:context=>({source:'author_setting',entries:[{documentId:'marker',content:'knowledge-marker:'+context.character.characterId}]})})}))`,
  )
  const session = await loadHostPlugins([{ id: 'knowledge', path, enabled: true }])
  sessions.push(session)
  expect(session.skipped).toEqual([])
  const { runtime, calls } = await start(session.seams.knowledge!)
  await runtime.submit('你好')
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    const request = JSON.parse(call.userText)
    expect(request.context.knowledge.entries[0].content).toBe(
      'knowledge-marker:' + request.context.character.characterId,
    )
  }
})

it('fails opening instead of silently replacing a broken knowledge mechanism', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(
    start({
      id: 'broken-knowledge',
      version: '1.0.0',
      open: async () => {
        throw new Error('cannot parse')
      },
    }),
  ).rejects.toThrow('知识机制 broken-knowledge 无法打开')
})

it('attributes selection errors to the mechanism and preserves the player input', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime, calls } = await start({
    id: 'broken-selection',
    version: '1.0.0',
    open: async () => ({
      select: () => {
        throw new Error('selection failed')
      },
    }),
  })
  const state = await runtime.submit('你好')
  expect(state.notice).toContain('broken-selection')
  expect(state.transcript.some(line => line.player)).toBe(true)
  expect(calls).toHaveLength(0)
})

it('opens independent candidate instances, closes each one, and compares public identity', async () => {
  const instances: { closed: boolean }[] = []
  const identity = { mode: 1 }
  const { runtime } = await start({
    id: 'counted-knowledge',
    version: '1.0.0',
    identity,
    open: async () => {
      const instance = { closed: false }
      instances.push(instance)
      return {
        select: () => undefined,
        close: () => {
          instance.closed = true
        },
      }
    },
  })
  const first = await runtime.submit('你好')
  const before = instances.length
  await runtime.regenerate(first.tailRound!.id!, 'knowledge-regenerate')
  expect(instances.length).toBeGreaterThan(before)
  const current = await runtime.state()
  identity.mode = 2
  await expect(runtime.regenerate(current.tailRound!.id!, 'knowledge-changed')).rejects.toThrow('环境已改变')
  await runtime.close()
  expect(instances.every(instance => instance.closed)).toBe(true)
})
