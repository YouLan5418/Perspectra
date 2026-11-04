import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CharacterLoopInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { officialCharacterLoop } from '@harness-world/official-character-loop'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { WorldHostRuntime, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = [],
  sessions: HostPlugins[] = [],
  runtimes: WorldHostRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of runtimes.splice(0)) await r.close()
  for (const s of sessions.splice(0)) await s.close()
  for (const s of servers.splice(0)) await s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const MOVE = '/act move {"locationId":"location:front-room"}'
const EXAMPLE = resolve('examples/host-plugins/single-action-loop.mjs')
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'loop-seam-'))
  roots.push(root)
  return root
}
async function start(
  characterLoop: SeamProvider<CharacterLoopInstance>,
  pack = 'dynamic-scheduling',
  extra: Partial<WorldHostOptions> = {},
) {
  const root = extra.dataDirectory ?? fresh()
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs', pack),
    models: fakeModels(server.endpoint),
    plugins: { characterLoop },
    ...extra,
  })
  runtimes.push(runtime)
  return { runtime, root, calls: server.calls }
}

it.each(['dynamic-scheduling', 'autonomy-scheduling', 'scripted-performance'])(
  'loads the external example and runs it for %s',
  async pack => {
    const session = await loadHostPlugins([{ id: 'loop', path: EXAMPLE, enabled: true }])
    sessions.push(session)
    expect(session.skipped).toEqual([])
    const source = session.seams.characterLoop!
    const actors: string[] = []
    const { runtime, root, calls } = await start(
      {
        ...source,
        open: async (world, signal) => {
          const instance = await source.open(world, signal)
          return {
            ...instance,
            run: a => {
              actors.push(a.characterId)
              return instance.run(a)
            },
          }
        },
      },
      pack,
      { stagedAutonomy: true, serialScheduling: true },
    )
    const state =
      pack === 'scripted-performance'
        ? await runtime.activityAction({
            activityKey: 'default',
            activityId: null,
            revision: 0,
            operation: 'start',
            parameters: {},
            requestId: 'loop-activity',
          })
        : await runtime.submit(pack === 'dynamic-scheduling' ? MOVE : '你好')
    expect(state.error).toBeFalsy()
    expect(actors.length).toBeGreaterThan(0)
    if (pack === 'autonomy-scheduling') expect(actors).toContain('character:friend')
    if (pack === 'scripted-performance') {
      expect(state.transcript.some(line => !line.player)).toBe(true)
    } else {
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        const request = JSON.parse(call.userText)
        expect(actors).toContain(request.context.character.characterId)
        expect(request.context).not.toHaveProperty('store')
      }
    }
    expect(JSON.parse(readFileSync(join(root, 'plugin-set.json'), 'utf8')).seams.characterLoop).toEqual([
      { id: source.id, version: source.version },
    ])
  },
)

it('fails opening instead of falling back to a different character policy', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(
    start({
      id: 'broken-loop',
      version: '1.0.0',
      open: async () => {
        throw new Error('open failed')
      },
    }),
  ).rejects.toThrow('角色循环插件 broken-loop')
})

it('attributes a loop bug to the selected plugin and keeps the player input', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime, calls } = await start({
    id: 'broken-loop',
    version: '1.0.0',
    open: async () => ({
      run: async () => {
        throw new Error('loop bug')
      },
    }),
  })
  const state = await runtime.submit(MOVE)
  expect(state.error).toBe(true)
  expect(state.notice).toContain('broken-loop')
  expect(state.transcript.some(line => line.player)).toBe(true)
  expect(calls).toHaveLength(0)
})

it('opens independent instances for candidates and node restores, and tracks identity changes', async () => {
  const instances: { closed: boolean }[] = []
  const identity = { mode: 1 }
  const provider: SeamProvider<CharacterLoopInstance> = {
    id: 'counted-loop',
    version: '1.0.0',
    identity,
    open: async () => {
      const instance = { closed: false }
      instances.push(instance)
      return {
        run: a => officialCharacterLoop.run(a),
        close: () => {
          instance.closed = true
        },
      }
    },
  }
  const { runtime, root } = await start(provider, 'dynamic-scheduling', { storyNodes: true })
  const state = await runtime.submit(MOVE)
  const before = instances.length
  await runtime.regenerate(state.tailRound!.id!, 'loop-regenerate')
  expect(instances.length).toBeGreaterThan(before)
  const regenerated = await runtime.state()
  await runtime.selectCandidate(regenerated.tailRound!.id!, state.tailRound!.candidateIds![0]!, 'loop-select')
  const selected = await runtime.state()
  identity.mode = 2
  await expect(runtime.regenerate(selected.tailRound!.id!, 'loop-changed')).rejects.toThrow('环境已改变')
  await expect(
    runtime.selectCandidate(
      selected.tailRound!.id!,
      selected.tailRound!.candidateIds!.at(-1)!,
      'loop-changed-selection',
    ),
  ).rejects.toThrow('环境已改变')
  identity.mode = 1
  const node = await runtime.saveNode('角色循环节点')
  await runtime.close()
  const target = fresh()
  restoreStoryNode(root, node.id, target, node.packHash)
  const restored = await start(provider, 'dynamic-scheduling', { dataDirectory: target })
  await restored.runtime.close()
  expect(instances.every(instance => instance.closed)).toBe(true)
})
