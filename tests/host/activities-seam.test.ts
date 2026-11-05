import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivitiesScripts } from '@harness-world/official-activities'
import type { ActivitiesInstance, SeamProvider } from '@harness-world/plugin-sdk'
import type { ActivityState, WorldJsonObject } from '@harness-world/contracts'
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
  const root = mkdtempSync(join(tmpdir(), 'activities-seam-'))
  roots.push(root)
  return root
}
function pack(enabled = true) {
  const path = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/launcher-demo'), path, { recursive: true })
  if (!enabled) {
    const file = join(path, 'worldpack.source.json'),
      manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.assetFiles = manifest.assetFiles.filter((entry: string) => entry !== 'scripts/activity.js')
    writeFileSync(file, JSON.stringify(manifest))
  }
  return path
}
async function start(activities: SeamProvider<ActivitiesInstance>, packPath = pack()) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const runtime = await WorldHostRuntime.create({
    dataDirectory: fresh(),
    packPath,
    models: fakeModels(server.endpoint),
    plugins: { activities },
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
  const begin = () =>
    runtime.activityAction({ activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  const state = () =>
    (events().findLast(event => event.eventType === 'activity.updated')!.data as WorldJsonObject).state as ActivityState
  return { runtime, events, begin, state }
}
function decorated(change: (instance: ActivitiesScripts) => void): SeamProvider<ActivitiesInstance> {
  return {
    id: 'custom-activities',
    version: '1.0.0',
    open: async world => {
      const instance = new ActivitiesScripts(world.activitySource)
      change(instance)
      return instance
    },
  }
}

it('registers an external activities service through Cordis and commits its proposal', async () => {
  const path = join(fresh(), 'activities.mjs')
  writeFileSync(
    path,
    `import { Script, createContext } from 'node:vm';
    export const hostApi='2.7'; export default ctx=>ctx.effect(()=>ctx.activities.register({id:'external-activities',version:'1.0.0',open:async world=>({
      entries:world.activitySource.entries.map(source=>{
        const call=(method,args,random)=>JSON.parse(new Script(source.source+';JSON.stringify(__method==="definition"?activityScript.definition:typeof activityScript[__method]==="function"?activityScript[__method](...__args):null)').runInContext(createContext({__method:method,__args:args,Math:{...Math,random,floor:Math.floor}})));
        return {key:source.key,definition:call('definition',[]),hasAutoStart:false,hasResume:()=>false,
          initialize:(input,random)=>{const result=call('initialize',[input],random);result.public.external=true;return result},
          policy:(...args)=>call('policy',args),resolve:(...args)=>call('resolve',args),published:()=>null,resume:()=>null,autoStart:()=>null,simulate:()=>null,
          schedule:(...args)=>call('schedule',args),outcome:(...args)=>call('onOutcome',args)};
      }), select:()=> 'default',chooseAutoStart:()=>undefined
    })}))`,
  )
  writeFileSync(
    path.replace('.mjs', '.plugin.json'),
    JSON.stringify({ id: 'external-activities', name: '活动机制', version: '1.0.0', services: ['activities'] }),
  )
  const session = await loadHostPlugins([{ id: 'activities', path, enabled: true }])
  sessions.push(session)
  expect(session.skipped).toEqual([])
  const f = await start(session.seams.activities!)
  await f.begin()
  expect(f.state().game.public.external).toBe(true)
})

it('rejects a broken selected implementation without using the default', async () => {
  await expect(
    start({
      id: 'broken',
      version: '1.0.0',
      open: async () => {
        throw new Error('broken')
      },
    }),
  ).rejects.toThrow('活动机制 broken 无法打开')
})

it.each(['owner', 'turn'] as const)('rejects invalid %s proposals before any activity commit', async kind => {
  const f = await start(
    decorated(instance => {
      const entry = instance.entries[0]!,
        initialize = entry.initialize.bind(entry)
      entry.initialize = (input, random) => {
        const game = initialize(input, random) as WorldJsonObject
        if (kind === 'owner') Object.assign(game.private!, { 'character:absent': { secret: true } })
        else Object.assign(game, { turn: 'character:absent' })
        return game
      }
    }),
  )
  const before = f.events()
  await expect(f.begin()).rejects.toThrow(kind === 'owner' ? '私有变量角色无效' : '活动阶段或轮次无效')
  expect(f.events()).toEqual(before)
})

it('attributes computation failures to the selected provider and keeps the prefix unchanged', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = await start(
    decorated(instance => {
      instance.entries[0]!.initialize = () => {
        throw new TypeError('calculation failed')
      }
    }),
  )
  const before = f.events()
  await expect(f.begin()).rejects.toThrow('活动机制 custom-activities（default）')
  expect(f.events()).toEqual(before)
})

it('projects policy per actor and copies mechanism inputs away from cached truth', async () => {
  let policies = 0,
    schedules = 0
  const f = await start(
    decorated(instance => {
      const entry = instance.entries[0]!,
        initialize = entry.initialize.bind(entry),
        policy = entry.policy.bind(entry)
      entry.initialize = (input, random) => {
        const game = initialize(input, random) as WorldJsonObject
        Object.assign(game, { internal: { secret: 'core-only' } })
        Object.assign(game.private!, { 'character:companion': { secret: 'npc-only' } })
        return game
      }
      entry.policy = (scoped, actor) => {
        const game = scoped.game as WorldJsonObject
        expect(game).not.toHaveProperty('internal')
        expect(game.private).toEqual(actor === 'character:companion' ? { secret: 'npc-only' } : {})
        policies++
        const result = policy(scoped, actor)
        Object.assign(game.public!, { tampered: true })
        return result
      }
      entry.schedule = state => {
        expect(state.game.internal).toEqual({ secret: 'core-only' })
        schedules++
        Object.assign(state.game.public, { tampered: true })
        return { kind: 'wait' }
      }
    }),
  )
  await f.begin()
  expect(policies).toBeGreaterThan(0)
  expect(schedules).toBeGreaterThan(0)
  expect(f.state().game.public).not.toHaveProperty('tampered')
  expect(JSON.stringify(await f.runtime.state())).not.toContain('core-only')
  expect(JSON.stringify(await f.runtime.state())).not.toContain('npc-only')
})

it('does not allow selection to hide a committed foreground activity', async () => {
  let hide = false
  const sourcePath = pack(),
    provider = decorated(instance => {
      const select = instance.select.bind(instance)
      instance.select = (progress, latest) =>
        hide && progress.some(entry => entry.active) ? undefined : select(progress, latest)
    })
  const f = await start(provider, sourcePath)
  await f.begin()
  const before = f.events()
  await f.runtime.close()
  hide = true
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  // Reopen the same committed prefix using the same mechanism, now returning an invalid choice.
  await expect(
    WorldHostRuntime.create({
      dataDirectory: f.runtime.dataDirectory,
      packPath: sourcePath,
      models: fakeModels(server.endpoint),
      plugins: { activities: provider },
    }),
  ).rejects.toThrow('活动选择必须保持已提交的前台活动')
  expect(f.events()).toEqual(before)
})

it('revokes random draws after initialization and records them for candidates', async () => {
  let draw: (() => number) | undefined
  const instances: { closed: boolean }[] = [],
    identity = { mode: 1 }
  const f = await start({
    id: 'isolated-activities',
    version: '1.0.0',
    identity,
    open: async world => {
      const tracked = { closed: false }
      instances.push(tracked)
      const instance = new ActivitiesScripts(world.activitySource),
        entry = instance.entries[0]!,
        initialize = entry.initialize.bind(entry)
      entry.initialize = (input, random) => {
        draw = random
        return initialize(input, random)
      }
      return Object.assign(instance, {
        close: () => {
          tracked.closed = true
        },
      })
    },
  })
  const first = await f.begin(),
    answer = f.state().game.internal.answer,
    before = instances.length
  expect(draw).toBeDefined()
  expect(() => draw!()).toThrow('random capability has ended')
  await f.runtime.regenerate(first.tailRound!.id!, 'activities-candidate')
  expect(instances.length).toBeGreaterThan(before)
  expect(f.state().game.internal.answer).toBe(answer)
  identity.mode = 2
  await expect(f.runtime.regenerate((await f.runtime.state()).tailRound!.id!, 'changed-activities')).rejects.toThrow(
    '环境已改变',
  )
  await f.runtime.close()
  expect(instances.every(instance => instance.closed)).toBe(true)
})

it('refuses activities not declared in the world assets', async () => {
  await expect(
    start(
      decorated(instance => {
        Object.defineProperty(instance.entries[0]!, 'key', { value: 'foreign' })
      }),
    ),
  ).rejects.toThrow('未知或重复活动标识')
  const source = {
    entries: [
      {
        key: 'foreign',
        entry: 'unused',
        source: readFileSync(resolve('examples/world-packs/launcher-demo/scripts/activity.js'), 'utf8'),
      },
    ],
  }
  await expect(
    start({ id: 'undeclared', version: '1.0.0', open: async () => new ActivitiesScripts(source) }, pack(false)),
  ).rejects.toThrow('必须匹配世界声明')
})

it('refuses an ineligible automatic-start choice and revokes its random callback', async () => {
  let draw: (() => number) | undefined
  const f = await start(
    decorated(instance => {
      const entry = instance.entries[0]!
      Object.defineProperty(entry, 'hasAutoStart', { value: true })
      entry.autoStart = () => ({ when: [true] })
      instance.chooseAutoStart = (candidates, random) => {
        expect(candidates).toEqual([{ key: 'default', conditions: 1 }])
        draw = random
        return 'foreign'
      }
    }),
  )
  const result = await f.runtime.submit('继续。')
  expect(result.debug.autoStartError).toContain('条件未满足')
  expect(f.events().filter(event => event.eventType === 'activity.updated')).toEqual([])
  expect(() => draw!()).toThrow('random capability has ended')
})

it('rejects activation outside participants without undoing the committed start', async () => {
  const f = await start(
    decorated(instance => {
      instance.entries[0]!.schedule = () => ({ kind: 'activate', characterId: 'character:friend' })
    }),
  )
  await expect(f.begin()).rejects.toThrow('调度请求了未授权角色')
  expect(f.state().game.active).toBe(true)
  expect(f.state().participants).not.toContain('character:friend')
})
