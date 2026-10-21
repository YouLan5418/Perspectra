import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { interactionPackageDescription, resolutionAuthority, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { createCoreRulebookRegistry, type CompiledWorldManifest } from '@harness-world/kernel'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { PackActivities } from '../../desktop/host/pack-activities.ts'
import { PackStatus, type KnownStatus } from '../../desktop/host/pack-status.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'

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

const PLAYER = 'character:player',
  RIVAL = 'character:companion',
  BYSTANDER = 'character:friend'
const object = (value: unknown) => value as WorldJsonObject
const actor = (input: WorldJsonObject) => String(object(object(input.context).character).characterId)
const potion = {
  decision: 'perform',
  actionType: 'interact',
  parameters: {
    targetRef: { kind: 'character', id: RIVAL },
    bindingId: 'status',
    definitionRef: { id: 'status:drink-potion', version: 1 },
    arguments: {},
  },
}
const ids = (affordances: readonly unknown[]) =>
  affordances
    .flatMap(a => (object(a).interactions as WorldJsonObject[] | undefined) ?? [])
    .map(i => String(object(i.definitionRef).id))
const source = (event: { data: unknown }) => object(object(event.data).source)
type Decide = (input: WorldJsonObject) => unknown

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pack-status-activity-'))
  roots.push(root)
  const packPath = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/prototype-g1'), packPath, { recursive: true })
  mkdirSync(join(packPath, 'scripts/activities'), { recursive: true })
  writeFileSync(join(packPath, 'scripts/status.js'), readFileSync(resolve('tests/fixtures/status-market.js'), 'utf8'))
  writeFileSync(
    join(packPath, 'scripts/activities/duel.js'),
    readFileSync(resolve('tests/fixtures/status-duel.js'), 'utf8'),
  )
  const manifest = JSON.parse(readFileSync(join(packPath, 'worldpack.source.json'), 'utf8'))
  manifest.assetFiles = ['scripts/status.js', 'scripts/activities/duel.js']
  writeFileSync(join(packPath, 'worldpack.source.json'), JSON.stringify(manifest))
  const pack = (await compileWorldPackSource(
    packPath,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )) as CompiledWorldPackV5
  const requests: WorldJsonObject[] = []
  let decide: Decide = () => ({ decision: 'abstain' })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      try {
        const messages = JSON.parse(body).messages as { role: string; content: string }[]
        const input = JSON.parse(messages.findLast(m => m.role === 'user')!.content) as WorldJsonObject
        requests.push(input)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: { content: JSON.stringify(decide(input)) } }))
      } catch (error) {
        response.writeHead(500)
        response.end(String(error))
      }
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({
    packPath,
    dataDirectory: data,
    provider: 'ollama',
    model: 'fixture',
    timeoutMs: 5000,
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/chat',
  })
  runtimes.push(runtime)
  const worldPath = join(runtime.dataDirectory, 'world.sqlite')
  const events = () => {
    const store = new WorldStore(worldPath)
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  const status = PackStatus.load(packPath, pack)!
  // The runtime's resolver chain, rebuilt here to ask what a non-player character would be offered;
  // the player's options are read from the runtime itself.
  const activities = PackActivities.load(packPath, pack, worldPath, runtime.address, PLAYER, status)!
  const core = createCoreRulebookRegistry({ interactionPackages: createInstalledInteractionPackages() }).resolve(
    'builtin:speak-move',
    2,
    'test',
    runtime.address,
  )
  const chain = activities
    .rulebooks(status.resolver(core, worldPath, runtime.address, PLAYER))
    .resolve('builtin:speak-move', 2, 'test', runtime.address)
  const offered = (characterId: string) => {
    const store = new WorldStore(worldPath)
    try {
      const { manifest, manifestHash } = store.readManifest(runtime.address)!
      return ids(
        chain.affordances({
          manifest: manifest as CompiledWorldManifest,
          manifestHash,
          events: store.readEvents(runtime.address),
          characterId,
          asOfWorldSeq: store.head(runtime.address).headSeq,
          resolutionAuthority: resolutionAuthority(characterId === PLAYER ? 'player' : 'agent', 'standard'),
        }),
      )
    } finally {
      store.close()
    }
  }
  const duel = async (operation: string) => {
    const view = (await runtime.state()).activities!.find(a => a.activityKey === 'duel')!
    return runtime.activityAction({
      activityKey: 'duel',
      activityId: operation === 'start' ? null : String(view.id),
      revision: operation === 'start' ? 0 : Number(view.revision),
      operation,
      parameters: {},
      requestId: randomUUID(),
    })
  }
  const statusEvents = () => events().filter(e => e.eventType === 'status.updated')
  return {
    runtime,
    requests,
    events,
    statusEvents,
    status,
    offered,
    duel,
    setDecision: (fn: Decide) => {
      decide = fn
    },
  }
}

it('duel attack commits activity and status in one transaction', async () => {
  const f = await fixture()
  await f.duel('start')
  await f.duel('attack')
  const attack = f.events().find(e => e.eventType === 'activity.updated' && object(e.data).operation === 'attack')!
  const update = f.statusEvents().find(e => source(e).kind === 'activity')!
  expect(update.transactionId).toBe(attack.transactionId)
  expect(object(update.data)).toEqual({
    source: { kind: 'activity', activityKey: 'duel', actorId: PLAYER },
    changes: [{ holderId: RIVAL, key: 'hp', value: 15 }],
    reveals: [PLAYER, RIVAL, BYSTANDER].map(observerId => ({ observerId, holderId: RIVAL, key: 'hp', value: 15 })),
  })
}, 60_000)

