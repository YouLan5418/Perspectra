import { Context } from '@deepseek-ai/cordis'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, Script } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { HostCapabilities } from '../../desktop/host-capabilities.ts'

interface Bridge {
  port: number
  connected: boolean
  observe(actorId: number): Promise<unknown>
  queueCommonEvent(actorId: number, eventId: number): Promise<unknown>
  close(): Promise<void>
}
interface EnginePlugin {
  status: string
  connect(): Promise<void>
  disconnect(): void
  requestCharacter(actorId: number): Promise<unknown>
}
const roots: Context[] = [],
  bridges: Bridge[] = [],
  engines: EnginePlugin[] = [],
  sockets: Socket[] = []
const token = 'a'.repeat(64)
const moduleUrl = (path: string) => pathToFileURL(resolve(path)).href
const createBridge = (await import(moduleUrl('examples/host-plugins/rpg-maker/transport.mjs')))
  .createRpgMakerBridge as (options: { token: string; port?: number; timeoutMs?: number }) => Promise<Bridge>
const plugin = (await import(moduleUrl('examples/host-plugins/rpg-maker-bridge.mjs'))).default
const nodeRequire = createRequire(import.meta.url)

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.disconnect()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  for (const bridge of bridges.splice(0)) await bridge.close()
  vi.unstubAllEnvs()
})

async function cordis() {
  vi.stubEnv('PERSPECTRA_RPG_MAKER_TOKEN', token)
  vi.stubEnv('PERSPECTRA_RPG_MAKER_PORT', '0')
  const ctx = new Context()
  roots.push(ctx)
  const capabilities = new HostCapabilities(ctx)
  const owner = ctx.plugin(plugin)
  await owner
  return { ctx, owner, capabilities, bridge: ctx.get('rpgMaker') as Bridge }
}

function engine(bridge: Bridge, secret = token) {
  let inBattle = true,
    running = false,
    reserved = 0
  const commands = new Map<string, () => void>()
  // These are small interface doubles, not RPG Maker engine code or proof of engine compatibility.
  const world = createContext({
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    require: (name: string) => {
      if (name !== 'net') throw new Error('Unexpected module')
      return nodeRequire(name)
    },
    process: { env: { PERSPECTRA_RPG_MAKER_TOKEN: secret, PERSPECTRA_RPG_MAKER_PORT: String(bridge.port) } },
    PluginManager: {
      parameters: () => ({ CommonEvents: '["2"]' }),
      registerCommand: (_name: string, command: string, handler: () => void) => commands.set(command, handler),
    },
    $gameParty: {
      members: () => [
        { actorId: () => 1, name: () => '冒险者', hp: 34, mp: 7 },
        { actorId: () => 2, name: () => '澄', hp: 12, mp: 5 },
      ],
      inBattle: () => inBattle,
    },
    $gameMap: { mapId: () => 7, isEventRunning: () => running },
    $gameTroop: {
      members: () => [
        { name: () => '守卫', isAppeared: () => true, isAlive: () => true, hp: 'PRIVATE_ENEMY_HP' },
        { name: () => 'HIDDEN_BOSS', isAppeared: () => false, isAlive: () => true },
      ],
    },
    $gameVariables: {
      value: () => {
        throw new Error('Private variables must not be read')
      },
    },
    $dataCommonEvents: [null, { name: 'PRIVATE_EVENT' }, { name: '同伴招呼' }],
    $gameTemp: {
      isCommonEventReserved: () => reserved !== 0,
      reserveCommonEvent: (id: number) => {
        reserved = id
      },
    },
  })
  new Script(readFileSync(resolve('examples/rpg-maker/PerspectraBridge.js'), 'utf8')).runInContext(world)
  const client = world.PerspectraBridge as EnginePlugin
  engines.push(client)
  return {
    client,
    commands,
    reserved: () => reserved,
    map: () => {
      inBattle = false
    },
    busy: () => {
      running = true
    },
  }
}

