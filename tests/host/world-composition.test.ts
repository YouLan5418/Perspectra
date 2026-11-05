import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assembleRoleplay, type WorldComposition } from '../../desktop/official-bundle.ts'
import { WorldHostCore, WorldHostRuntime, type WorldHostCoreOptions } from '../../desktop/host/world-runtime.ts'
import { LensSimulation } from '../../desktop/lens/simulation.ts'
import { LensSession } from '../../desktop/lens/session.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'
import type { SeamProvider, StatusInstance } from '@harness-world/plugin-sdk'

const roots: string[] = [],
  runtimes: WorldHostRuntime[] = [],
  sessions: LensSession[] = [],
  simulations: LensSimulation[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  for (const simulation of simulations.splice(0)) await simulation.close()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'composition-'))
  roots.push(root)
  return root
}
function pack(withStatus = false) {
  const path = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/prototype-g1'), path, { recursive: true })
  const file = join(path, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (!withStatus) manifest.assetFiles = []
  else
    writeFileSync(
      join(path, 'scripts/status.js'),
      'throw new Error("the selected native interpreter must handle this source")',
    )
  writeFileSync(file, JSON.stringify(manifest))
  return path
}
async function start(composition: WorldComposition, packPath = pack()) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const root = fresh()
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath,
    models: fakeModels(server.endpoint),
    composition,
  })
  runtimes.push(runtime)
  return { runtime, root, packPath }
}
function customStatus() {
  const opened: { closed: boolean }[] = []
  const status: SeamProvider<StatusInstance> = {
    id: 'selected-native-status',
    version: '1.0.0',
    open: async () => {
      const entry = { closed: false }
      opened.push(entry)
      return {
        definition: {
          statuses: [{ key: 'custom', label: '自定义状态', owner: 'public', type: 'number' }],
          operations: [],
        },
        moduleDefinitions: [],
        hasRoundHook: false,
        initialize: ids => ({ public: { custom: 1 }, characters: Object.fromEntries(ids.map(id => [id, {}])) }),
        policy: () => null,
        resolve: () => {
          throw new Error('no operations')
        },
        endRound: () => null,
        prepareModule: () => {
          throw new Error('no modules')
        },
        close: () => {
          entry.closed = true
        },
      }
    },
  }
  return { composition: assembleRoleplay({ status }), opened }
}

it('requires an explicit composition in the core instead of installing the RP defaults', async () => {
  await expect(WorldHostCore.create({ dataDirectory: fresh() } as WorldHostCoreOptions)).rejects.toThrow(
    '世界组合必须明确提供',
  )
})
it('keeps absent optional mechanisms disabled through rounds and candidate regeneration', async () => {
  const standard = assembleRoleplay()
  const f = await start({
    ...standard,
    mechanisms: { scheduler: standard.mechanisms.scheduler, characterLoop: standard.mechanisms.characterLoop! },
  })
  const first = await f.runtime.submit('继续。')
  await f.runtime.regenerate(first.tailRound!.id!, 'without-optional-services')
  const record = JSON.parse(readFileSync(join(f.root, 'plugin-set.json'), 'utf8'))
  expect(Object.keys(record.seams).sort()).toEqual(['characterLoop', 'llm', 'scheduler'])
})
it('does not manufacture the standard interaction catalog for an explicit empty install', async () => {
  await expect(start({ ...assembleRoleplay(), interactionPackages: [] })).rejects.toThrow()
})
it('refuses required status assets when the selected composition omits the status mechanism', async () => {
  const standard = assembleRoleplay(),
    { status: _status, ...mechanisms } = standard.mechanisms
  await expect(start({ ...standard, mechanisms }, pack(true))).rejects.toThrow('世界声明的 status 需要对应机制')
})
it('does not manufacture a scheduler fallback for a custom composition', async () => {
  const { fallbackScheduler: _fallback, ...composition } = assembleRoleplay()
  await expect(
    start({
      ...composition,
      mechanisms: {
        ...composition.mechanisms,
        scheduler: {
          id: 'broken-scheduler',
          version: '1.0.0',
          open: async () => {
            throw new Error('no fallback chosen')
          },
        },
      },
    }),
  ).rejects.toThrow('no fallback chosen')
})
it('uses the selected status definition and initializer for Lens opening overrides', async () => {
  const { composition, opened } = customStatus()
  const simulation = await LensSimulation.open(pack(true), { status: { public: { custom: 7 } } }, composition)
  simulations.push(simulation)
  expect(await simulation.statusTruth()).toMatchObject({ public: { custom: 7 } })
  expect(simulation.statusDefinition().statuses.map(status => status.key)).toEqual(['custom'])
  await simulation.close()
  expect(opened.every(entry => entry.closed)).toBe(true)
})
it('retains the selected composition across Lens restarts and reloads', async () => {
  const { composition } = customStatus(),
    session = await LensSession.open(pack(true), composition)
  sessions.push(session)
  await session.restart({ status: { public: { custom: 9 } } })
  const reloaded = await session.reload()
  expect(reloaded.view.items.some(item => item.title === '自定义状态')).toBe(true)
  expect(JSON.stringify(reloaded.simulation.state)).not.toContain('the selected native interpreter')
})
it('opens and closes the selected status provider for share preflight without a second interpreter', async () => {
  const { composition, opened } = customStatus(),
    f = await start(composition, pack(true))
  const node = await f.runtime.saveNode('自定义状态节点')
  const archive = join(fresh(), 'selected.perspectra-story')
  await exportStoryNode(f.root, node.id, archive, f.packPath, composition)
  expect(opened.length).toBeGreaterThan(1)
  const imported = await importStoryNode(archive, fresh(), f.packPath, node.packHash, composition)
  expect(imported.node.title).toBe(node.title)
  await f.runtime.close()
  expect(opened.every(entry => entry.closed)).toBe(true)
})

it('closes a selected mechanism that opens but fails validation, and names it in the error', async () => {
  const standard = assembleRoleplay()
  let closed = false
  const broken: SeamProvider<StatusInstance> = {
    id: 'broken-status',
    version: '1.0.0',
    open: async () =>
      ({
        definition: {},
        close: () => {
          closed = true
        },
      }) as unknown as StatusInstance,
  }
  await expect(
    start({ ...standard, mechanisms: { ...standard.mechanisms, status: broken } }, pack(true)),
  ).rejects.toThrow('状态机制 broken-status 无法打开：status requires initialize')
  expect(closed).toBe(true)
})
it('refuses a knowledge mechanism without select but does not require knowledge for a world', async () => {
  const standard = assembleRoleplay()
  await expect(
    start({
      ...standard,
      mechanisms: {
        ...standard.mechanisms,
        knowledge: { id: 'broken-knowledge', version: '1.0.0', open: async () => ({}) as never },
      },
    }),
  ).rejects.toThrow('知识机制 broken-knowledge 无法打开：knowledge requires select')
})
