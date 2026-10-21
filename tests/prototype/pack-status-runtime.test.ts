import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { brandId, interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { CharacterRuntimeAvailabilityService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { createCoreRulebookRegistry, RulebookRegistry } from '@harness-world/kernel'
import { PrototypeCharacterTurn, type PrototypeTurnResult } from '../../packages/application/src/prototype-character-turn.ts'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { PackStatus, type KnownStatus } from '../../desktop/host/pack-status.ts'
import type { CoreRunner } from '../../desktop/host/memory/python-worker.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'

const roots: string[] = [], runtimes: WorldHostRuntime[] = [], servers: Server[] = []
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

const HOOK = /  onRoundEnd\(truth\) \{[\s\S]*?\r?\n  \},\r?\n/u
/** Fixture script variants: the default market, without the round hook, or with a throwing one. */
const scripts = { market: (s: string) => s, noHook: (s: string) => s.replace(HOOK, ''),
  quests: () => readFileSync(resolve('examples/world-packs/status-market/scripts/status.js'), 'utf8'),
  invalidQuests: () => readFileSync(resolve('examples/world-packs/status-market/scripts/status.js'), 'utf8')
    .replace("notes: ['领取委托']", 'notes: [123]')
    .replace("return { changes: [{ holderId: actorId, key: 'quests'", "return { changes: [{ holderId: actorId, key: 'money', value: 0 }, { holderId: actorId, key: 'quests'"),
  privateResult: (s: string) => s.replace("description: '查看了钱包'", "description: actorId + ' 余额 ' + own.money")
    .replace('money: 100, hp: 20', 'money: id === "character:friend" ? 7319 : 100, hp: 20'),
  conditionalHook: (s: string) => s.replace(HOOK, '  onRoundEnd(truth, round) { if (round < 2) return null;'
    + ' return { changes: [{ holderId: null, key: "time", value: round }], reveals: [] } },\n'),
  failedFirstHook: (s: string) => s.replace(HOOK, '  onRoundEnd(truth, round) { if (round === 1) throw new Error("首轮故障");'
    + ' return { changes: [{ holderId: null, key: "time", value: round }], reveals: [] } },\n'),
  // An author policy that breaks once the clock has moved: options vanish, the session keeps running.
  throwingPolicy: (s: string) => s.replace('  resolve(truth,', '  policy(known) { if (known.public.time >= 10) throw new Error("告示牌坏了"); return null },\n  resolve(truth,'),
  // The sample with every operation offered, so only resolve's check against the truth can stop a second claim.
  openQuests: () => readFileSync(resolve('examples/world-packs/status-market/scripts/status.js'), 'utf8')
    .replace('  policy(known) {', '  policy() { return null },\n  samplePolicy(known) {'),
  // The author hands true balances to the player's frontend; characters still get only known values.
  playerTruth: (s: string) => s.replace("key: 'money', label: '余额',", "key: 'money', label: '余额', playerTruth: true,"),
  throwingHook: (s: string) => s.replace(HOOK, '  onRoundEnd() { throw new Error("钟楼坏了") },\n'),
  // A round hook may not touch an activity-scoped status, nor tell anyone but the changed status's owner.
  scopedHook: (s: string) => s.replace(HOOK, '  onRoundEnd() { return { changes: [{ holderId: "character:player", key: "hp", value: 1 }],'
    + ' reveals: [] } },\n'),
  leakyHook: (s: string) => s.replace(HOOK, '  onRoundEnd(truth) { return { changes: [{ holderId: "character:player", key: "money",'
    + ' value: truth.characters["character:player"].money - 1 }],'
    + ' reveals: [{ observerId: "character:companion", holderId: "character:player", key: "money" }] } },\n'),
  ownerHook: (s: string) => s.replace(HOOK, '  onRoundEnd(truth, round) { return { changes: [{ holderId: "character:player", key: "money",'
    + ' value: truth.characters["character:player"].money - round }],'
    + ' reveals: [{ observerId: "character:player", holderId: "character:player", key: "money" }] } },\n') }

async function fixture(provider: 'ollama' | 'local', script: keyof typeof scripts = 'market', activity: boolean | 'quick' = false) {
  const root = mkdtempSync(join(tmpdir(), 'pack-status-runtime-')); roots.push(root)
  const packPath = join(root, 'pack'), data = join(root, 'data')
  cpSync(resolve('examples/world-packs/prototype-g1'), packPath, { recursive: true })
  mkdirSync(join(packPath, 'scripts'), { recursive: true })
  const market = readFileSync(resolve('tests/prototype/fixtures/status-market.js'), 'utf8'), variant = scripts[script](market)
  if (script !== 'market' && variant === market) throw new Error('fixture variant did not apply')
  writeFileSync(join(packPath, 'scripts/status.js'), variant)
  const source = JSON.parse(readFileSync(join(packPath, 'worldpack.source.json'), 'utf8'))
  source.assetFiles = ['scripts/status.js']
  if (script === 'quests' || script === 'invalidQuests' || script === 'openQuests') {
    for (const file of ['knowledge.json', 'documents.json', 'task-reward.md']) {
      writeFileSync(join(packPath, file), readFileSync(resolve('examples/world-packs/status-market', file)))
    }
    source.assetFiles.push('knowledge.json'); source.documentFiles = ['documents.json']; source.markdownFiles = ['task-reward.md']
  }
  if (activity) {
    const activitySource = activity === 'quick'
      ? readFileSync(resolve('tests/prototype/fixtures/status-duel.js'), 'utf8')
        .replace("npcIds: ['character:companion']", 'npcIds: []')
        .replace("id: 'yield', label: '认输'", "id: 'yield', label: '认输', quick: true")
        .replace('private: { [playerId]: {}, [npcIds[0]]: {} }', 'private: { [playerId]: {} }')
      : readFileSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/activity.js'), 'utf8')
        .replaceAll('character:gpt', 'character:companion')
    writeFileSync(join(packPath, 'scripts/activity.js'), activitySource)
    source.assetFiles.push('scripts/activity.js')
  }
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
  // A story fork rebuilds memory through Core, so forks get an empty in-process Core runner.
  const memory: CoreRunner = async input => input.operation === 'build' ? { archive: { scope: input.scope!, sources: input.sources!,
    facts: [], episodes: [], observations: [] }, index: { scope: input.scope!, units: [], vectors: [] } }
    : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
  const create = async (dataDirectory = data) => {
    const runtime = await WorldHostRuntime.create({ ...options, dataDirectory,
      ...(dataDirectory === data ? {} : { memoryCore: true, memoryCoreRun: memory, memoryCoreBuildRun: memory }) })
    runtimes.push(runtime); return runtime
  }
  const runtime = await create()
  const events = (r = runtime) => {
    const store = new WorldStore(join(r.dataDirectory, 'world.sqlite'))
    try { return store.readEvents(r.address) } finally { store.close() }
  }
  const statusEvents = (r = runtime) => events(r).filter(event => event.eventType === 'status.updated')
  return { root, data, runtime, create, requests, events, statusEvents, status: PackStatus.load(packPath, pack)!,
    setDecision: (fn: Decide) => { decide = fn } }
}
const known = (input: WorldJsonObject) => object(input.context).knownStatus as unknown as KnownStatus[]

it('interleaved private status operations keep each continuation bound to its own result', async () => {
  const f = await fixture('ollama', 'privateResult')
  const path = join(f.runtime.dataDirectory, 'world.sqlite'), address = f.runtime.address
  await f.runtime.close(); runtimes.splice(runtimes.indexOf(f.runtime), 1)
  const store = new WorldStore(path), leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  const core = createCoreRulebookRegistry({ interactionPackages: createInstalledInteractionPackages() })
    .resolve('builtin:speak-move', 2, 'test', address)
  const rules = new RulebookRegistry()
  rules.register('builtin:speak-move', 2, f.status.resolver(core, path, address, PLAYER))
  const continuations = new Map<string, WorldJsonObject>()
  let operation = 'check-purse'
  let follower: Promise<PrototypeTurnResult> | undefined
  let started!: () => void
  const followerStarted = new Promise<void>(done => { started = done })
  const turn = new PrototypeCharacterTurn({ address, store, leases, availability, rulebooks: rules,
    allowUnrelatedCommits: true, executionResult: input => f.status.executionResult(input) ?? characterExecutionResult(input),
    decide: async request => {
      const id = String(object(request.context.character).characterId)
      if (request.continuation) {
        continuations.set(id, request.result!)
        return { decision: 'abstain' }
      }
      if (id === BYSTANDER) started()
      return { decision: 'perform', actionType: 'interact', parameters: { targetRef: { kind: 'character', id },
        bindingId: 'status', definitionRef: { id: 'status:' + operation, version: 1 },
        arguments: operation === 'buy' ? { price: 1 } : {} } }
    },
    onCommitted: async () => {
      if (!follower) {
        // Queue the other actor's commit before the first actor builds its continuation.
        follower = turn.run(brandId(BYSTANDER, 'CharacterId'))
        await followerStarted
      }
    },
  })
  try {
    const first = await turn.run(brandId(THIEF, 'CharacterId')); await follower
    expect(continuations.get(THIEF)).toMatchObject({ description: THIEF + ' 余额 100' })
    expect(continuations.get(BYSTANDER)).toMatchObject({ description: BYSTANDER + ' 余额 7319' })
    expect(JSON.stringify(continuations.get(THIEF))).not.toContain('7319')
    // Actor/operation matching alone is insufficient after the same actor performs that operation again.
    operation = 'buy'
    await turn.run(brandId(THIEF, 'CharacterId'))
    operation = 'check-purse'
    await turn.run(brandId(THIEF, 'CharacterId'))
    expect(continuations.get(THIEF)).toMatchObject({ description: THIEF + ' 余额 99' })
    const prior = first.performResult!, action = object(prior.action)
    await turn.run(brandId(THIEF, 'CharacterId'), { continuationOf: { actionId: String(prior.operationId),
      action: { actionType: String(action.actionType), parameters: action.parameters! } } })
    expect(continuations.get(THIEF)).toMatchObject({ description: THIEF + ' 余额 100' })
  } finally { availability.close(); leases.close(); store.close() }
}, 60_000)

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

  // Initial values, the theft, then the round hook as the round's last status event.
  const updates = f.statusEvents()
  expect(updates.map(e => object(object(e.data).source).kind)).toEqual(['initial', 'operation', 'round'])
  expect(f.status.truth(updates).characters[PLAYER]!.money).toBe(70)
  expect(f.status.truth(updates).characters[THIEF]!.money).toBe(130)
  expect(f.status.known(updates, PLAYER)).toContainEqual({ key: 'money', label: '余额', holderId: PLAYER, value: 100, current: false })
  expect(f.status.known(updates, THIEF)).toContainEqual({ key: 'money', label: '余额', holderId: THIEF, value: 130, current: true })
  // The player's status bar is the player's known values only; the creator debug view shows the truth.
  const bar = (await f.runtime.state()).statusBar!
  expect(bar).toContainEqual(expect.objectContaining({ key: 'money', holderId: PLAYER, value: 100, current: false }))
  expect(bar.find(entry => entry.holderId === PLAYER)).toMatchObject({ holderName: expect.any(String), self: true })
  expect(bar.filter(entry => entry.self).every(entry => entry.holderId === PLAYER)).toBe(true)
  expect(bar.some(entry => entry.holderId === THIEF)).toBe(false)
  expect(f.runtime.creatorInspection().statusTruth).toEqual({ public: { time: 10 },
    characters: expect.objectContaining({ [PLAYER]: { money: 70, hp: 20 }, [THIEF]: { money: 130, hp: 20 } }) })

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
  expect(f.statusEvents().filter(e => object(object(e.data).source).kind === 'operation')).toHaveLength(1)
}, 60_000)