it('connects the real Cordis and MZ bridge scripts over loopback and exposes only an actor-scoped view', async () => {
  const { bridge } = await cordis(),
    rm = engine(bridge)
  expect(rm.commands.has('connect')).toBe(true)
  await rm.client.connect()
  expect(bridge.connected).toBe(true)
  expect(rm.client.status).toBe('ready')
  expect(await bridge.observe(2)).toEqual({
    engine: 'RPG Maker MZ',
    actor: { id: 2, name: '澄', hp: 12, mp: 5 },
    mapId: 7,
    battle: true,
    opponents: [{ index: 0, name: '守卫', alive: true }],
    commonEvents: [{ id: 2, name: '同伴招呼' }],
  })
  await expect(bridge.observe(3)).rejects.toThrow('ACTOR_NOT_IN_PARTY')
  await expect(bridge.queueCommonEvent(2, 2)).rejects.toThrow('GAME_BUSY')
  expect(rm.reserved()).toBe(0)
  rm.map()
  await expect(bridge.queueCommonEvent(2, 1)).rejects.toThrow('EVENT_NOT_ALLOWED')
  expect(await bridge.queueCommonEvent(2, 2)).toEqual({ queued: true, eventId: 2 })
  expect(rm.reserved()).toBe(2)
  await expect(bridge.queueCommonEvent(2, 2)).rejects.toThrow('GAME_BUSY')
})

it('rejects a wrong session token without exposing a connected game', async () => {
  const { bridge } = await cordis(),
    bad = engine(bridge, 'b'.repeat(64))
  await expect(bad.client.connect()).rejects.toThrow('BRIDGE_DISCONNECTED')
  expect(bridge.connected).toBe(false)
  const good = engine(bridge)
  await good.client.connect()
  expect(await bridge.observe(1)).toEqual(expect.objectContaining({ actor: { id: 1, name: '冒险者', hp: 34, mp: 7 } }))
})

it('binds native capabilities to a world and routes MZ requests through the scoped character callback', async () => {
  const { bridge, capabilities } = await cordis(),
    rm = engine(bridge)
  await rm.client.connect()
  const requested: string[] = []
  const session = await capabilities.attach(
    {
      address: {
        tenantId: brandId('tenant:test', 'TenantId'),
        worldId: brandId('world:bridge', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      worldVersion: 'fixture',
      requestCharacter: async characterId => {
        requested.push(characterId)
        return { status: 'completed', expressions: [] }
      },
    },
    [
      {
        id: 'rpg-maker',
        version: '0.1.0',
        required: true,
        config: { actors: { 'character:companion': 2 } },
        characters: ['character:companion'],
      },
    ],
  )
  try {
    expect(await session.invoke('rpg-maker', 'observe', {}, 'character:companion')).toMatchObject({
      completion: 'completed',
      data: { actor: { id: 2 } },
    })
    await expect(session.invoke('rpg-maker', 'observe', {}, 'character:stranger')).rejects.toThrow('not bound')
    expect(await rm.client.requestCharacter(2)).toEqual({ status: 'completed', expressions: [] })
    expect(requested).toEqual(['character:companion'])
    await expect(rm.client.requestCharacter(1)).rejects.toThrow('CHARACTER_REQUEST_FAILED')
    expect(requested).toHaveLength(1)
    rm.map()
    expect(await session.invoke('rpg-maker', 'queue-common-event', { eventId: 2 }, 'character:companion')).toEqual({
      completion: 'queued',
      data: { queued: true, eventId: 2 },
    })
  } finally {
    await session.close()
  }
  await expect(rm.client.requestCharacter(2)).rejects.toThrow('CHARACTER_REQUEST_FAILED')
})

async function peer(bridge: Bridge) {
  const socket = createConnection({ host: '127.0.0.1', port: bridge.port })
  sockets.push(socket)
  await once(socket, 'connect')
  const ready = once(socket, 'data')
  socket.write(JSON.stringify({ type: 'hello', engine: 'RPG Maker MZ', token }) + '\n')
  await ready
  return socket
}

it('rejects in-flight requests and closes its listener when Cordis unloads the bridge', async () => {
  const { bridge, owner } = await cordis()
  const socket = await peer(bridge),
    closed = once(socket, 'close')
  const request = expect(bridge.observe(1)).rejects.toThrow('connection closed')
  await owner.dispose()
  await request
  await closed
  expect(bridge.connected).toBe(false)
  await expect(bridge.observe(1)).rejects.toThrow('not connected')
})

it('times out an unanswered command without retrying a potentially executed game event', async () => {
  const bridge = await createBridge({ token, timeoutMs: 100 })
  bridges.push(bridge)
  const socket = await peer(bridge),
    received: string[] = []
  socket.on('data', data => received.push(String(data)))
  await expect(bridge.queueCommonEvent(1, 2)).rejects.toThrow('inspect the game before retrying')
  expect(received.join('').split('\n').filter(Boolean)).toHaveLength(1)
  expect(bridge.connected).toBe(false)
})