it('hp cannot change outside duel', async () => {
  const f = await fixture()
  const head = f.events().length
  await expect(f.runtime.submit('/status cheat-hp {}')).rejects.toThrow('状态 hp 只能由指定活动改变')
  await expect(f.runtime.submit('/status drink-potion {}')).rejects.toThrow('只能在指定活动中进行')
  expect(f.events()).toHaveLength(head)
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.hp).toBe(20)
}, 60_000)

it('drink-potion is offered only during duel to participants', async () => {
  const f = await fixture()
  // The player's options are the runtime's own: what state() serves and the player view turns into actions.
  const player = async () => ids((await f.runtime.state()).availableActions!)
  expect(await player()).not.toContain('status:drink-potion')
  expect(await player()).toEqual(expect.arrayContaining(['status:buy', 'status:check-purse', 'status:set-time']))
  for (const id of [RIVAL, BYSTANDER]) expect(f.offered(id)).not.toContain('status:drink-potion')
  expect(f.offered(RIVAL)).toContain('status:buy')
  await f.duel('start')
  expect(await player()).toContain('status:drink-potion')
  expect(f.offered(RIVAL)).toContain('status:drink-potion')
  expect(f.offered(BYSTANDER)).not.toContain('status:drink-potion')
  // The duel's policy lists only drink-potion, so ordinary status operations are filtered out for fighters.
  expect(await player()).not.toContain('status:buy')
  expect(f.offered(RIVAL)).not.toContain('status:buy')
  expect(f.offered(BYSTANDER)).toContain('status:buy')
  // The player's menu item maps the status operation to `/status`; during the duel it runs under the duel's rules.
  const drinkOption = projectPlayerView(await f.runtime.state()).actions.find(a => a.label === '喝药水')!
  await f.runtime.perform(drinkOption.action)
  const drink = f.statusEvents().find(e => source(e).operation === 'drink-potion')!
  expect(source(drink)).toEqual({ kind: 'operation', operation: 'drink-potion', actorId: PLAYER, activityKey: 'duel' })
  expect(f.status.known(f.statusEvents(), PLAYER)).toContainEqual({
    key: 'hp',
    label: '生命',
    holderId: PLAYER,
    value: 25,
    current: true,
  })
  await expect(f.runtime.submit('/status cheat-hp {}')).rejects.toThrow('活动期间禁止此交互')
  // An operation the duel allows but the status rules reject tells the player the status reason.
  const head = f.events().length
  await expect(f.runtime.submit('/status drink-potion {"extra":1}')).rejects.toThrow(
    '操作缺少有效的必要信息，什么都没有发生。',
  )
  expect(f.events()).toHaveLength(head)
}, 60_000)

it('after duel ends hp keeps its last value and is shown as last confirmed to bystanders', async () => {
  const f = await fixture()
  let drank = false
  f.setDecision(input => {
    if (actor(input) !== RIVAL || input.continuation || drank || object(input.context).activity === undefined)
      return { decision: 'abstain' }
    drank = true
    return potion
  })
  await f.duel('start')
  // The player's blow is seen by everyone present; the rival then heals on its turn, which only it learns.
  await f.duel('attack')
  const rival = f.requests.find(input => actor(input) === RIVAL && object(input.context).activity !== undefined)!
  expect(ids(object(rival.context).affordances as unknown as unknown[])).toContain('status:drink-potion')
  expect(drank).toBe(true)
  const drink = f.statusEvents().find(e => source(e).operation === 'drink-potion')!
  expect(source(drink)).toEqual({ kind: 'operation', operation: 'drink-potion', actorId: RIVAL, activityKey: 'duel' })
  await f.duel('yield')
  expect((await f.runtime.state()).activity?.game).toMatchObject({ active: false })
  const updates = f.statusEvents()
  expect(f.status.truth(updates).characters[RIVAL]!.hp).toBe(20)
  expect(f.status.known(updates, RIVAL)).toContainEqual({
    key: 'hp',
    label: '生命',
    holderId: RIVAL,
    value: 20,
    current: true,
  })
  expect(f.status.known(updates, BYSTANDER)).toContainEqual({
    key: 'hp',
    label: '生命',
    holderId: RIVAL,
    value: 15,
    current: false,
  })
  // Outside the duel the bystander still sees the last confirmed value in its own context.
  const after = f.requests.length
  await f.runtime.submit('/act speak ' + JSON.stringify({ text: '决斗结束了。', scope: 'scene_public' }))
  const bystander = f.requests.slice(after).find(input => actor(input) === BYSTANDER)!
  expect(object(bystander.context).knownStatus as unknown as KnownStatus[]).toContainEqual({
    key: 'hp',
    label: '生命',
    holderId: RIVAL,
    value: 15,
    current: false,
  })
  expect(f.status.truth(f.statusEvents()).characters[RIVAL]!.hp).toBe(20)
}, 90_000)