it('a playerTruth status reaches the player state as truth while every character keeps only known values', async () => {
  const plain = await fixture('local')
  plain.setDecision(() => ({ decision: 'abstain' }))
  await plain.runtime.submit('/act speak {"text":"开始。","scope":"scene_public"}')
  expect((await plain.runtime.state()).statusTruth).toBeUndefined()

  const f = await fixture('local', 'playerTruth')
  let stolen = false
  f.setDecision(input => {
    if (actor(input) !== THIEF || stolen || input.continuation) return { decision: 'abstain' }
    stolen = true; return steal
  })
  await f.runtime.submit('/act speak {"text":"今天集市人真多。","scope":"scene_public"}')
  await f.runtime.submit('/act speak {"text":"大家注意钱包。","scope":"scene_public"}')
  const state = await f.runtime.state()
  expect(state.statusTruth).toContainEqual(expect.objectContaining({ key: 'money', holderId: PLAYER, value: 70, self: true }))
  expect(state.statusTruth).toContainEqual(expect.objectContaining({ key: 'money', holderId: THIEF, value: 130 }))
  expect(state.statusTruth?.some(row => row.key !== 'money')).toBe(false)
  // The known bar is unchanged by the opt-in.
  expect(state.statusBar).toContainEqual(expect.objectContaining({ key: 'money', holderId: PLAYER, value: 100, current: false }))
  expect(projectPlayerView(state).statusTruth).toEqual(state.statusTruth)
  // No character request carries a truth field or another holder's balance.
  for (const input of f.requests) {
    expect(object(input.context)).not.toHaveProperty('statusTruth')
    expect(known(input).filter(k => k.key === 'money' && k.holderId !== actor(input))).toEqual([])
  }
}, 60_000)

