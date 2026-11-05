import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import type { ActivitiesInstance, SeamProvider, StatusInstance } from '@harness-world/plugin-sdk'
import { WorldStore } from '@harness-world/store-sqlite'
import { HostCapabilities } from '../../desktop/host-capabilities.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { assembleRoleplay, type HostSeams, type WorldComposition } from '../../desktop/official-bundle.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

// M7: different games differ only in the mechanisms they select and the pack scripts they bring. No test here reaches
// a private host class: everything goes through composition, the host's player operations and committed events.
const PLAYER = 'character:player'
const GAMEPLAY = ['knowledge', 'status', 'activities', 'communication', 'autonomy'] as const
type Gameplay = (typeof GAMEPLAY)[number]

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const obj = (value: unknown) => value as WorldJsonObject

function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), 'composition-acceptance-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return root
}

/** The default RP install minus every gameplay mechanism the game did not ask for. */
function selecting(...wanted: Gameplay[]): WorldComposition {
  const standard = assembleRoleplay()
  const mechanisms = { ...standard.mechanisms } as Record<string, unknown>
  for (const name of GAMEPLAY) if (!wanted.includes(name)) delete mechanisms[name]
  return { ...standard, mechanisms: mechanisms as unknown as HostSeams }
}

async function play(
  pack: string,
  composition: WorldComposition,
  decide: (input: WorldJsonObject) => WorldJsonObject = () => ({ decision: 'abstain' }),
  extra: Partial<Parameters<typeof WorldHostRuntime.create>[0]> = {},
) {
  const requests: WorldJsonObject[] = []
  const server = await startFakeProvider('openai', call => {
    const input = JSON.parse(call.userText) as WorldJsonObject
    requests.push(input)
    return { tool: decide(input) }
  })
  cleanups.push(() => server.close())
  const dataDirectory = fresh()
  const open = async (directory = dataDirectory) => {
    const runtime = await WorldHostRuntime.create({
      packPath: resolve('examples/world-packs', pack),
      dataDirectory: directory,
      models: fakeModels(server.endpoint),
      timeoutMs: 5000,
      composition,
      ...extra,
    })
    cleanups.push(() => runtime.close())
    return runtime
  }
  const runtime = await open()
  const events = (from = runtime) => {
    const store = new WorldStore(join(from.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(from.address)
    } finally {
      store.close()
    }
  }
  const option = async (label: string) => {
    const found = projectPlayerView(await runtime.state()).actions.find(a => a.label === label)
    expect(found, label).toBeDefined()
    return found!
  }
  const seams = () => JSON.parse(readFileSync(join(dataDirectory, 'plugin-set.json'), 'utf8')).seams
  return { runtime, open, events, option, requests, seams, dataDirectory }
}

function withTarget<T extends { readonly parameters: WorldJsonObject }>(action: T, args: WorldJsonObject): T {
  return {
    ...action,
    parameters: { ...action.parameters, arguments: { ...obj(action.parameters.arguments), ...args } },
  }
}

/** A selected mechanism wrapping the official one: only reachable if the host really goes through the service. */
function recording<T extends object>(instance: T, calls: Set<string>): T {
  return new Proxy(instance, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            calls.add(String(key))
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        : value
    },
  })
}
function recordingStatus(calls: Set<string>): SeamProvider<StatusInstance> {
  const official = assembleRoleplay().mechanisms.status!
  return {
    id: 'recording-status',
    version: '1.0.0',
    open: async (world, signal) => recording(await official.open(world, signal), calls),
  }
}
function recordingActivities(calls: Set<string>): SeamProvider<ActivitiesInstance> {
  const official = assembleRoleplay().mechanisms.activities!
  return {
    id: 'recording-activities',
    version: '1.0.0',
    open: async (world, signal) => {
      const instance = await official.open(world, signal)
      return {
        entries: instance.entries.map(entry => recording(entry, calls)),
        select: (...args) => instance.select(...args),
        chooseAutoStart: (...args) => instance.chooseAutoStart(...args),
      }
    },
  }
}

const startBattle = async (f: Awaited<ReturnType<typeof play>>) => {
  await f.runtime.perform((await f.option('进入遗迹迎战')).action)
}
const battle = async (runtime: WorldHostRuntime) =>
  obj((await runtime.state()).activities!.find(a => a.activityKey === 'battle'))

it('default RP: the full install answers a player with a model line through the core commit path', async () => {
  const f = await play('dynamic-scheduling', assembleRoleplay(), () => ({
    decision: 'publish',
    segments: [{ type: 'speech', text: '听到了。' }],
  }))
  await f.runtime.submit('有人吗？')
  const lines = f.events().filter(e => e.eventType === 'character.speak')
  expect(lines.some(e => obj(e.data).characterId === PLAYER)).toBe(true)
  expect(lines.find(e => obj(e.data).characterId !== PLAYER)?.data).toMatchObject({
    segments: [{ type: 'speech', text: '听到了。' }],
  })
  for (const name of ['scheduler', 'characterLoop', 'llm', 'status', 'activities', 'knowledge'])
    expect(f.seams()).toHaveProperty(name)
})

