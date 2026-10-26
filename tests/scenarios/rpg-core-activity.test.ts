import { createServer, type Server } from 'node:http'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { PackStatus } from '../../desktop/host/pack-status.ts'

const { renderActivityFile, HOST_SOURCE_LIMIT } = (await import(
  pathToFileURL(resolve('examples/rpg-core/generate.mjs')).href
)) as {
  renderActivityFile: (config: unknown, from: string, limit?: number) => string
  HOST_SOURCE_LIMIT: number
}
const PACK = resolve('examples/world-packs/rpg-core-demo'),
  CONFIG = 'battle.config.json',
  SCRIPT = 'scripts/activities/battle.js'
const PLAYER = 'character:player',
  ALLY = 'character:companion'
const roots: string[] = [],
  runtimes: WorldHostRuntime[] = [],
  servers: Server[] = []
const obj = (value: unknown) => value as WorldJsonObject
type MutableObject = { -readonly [K in keyof WorldJsonObject]: WorldJsonObject[K] }
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

function packFixture(modify?: (config: MutableObject) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rpg-core-activity-'))
  roots.push(root)
  const packPath = join(root, 'pack'),
    dataDirectory = join(root, 'data')
  cpSync(PACK, packPath, { recursive: true })
  // Authors regenerate the activity script after editing the data; the host only ever sees the script.
  const config = JSON.parse(readFileSync(join(packPath, CONFIG), 'utf8'))
  modify?.(config)
  writeFileSync(join(packPath, SCRIPT), renderActivityFile(config, CONFIG))
  return { packPath, dataDirectory }
}
async function fixture(modify?: (config: MutableObject) => void) {
  const files = packFixture(modify)
  const compiled = await compileWorldPackSource(
    files.packPath,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )
  const status = PackStatus.load(files.packPath, compiled)!
  const requests: WorldJsonObject[] = []
  let mode: 'fire' | 'guard' | 'abstain' = 'fire'
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
      let decision: unknown = { decision: 'abstain' }
      if (input.continuation)
        decision = { decision: 'publish', segments: [{ type: 'speech', text: '我会照应你，继续。' }] }
      else if (activity && mode !== 'abstain') {
        const units = obj(obj(activity.game).public).units as WorldJsonObject[]
        const own = units.find(u => u.characterId === ALLY)!
        const target = units.find(u => u.team === 'enemy' && Number(u.hp) > 0)!
        decision = {
          decision: 'perform',
          actionType: 'interact',
          parameters: {
            targetRef: { kind: 'character', id: ALLY },
            bindingId: activity.id,
            definitionRef: { id: mode === 'guard' ? 'activity:guard' : 'activity:skill', version: 1 },
            arguments: {
              activityId: activity.id,
              revision: activity.revision,
              ...(mode === 'guard' ? {} : { skill: Number(own.mp) >= 3 ? '火球术' : '普通攻击', target: target.name }),
            },
          },
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(decision) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const options = {
    ...files,
    provider: 'ollama' as const,
    model: 'fixture',
    timeoutMs: 5000,
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/chat',
  }
  let runtime = await WorldHostRuntime.create(options)
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
  const act = async (label: string, args: WorldJsonObject = {}) => {
    const option = (await view()).actions.find(a => a.label === label)
    expect(option, label).toBeDefined()
    return runtime.perform({
      ...option!.action,
      parameters: { ...option!.action.parameters, arguments: { ...obj(option!.action.parameters.arguments), ...args } },
    })
  }
  const battle = async () => (await runtime.state()).activities!.find(a => a.activityKey === 'battle')!
  const game = async () => obj((await battle()).game)
  const unit = async (id: string) => (obj((await game()).public).units as WorldJsonObject[]).find(u => u.id === id)!
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
    ...files,
    events,
    view,
    act,
    battle,
    game,
    unit,
    manage,
    requests,
    truth: () => status.truth(events()),
    setMode(value: typeof mode) {
      mode = value
    },
    async reopen() {
      await runtime.close()
      runtimes.splice(runtimes.indexOf(runtime), 1)
      runtime = await WorldHostRuntime.create(options)
      runtimes.push(runtime)
    },
  }
}

it('runs a generated RPG Core activity with two rule enemies without characters, and atomically persists victory', async () => {
  const f = await fixture()
  expect((await f.view()).scene!.recipients.map(r => r.id)).toEqual([ALLY])
  await f.act('进入遗迹迎战')
  expect((await f.battle()).participants).toEqual([PLAYER, ALLY])
  await f.act('使用技能', { skill: '毒雾新星', target: '遗迹守卫' })
  expect(await f.unit('unit:golem')).toMatchObject({ hp: 24, poison: { turns: 1 } })
  expect(await f.unit('unit:drone')).toMatchObject({ hp: 10 })
  expect(await f.unit('unit:mage')).toMatchObject({ hp: 15, mp: 9 })
  expect((await f.game()).turn).toBe(PLAYER)
  const results = obj((await f.game()).public).results as WorldJsonObject[]
  expect(results.filter(r => r.kind === 'poison')).toHaveLength(2)
  expect(results.some(r => r.actorId === 'unit:golem')).toBe(true)
  expect(results.some(r => r.actorId === 'unit:drone')).toBe(true)
  await f.act('使用技能', { skill: '毒雾新星', target: '遗迹守卫' })
  expect(await f.game()).toMatchObject({ active: false, phase: 'victory' })
  expect(f.truth().characters[PLAYER]!.gold).toBe(45)
  expect((await f.view()).statusBar).toContainEqual(
    expect.objectContaining({ holderId: PLAYER, key: 'gold', value: 45, current: true }),
  )
  const reward = f
    .events()
    .find(
      e =>
        e.eventType === 'status.updated' &&
        obj(obj(e.data).source).kind === 'activity' &&
        (obj(e.data).changes as WorldJsonObject[]).some(c => c.key === 'gold'),
    )!
  expect(reward).toBeDefined()
  expect(f.events().some(e => e.eventType === 'activity.updated' && e.transactionId === reward.transactionId)).toBe(
    true,
  )
  const roleRequests = f.requests.filter(r => obj(r.context).activity !== undefined)
  expect(roleRequests.length).toBeGreaterThan(0)
  for (const request of roleRequests) {
    expect(obj(obj(request.context).character).characterId).toBe(ALLY)
    expect(JSON.stringify(request.context)).not.toContain('enemyFocus')
    expect(obj(obj(request.context).activity).participants).toEqual([PLAYER, ALLY])
  }
  const before = await f.game()
  await f.reopen()
  expect(await f.game()).toEqual(before)
  expect(f.truth().characters[PLAYER]!.gold).toBe(45)
}, 60_000)

it('supports more than 16 skills through one operation and rejects invalid targets and MP without commits', async () => {
  const f = await fixture(config => {
    const skills = config.skills as WorldJsonObject[],
      units = config.units as MutableObject[]
    for (let i = 0; i < 20; i++) skills.push({ ...skills[0]!, id: 'extra-' + i, name: '演示技能' + i })
    ;(units[0]!.skills as string[]).push('extra-19')
    units[0]!.mp = 0
  })
  await f.act('进入遗迹迎战')
  const skillOption = (await f.view()).actions.find(a => a.label === '使用技能')!
  expect((obj(obj(skillOption.argumentSchema).properties).skill as WorldJsonObject).enum).toHaveLength(24)
  for (const args of [
    { skill: '火球术', target: '遗迹守卫' },
    { skill: '普通攻击', target: '澄' },
    { skill: '演示技能0', target: '遗迹守卫' },
    { skill: '普通攻击', target: '不存在的目标' },
  ]) {
    const head = f.events().length,
      game = await f.game()
    await expect(f.act('使用技能', args)).rejects.toThrow()
    expect(f.events()).toHaveLength(head)
    expect(await f.game()).toEqual(game)
  }
  await f.act('使用技能', { skill: '演示技能19', target: '遗迹守卫' })
  expect(Number((await f.unit('unit:golem')).hp)).toBeLessThan(50)
}, 60_000)

it('preserves paused unit state across reopening and retreats without rewards', async () => {
  const f = await fixture()
  await f.act('进入遗迹迎战')
  await f.act('防御')
  await f.manage('suspend')
  const units = obj((await f.game()).public).units
  await f.reopen()
  await f.manage('resume')
  expect(obj((await f.game()).public).units).toEqual(units)
  await f.act('撤退')
  expect(await f.game()).toMatchObject({ active: false, phase: 'fled' })
  expect(f.truth().characters[PLAYER]!.gold).toBe(0)
}, 60_000)

it('keeps the ally turn after abstention and finishes a deterministic defeat without rewards', async () => {
  const f = await fixture()
  await f.act('进入遗迹迎战')
  f.setMode('abstain')
  await f.act('防御')
  expect((await f.game()).turn).toBe(ALLY)
  expect((await f.view()).actions.some(a => a.label === '使用技能')).toBe(false)
  f.setMode('guard')
  for (let i = 0; i < 16 && (await f.game()).active; i++) {
    if ((await f.game()).turn === PLAYER) await f.act('防御')
    else await f.manage('retry')
  }
  expect((await f.game()).phase).toBe('defeat')
  expect(f.truth().characters[PLAYER]!.gold).toBe(0)
}, 60_000)

it('ships the script generated from its config and rejects invalid RPG data before writing any script', () => {
  const config = JSON.parse(readFileSync(join(PACK, CONFIG), 'utf8'))
  expect(readFileSync(join(PACK, SCRIPT), 'utf8')).toBe(renderActivityFile(config, CONFIG))
  config.units[0].skills = ['missing-skill']
  expect(() => renderActivityFile(config, CONFIG)).toThrow('RPG_CONFIG_INVALID')
})

it('fits every valid config under the host limit, rejects oversize, and never overwrites output on failure', () => {
  const config = JSON.parse(readFileSync(join(PACK, CONFIG), 'utf8'))
  config.skills = Array.from({ length: 64 }, (_, index) => ({
    id: 'skill-' + index + '-' + 'x'.repeat(88),
    name: '技能' + index,
    kind: 'damage',
    scope: 'one',
    power: 1,
    mp: 0,
  }))
  config.units = Array.from({ length: 16 }, (_, index) => ({
    id: 'unit:' + index,
    name: '单位' + index,
    team: index === 0 ? 'party' : 'enemy',
    ...(index === 0 ? { characterId: PLAYER } : {}),
    hp: 10,
    mp: 0,
    attack: 1,
    defense: 0,
    speed: index === 0 ? 20 : 10,
    skills: config.skills.map((skill: { id: string }) => skill.id),
  }))
  // The largest config validation allows still renders well under the host's 256 KiB.
  expect(HOST_SOURCE_LIMIT).toBe(256 * 1024)
  expect(Buffer.byteLength(renderActivityFile(config, CONFIG))).toBeLessThan(HOST_SOURCE_LIMIT)
  // The size check itself, exercised with a smaller limit since valid data cannot reach the real one.
  expect(() => renderActivityFile(config, CONFIG, 65536)).toThrow('65536 UTF-8 bytes')
  const root = mkdtempSync(join(tmpdir(), 'rpg-core-oversized-'))
  roots.push(root)
  const input = join(root, CONFIG),
    output = join(root, 'battle.js'),
    previous = '// previous valid activity\n'
  // The CLI renders before it writes: a config that fails validation leaves the old file in place.
  config.units[0].skills = ['missing-skill']
  writeFileSync(input, JSON.stringify(config))
  writeFileSync(output, previous)
  const result = spawnSync(process.execPath, [resolve('examples/rpg-core/generate.mjs'), input, output], {
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('RPG_CONFIG_INVALID')
  expect(readFileSync(output, 'utf8')).toBe(previous)
})

it('rejects an invalid reward and rolls back the winning strike together with all enemy HP changes', async () => {
  const f = await fixture(config => {
    ;(config.reward as MutableObject).key = 'missing'
    for (const unit of config.units as MutableObject[]) if (unit.team === 'enemy') unit.hp = 1
  })
  await f.act('进入遗迹迎战')
  const head = f.events().length,
    game = await f.game()
  await expect(f.act('使用技能', { skill: '毒雾新星', target: '遗迹守卫' })).rejects.toThrow()
  expect(f.events()).toHaveLength(head)
  expect(await f.game()).toEqual(game)
  expect(f.truth().characters[PLAYER]!.gold).toBe(0)
}, 60_000)