const rejections = [
  { name: 'a target that left the scene', move: true, targetId: PLAYER, text: '操作指定的角色不在你当前的场景里，什么都没有发生。' },
  { name: 'an author rejectReason', move: false, targetId: THIEF, text: '不能偷自己的钱袋' },
] as const
for (const provider of ['ollama', 'local'] as const) {
  for (const c of rejections) {
    it(`${c.name} is rejected back to the thief without any status commit (${provider})`, async () => {
      const f = await fixture(provider, 'noHook')
      let headAtRequest: number | undefined, attempted = false
      const continuations: WorldJsonObject[] = []
      f.setDecision(input => {
        if (actor(input) !== THIEF) return { decision: 'abstain' }
        if (input.continuation) { continuations.push(input); return { decision: 'abstain' } }
        if (attempted) return { decision: 'abstain' }
        attempted = true
        const store = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
        try { headAtRequest = store.head(f.runtime.address).headSeq } finally { store.close() }
        return { ...steal, parameters: { ...steal.parameters, arguments: { targetId: c.targetId } } }
      })
      const before = f.statusEvents()
      // With `move`, the player leaves; the thief, still in the front room, tries to rob someone who is gone.
      const state = await f.runtime.submit(c.move ? '/act move {"locationId":"location:back-room"}'
        : '/act speak {"text":"看好你的钱袋。","scope":"scene_public"}')
      expect(state.error, JSON.stringify(state.debug)).toBe(false)
      expect(f.statusEvents()).toEqual(before)
      // Only the rejected action's own round is committed after the thief's request.
      const rejected = f.events().filter(e => e.seq > headAtRequest!)
      expect(rejected.map(e => e.eventType)).toContain('action.rejected')
      expect(new Set(rejected.map(e => e.tick)).size).toBe(1)
      expect(continuations).toHaveLength(1)
      expect(object(continuations[0]!.result)).toMatchObject({ status: 'rejected', description: c.text })
      expect(JSON.stringify(continuations[0]!.result)).not.toMatch(/余额|money/u)
    }, 60_000)
  }
}

