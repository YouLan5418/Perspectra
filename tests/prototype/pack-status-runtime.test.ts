import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'
import { PackStatus, type KnownStatus } from '../experiments/pack-status.ts'

const roots: string[] = [], runtimes: FrozenWorldPlaytestRuntime[] = [], servers: Server[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

const PLAYER = 'character:player', THIEF = 'character:companion', BYSTANDER = 'character:friend'
const object = (value: unknown) => value as WorldJsonObject
const actor = (input: WorldJsonObject) => String(object(object(input.context).character).characterId)
const steal = { decision: 'perform', actionType: 'interact', parameters: { targetRef: { kind: 'character', id: THIEF },
  bindingId: 'status', definitionRef: { id: 'status:steal', version: 1 }, arguments: { targetId: PLAYER } } }
type Decide = (input: WorldJsonObject) => unknown

async function fixture(provider: 'ollama' | 'local') {
  const root = mkdtempSync(join(tmpdir(), 'pack-status-runtime-')); roots.push(root)
  const packPath = join(root, 'pack'), data = join(root, 'data')
  cpSync(resolve('examples/world-packs/prototype-g1'), packPath, { recursive: true })
  mkdirSync(join(packPath, 'scripts'), { recursive: true })
  cpSync(resolve('tests/prototype/fixtures/status-market.js'), join(packPath, 'scripts/status.js'))
  const source = JSON.parse(readFileSync(join(packPath, 'worldpack.source.json'), 'utf8'))
  source.assetFiles = ['scripts/status.js']
  writeFileSync(join(packPath, 'worldpack.source.json'), JSON.stringify(source))
  const pack = await compileWorldPackSource(packPath, createInstalledInteractionPackages().map(interactionPackageDescription)) as CompiledWorldPackV5
  const requests: WorldJsonObject[] = []
  let decide: Decide = () => ({ decision: 'abstain' })
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      try {
        const messages = JSON.parse(body).messages as { role: string; content: string }[]
        const input = JSON.parse(messages.findLast(m => m.role === 'user')!.content) as WorldJsonObject
        requests.push(input)
        const output = decide(input)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(provider === 'ollama' ? { message: { content: JSON.stringify(output) } }
          : { choices: [{ message: { tool_calls: [{ id: 'fixture-call', type: 'function',
            function: { name: 'submit_actions', arguments: JSON.stringify(output) } }] } }] }))
      } catch (error) { response.writeHead(500); response.end(String(error)) }
    })
  })
  servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const options = { packPath, dataDirectory: data, provider, model: 'fixture', timeoutMs: 5000,
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port
      + (provider === 'ollama' ? '/api/chat' : '/v1/chat/completions') }
  const create = async () => { const runtime = await FrozenWorldPlaytestRuntime.create(options); runtimes.push(runtime); return runtime }
  const runtime = await create()
  const events = (r = runtime) => {
    const store = new WorldStore(join(r.dataDirectory, 'world.sqlite'))
    try { return store.readEvents(r.address) } finally { store.close() }
  }
  const statusEvents = (r = runtime) => events(r).filter(event => event.eventType === 'status.updated')
  return { runtime, create, requests, events, statusEvents, status: PackStatus.load(packPath, pack)!,
    setDecision: (fn: Decide) => { decide = fn } }
}
const known = (input: WorldJsonObject) => object(input.context).knownStatus as unknown as KnownStatus[]

