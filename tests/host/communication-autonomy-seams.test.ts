import { AutonomyRuntime } from '../../desktop/host/autonomy-runtime.ts'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CommunicationPolicy } from '@harness-world/official-communication'
import { AutonomyPolicy } from '@harness-world/official-scheduler'
import type { AutonomySource, AutonomyInstance, CommunicationInstance, SeamProvider } from '@harness-world/plugin-sdk'
import type { WorldJsonObject } from '@harness-world/contracts'
import { currentLocation, type RulebookResolver, type CompiledWorldManifest } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { HostSeams } from '../../desktop/official-bundle.ts'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  runtimes: WorldHostRuntime[] = [],
  sessions: HostPlugins[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const session of sessions.splice(0)) await session.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'm5-seams-'))
  roots.push(root)
  return root
}
function pack(enabled = true) {
  const path = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/character-autonomy'), path, { recursive: true })
  const file = join(path, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (enabled) {
    manifest.assetFiles.push('communication.json')
    writeFileSync(
      join(path, 'communication.json'),
      JSON.stringify({
        medium: '短信',
        contacts: { 'character:player': ['character:friend'], 'character:friend': ['character:player'] },
      }),
    )
  } else manifest.assetFiles = manifest.assetFiles.filter((name: string) => name !== 'autonomy.json')
  writeFileSync(file, JSON.stringify(manifest))
  return path
}
async function start(plugins: Partial<HostSeams> = {}, packPath = pack()) {
  const requests: WorldJsonObject[] = []
  const server = await startFakeProvider('openai', input => {
    requests.push(JSON.parse(input.userText) as WorldJsonObject)
    return { tool: { decision: 'abstain' } }
  })
  servers.push(server)
  const runtime = await WorldHostRuntime.create({
    packPath,
    dataDirectory: fresh(),
    plugins,
    models: fakeModels(server.endpoint),
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
  return {
    runtime,
    events,
    requests,
    message: () =>
      runtime.submit('/message ' + JSON.stringify({ recipientId: 'character:friend', text: '门外的传闻' })),
  }
}
function communication(change: (instance: CommunicationPolicy) => void): SeamProvider<CommunicationInstance> {
  return {
    id: 'custom-communication',
    version: '1.0.0',
    open: async world => {
      const instance = new CommunicationPolicy(world.communicationSource)
      change(instance)
      return instance
    },
  }
}
function autonomy(change: (instance: AutonomyPolicy) => void): SeamProvider<AutonomyInstance> {
  return {
    id: 'custom-autonomy',
    version: '1.0.0',
    open: async world => {
      const instance = world.autonomySource
        ? AutonomyPolicy.parse(world.autonomySource.config, world.autonomySource, world.cast.playerId)
        : new AutonomyPolicy([])
      change(instance)
      return instance
    },
  }
}

it('loads actual Cordis communication and autonomy replacements, preserving sender and recipient authority', async () => {
  const path = join(fresh(), 'mechanisms.mjs')
  writeFileSync(
    path,
    `export const hostApi='2.8';export default ctx=>{
    const parameters=(id,text)=>({targetRef:{kind:'character',id},bindingId:'experiment:message',definitionRef:{id:'experiment:message',version:1},arguments:{text}});
    ctx.effect(()=>ctx.communication.register({id:'external-communication',version:'1.0.0',open:async world=>({definition:world.communicationSource?.config,instruction:'外部短信规则',parameters,
      options:input=>input.recipientIds.map(id=>({...parameters(id,''),medium:'短信',argumentSchema:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',minLength:1,maxLength:input.publicationCharacters}}}})),
      prepare:input=>({text:input.text+'（外部机制）',description:'发送者的陈述'}),describeDelivery:()=> '已投递'})}));
    ctx.effect(()=>ctx.autonomy.register({id:'external-autonomy',version:'1.0.0',open:async world=>{
      const roles=world.autonomySource?.config.characters??[];
      return {roles,instruction:'外部自主指引',due:input=>input.actions.some(action=>action.seq>input.afterSeq)?roles.map(role=>role.characterId):[],permits:()=>true};
    }}));
  }`,
  )
  writeFileSync(
    path.replace('.mjs', '.plugin.json'),
    JSON.stringify({
      id: 'external-mechanisms',
      name: '通信与自主',
      version: '1.0.0',
      services: ['communication', 'autonomy'],
    }),
  )
  const session = await loadHostPlugins([{ id: 'external-mechanisms', path, enabled: true }])
  sessions.push(session)
  expect(session.skipped).toEqual([])
  const f = await start(session.seams)
  await f.message()
  const speech = f
    .events()
    .filter(event => event.eventType === 'character.speak')
    .find(event => (event.data as WorldJsonObject).medium === '短信')!
  expect(speech.data).toMatchObject({
    characterId: 'character:player',
    addresseeIds: ['character:friend'],
    text: '门外的传闻（外部机制）',
    scope: 'direct',
  })
  const receivers = f
    .events()
    .filter(
      event =>
        event.eventType === 'observation.upsert' && JSON.stringify(event.data).includes('门外的传闻（外部机制）'),
    )
    .map(event => ((event.data as WorldJsonObject).value as WorldJsonObject).observerId)
  expect(new Set(receivers)).toEqual(new Set(['character:friend', 'character:player']))
  expect(currentLocation(f.events(), 'character:friend')).toBe('location:back-room')
  expect(
    f.requests.some(
      request => ((request.context as WorldJsonObject)?.autonomy as WorldJsonObject)?.instruction === '外部自主指引',
    ),
  ).toBe(true)
})

it.each(['communication', 'autonomy'] as const)(
  'does not fall back after a selected %s provider fails to open',
  async seam => {
    const broken = {
      id: 'broken-' + seam,
      version: '1.0.0',
      open: async () => {
        throw new Error('broken')
      },
    }
    await expect(start({ [seam]: broken })).rejects.toThrow('broken-' + seam + ' 无法打开')
  },
)

it.each(['recipientId', 'characterId', 'events'] as const)(
  'rejects forged %s fields in a delivery proposal before committing',
  async field => {
    const f = await start({
      communication: communication(instance => {
        instance.prepare = input => ({
          text: input.text,
          description: 'candidate',
          [field]: field === 'events' ? [] : 'character:companion',
        })
      }),
    })
    const before = f.events()
    await expect(f.message()).rejects.toThrow('无效投递候选')
    expect(f.events()).toEqual(before)
  },
)

it('computes messages from a narrow copy and attributes failures without partial delivery', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let received = false
  const f = await start({
    communication: communication(instance => {
      instance.prepare = input => {
        expect(Object.keys(input).sort()).toEqual(['actorId', 'publicationCharacters', 'recipientId', 'text'])
        received = true
        throw new TypeError('calculation failed')
      }
    }),
  })
  const before = f.events()
  await expect(f.message()).rejects.toThrow('机制 custom-communication')
  expect(received).toBe(true)
  expect(f.events()).toEqual(before)
})

it('rejects unauthorized contact options during initial projection', async () => {
  const directory = fresh()
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  await expect(
    WorldHostRuntime.create({
      dataDirectory: directory,
      packPath: pack(),
      models: fakeModels(server.endpoint),
      plugins: {
        communication: communication(instance => {
          const options = instance.options.bind(instance)
          instance.options = input => options({ ...input, recipientIds: ['character:companion'] })
        }),
      },
    }),
  ).rejects.toThrow('未授权联系人')
})

it('lets the autonomy mechanism veto advertised actions while keeping declared scope caps', async () => {
  let checked = 0
  const f = await start({
    autonomy: autonomy(instance => {
      instance.permits = input => {
        checked++
        expect(Object.keys(input).sort()).toEqual(['actionType', 'characterId', 'locationId', 'parameters'])
        return input.actionType === 'speak'
      }
    }),
  })
  await f.runtime.submit('继续。')
  const request = f.requests.find(request => !!(request.context as WorldJsonObject)?.autonomy)!
  expect(request).toBeDefined()
  expect(checked).toBeGreaterThan(0)
  const actions = (request.context as WorldJsonObject).affordances as WorldJsonObject[]
  expect(actions.some(action => action.actionType === 'move')).toBe(false)
})

it('rejects unknown due actors and preserves the already committed player action', async () => {
  const f = await start({
    autonomy: autonomy(instance => {
      instance.due = () => ['character:player']
    }),
  })
  await expect(f.runtime.submit('这是本轮事实。')).rejects.toThrow('自主机制选择了未声明角色')
  expect(
    f
      .events()
      .some(
        event => event.eventType === 'character.speak' && (event.data as WorldJsonObject).text === '这是本轮事实。',
      ),
  ).toBe(true)
  expect(f.requests.some(request => !!(request.context as WorldJsonObject)?.autonomy)).toBe(false)
})

it.each(['player', 'location', 'opportunities'] as const)(
  'rejects invalid autonomy %s metadata before genesis',
  async kind => {
    const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
    servers.push(server)
    const directory = fresh()
    await expect(
      WorldHostRuntime.create({
        packPath: pack(),
        dataDirectory: directory,
        models: fakeModels(server.endpoint),
        plugins: {
          autonomy: autonomy(instance => {
            Object.assign(
              instance.roles[0]!,
              kind === 'player'
                ? { characterId: 'character:player' }
                : kind === 'location'
                  ? { locationIds: ['missing'] }
                  : { opportunities: 101 },
            )
          }),
        },
      }),
    ).rejects.toThrow('自主机制返回了未授权角色、地点、目标或无效机会')
  },
)

it.each(['communication', 'autonomy'] as const)(
  'opens and closes independent %s candidates and checks public identity',
  async seam => {
    const tracked: { closed: boolean }[] = [],
      identity = { mode: 1 }
    const decorate = (instance: CommunicationPolicy | AutonomyPolicy) => {
      const item = { closed: false }
      tracked.push(item)
      Object.assign(instance, {
        close: () => {
          item.closed = true
        },
      })
    }
    const provider = seam === 'communication' ? communication(decorate) : autonomy(decorate)
    const f = await start({ [seam]: { ...provider, identity } })
    const first = await f.runtime.submit('继续。'),
      before = tracked.length
    await f.runtime.regenerate(first.tailRound!.id!, 'm5-candidate')
    expect(tracked.length).toBeGreaterThan(before)
    identity.mode = 2
    await expect(f.runtime.regenerate((await f.runtime.state()).tailRound!.id!, 'changed-m5')).rejects.toThrow(
      '环境已改变',
    )
    await f.runtime.close()
    expect(tracked.every(item => item.closed)).toBe(true)
  },
)

it('does not install undeclared communication or autonomous state', async () => {
  await expect(
    start(
      {
        communication: communication(instance => {
          Object.defineProperty(instance, 'definition', { value: { medium: '短信', contacts: {} } })
        }),
      },
      pack(false),
    ),
  ).rejects.toThrow('通信机制必须匹配声明的配置')
  await expect(
    start(
      {
        autonomy: autonomy(instance => {
          Object.defineProperty(instance, 'roles', { value: [{}] })
        }),
      },
      pack(false),
    ),
  ).rejects.toThrow('自主机制需要合法声明')
})

it('binds manual parameters to the requested recipient even when another contact is authorized', async () => {
  const source = pack(),
    file = join(source, 'communication.json'),
    config = JSON.parse(readFileSync(file, 'utf8'))
  config.contacts['character:player'].push('character:companion')
  writeFileSync(file, JSON.stringify(config))
  const f = await start(
    {
      communication: communication(instance => {
        const parameters = instance.parameters.bind(instance)
        const canonical = new CommunicationPolicy({ config })
        instance.options = canonical.options.bind(canonical)
        instance.parameters = (_id, text) => parameters('character:companion', text)
      }),
    },
    source,
  )
  const before = f.events()
  await expect(f.message()).rejects.toThrow('消息参数必须绑定请求的收件人与正文')
  expect(f.events()).toEqual(before)
})

it('enforces autonomous locations and effect bounds even when a native permission hook approves everything', async () => {
  const sourcePath = pack(),
    file = join(sourcePath, 'autonomy.json'),
    config = JSON.parse(readFileSync(file, 'utf8'))
  Object.assign(config.characters[0], {
    locationIds: ['location:back-room'],
    interactions: ['status:take'],
    targetIds: ['entity:brass-key'],
  })
  writeFileSync(file, JSON.stringify(config))
  let mechanism!: AutonomyPolicy, source!: AutonomySource
  const f = await start(
    {
      autonomy: {
        id: 'approve-all',
        version: '1.0.0',
        open: async world => {
          source = world.autonomySource!
          mechanism = AutonomyPolicy.parse(source.config, source, world.cast.playerId)
          mechanism.permits = () => true
          return mechanism
        },
      },
    },
    sourcePath,
  )
  const store = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
  try {
    const events = store.readEvents(f.runtime.address),
      manifest = store.readManifest(f.runtime.address)!.manifest as CompiledWorldManifest
    const base: RulebookResolver = {
      affordances: () => [],
      resolve: () => ({
        status: 'accepted',
        events: [
          {
            eventType: 'character.moved',
            eventVersion: 1,
            data: {
              characterId: 'character:friend',
              fromLocationId: 'location:back-room',
              toLocationId: 'location:front-room',
            },
          },
        ],
      }),
    }
    const rules = new AutonomyRuntime(mechanism, source, 'character:player')
      .rulebooks(base)
      .resolve('builtin:speak-move', 2, 'test', f.runtime.address)
    expect(
      rules.resolve({
        manifest,
        events,
        characterId: 'character:friend',
        action: { actionType: 'move', parameters: { locationId: 'location:front-room' } },
      }),
    ).toMatchObject({ status: 'rejected', events: [] })
    expect(
      rules.resolve({
        manifest,
        events,
        characterId: 'character:friend',
        action: {
          actionType: 'interact',
          parameters: { definitionRef: { id: 'status:take' }, targetRef: { kind: 'entity', id: 'entity:brass-key' } },
        },
      }),
    ).toMatchObject({ status: 'rejected', reason: '本次自主交互的结果超出允许范围', events: [] })
  } finally {
    store.close()
  }
})