it.each(['ollama', 'local'] as const)('narration claiming a theft changes nothing (%s)', async provider => {
  const f = await fixture(provider, 'noHook')
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

const source = (event: { data: unknown }) => object(object(event.data).source)
const speak = (text: string) => '/act speak ' + JSON.stringify({ text, scope: 'scene_public' })

it('structured quest state unlocks options, grants a reward once, and follows regeneration and story forks', async () => {
  const f = await fixture('local', 'quests')
  const offered = async () => (await f.runtime.state()).availableActions!.flatMap(a => a.interactions ?? [])
    .map(option => object(option.definitionRef).id)
  expect(await offered()).toContain('status:accept-task')
  expect(await offered()).not.toContain('status:claim-reward')
  const head = f.events().length
  await expect(f.runtime.submit('/status claim-reward {}')).rejects.toThrow('已知条件')
  expect(f.events()).toHaveLength(head)
  await f.runtime.submit('/status accept-task {}')
  expect(await offered()).toContain('status:finish-task')
  await f.runtime.submit('/status finish-task {}')
  expect(await offered()).toContain('status:claim-reward')
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.quests).toEqual({
    market: { stage: 'done', notes: ['领取委托', '完成演示流程'] } })
  const node = await f.runtime.saveNode('委托完成，尚未领奖')
  await f.runtime.submit('/status claim-reward {}')
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.money).toBe(130)
  expect(await offered()).not.toContain('status:claim-reward')
  const tail = (await f.runtime.state()).tailRound!
  await f.runtime.regenerate(tail.id!, randomUUID())
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.money).toBe(130)
  const after = f.events().length
  await expect(f.runtime.submit('/status claim-reward {}')).rejects.toThrow('已知条件')
  expect(f.events()).toHaveLength(after)
  await f.runtime.close(); runtimes.splice(runtimes.indexOf(f.runtime), 1)
  const target = join(f.root, 'quest-fork')
  restoreStoryNode(f.data, node.id, target, node.packHash)
  const child = await f.create(target)
  expect(f.status.truth(f.statusEvents(child)).characters[PLAYER]!.money).toBe(100)
  await child.submit('/status claim-reward {}')
  expect(f.status.truth(f.statusEvents(child)).characters[PLAYER]!.money).toBe(130)
}, 90_000)