it.each(['ollama', 'local'] as const)('an NPC theft commits one status.updated and only the thief learns the new balances (%s)', async provider => {
  const f = await fixture(provider)
  let stolen = false
  f.setDecision(input => {
    if (actor(input) !== THIEF || stolen || input.continuation) return { decision: 'abstain' }
    stolen = true; return steal
  })
  const first = await f.runtime.submit('/act speak {"text":"今天集市人真多。","scope":"scene_public"}')
  expect(first.error, JSON.stringify(first.debug)).toBe(false)
  const offered = f.requests.find(input => actor(input) === THIEF)!
  const options = (object(offered.context).affordances as WorldJsonObject[])
    .flatMap(a => (a.interactions as WorldJsonObject[] | undefined) ?? []).map(o => object(o.definitionRef).id)
  expect(options).toEqual(expect.arrayContaining(['status:steal', 'status:buy', 'status:check-purse']))
  // Player-only and activity-scoped operations are not offered to an NPC outside an activity.
  expect(options).not.toContain('status:set-time')
  expect(options).not.toContain('status:drink-potion')
  expect(object(offered.context).knownStatusNote).toBe('这是你上次确认的状态值；current=false 表示之后可能已经改变，你并不知道现在的值。')

  const updates = f.statusEvents()
  expect(updates).toHaveLength(2)
  expect(f.status.truth(updates).characters[PLAYER]!.money).toBe(70)
  expect(f.status.truth(updates).characters[THIEF]!.money).toBe(130)
  expect(f.status.known(updates, PLAYER)).toContainEqual({ key: 'money', label: '余额', holderId: PLAYER, value: 100, current: false })
  expect(f.status.known(updates, THIEF)).toContainEqual({ key: 'money', label: '余额', holderId: THIEF, value: 130, current: true })

  // A later round reaches the bystander after the theft; it never learns either balance.
  const after = f.requests.length
  const second = await f.runtime.submit('/act speak {"text":"大家注意钱包。","scope":"scene_public"}')
  expect(second.error, JSON.stringify(second.debug)).toBe(false)
  const bystander = f.requests.filter(input => actor(input) === BYSTANDER)
  expect(f.requests.slice(after).some(input => actor(input) === BYSTANDER)).toBe(true)
  for (const input of bystander) {
    expect(known(input).filter(k => k.key === 'money' && (k.holderId === PLAYER || k.holderId === THIEF))).toEqual([])
  }
  const thief = f.requests.slice(after).filter(input => actor(input) === THIEF)
  expect(thief.length).toBeGreaterThan(0)
  expect(known(thief.at(-1)!)).toContainEqual({ key: 'money', label: '余额', holderId: THIEF, value: 130, current: true })
  expect(f.statusEvents()).toHaveLength(2)
}, 60_000)

it.each(['ollama', 'local'] as const)('a target that left the scene is rejected without any commit (%s)', async provider => {
  const f = await fixture(provider)
  let headAtRequest: number | undefined
  f.setDecision(input => {
    if (actor(input) !== THIEF || input.continuation) return { decision: 'abstain' }
    const store = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
    try { headAtRequest = store.head(f.runtime.address).headSeq } finally { store.close() }
    return steal
  })
  // The player leaves; the thief, still in the front room, reacts by stealing from someone who is gone.
  await expect(f.runtime.submit('/act move {"locationId":"location:back-room"}')).rejects.toThrow('引用的角色不在当前场景')
  expect(headAtRequest).toBeDefined()
  const store = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
  try { expect(store.head(f.runtime.address).headSeq).toBe(headAtRequest) } finally { store.close() }
  expect(f.statusEvents()).toHaveLength(1)
}, 60_000)

it.each(['ollama', 'local'] as const)('narration claiming a theft changes nothing (%s)', async provider => {
  const f = await fixture(provider)
  f.setDecision(input => actor(input) === THIEF && !input.continuation
    ? { decision: 'publish', segments: [{ type: 'narration', text: '他偷走了钱袋' }] } : { decision: 'abstain' })
  const before = f.statusEvents()
  const state = await f.runtime.submit('/act speak {"text":"你在看什么？","scope":"scene_public"}')
  expect(state.error, JSON.stringify(state.debug)).toBe(false)
  expect(JSON.stringify(f.events())).toContain('他偷走了钱袋')
  expect(f.statusEvents()).toEqual(before)
}, 60_000)

it('initial event is committed once on first open and not again on reopen', async () => {
  const f = await fixture('ollama')
  const initial = f.statusEvents()
  expect(initial).toHaveLength(1)
  expect(object(initial[0]!.data).source).toEqual({ kind: 'initial' })
  const head = f.events().length
  await f.runtime.close(); runtimes.splice(runtimes.indexOf(f.runtime), 1)
  const reopened = await f.create()
  expect(f.events(reopened)).toHaveLength(head)
  expect(f.statusEvents(reopened)).toEqual(initial)
}, 60_000)
