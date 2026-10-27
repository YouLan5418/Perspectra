import { Context } from '@deepseek-ai/cordis'
import { type Server } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { PackStatus } from '../../desktop/host/pack-status.ts'
import { PackModules } from '../../desktop/host/pack-modules.ts'
import {
  HostCapabilities,
  MissingCapabilityError,
  type CapabilityProvider,
  type CapabilityWorld,
} from '../../desktop/host-capabilities.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const PLAYER = 'character:player',
  ALLY = 'character:companion',
  OTHER = 'character:friend'
const roots: string[] = [],
  runtimes: WorldHostRuntime[] = [],
  contexts: Context[] = [],
  servers: Server[] = []
const obj = (value: unknown) => value as WorldJsonObject
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

function files(modify?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'dual-plugins-'))
  roots.push(root)
  const packPath = join(root, 'pack'),
    dataDirectory = join(root, 'data')
  cpSync(resolve('examples/world-packs/plugin-capabilities-demo'), packPath, { recursive: true })
  modify?.(packPath)
  return { packPath, dataDirectory }
}

async function fixture(options: { provider?: CapabilityProvider; modify?: (path: string) => void } = {}) {
  const paths = files(options.modify),
    root = new Context()
  contexts.push(root)
  const catalog = new HostCapabilities(root)
  let scopedWorld: CapabilityWorld | undefined
  if (options.provider) {
    const provider = options.provider
    root.effect(() =>
      catalog.register({
        ...provider,
        open: async (world, config) => {
          scopedWorld = world
          return provider.open(world, config)
        },
      }),
    )
  } else {
    const plugin = await import(pathToFileURL(resolve('examples/host-plugins/demo-device.mjs')).href)
    await root.plugin(plugin.default)
  }
  const compiled = await compileWorldPackSource(
    paths.packPath,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )
  const modules = PackModules.load(paths.packPath, compiled, catalog)!
  const status = PackStatus.fromSource(modules.statusSource(), compiled)
  const requests: WorldJsonObject[] = []
  let mode: 'perform' | 'abstain' = 'abstain'
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const messages = JSON.parse(body).messages as { role: string; content: string }[]
      const input = JSON.parse(messages.findLast(m => m.role === 'user')!.content) as WorldJsonObject
      requests.push(input)
      const actor = obj(obj(input.context).character).characterId
      const decision = input.continuation
        ? { decision: 'publish', segments: [{ type: 'speech', text: '我按刚收到的结果继续。' }] }
        : actor === ALLY && mode === 'perform'
          ? {
              decision: 'perform',
              actionType: 'interact',
              parameters: {
                targetRef: { kind: 'character', id: ALLY },
                bindingId: 'status',
                definitionRef: { id: 'status:greetings-confirm', version: 1 },
                arguments: {},
              },
            }
          : { decision: 'abstain' }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(decision) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({
    ...paths,
    capabilities: catalog,
    models: fakeModels(
      'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/chat',
      'openai',
      'fixture',
    ),
    timeoutMs: 5000,
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
  const view = async () => projectPlayerView(await runtime.state())
  const action = async (label: string) => {
    const option = (await view()).actions.find(a => a.label === label)
    expect(option, label).toBeDefined()
    return option!.action
  }
  const device = options.provider
    ? undefined
    : (root.get('demoDevice') as {
        worlds(): string[]
        requestCharacter(worldVersion: string, characterId: string): Promise<WorldJsonObject>
      })
  const ask = (characterId: string) =>
    device ? device.requestCharacter(device.worlds()[0]!, characterId) : scopedWorld!.requestCharacter(characterId)
  return {
    ...paths,
    runtime,
    events,
    view,
    action,
    catalog,
    requests,
    ask,
    act: async (label: string) => runtime.perform(await action(label)),
    truth: () => status.truth(events()),
    setMode(value: typeof mode) {
      mode = value
    },
  }
}

it('composes a pack module with a real Cordis provider and reuses the authorized character turn', async () => {
  const f = await fixture()
  expect(f.catalog.list()).toEqual([expect.objectContaining({ id: 'demo-device', version: '0.1.0' })])
  await f.act('请求设备确认')
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(1)
  expect(f.truth().characters[ALLY]!['greetings-count']).toBe(0)
  f.setMode('perform')
  const reply = await f.ask(ALLY)
  expect(reply).toMatchObject({
    status: 'published',
    calls: 2,
    expressions: [expect.objectContaining({ speakerId: ALLY, text: '我按刚收到的结果继续。' })],
  })
  expect(Object.keys(reply).sort()).toEqual(['calls', 'expressions', 'status'])
  expect(f.truth().characters[ALLY]!['greetings-count']).toBe(1)
  expect(f.truth().characters[OTHER]!['greetings-count']).toBe(0)
  const request = f.requests.find(r => !r.continuation && obj(obj(r.context).character).characterId === ALLY)!
  const known = obj(request.context).knownStatus as WorldJsonObject[]
  expect(known.some(entry => entry.holderId === PLAYER && entry.key === 'greetings-count')).toBe(false)
  expect(known.some(entry => entry.holderId === OTHER && entry.key === 'greetings-count')).toBe(false)
  const update = f.events().findLast(e => e.eventType === 'status.updated' && obj(obj(e.data).source).actorId === ALLY)!
  expect(
    f
      .events()
      .some(
        e =>
          e.eventType === 'action.resolved' &&
          e.transactionId === update.transactionId &&
          obj(e.data).accepted === true,
      ),
  ).toBe(true)
  await expect(f.ask(OTHER)).rejects.toThrow('not bound')
  await expect(f.ask(PLAYER)).rejects.toThrow('not bound')
}, 60_000)

it('records a queued acknowledgement without applying the module completion effects', async () => {
  const f = await fixture()
  await f.act('排队请求设备')
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(0)
  expect(
    f.events().some(e => e.eventType === 'status.updated' && String(obj(e.data).description).includes('尚未确认执行')),
  ).toBe(true)
  await f.act('请求设备确认')
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(1)
  expect((await f.runtime.state()).tailRound!.canRegenerate).toBe(false)
  await expect(f.runtime.regenerate('external-no-tail', 'no-external-replay')).rejects.toThrow('不支持')
}, 60_000)

it('filters module actions by policy and rechecks stale options without executing them', async () => {
  let calls = 0
  const f = await fixture({
      provider: provider(async (_method, _args, actorId) => {
        calls++
        return { completion: 'completed', data: { confirmed: true, actorId } }
      }),
    }),
    old = await f.action('请求设备确认')
  await f.act('切换设备可用状态')
  expect((await f.view()).actions.some(a => a.label === '请求设备确认')).toBe(false)
  const head = f.events().length
  await expect(f.runtime.perform(old)).rejects.toThrow()
  expect(f.events()).toHaveLength(head)
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(0)
  expect(calls).toBe(0)
}, 60_000)

it('fails missing required capabilities before world creation and supports a pure pack module', async () => {
  const missing = files()
  const failure = await WorldHostRuntime.create({
    ...missing,
    models: fakeModels('http://127.0.0.1:1/api/chat', 'openai', 'unused'),
  }).catch((error: unknown) => error)
  // The launcher names this capability to the player, so the error must carry it.
  expect(failure).toBeInstanceOf(MissingCapabilityError)
  expect((failure as MissingCapabilityError).capability).toBe('demo-device@0.1.0')
  expect(existsSync(join(missing.dataDirectory, 'world.sqlite'))).toBe(false)
  const f = await fixture({
    modify(path) {
      const file = join(path, 'plugins.json'),
        declaration = JSON.parse(readFileSync(file, 'utf8'))
      declaration.modules[0].capabilities = []
      writeFileSync(file, JSON.stringify(declaration))
      const script = join(path, 'plugins/greetings.js')
      writeFileSync(
        script,
        readFileSync(script, 'utf8')
          .replace("capability: 'demo-device', method: 'confirm'", '')
          .replace("capability: 'demo-device', method: 'queue'", ''),
      )
    },
  })
  await f.act('切换设备可用状态')
  expect(f.truth().public['greetings-enabled']).toBe(false)
}, 60_000)

function sharedCapabilityModules(path: string, conflicting = false) {
  const file = join(path, 'plugins.json'),
    declaration = JSON.parse(readFileSync(file, 'utf8'))
  const first = declaration.modules[0]
  first.capabilities[0].config = { channel: 'greetings', options: { primary: 1, fallback: 2 } }
  declaration.modules.push({
    id: 'second',
    entry: 'plugins/second.js',
    characters: first.characters,
    capabilities: [
      {
        config: { options: { fallback: conflicting ? 3 : 2, primary: 1 }, channel: 'greetings' },
        required: true,
        version: '0.1.0',
        id: 'demo-device',
      },
    ],
  })
  writeFileSync(file, JSON.stringify(declaration))
  writeFileSync(
    join(path, 'plugins/second.js'),
    readFileSync(join(path, 'plugins/greetings.js'), 'utf8')
      .replaceAll('greetings-', 'second-')
      .replace('请求设备确认', '请求第二模块确认'),
  )
  const manifestPath = join(path, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.assetFiles.push('plugins/second.js')
  writeFileSync(manifestPath, JSON.stringify(manifest))
}

it('shares a capability across modules regardless of declaration and nested config key order', async () => {
  const f = await fixture({ modify: path => sharedCapabilityModules(path) })
  await f.act('请求设备确认')
  await f.act('请求第二模块确认')
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(1)
  expect(f.truth().characters[PLAYER]!['second-count']).toBe(1)
}, 60_000)

it('still rejects genuinely conflicting shared capability config', async () => {
  await expect(fixture({ modify: path => sharedCapabilityModules(path, true) })).rejects.toThrow(
    'Conflicting module capability requirement',
  )
})

it('keeps optional missing capabilities out of options while allowing local game rules', async () => {
  const f = await fixture({
    modify(path) {
      const file = join(path, 'plugins.json'),
        declaration = JSON.parse(readFileSync(file, 'utf8'))
      declaration.modules[0].capabilities[0].id = 'optional-device'
      declaration.modules[0].capabilities[0].required = false
      writeFileSync(file, JSON.stringify(declaration))
      const script = join(path, 'plugins/greetings.js')
      writeFileSync(
        script,
        readFileSync(script, 'utf8').replaceAll("capability: 'demo-device'", "capability: 'optional-device'"),
      )
    },
  })
  expect((await f.view()).actions.some(a => a.label === '请求设备确认')).toBe(false)
  await f.act('切换设备可用状态')
  expect(f.truth().public['greetings-enabled']).toBe(false)
}, 60_000)

const empty = { type: 'object', additionalProperties: false, properties: {} }
function provider(invoke: Awaited<ReturnType<CapabilityProvider['open']>>['invoke']): CapabilityProvider {
  return {
    id: 'demo-device',
    version: '0.1.0',
    methods: {
      confirm: {
        arguments: {
          type: 'object',
          additionalProperties: false,
          required: ['message'],
          properties: { message: { type: 'string' } },
        },
        result: { type: 'object', additionalProperties: true },
        effect: 'external',
      },
      queue: { arguments: empty, result: empty, effect: 'external' },
    },
    open: async () => ({ invoke, close: async () => {} }),
  }
}

it('rolls back invalid completion effects and prevents repeating an external effect after a local failure', async () => {
  let calls = 0
  const f = await fixture({
    provider: provider(async (_method, _args, actorId) => {
      calls++
      return { completion: 'completed', data: { confirmed: true, actorId } }
    }),
    modify(path) {
      const script = join(path, 'plugins/greetings.js')
      writeFileSync(
        script,
        readFileSync(script, 'utf8').replace("truth.characters[actorId]['greetings-count'] + 1", "'invalid-count'"),
      )
    },
  })
  const action = await f.action('请求设备确认'),
    head = f.events().length
  await expect(f.runtime.perform(action)).rejects.toThrow()
  expect(f.events()).toHaveLength(head)
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(0)
  await expect(f.runtime.perform(action)).rejects.toThrow('外部执行结果尚未确认')
  expect(calls).toBe(1)
}, 60_000)

it('cancels an in-flight external request on pause and discards a late completion', async () => {
  let entered!: () => void, release!: (value: { completion: 'completed'; data: WorldJsonObject }) => void
  const started = new Promise<void>(done => {
    entered = done
  })
  const f = await fixture({
    provider: provider(async () => {
      entered()
      return new Promise(done => {
        release = done
      })
    }),
  })
  const head = f.events().length
  const request = expect(f.act('请求设备确认')).rejects.toThrow('EXTERNAL_RESULT_UNKNOWN')
  await started
  await f.runtime.pause()
  await request
  release({ completion: 'completed', data: { confirmed: true, actorId: PLAYER } })
  expect(f.events()).toHaveLength(head)
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(0)
}, 60_000)

it('uses activity policy and the same commit boundary for asynchronous module operations', async () => {
  let calls = 0
  const f = await fixture({
    provider: provider(async (_method, _args, actorId) => {
      calls++
      return { completion: 'completed', data: { confirmed: calls === 1, actorId } }
    }),
    modify(path) {
      mkdirSync(join(path, 'scripts/activities'), { recursive: true })
      writeFileSync(
        join(path, 'scripts/activities/device.js'),
        readFileSync('tests/fixtures/status-duel.js', 'utf8').replace(
          'status:drink-potion',
          'status:greetings-confirm',
        ),
      )
      const manifestPath = join(path, 'worldpack.source.json'),
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.assetFiles.push('scripts/activities/device.js')
      writeFileSync(manifestPath, JSON.stringify(manifest))
    },
  })
  await f.runtime.activityAction({
    activityKey: 'device',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'start-device',
  })
  expect((await f.view()).actions.some(a => a.label === '排队请求设备')).toBe(false)
  await f.act('请求设备确认')
  expect(f.truth().characters[PLAYER]!['greetings-count']).toBe(1)
  const head = f.events().length
  await expect(f.act('请求设备确认')).rejects.toThrow('设备没有确认')
  expect(f.events()).toHaveLength(head)
  await expect(f.act('请求设备确认')).rejects.toThrow('外部执行结果尚未确认')
  expect(calls).toBe(2)
}, 60_000)

it('loads the shipped RPG Maker pack adapter and commits only the actor-scoped observed status', async () => {
  const f = await fixture({
    provider: {
      id: 'rpg-maker',
      version: '0.1.0',
      methods: {
        observe: { arguments: empty, result: { type: 'object' }, effect: 'read' },
        'queue-common-event': { arguments: { type: 'object' }, result: { type: 'object' }, effect: 'external' },
      },
      open: async () => ({
        invoke: async () => ({
          completion: 'completed',
          data: { engine: 'RPG Maker MZ', mapId: 7, actor: { id: 1, hp: 34 } },
        }),
        close: async () => {},
      }),
    },
    modify(path) {
      cpSync('examples/rpg-maker/pack-module.js', join(path, 'plugins/rpg-maker.js'))
      cpSync('examples/rpg-maker/plugins.example.json', join(path, 'plugins.json'))
      const manifestPath = join(path, 'worldpack.source.json'),
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.assetFiles = ['plugins.json', 'plugins/rpg-maker.js']
      writeFileSync(manifestPath, JSON.stringify(manifest))
    },
  })
  await f.act('查看外部游戏')
  expect(f.truth().characters[PLAYER]!['rm-view']).toMatchObject({ mapId: 7 })
  expect(f.truth().characters[ALLY]!['rm-view']).toEqual({})
  expect((await f.view()).scene!.locationId).not.toBe('7')
}, 60_000)