it('a second reward claim is refused by the true quest stage when the policy offers it', async () => {
  const f = await fixture('local', 'openQuests')
  await f.runtime.submit('/status accept-task {}')
  await f.runtime.submit('/status finish-task {}')
  await f.runtime.submit('/status claim-reward {}')
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.money).toBe(130)
  const offered = (await f.runtime.state()).availableActions!.flatMap(a => a.interactions ?? []).map(o => object(o.definitionRef).id)
  expect(offered).toContain('status:claim-reward')
  const head = f.events().length, updates = f.statusEvents().length
  await expect(f.runtime.submit('/status claim-reward {}')).rejects.toThrow('委托未完成或已经领取过报酬')
  expect(f.events()).toHaveLength(head)
  expect(f.statusEvents()).toHaveLength(updates)
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.money).toBe(130)
}, 60_000)

it('a throwing author policy hides status options but keeps the session and NPC turns running', async () => {
  const f = await fixture('ollama', 'throwingPolicy')
  const ids = (affordances: unknown) => (affordances as WorldJsonObject[]).flatMap(a => (a.interactions as WorldJsonObject[] | undefined) ?? [])
    .map(o => String(object(o.definitionRef).id)).filter(id => id.startsWith('status:'))
  expect(ids((await f.runtime.state()).availableActions)).toContain('status:check-purse')
  // The first round's hook moves the clock to 10; from then on the policy throws.
  expect((await f.runtime.submit(speak('第一轮。'))).error).toBe(false)
  const state = await f.runtime.state()
  expect(ids(state.availableActions)).toEqual([])
  expect(state.statusBar).toContainEqual(expect.objectContaining({ key: 'time', value: 10 }))
  expect(String(object(state.debug.statusPolicyError)[PLAYER])).toContain('告示牌坏了')
  const after = f.requests.length
  const second = await f.runtime.submit(speak('第二轮。'))
  expect(second.error, JSON.stringify(second.debug)).toBe(false)
  const npc = f.requests.slice(after).filter(input => actor(input) === THIEF)
  expect(npc.length).toBeGreaterThan(0)
  for (const input of npc) expect(ids(object(input.context).affordances)).toEqual([])
  expect(String(object(second.debug.statusPolicyError)[THIEF])).toContain('告示牌坏了')
  expect(f.status.truth(f.statusEvents()).public.time).toBe(20)
  // Executing an operation still runs the policy, and its failure stays the author's fault.
  const head = f.events().length
  await expect(f.runtime.submit('/status check-purse {}')).rejects.toThrow('告示牌坏了')
  expect(f.events()).toHaveLength(head)
}, 60_000)

it('invalid nested changes reject the entire operation without spending money or committing a round', async () => {
  const f = await fixture('ollama', 'invalidQuests'), before = f.events()
  await expect(f.runtime.submit('/status accept-task {}')).rejects.toThrow('schema')
  expect(f.events()).toEqual(before)
  expect(f.status.truth(f.statusEvents()).characters[PLAYER]!.money).toBe(100)
}, 60_000)

