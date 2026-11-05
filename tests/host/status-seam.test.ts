import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SeamProvider, StatusInstance } from '@harness-world/plugin-sdk'
import { StatusScripts } from '@harness-world/official-status'
import { WorldStore } from '@harness-world/store-sqlite'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  sessions: HostPlugins[] = [],
  runtimes: WorldHostRuntime[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const session of sessions.splice(0)) await session.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'status-seam-'))
  roots.push(root)
  return root
}
const script = `globalThis.statusScript={
  definition:{statuses:[{key:'score',label:'积分',type:'number',owner:'character'}],operations:[{id:'gain',label:'加分',actors:'player',schema:{type:'object',additionalProperties:false,properties:{}}}]},
  initialize:ids=>({public:{},characters:Object.fromEntries(ids.map(id=>[id,{score:0}]))}),
  resolve:(truth,actor)=>({changes:[{holderId:actor,key:'score',value:truth.characters[actor].score+1}],reveals:[],description:'已加分',audience:'self'})
}`
function pack(enabled = true) {
  const path = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/prototype-g1'), path, { recursive: true })
  const manifestPath = join(path, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.assetFiles = manifest.assetFiles.filter((entry: string) => entry !== 'scripts/status.js')
  if (enabled) manifest.assetFiles.push('scripts/status.js')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(path, 'scripts/status.js'), script)
  return path
}
async function start(status: SeamProvider<StatusInstance>, packPath = pack()) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const runtime = await WorldHostRuntime.create({
    dataDirectory: fresh(),
    packPath,
    models: fakeModels(server.endpoint),
    plugins: { status },
    serialScheduling: true,
  })
  runtimes.push(runtime)
  const events = () => {
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  return { runtime, events }
}
function decorated(change: (instance: StatusScripts) => void): SeamProvider<StatusInstance> {
  return {
    id: 'custom-status',
    version: '1.0.0',
    open: async world => {
      const instance = new StatusScripts(world.statusSource)
      change(instance)
      return instance
    },
  }
}

it('loads an external status service and submits its proposed changes through the core', async () => {
  const path = join(fresh(), 'status.mjs')
  writeFileSync(
    path,
    `export const hostApi='2.6'; export default ctx=>ctx.effect(()=>ctx.status.register({id:'external-status',version:'1.0.0',open:async world=>{
    if(!world.statusSource)throw new Error('missing declared source');
    return {definition:{statuses:[{key:'score',label:'积分',type:'number',owner:'character'}],operations:[{id:'gain',label:'加分',actors:'player',schema:{type:'object',additionalProperties:false,properties:{}}}]},
    hasRoundHook:false,moduleDefinitions:[],initialize:ids=>({public:{},characters:Object.fromEntries(ids.map(id=>[id,{score:0}]))}),
    policy:()=>null,resolve:({truth,actorId})=>({changes:[{holderId:actorId,key:'score',value:truth.characters[actorId].score+7}],reveals:[],description:'外部机制加分',audience:'self'}),endRound:()=>null,prepareModule:()=>{throw new Error('no modules')}};
  }}))`,
  )
  writeFileSync(
    path.replace('.mjs', '.plugin.json'),
    JSON.stringify({ id: 'external-status', name: '状态机制', version: '1.0.0', services: ['status'] }),
  )
  const session = await loadHostPlugins([{ id: 'state', path, enabled: true }])
  sessions.push(session)
  expect(session.skipped).toEqual([])
  const f = await start(session.seams.status!)
  await f.runtime.submit('/status gain {}')
  expect(
    f
      .events()
      .filter(event => event.eventType === 'status.updated')
      .map(event => event.data),
  ).toContainEqual(
    expect.objectContaining({
      description: '外部机制加分',
      changes: [expect.objectContaining({ key: 'score', value: 7 })],
    }),
  )
})

it('fails opening a broken service without falling back to the official interpreter', async () => {
  await expect(
    start({
      id: 'broken-status',
      version: '1.0.0',
      open: async () => {
        throw new Error('cannot initialize')
      },
    }),
  ).rejects.toThrow('状态机制 broken-status 无法打开')
})

it('attributes interpreter errors and keeps the authoritative prefix unchanged', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = await start(
    decorated(instance => {
      instance.resolve = () => {
        throw new Error('calculation failed')
      }
    }),
  )
  const before = f.events()
  await expect(f.runtime.submit('/status gain {}')).rejects.toThrow('状态机制 custom-status')
  expect(f.events()).toEqual(before)
})

it.each(['value', 'reveal'] as const)('refuses invalid %s effects returned by a replacement service', async kind => {
  const f = await start(
    decorated(instance => {
      instance.resolve = input => ({
        changes: [{ holderId: input.actorId, key: 'score', value: kind === 'value' ? 'invalid' : 1 }],
        reveals: kind === 'reveal' ? [{ observerId: 'character:absent', holderId: input.actorId, key: 'score' }] : [],
        description: 'candidate',
        audience: 'self',
      })
    }),
  )
  const before = f.events()
  await expect(f.runtime.submit('/status gain {}')).rejects.toThrow(
    kind === 'value' ? '状态值不符合' : '告知对象不在当前场景',
  )
  expect(f.events()).toEqual(before)
})

it('gives policy only authorized status values while trusted resolution receives truth', async () => {
  let policies = 0
  const f = await start(
    decorated(instance => {
      instance.policy = (known, actorId) => {
        policies++
        const characters = known.characters as Record<string, unknown>
        expect(Object.keys(characters)).toEqual([actorId])
        return null
      }
    }),
  )
  await f.runtime.submit('/status gain {}')
  expect(policies).toBeGreaterThan(0)
})

it('opens independent candidate instances, closes each, and refuses changed public identity', async () => {
  const instances: { closed: boolean }[] = [],
    identity = { mode: 1 }
  const f = await start({
    id: 'isolated-status',
    version: '1.0.0',
    identity,
    open: async world => {
      const tracked = { closed: false }
      instances.push(tracked)
      return Object.assign(new StatusScripts(world.statusSource), {
        close: () => {
          tracked.closed = true
        },
      })
    },
  })
  const first = await f.runtime.submit('/status gain {}'),
    before = instances.length
  await f.runtime.regenerate(first.tailRound!.id!, 'status-candidate')
  expect(instances.length).toBeGreaterThan(before)
  const current = await f.runtime.state()
  identity.mode = 2
  await expect(f.runtime.regenerate(current.tailRound!.id!, 'changed-status')).rejects.toThrow('环境已改变')
  await f.runtime.close()
  expect(instances.every(instance => instance.closed)).toBe(true)
})

it('does not create undeclared persistent state when the world has no status source', async () => {
  const undeclared = new StatusScripts({ script, modules: [] })
  await expect(
    start({ id: 'undeclared-status', version: '1.0.0', open: async () => undeclared }, pack(false)),
  ).rejects.toThrow('must match the world declared source')
})

it('preserves initialization for a declared empty module bundle without a base status script', async () => {
  const path = pack(false),
    manifestPath = join(path, 'worldpack.source.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.assetFiles.push('plugins.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(path, 'plugins.json'), JSON.stringify({ modules: [] }))
  const f = await start(
    decorated(() => {}),
    path,
  )
  const updates = () => f.events().filter(event => event.eventType === 'status.updated')
  expect(updates()).toHaveLength(1)
  expect(updates()[0]!.data).toEqual({ source: { kind: 'initial' }, changes: [], reveals: [] })
  await f.runtime.submit('你好')
  expect(updates()).toHaveLength(1)
})
