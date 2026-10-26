import { createServer, type Server } from 'node:http'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { PackStatus } from '../../desktop/host/pack-status.ts'

const PLAYER = 'character:player',
  ALLY = 'character:companion',
  ENEMY = 'character:friend'
const roots: string[] = [],
  runtimes: WorldHostRuntime[] = [],
  servers: Server[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
const obj = (value: unknown) => value as WorldJsonObject

async function fixture(fault = false) {
  const root = mkdtempSync(join(tmpdir(), 'rpg-turn-battle-'))
  roots.push(root)
  const packPath = join(root, 'pack'),
    dataDirectory = join(root, 'data')
  cpSync(resolve('examples/world-packs/rpg-turn-battle'), packPath, { recursive: true })
  if (fault) {
    const script = join(packPath, 'scripts/activities/battle.js')
    writeFileSync(script, readFileSync(script, 'utf8').replace("set(targetId, 'hp', hp)", "set(targetId, 'hp', -1)"))
  }
  const compiled = await compileWorldPackSource(
    packPath,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )
  const status = PackStatus.load(packPath, compiled)!
  const requests: WorldJsonObject[] = []
  let tactics: 'guard' | 'abstain' = 'guard'
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const messages = JSON.parse(body).messages as { role: string; content: string }[]
      const input = JSON.parse(messages.findLast(m => m.role === 'user')!.content) as WorldJsonObject
      requests.push(input)
      const activity = obj(obj(input.context).activity)
      const decision =
        activity && !input.continuation && tactics === 'guard'
          ? {
              decision: 'perform',
              actionType: 'interact',
              parameters: {
                targetRef: { kind: 'character', id: ALLY },
                bindingId: activity.id,
                definitionRef: { id: 'activity:guard', version: 1 },
                arguments: { activityId: activity.id, revision: activity.revision },
              },
            }
          : input.continuation
            ? { decision: 'publish', segments: [{ type: 'speech', text: '我守住这里。' }] }
            : { decision: 'abstain' }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(decision) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const options = {
    packPath,
    dataDirectory,
    provider: 'ollama' as const,
    model: 'fixture',
    timeoutMs: 5000,
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/chat',
  }
  let runtime = await WorldHostRuntime.create(options)
  runtimes.push(runtime)
  const events = () => {
    const store = new WorldStore(join(dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  const view = async () => projectPlayerView(await runtime.state())
  const action = async (label: string, args: WorldJsonObject = {}) => {
    const names: Record<string, string> = { [PLAYER]: '冒险者', [ALLY]: '澄', [ENEMY]: '遗迹守卫' }
    if (typeof args.targetId === 'string') args = { ...args, targetId: names[args.targetId] ?? args.targetId }
    const option = (await view()).actions.find(a => a.label === label)
    expect(option, label).toBeDefined()
    return {
      ...option!.action,
      parameters: { ...option!.action.parameters, arguments: { ...obj(option!.action.parameters.arguments), ...args } },
    }
  }
  const act = async (label: string, args: WorldJsonObject = {}) => runtime.perform(await action(label, args))
  const battle = async () => (await runtime.state()).activities!.find(a => a.activityKey === 'battle')!
  const start = async (model = false) => {
    if (model) await act('让同伴使用真实模型决策')
    await act('进入遗迹迎战')
    expect(obj((await battle()).game).turn).toBe(PLAYER)
  }
  const manage = async (operation: string) => {
    const current = await battle()
    return runtime.activityAction({
      activityKey: 'battle',
      activityId: String(current.id),
      revision: Number(current.revision),
      operation,
      parameters: {},
      requestId: randomUUID(),
    })
  }
  return {
    events,
    view,
    action,
    act,
    battle,
    start,
    manage,
    requests,
    get runtime() {
      return runtime
    },
    truth: () => status.truth(events()),
    setTactics(value: typeof tactics) {
      tactics = value
    },
    async reopen() {
      await runtime.close()
      runtimes.splice(runtimes.indexOf(runtime), 1)
      runtime = await WorldHostRuntime.create(options)
      runtimes.push(runtime)
    },
  }
}

it('runs a complete 2v1 battle through player options and NPC activations, with atomic persistent rewards', async () => {
  const f = await fixture()
  expect((await f.view()).actions.some(a => a.label === '开始 遗迹守卫战')).toBe(false)
  await f.start()
  const before = f.requests.length
  await f.act('火球术（3魔力）', { targetId: ENEMY })
  expect(f.truth().characters[ENEMY]!.hp).toBe(34)
  expect(f.truth().characters[PLAYER]!.hp).toBe(20)
  expect(obj((await f.battle()).game).round).toBe(2)
  expect(f.requests).toHaveLength(before)
  const winningAction = await f.action('火球术（3魔力）', { targetId: ENEMY })
  await f.runtime.perform(winningAction)
  expect(obj((await f.battle()).game)).toMatchObject({ active: false, phase: 'victory', turn: null })
  expect(f.truth().characters[ENEMY]!.hp).toBe(0)
  expect(f.truth().characters[PLAYER]).toMatchObject({ mp: 0, gold: 30 })
  expect(f.truth().public.encounter).toBe('victory')
  const combat = f.events().filter(e => e.eventType === 'activity.updated' && obj(e.data).operation !== 'start')
  expect(combat.map(e => obj(e.data).actorId)).toEqual([PLAYER, ALLY, ENEMY, PLAYER, ALLY])
  for (const event of combat)
    expect(f.events().some(e => e.eventType === 'status.updated' && e.transactionId === event.transactionId)).toBe(true)
  const head = f.events().length
  // A finished-fight option may log a rejected attempt, but cannot change combat state or reward again.
  await f.runtime.perform(winningAction)
  expect(
    f
      .events()
      .slice(head)
      .filter(e => ['status.updated', 'activity.updated'].includes(e.eventType)),
  ).toEqual([])
  expect(f.truth().characters[PLAYER]!.gold).toBe(30)
  await f.reopen()
  expect(f.truth().characters[PLAYER]!.gold).toBe(30)
  expect(obj((await f.battle()).game).phase).toBe('victory')
  expect((await f.view()).actions.some(a => a.label.includes('开始 遗迹守卫战'))).toBe(false)
}, 60_000)

it('defends, heals with limited potions, and rejects depleted resources and invalid targets without commits', async () => {
  const f = await fixture()
  await f.start()
  for (const [label, targetId] of [
    ['普通攻击', ALLY],
    ['使用药水（恢复16生命）', PLAYER],
    ['普通攻击', 'character:unknown'],
  ]) {
    const head = f.events().length
    await expect(f.act(label!, { targetId: targetId! })).rejects.toThrow()
    expect(f.events()).toHaveLength(head)
  }
  await f.act('防御（下次受击减半）')
  expect(f.truth().characters[PLAYER]!.hp).toBe(26)
  for (let i = 0; i < 2; i++) await f.act('使用药水（恢复16生命）', { targetId: PLAYER })
  expect(f.truth().public.potions).toBe(0)
  expect(f.truth().characters[PLAYER]!.hp).toBe(20)
  const head = f.events().length
  await expect(f.act('使用药水（恢复16生命）', { targetId: PLAYER })).rejects.toThrow('药水已经用完')
  expect(f.events()).toHaveLength(head)
}, 60_000)

it('rejects exhausted MP and stale revisions and preserves a paused fight across reopening', async () => {
  const f = await fixture()
  await f.start()
  const stale = await f.action('普通攻击', { targetId: ENEMY })
  await f.act('防御（下次受击减半）')
  await f.act('治疗术（3魔力）', { targetId: PLAYER })
  await f.act('治疗术（3魔力）', { targetId: PLAYER })
  expect(f.truth().characters[PLAYER]!.mp).toBe(0)
  const head = f.events().length
  await expect(f.act('火球术（3魔力）', { targetId: ENEMY })).rejects.toThrow('魔力不足')
  await expect(f.runtime.perform(stale)).rejects.toThrow()
  expect(f.events()).toHaveLength(head)
  await f.manage('suspend')
  const truth = f.truth()
  await f.reopen()
  expect(f.truth()).toEqual(truth)
  await f.manage('resume')
  expect(obj((await f.battle()).game).turn).toBe(PLAYER)
  await f.act('撤退')
  expect(f.truth().public.encounter).toBe('fled')
  expect(f.truth().characters[PLAYER]!.gold).toBe(0)
}, 60_000)

it('lets the ally use the provider path, skips downed actors and reaches defeat without rewards', async () => {
  const f = await fixture()
  await f.start(true)
  for (let i = 0; i < 12 && obj((await f.battle()).game).active; i++) {
    if (obj((await f.battle()).game).turn === PLAYER) await f.act('防御（下次受击减半）')
    else await f.manage('retry')
  }
  expect(obj((await f.battle()).game).phase).toBe('defeat')
  expect(f.truth().characters[PLAYER]).toMatchObject({ hp: 0, gold: 0 })
  expect(f.truth().characters[ALLY]!.hp).toBe(0)
  expect(f.requests.some(r => obj(r.context).activity !== undefined)).toBe(true)
}, 60_000)

it('retains the NPC turn after abstention and rejects a player acting out of turn', async () => {
  const f = await fixture()
  await f.start(true)
  f.setTactics('abstain')
  await f.act('普通攻击', { targetId: ENEMY })
  const state = await f.battle()
  expect(obj(state.game).turn).toBe(ALLY)
  expect((await f.view()).actions.some(a => a.label === '普通攻击')).toBe(false)
  const head = f.events().length
  await expect(
    f.runtime.activityAction({
      activityKey: 'battle',
      activityId: String(state.id),
      revision: Number(state.revision),
      operation: 'strike',
      parameters: { targetId: '遗迹守卫' },
      requestId: randomUUID(),
    }),
  ).rejects.toThrow()
  expect(f.events()).toHaveLength(head)
  await f.manage('retry')
  expect(obj((await f.battle()).game).turn).toBe(ALLY)
}, 60_000)

it('rolls back activity progress as well as status when an author returns an invalid HP', async () => {
  const f = await fixture(true)
  await f.start()
  const head = f.events().length,
    state = await f.battle(),
    truth = f.truth()
  await expect(f.act('普通攻击', { targetId: ENEMY })).rejects.toThrow()
  expect(f.events()).toHaveLength(head)
  expect(await f.battle()).toEqual(state)
  expect(f.truth()).toEqual(truth)
}, 60_000)