it.each(['ollama', 'local'] as const)('NPC nested-state conditions control both options and delivered knowledge (%s)', async provider => {
  const f = await fixture(provider, 'quests')
  f.setDecision(input => {
    if (actor(input) !== THIEF || input.continuation) return { decision: 'abstain' }
    const own = known(input).find(row => row.key === 'quests' && row.holderId === THIEF)?.value as WorldJsonObject
    const stage = (own.market as WorldJsonObject | undefined)?.stage
    const operation = stage === undefined ? 'accept-task' : stage === 'active' ? 'finish-task' : stage === 'done' ? 'claim-reward' : undefined
    return operation === undefined ? { decision: 'abstain' } : { decision: 'perform', actionType: 'interact', parameters: {
      targetRef: { kind: 'character', id: THIEF }, bindingId: 'status', definitionRef: { id: 'status:' + operation, version: 1 }, arguments: {} } }
  })
  await f.runtime.submit(speak('第一轮。'))
  await f.runtime.submit(speak('第二轮。'))
  const done = f.requests.findLast(input => actor(input) === THIEF && input.continuation)!
  expect(JSON.stringify(object(done.context).knowledge)).toContain('你的演示委托已经完成')
  const others = f.requests.filter(input => actor(input) === BYSTANDER)
  expect(others.length).toBeGreaterThan(0)
  for (const input of others) {
    expect(JSON.stringify(object(input.context).knowledge)).not.toContain('你的演示委托已经完成')
    expect(known(input).some(row => row.key === 'quests' && row.holderId === THIEF)).toBe(false)
  }
  await f.runtime.submit(speak('第三轮。'))
  const claimed = f.requests.findLast(input => actor(input) === THIEF && input.continuation)!
  expect(JSON.stringify(object(claimed.context).knowledge)).not.toContain('你的演示委托已经完成')
  expect(f.status.truth(f.statusEvents()).characters[THIEF]!.money).toBe(130)
}, 90_000)

it('player buy with too little money is accepted, spends nothing and reveals the true balance', async () => {
  const f = await fixture('ollama')
  let stolen = false
  f.setDecision(input => {
    if (actor(input) !== THIEF || stolen || input.continuation) return { decision: 'abstain' }
    stolen = true; return steal
  })
  expect((await f.runtime.submit(speak('今天集市人真多。'))).error).toBe(false)
  expect(f.status.known(f.statusEvents(), PLAYER)).toContainEqual({ key: 'money', label: '余额', holderId: PLAYER, value: 100, current: false })
  // The interaction menu maps a status operation onto the replayable `/status` text command.
  const state = await f.runtime.perform({ actionType: 'interact', parameters: { targetRef: { kind: 'character', id: PLAYER },
    bindingId: 'status', definitionRef: { id: 'status:buy', version: 1 }, arguments: { price: 90 } } })
  expect(state.error, JSON.stringify(state.debug)).toBe(false)
  const updates = f.statusEvents(), buy = updates.find(e => source(e).operation === 'buy')!
  expect(object(buy.data)).toMatchObject({ source: { kind: 'operation', operation: 'buy', actorId: PLAYER }, changes: [],
    reveals: [{ observerId: PLAYER, holderId: PLAYER, key: 'money', value: 70 }], description: '余额不足' })
  expect(f.status.truth(updates).characters[PLAYER]!.money).toBe(70)
  expect(f.status.truth(updates).characters[THIEF]!.money).toBe(130)
  expect(f.status.known(updates, PLAYER)).toContainEqual({ key: 'money', label: '余额', holderId: PLAYER, value: 70, current: true })
  expect(f.status.known(updates, THIEF).filter(k => k.holderId === PLAYER && k.key === 'money')).toEqual([])
  // The result goes to the player alone (audience self), in the same commit as the status event.
  const round = f.events().filter(e => e.seq >= buy.seq && e.tick === buy.tick)
  const observations = round.filter(e => e.eventType === 'observation.upsert').map(e => object(object(e.data).value))
  expect(observations.map(o => o.observerId)).toEqual([PLAYER])
  expect(object(observations[0]!.content)).toMatchObject({ status: 'accepted', actorId: PLAYER, resultDescription: '余额不足' })
  expect(round.find(e => e.eventType === 'action.resolved')?.data).toMatchObject({ actorId: PLAYER, accepted: true, sourceRole: 'player' })
}, 60_000)

