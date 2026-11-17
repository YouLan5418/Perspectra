import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assembleRoleplay, type WorldComposition } from '../../apps/host/src/official-bundle.ts'
import {
  WorldHostCore,
  WorldHostRuntime,
  type WorldHostCoreOptions,
} from '../../apps/host/src/runtime/world-runtime.ts'
import { LensSimulation } from '../../apps/host/src/lens/simulation.ts'
import { LensSession } from '../../apps/host/src/lens/session.ts'
import { exportStoryNode, importStoryNode } from '../../apps/host/src/story-share.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'
import type { SeamProvider, StatusInstance } from '@perspectra/sdk'
import { PluginFaultError } from '../../apps/host/src/runtime/plugin-runtime.ts'

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
  delete manifest.scripts
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
it('opens an explicit empty interaction install without manufacturing a base package', async () => {
  expect(assembleRoleplay().interactionPackages).toEqual([])
  await expect(start({ ...assembleRoleplay(), interactionPackages: [] })).resolves.toBeDefined()
})
it('refuses required status assets when the selected composition omits the status mechanism', async () => {
  const standard = assembleRoleplay(),
    { status: _status, ...mechanisms } = standard.mechanisms
  await expect(start({ ...standard, mechanisms }, pack(true))).rejects.toThrow('世界声明的 status 需要对应机制')
})
it('does not manufacture a scheduler fallback for a custom composition', async () => {
  const composition = assembleRoleplay()
  const failure = await start({
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
  }).then(
    () => undefined,
    error => error,
  )
  expect(failure).toBeInstanceOf(PluginFaultError)
  if (!(failure instanceof PluginFaultError)) return
  expect(failure).toMatchObject({
    origin: 'plugin',
    pluginId: 'broken-scheduler',
    operation: 'open',
    invalidResult: false,
  })
  expect(failure.message).toBe('插件 broken-scheduler 的 open 操作失败。')
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
  expect(node.files).toContain('plugin-set.json')
  const archive = join(fresh(), 'selected.perspectra-story')
  await exportStoryNode(f.root, node.id, archive, f.packPath, composition)
  expect(opened.length).toBeGreaterThan(1)
  const imported = await importStoryNode(archive, fresh(), f.packPath, node.packHash, composition)
  expect(imported.node.title).toBe(node.title)
  await f.runtime.close()
  expect(opened.every(entry => entry.closed)).toBe(true)
})

it('closes and safely attributes a selected mechanism that opens but fails validation', async () => {
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
  const failure = await start({ ...standard, mechanisms: { ...standard.mechanisms, status: broken } }, pack(true)).then(
    () => undefined,
    error => error,
  )
  expect(failure).toBeInstanceOf(PluginFaultError)
  if (!(failure instanceof PluginFaultError)) return
  expect(failure).toMatchObject({
    origin: 'plugin',
    pluginId: 'broken-status',
    operation: 'open:initialize',
    invalidResult: true,
  })
  expect(failure.message).toBe('插件 broken-status 的 open:initialize 返回了无效结果。')
  expect(closed).toBe(true)
})
it('refuses a knowledge mechanism without select but does not require knowledge for a world', async () => {
  const standard = assembleRoleplay()
  const missingSelect: { select: () => undefined } = { select: () => undefined }
  Object.defineProperty(missingSelect, 'select', { value: undefined })
  const failure = await start({
    ...standard,
    mechanisms: {
      ...standard.mechanisms,
      knowledge: { id: 'broken-knowledge', version: '1.0.0', open: async () => missingSelect },
    },
  }).then(
    () => undefined,
    error => error,
  )
  expect(failure).toBeInstanceOf(PluginFaultError)
  if (!(failure instanceof PluginFaultError)) return
  expect(failure).toMatchObject({
    origin: 'plugin',
    pluginId: 'broken-knowledge',
    operation: 'open:select',
    invalidResult: true,
  })
  expect(failure.message).toBe('插件 broken-knowledge 的 open:select 返回了无效结果。')
})

it('starts a normal system cycle without an installed status script or a player wait action', async () => {
  const standard = assembleRoleplay()
  const { runtime } = await start({
    ...standard,
    mechanisms: { scheduler: standard.mechanisms.scheduler, characterLoop: standard.mechanisms.characterLoop! },
  })
  expect((await runtime.state()).canWait).not.toBe(true)
  const state = await runtime.processStimulus(0)
  expect(state.busy).toBe(false)
  expect(state.debug.execution).toMatchObject({ status: 'completed' })
  expect(state.transcript.filter(line => line.player)).toEqual([])
})