it('werewolf: runs on the activity mechanism alone and keeps every role with its owner', async () => {
  const calls = new Set<string>()
  const composition = selecting()
  const f = await play('model-girls-werewolf', {
    ...composition,
    mechanisms: { ...composition.mechanisms, activities: recordingActivities(calls) },
  })
  expect(Object.keys(f.seams())).not.toContain('status')
  const current = async () => obj((await f.runtime.state()).activities!.find(a => a.activityKey === 'werewolf'))
  const operate = async (operation: string) => {
    const game = operation === 'start' ? undefined : await current()
    await f.runtime.activityAction({
      activityKey: 'werewolf',
      activityId: game ? String(game.id) : null,
      revision: game ? Number(game.revision) : 0,
      operation,
      parameters: {},
      requestId: randomUUID(),
    })
  }
  await operate('start')
  const mine = await current()
  expect(calls).toContain('initialize')
  expect(obj(mine.game)).not.toHaveProperty('internal')
  // The committed game holds all seven roles; the player's view holds one, and no status event was invented.
  const update = f.events().findLast(e => e.eventType === 'activity.updated')!
  expect(Object.keys(obj(obj(obj(obj(obj(update.data).state).game).internal)['身份表'])).length).toBe(7)
  expect(Object.keys(obj(mine.game).private as WorldJsonObject)).toContain('身份')
  expect(f.events().some(e => e.eventType === 'status.updated')).toBe(false)
  // Roles are dealt at random: when the player acts first no model is asked yet, so deal again until one is.
  await operate('retry')
  for (let deal = 0; deal < 40 && f.requests.length === 0; deal++) {
    await operate('quit')
    await operate('start')
    await operate('retry')
  }
  expect(f.requests.length).toBeGreaterThan(0)
  for (const request of f.requests) {
    const activity = obj(obj(request.context).activity)
    expect(activity.game).not.toHaveProperty('internal')
    expect(JSON.stringify(request)).not.toContain('身份表')
  }
})

it('RPG: status and activities commit together, and a saved node restores the mid-battle world', async () => {
  const statusCalls = new Set<string>(),
    activityCalls = new Set<string>()
  const composition = selecting()
  const selected: WorldComposition = {
    ...composition,
    mechanisms: {
      ...composition.mechanisms,
      status: recordingStatus(statusCalls),
      activities: recordingActivities(activityCalls),
    },
  }
  const f = await play('rpg-turn-battle', selected)
  await startBattle(f)
  await f.runtime.perform(withTarget((await f.option('火球术（3魔力）')).action, { targetId: '遗迹守卫' }))
  expect(statusCalls).toContain('resolve')
  expect(activityCalls).toContain('resolve')
  const combat = f.events().filter(e => e.eventType === 'activity.updated' && obj(e.data).operation !== 'start')
  for (const event of combat)
    expect(f.events().some(e => e.eventType === 'status.updated' && e.transactionId === event.transactionId)).toBe(true)

  const truth = (from = f.runtime) => from.creatorInspection().statusTruth
  const saved = { truth: truth(), revision: (await battle(f.runtime)).revision }
  const node = await f.runtime.saveNode('激战中')
  await f.runtime.perform(withTarget((await f.option('火球术（3魔力）')).action, { targetId: '遗迹守卫' }))
  expect(truth()).not.toEqual(saved.truth)

  const branch = join(fresh(), 'restored')
  restoreStoryNode(f.dataDirectory, node.id, branch, node.packHash)
  const restored = await f.open(branch)
  expect(truth(restored)).toEqual(saved.truth)
  expect((await battle(restored)).revision).toBe(saved.revision)
  expect((await battle(f.runtime)).revision).not.toBe(saved.revision)
})

it('status market: runs without activities or knowledge, and custody follows only adjudicated facts', async () => {
  const calls = new Set<string>()
  const composition = selecting()
  const f = await play('status-market', {
    ...composition,
    mechanisms: { ...composition.mechanisms, status: recordingStatus(calls) },
  })
  expect((await f.runtime.state()).activities ?? []).toEqual([])
  await f.runtime.perform((await f.option('拿起保温杯')).action)
  expect(calls).toContain('resolve')
  const thermos = () => currentEntityState(f.events(), 'entity:thermos')!
  expect(thermos().holderId).toBe(PLAYER)
  // A hand-over to someone who is not here is refused by the core, whatever the author's script says.
  const give = (await f.option('把保温杯交给')).action
  await expect(f.runtime.perform(withTarget(give, { recipientId: 'character:nobody' }))).rejects.toThrow()
  expect(thermos().holderId).toBe(PLAYER)
  await f.runtime.submit('有人要喝水吗？')
  for (const request of f.requests) expect(obj(request.context)).not.toHaveProperty('knowledge')
})

it('native capability: a real Cordis provider and a pack module compose over the same status mechanism', async () => {
  const root = new Context()
  cleanups.push(() => root.fiber.dispose() as Promise<void>)
  const capabilities = new HostCapabilities(root)
  const plugin = await import(pathToFileURL(resolve('examples/host-plugins/demo-device.mjs')).href)
  await root.plugin(plugin.default)
  const calls = new Set<string>()
  const composition = selecting()
  const selected = {
    ...composition,
    mechanisms: { ...composition.mechanisms, status: recordingStatus(calls) },
  }
  const f = await play('plugin-capabilities-demo', selected, undefined, { capabilities })
  await f.runtime.perform((await f.option('请求设备确认')).action)
  expect(calls).toContain('prepareModule')
  expect(calls).toContain('resolve')
  const update = f
    .events()
    .findLast(e => e.eventType === 'status.updated' && obj(obj(e.data).source).kind === 'operation')
  expect(obj(update!.data).changes).toEqual([{ holderId: PLAYER, key: 'greetings-count', value: 1 }])
  // The same pack refuses to open when its declared mechanism was left out of the selection.
  await expect(
    play(
      'plugin-capabilities-demo',
      { ...selected, mechanisms: { ...selected.mechanisms, status: undefined } as unknown as HostSeams },
      undefined,
      { capabilities },
    ),
  ).rejects.toThrow('世界声明的 status 需要对应机制')
})