it('an invalid parameter rejects without commit', async () => {
  const f = await fixture('ollama')
  const head = f.events().length
  await expect(f.runtime.submit('/status buy {"price":"x"}')).rejects.toThrow('操作缺少有效的必要信息，什么都没有发生。')
  await expect(f.runtime.submit('/status steal {"targetId":"character:companion"}')).rejects.toThrow('你不能进行这个操作')
  await expect(f.runtime.submit('/status drink-potion {}')).rejects.toThrow('只能在指定活动中进行')
  expect(f.events()).toHaveLength(head)
}, 60_000)

it('onRoundEnd advances time once per accepted player input', async () => {
  const f = await fixture('ollama')
  const time = () => f.status.truth(f.statusEvents()).public.time
  for (const text of ['一', '二', '三']) expect((await f.runtime.submit(speak(text))).error).toBe(false)
  expect(time()).toBe(30)
  await expect(f.runtime.submit('/status buy {"price":"x"}')).rejects.toThrow()
  const head = f.events().length, clarification = await f.runtime.submit('/nonsense 1')
  expect(clarification.notice).toContain('没有提交')
  expect(f.events()).toHaveLength(head)
  expect(time()).toBe(30)
  // An accepted status command is a player input too; its round ends with the hook after the operation.
  await f.runtime.submit('/status set-time {"value":100}')
  expect(time()).toBe(110)
  expect(f.statusEvents().filter(e => source(e).kind === 'round').map(e => source(e).round)).toEqual([1, 2, 3, 4])
  expect(source(f.statusEvents().at(-1)!)).toEqual({ kind: 'round', round: 4 })
  // A retried request (same key) returns the original result and ends no further round.
  const key = randomUUID()
  await f.runtime.submit('/status set-time {"value":200}', key)
  const committed = f.events().length
  expect((await f.runtime.submit('/status set-time {"value":200}', key)).notice).toContain('没有再次执行')
  expect(f.events()).toHaveLength(committed)
  expect(time()).toBe(210)
}, 60_000)

it('a throwing onRoundEnd keeps the round and leaves status unchanged', async () => {
  const f = await fixture('ollama', 'throwingHook')
  const state = await f.runtime.submit(speak('钟声呢？'))
  expect(JSON.stringify(f.events())).toContain('钟声呢？')
  expect(f.statusEvents()).toHaveLength(1)
  expect(f.status.truth(f.statusEvents()).public.time).toBe(0)
  expect(String(state.debug.statusRoundError)).toContain('钟楼坏了')
}, 60_000)

it('replaying a committed speech does not run the round hook again', async () => {
  const f = await fixture('ollama'), key = randomUUID(), input = speak('只说一次。')
  await f.runtime.submit(input, key)
  const before = f.statusEvents()
  await f.runtime.submit(input, key)
  expect(f.statusEvents()).toEqual(before)
  expect(f.events().filter(e => e.eventType === 'character.speak')).toHaveLength(1)
  expect(f.status.truth(f.statusEvents()).public.time).toBe(10)
}, 60_000)

it.each(['conditionalHook', 'failedFirstHook'] as const)('round numbers advance after a hook commits nothing (%s)', async script => {
  const f = await fixture('ollama', script)
  await f.runtime.submit(speak('第一轮。'))
  expect(f.statusEvents()).toHaveLength(1)
  await f.runtime.submit(speak('第二轮。'))
  expect(f.status.truth(f.statusEvents()).public.time).toBe(2)
  await f.runtime.submit('/status check-purse {}')
  expect(f.status.truth(f.statusEvents()).public.time).toBe(3)
  expect(f.statusEvents().filter(e => source(e).kind === 'round').map(e => source(e).round)).toEqual([2, 3])
}, 60_000)

it('a quick activity action counts its start and operation as one player round', async () => {
  const f = await fixture('ollama', 'conditionalHook', 'quick')
  await f.runtime.activityAction({ activityId: null, revision: 0, operation: 'yield', parameters: {}, requestId: randomUUID() })
  expect(f.statusEvents()).toHaveLength(1)
  await f.runtime.submit(speak('快捷行动之后的第二轮。'))
  expect(f.status.truth(f.statusEvents()).public.time).toBe(2)
}, 60_000)

it('retrying NPC processing in an activity does not create another player status round', async () => {
  const f = await fixture('ollama', 'market', true)
  const started = await f.runtime.activityAction({ activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: randomUUID() })
  const before = f.statusEvents(), activity = started.activity!
  await f.runtime.activityAction({ activityId: String(activity.id), revision: Number(activity.revision),
    operation: 'retry', parameters: {}, requestId: randomUUID() })
  expect(f.statusEvents()).toEqual(before)
}, 60_000)

it.each(['scopedHook', 'leakyHook'] as const)('a round hook breaking its limits commits nothing (%s)', async script => {
  const f = await fixture('ollama', script)
  const state = await f.runtime.submit(speak('又一轮。'))
  expect(JSON.stringify(f.events())).toContain('又一轮。')
  expect(f.statusEvents()).toHaveLength(1)
  expect(state.debug.statusRoundError).toEqual(expect.any(String))
}, 60_000)

it('a round hook may tell only the owner of the status it changed', async () => {
  const f = await fixture('ollama', 'ownerHook')
  const state = await f.runtime.submit(speak('一轮过去。'))
  expect(state.debug.statusRoundError).toBeUndefined()
  const updates = f.statusEvents()
  expect(f.status.truth(updates).characters[PLAYER]!.money).toBe(99)
  expect(f.status.known(updates, PLAYER)).toContainEqual({ key: 'money', label: '余额', holderId: PLAYER, value: 99, current: true })
  expect(object(updates.at(-1)!.data)).toEqual({ source: { kind: 'round', round: 1 },
    changes: [{ holderId: PLAYER, key: 'money', value: 99 }], reveals: [{ observerId: PLAYER, holderId: PLAYER, key: 'money', value: 99 }] })
}, 60_000)

it("tail regeneration replays the round once and shows the selected candidate's values", async () => {
  const f = await fixture('ollama')
  const truth = () => f.status.truth(f.statusEvents())
  await f.runtime.submit(speak('看看时间。'))
  expect(truth().public.time).toBe(10)
  const original = (await f.runtime.state()).tailRound!
  let stolen = false
  f.setDecision(input => {
    if (actor(input) !== THIEF || stolen || input.continuation) return { decision: 'abstain' }
    stolen = true; return steal
  })
  const next = await f.runtime.regenerate(original.id!, randomUUID())
  expect(next.tailRound!.candidateIds).toHaveLength(2)
  // The candidate starts from the round's base: one hook run, not one more on top of the original.
  expect(truth().public.time).toBe(10)
  expect(truth().characters[PLAYER]!.money).toBe(70)
  expect(f.statusEvents().filter(e => source(e).kind === 'round').map(e => source(e).round)).toEqual([1])
  await f.runtime.selectCandidate(next.tailRound!.id!, original.candidateIds![0]!, randomUUID())
  expect(truth().public.time).toBe(10)
  expect(truth().characters[PLAYER]!.money).toBe(100)
}, 90_000)

it('story node fork restores status to the node', async () => {
  const f = await fixture('local')
  await f.runtime.submit(speak('十点了。'))
  const node = await f.runtime.saveNode('十点'), atNode = f.statusEvents()
  await f.runtime.submit('/status set-time {"value":500}')
  expect(f.status.truth(f.statusEvents()).public.time).toBe(510)
  await f.runtime.close(); runtimes.splice(runtimes.indexOf(f.runtime), 1)
  const target = join(f.root, 'child')
  restoreStoryNode(f.data, node.id, target, node.packHash)
  const child = await f.create(target)
  expect(f.statusEvents(child)).toEqual(atNode)
  expect(f.status.truth(f.statusEvents(child)).public.time).toBe(10)
  await child.submit(speak('分叉之后。'))
  expect(f.status.truth(f.statusEvents(child)).public.time).toBe(20)
}, 90_000)

it('speech during a running activity is an accepted input and ends one status round', async () => {
  const f = await fixture('ollama', 'market', true)
  const time = () => f.status.truth(f.statusEvents()).public.time
  const started = await f.runtime.activityAction({ activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: randomUUID() })
  expect(started.activity?.id).toEqual(expect.any(String))
  const before = Number(time())
  await f.runtime.submit('活动中说一句。')
  expect(JSON.stringify(f.events())).toContain('活动中说一句。')
  expect(time()).toBe(before + 10)
}, 60_000)
