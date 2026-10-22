import { createServer, type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { type WorldJsonObject } from '@harness-world/contracts'
import {
  currentEntityState,
  currentLocation,
  createCoreRulebookRegistry,
  type CompiledWorldManifest,
} from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { compileWorldPackSource } from '@harness-world/world-pack'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { interactionPackageDescription } from '@harness-world/contracts'
import { playSettings } from '../../desktop/play-settings.ts'
import { PackAutonomy } from '../../desktop/host/pack-autonomy.ts'
import { WorldHostRuntime, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { WAIT_ACTION } from '../../desktop/host/http-server.ts'
import type { PlaySettings } from '../../desktop/play-settings.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = [],
  releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const object = (value: unknown) => value as WorldJsonObject
const context = (input: WorldJsonObject) => object(input.context)
const actor = (input: WorldJsonObject) => String(object(context(input).character).characterId)
const move = (locationId: string) => ({ decision: 'perform', actionType: 'move', parameters: { locationId } })
const publish = (text: string) => ({ decision: 'publish', segments: [{ type: 'speech', text }] })
const take = () => ({
  decision: 'perform',
  actionType: 'interact',
  parameters: {
    targetRef: { kind: 'entity', id: 'entity:brass-key' },
    bindingId: 'status',
    definitionRef: { id: 'status:take', version: 1 },
    arguments: {},
  },
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  releases.push(resolve)
  return { promise, resolve }
}
async function fixture(
  change?: (
    role: { -readonly [K in keyof WorldJsonObject]: WorldJsonObject[K] },
    pack: string,
    config: { characters: WorldJsonObject[] },
  ) => void,
  settings: Partial<PlaySettings> = {},
  controls: Pick<WorldHostOptions, 'stagedAutonomy' | 'serialScheduling'> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'character-autonomy-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/character-autonomy'), pack, { recursive: true })
  const config = JSON.parse(readFileSync(join(pack, 'autonomy.json'), 'utf8'))
  change?.(config.characters[0], pack, config)
  writeFileSync(join(pack, 'autonomy.json'), JSON.stringify(config))
  const requests: WorldJsonObject[] = []
  let decision: (input: WorldJsonObject) => unknown | Promise<unknown> = () => ({ decision: 'abstain' })
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      void (async () => {
        try {
          const input = JSON.parse(
            JSON.parse(body).messages.findLast((message: { role: string }) => message.role === 'user').content,
          ) as WorldJsonObject
          requests.push(input)
          const output = await decision(input)
          if (!response.destroyed) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ message: { content: JSON.stringify(output) } }))
          }
        } catch {
          if (!response.destroyed) {
            response.writeHead(503)
            response.end('fixture failed')
          }
        }
      })()
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const options = {
    packPath: pack,
    dataDirectory: data,
    provider: 'ollama' as const,
    model: 'fixture',
    utilityEndpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/chat',
    timeoutMs: 5000,
    playSettings: playSettings(settings),
    ...controls,
  }
  const create = async () => {
    const runtime = await WorldHostRuntime.create(options)
    runtimes.push(runtime)
    return runtime
  }
  const runtime = await create()
  const events = (r = runtime) => {
    const store = new WorldStore(join(r.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(r.address)
    } finally {
      store.close()
    }
  }
  return {
    runtime,
    create,
    pack,
    requests,
    events,
    setDecision: (fn: typeof decision) => {
      decision = fn
    },
  }
}
const autonomous = (requests: WorldJsonObject[]) => requests.filter(input => context(input).autonomy !== undefined)

it('wakes an off-scene role with its own goal and no private player stimulus, then commits movement and reacts locally', async () => {
  const f = await fixture()
  f.setDecision(input =>
    context(input).autonomy
      ? input.continuation
        ? publish('我来讨论今天的安排。')
        : move('location:front-room')
      : actor(input) === 'character:companion' &&
          context(input).history &&
          JSON.stringify(context(input).history).includes('今天的安排')
        ? publish('我们一起商量。')
        : { decision: 'abstain' },
  )
  const state = await f.runtime.submit(
    '/act speak {"text":"私语暗号青竹","scope":"private","addresseeIds":["character:companion"]}',
  )
  expect(state.error).toBe(false)
  const calls = autonomous(f.requests)
  expect(calls).toHaveLength(2)
  expect(context(calls[0]!).stimulus).toEqual([])
  expect(JSON.stringify(calls[0])).toContain('想清楚今天自己的安排')
  expect(JSON.stringify(calls)).not.toContain('私语暗号青竹')
  expect(calls[1]!.result).toMatchObject({ status: 'accepted' })
  expect(currentLocation(f.events(), 'character:friend')).toBe('location:front-room')
  expect(state.transcript.some(line => line.text.includes('我们一起商量'))).toBe(true)
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 2 })
}, 60_000)

it('counts matching player turns rather than ticks, does not count rejected actions or retries, and restores frequency on reopen/replay', async () => {
  const f = await fixture(role => {
    role.everyPlayerTurns = 2
  })
  await f.runtime.submit('第一回合', 'first')
  await f.runtime.submit('第一回合', 'first')
  expect(autonomous(f.requests)).toHaveLength(0)
  await f.runtime.submit('/act move {"locationId":"location:missing"}')
  expect(autonomous(f.requests)).toHaveLength(0)
  await f.runtime.close()
  const reopened = await f.create()
  const second = await reopened.submit('第二回合')
  expect(autonomous(f.requests)).toHaveLength(1)
  f.requests.length = 0
  await reopened.regenerate(second.tailRound!.id!, randomUUID())
  expect(autonomous(f.requests)).toHaveLength(1)
  f.requests.length = 0
  await reopened.submit('第三回合')
  expect(autonomous(f.requests)).toHaveLength(0)
}, 90_000)

it.each([
  { opportunities: 1, turns: 3 },
  { opportunities: 4, turns: 1 },
])(
  'continues an isolated goal with $opportunities opportunities and no external observations',
  async ({ opportunities, turns }) => {
    const f = await fixture(
      (role, pack) => {
        role.opportunities = 4
        role.interactions = ['status:take', 'status:drop']
        role.targetIds = ['entity:brass-key']
        const entities = JSON.parse(readFileSync(join(pack, 'entities.json'), 'utf8'))
        entities.entities[0].locationId = 'location:back-room'
        writeFileSync(join(pack, 'entities.json'), JSON.stringify(entities))
      },
      { autonomyOpportunities: opportunities, autonomyNpcCalls: 10, autonomyReactionWaves: 0 },
    )
    f.setDecision(input => {
      expect(context(input).autonomy).toBeDefined()
      if (input.continuation) return { decision: 'abstain' }
      const item = (object(context(input).items).current as WorldJsonObject[]).find(
        item => item.entityId === 'entity:brass-key',
      )!
      if (item.holderId === null && item.locationId === 'location:front-room') return { decision: 'abstain' }
      if (item.holderId === 'character:friend' && context(input).locationId !== 'location:front-room')
        return move('location:front-room')
      if (item.holderId === null) return take()
      return {
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'entity', id: 'entity:brass-key' },
          bindingId: 'status',
          definitionRef: { id: 'status:drop', version: 1 },
          arguments: {},
        },
      }
    })
    for (let index = 0; index < turns; index++) {
      const state = await f.runtime.submit(
        '/act speak ' + JSON.stringify({ text: '我只记下自己的笔记。', scope: 'self', addresseeIds: [] }),
      )
      expect(state.error).toBe(false)
    }
    expect(f.requests.every(input => actor(input) === 'character:friend')).toBe(true)
    expect(currentEntityState(f.events(), 'entity:brass-key')).toMatchObject({
      holderId: null,
      locationId: 'location:front-room',
    })
    const resolved = f
      .events()
      .filter(event => event.eventType === 'action.resolved' && object(event.data).actorId === 'character:friend')
    expect(resolved.map(event => object(event.data).actionType)).toEqual(['interact', 'move', 'interact'])
    const external = f
      .events()
      .filter(
        event =>
          event.eventType === 'observation.upsert' &&
          object(object(event.data).value).observerId === 'character:friend' &&
          typeof object(object(object(event.data).value).content).actorId === 'string' &&
          object(object(object(event.data).value).content).actorId !== 'character:friend',
      )
    expect(external).toHaveLength(0)
  },
  60000,
)

it('matches specific committed interactions and leaves ordinary speech uncounted', async () => {
  const f = await fixture(role => {
    role.triggers = [{ actionType: 'interact', definitionId: 'status:take' }]
  })
  await f.runtime.submit('随便聊聊')
  expect(autonomous(f.requests)).toHaveLength(0)
  await f.runtime.submit('/status take@entity:brass-key {}')
  expect(autonomous(f.requests)).toHaveLength(1)
  expect(currentEntityState(f.events(), 'entity:brass-key')?.holderId).toBe('character:player')
}, 60_000)

it('lets a round pass on wait: the round is recorded, every autonomous role gets its turn, nothing is said', async () => {
  const f = await fixture(role => {
    // Waiting is the player's turn whatever the triggers say.
    role.triggers = [{ actionType: 'interact', definitionId: 'status:take' }]
  })
  f.setDecision(input => (context(input).autonomy ? publish('我先去后屋看看。') : { decision: 'abstain' }))
  const before = await f.runtime.state()
  expect(before.canWait).toBe(true)
  expect(projectPlayerView(before).actions.find(option => option.id === 'wait')?.action).toEqual(WAIT_ACTION)
  const state = await f.runtime.perform(WAIT_ACTION)
  expect(state.error).toBe(false)
  const calls = autonomous(f.requests)
  expect(calls).toHaveLength(1)
  expect(context(calls[0]!).stimulus).toEqual([])
  const rounds = f
    .events()
    .filter(e => e.eventType === 'status.updated' && object(object(e.data).source).kind === 'round')
  expect(rounds.map(e => object(e.data).source)).toEqual([{ kind: 'round', round: 1, pause: true }])
  // No line from the player, only a marked empty entry a frontend may show or skip.
  expect(
    f.events().some(e => e.eventType === 'character.speak' && object(e.data).characterId === 'character:player'),
  ).toBe(false)
  const pause = state.transcript.filter(line => line.pause)
  expect(pause).toEqual([expect.objectContaining({ seq: rounds[0]!.seq, text: '', player: true, pause: true })])
  expect(projectPlayerView(state).history.find(line => line.pause)).toMatchObject({ pause: true, text: '' })
  // The next spoken round counts after the wait, and regenerating the wait replays it as a wait.
  f.requests.length = 0
  await f.runtime.regenerate(state.tailRound!.id!, randomUUID())
  expect(autonomous(f.requests)).toHaveLength(1)
  const next = await f.runtime.submit('随便聊聊')
  expect(next.error).toBe(false)
  expect(
    f
      .events()
      .filter(e => e.eventType === 'status.updated' && object(object(e.data).source).kind === 'round')
      .map(e => object(object(e.data).source).round),
  ).toEqual([1])
}, 60_000)

it('merges a present role ordinary response into its autonomous opportunity and caps author requests', async () => {
  const f = await fixture(role => {
    role.opportunities = 5
  })
  f.setDecision(input =>
    context(input).autonomy && !input.continuation ? move('location:front-room') : { decision: 'abstain' },
  )
  await f.runtime.submit('先准备一下')
  f.requests.length = 0
  f.setDecision(() => ({ decision: 'abstain' }))
  await f.runtime.submit('现在同场交谈')
  expect(f.requests.filter(input => actor(input) === 'character:friend')).toHaveLength(1)
  expect(autonomous(f.requests)).toHaveLength(1)
}, 60_000)

it.each(['location', 'interaction', 'target'])(
  'enforces the autonomous %s restriction even for a direct model proposal',
  async restriction => {
    const f = await fixture(role => {
      if (restriction === 'location') role.locationIds = ['location:back-room']
      if (restriction === 'target') {
        role.interactions = ['status:take']
        role.targetIds = ['character:companion']
      }
    })
    f.setDecision(input =>
      !context(input).autonomy
        ? { decision: 'abstain' }
        : input.continuation
          ? publish('这次没有执行。')
          : restriction === 'location'
            ? move('location:front-room')
            : take(),
    )
    const state = await f.runtime.submit('请继续做你自己的事')
    if (restriction === 'location') {
      expect(state.error).toBe(false)
      expect(autonomous(f.requests)[1]!.result).toMatchObject({ status: 'rejected' })
    } else {
      // No legal interact branch exists: strict format validation now stops this proposal before execution.
      expect(state.error).toBe(true)
      expect(autonomous(f.requests)).toHaveLength(2)
      expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 2 })
      expect(
        f
          .events()
          .filter(event => event.eventType === 'action.resolved' && object(event.data).actorId === 'character:friend'),
      ).toHaveLength(0)
    }
    // Keep independently checking execution authority, even when the model boundary rejects first.
    const compiled = await compileWorldPackSource(
      f.pack,
      createInstalledInteractionPackages().map(interactionPackageDescription),
    )
    const policy = PackAutonomy.load(f.pack, compiled, 'character:player')!
    const base = createCoreRulebookRegistry({ interactionPackages: createInstalledInteractionPackages() })
    const rules = policy
      .rulebooks(base.resolve('builtin:speak-move', 2, 'test', f.runtime.address))
      .resolve('builtin:speak-move', 2, 'test', f.runtime.address)
    const store = new WorldStore(join(f.runtime.dataDirectory, 'world.sqlite'))
    try {
      const proposal = restriction === 'location' ? move('location:front-room') : take()
      expect(
        rules.resolve({
          manifest: store.readManifest(f.runtime.address)!.manifest as CompiledWorldManifest,
          events: store.readEvents(f.runtime.address),
          characterId: 'character:friend',
          action: { actionType: proposal.actionType, actionVersion: 1, parameters: proposal.parameters },
        }),
      ).toMatchObject({ status: 'rejected', events: [] })
    } finally {
      store.close()
    }
    expect(currentLocation(f.events(), 'character:friend')).toBe('location:back-room')
    expect(currentEntityState(f.events(), 'entity:brass-key')?.holderId).toBe(null)
    expect(JSON.stringify(context(autonomous(f.requests)[0]!).affordances)).not.toContain(
      restriction === 'location' ? 'location:front-room' : 'status',
    )
  },
  60_000,
)

it('includes recall and execution continuation in the strict autonomous call budget', async () => {
  const f = await fixture(undefined, { autonomyNpcCalls: 3 })
  f.setDecision(input =>
    !context(input).autonomy
      ? { decision: 'abstain' }
      : input.continuation
        ? publish('我准备好了。')
        : input.recallEvidence
          ? move('location:front-room')
          : { decision: 'recall', query: '自己的安排' },
  )
  const state = await f.runtime.submit('你可以自己安排')
  expect(state.error).toBe(false)
  expect(autonomous(f.requests)).toHaveLength(3)
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 3 })
  expect(currentLocation(f.events(), 'character:friend')).toBe('location:front-room')
}, 60_000)

it('with two calls disables recall and still reserves the result-aware continuation', async () => {
  const f = await fixture(undefined, { autonomyNpcCalls: 2 })
  f.setDecision(input =>
    !context(input).autonomy
      ? { decision: 'abstain' }
      : input.continuation
        ? publish('行动结果已确认。')
        : move('location:front-room'),
  )
  const state = await f.runtime.submit('继续安排')
  expect(state.error).toBe(false)
  expect(autonomous(f.requests)).toHaveLength(2)
  expect(autonomous(f.requests)[0]!.canRecall).toBe(false)
  expect(autonomous(f.requests)[1]!.result).toMatchObject({ status: 'accepted' })
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 2 })
}, 60_000)

it('counts declared activity operations across starts without waking the role on management actions', async () => {
  const f = await fixture((role, pack) => {
    role.triggers = [{ activityKey: 'default', operation: 'quit' }]
    role.everyPlayerTurns = 2
    mkdirSync(join(pack, 'scripts'), { recursive: true })
    writeFileSync(
      join(pack, 'scripts/activity.js'),
      readFileSync(resolve('examples/world-packs/ai-girls-awaken-v10/scripts/activity.js'), 'utf8').replaceAll(
        'character:gpt',
        'character:companion',
      ),
    )
    const manifest = JSON.parse(readFileSync(join(pack, 'worldpack.source.json'), 'utf8'))
    manifest.assetFiles.push('scripts/activity.js')
    writeFileSync(join(pack, 'worldpack.source.json'), JSON.stringify(manifest))
  })
  for (let index = 0; index < 2; index++) {
    const start = await f.runtime.activityAction({
      activityId: null,
      revision: 0,
      operation: 'start',
      parameters: {},
      requestId: randomUUID(),
    })
    expect(autonomous(f.requests)).toHaveLength(0)
    await f.runtime.activityAction({
      activityId: String(start.activity!.id),
      revision: Number(start.activity!.revision),
      operation: 'quit',
      parameters: {},
      requestId: randomUUID(),
    })
    expect(autonomous(f.requests)).toHaveLength(index)
  }
}, 60_000)

it('can disable autonomous waking without disabling normal responses', async () => {
  const f = await fixture(undefined, { autonomyOpportunities: 0 })
  await f.runtime.submit('普通交流')
  expect(autonomous(f.requests)).toHaveLength(0)
  expect(f.requests.some(input => actor(input) === 'character:companion')).toBe(true)
  expect(f.requests.some(input => actor(input) === 'character:friend')).toBe(false)
}, 60_000)

it('keeps autonomous opportunity independent when an ordinary observer provider fails', async () => {
  const f = await fixture()
  f.setDecision(input => {
    if (!context(input).autonomy) throw new Error('ordinary provider unavailable')
    return { decision: 'abstain' }
  })
  const state = await f.runtime.submit('继续安排自己的事')
  expect(state.error).toBe(true)
  expect(autonomous(f.requests)).toHaveLength(1)
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 1 })
}, 60_000)

it('shares dynamic slots with a foreground response, isolates private stimuli, and charges recall/perform/continuation only to autonomy', async () => {
  const f = await fixture(
    (role, pack) => {
      role.interactions = ['status:take']
      role.targetIds = ['entity:brass-key']
      const entities = JSON.parse(readFileSync(join(pack, 'entities.json'), 'utf8'))
      entities.entities[0].locationId = 'location:back-room'
      writeFileSync(join(pack, 'entities.json'), JSON.stringify(entities))
    },
    { maximumNpcCalls: 2, autonomyNpcCalls: 3, autonomyReactionWaves: 0 },
  )
  const foreground = deferred(),
    autonomousContinuation = deferred(),
    releaseForeground = deferred(),
    releaseAutonomous = deferred()
  f.setDecision(async input => {
    if (!context(input).autonomy) {
      foreground.resolve()
      await releaseForeground.promise
      return publish('前台回复已经提交')
    }
    if (input.continuation) {
      autonomousContinuation.resolve()
      await releaseAutonomous.promise
      return { decision: 'abstain' }
    }
    return input.recallEvidence ? take() : { decision: 'recall', query: '自己的安排' }
  })
  const pending = f.runtime.submit(
    '/act speak {"text":"私语暗号霜叶","scope":"private","addresseeIds":["character:companion"]}',
  )
  await Promise.all([foreground.promise, autonomousContinuation.promise])
  releaseForeground.resolve()
  await vi.waitFor(async () => {
    const state = await f.runtime.state()
    expect(state.canInterrupt).toBe(true)
    expect(state.transcript.some(line => line.text.includes('前台回复已经提交'))).toBe(true)
  })
  expect(autonomous(f.requests)).toHaveLength(3)
  expect(JSON.stringify(autonomous(f.requests))).not.toContain('私语暗号霜叶')
  expect(context(autonomous(f.requests)[0]!).stimulus).toEqual([])
  releaseAutonomous.resolve()
  const state = await pending
  expect(state.error).toBe(false)
  expect(state.debug.activationCycle).toMatchObject({ calls: 1 })
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 3, reactionCalls: 0, terminalReason: 'quiescent' })
  expect(currentEntityState(f.events(), 'entity:brass-key')?.holderId).toBe('character:friend')
}, 60000)

it('serializes co-located ordinary and autonomous roles while keeping each autonomous opportunity single-flight', async () => {
  const f = await fixture(
    (role, pack) => {
      role.opportunities = 2
      const characters = JSON.parse(readFileSync(join(pack, 'characters.json'), 'utf8'))
      characters.characters.find(
        (entry: { characterId: string }) => entry.characterId === 'character:friend',
      ).initialLocationId = 'location:front-room'
      writeFileSync(join(pack, 'characters.json'), JSON.stringify(characters))
      const scenes = JSON.parse(readFileSync(join(pack, 'scenes.json'), 'utf8'))
      scenes.scenes[0].participantIds.push('character:friend')
      scenes.scenes[1].participantIds = []
      scenes.scenes[1].lifecycle = 'created'
      writeFileSync(join(pack, 'scenes.json'), JSON.stringify(scenes))
    },
    { autonomyOpportunities: 2, autonomyNpcCalls: 4, autonomyReactionWaves: 0 },
  )
  let active = 0,
    peak = 0
  f.setDecision(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(done => setTimeout(done, 20))
    active--
    return { decision: 'abstain' }
  })
  const state = await f.runtime.submit('同场各自安排')
  expect(state.error).toBe(false)
  expect(peak).toBe(1)
  expect(autonomous(f.requests)).toHaveLength(2)
  expect(f.requests.filter(input => actor(input) === 'character:friend')).toHaveLength(2)
  expect(f.requests.filter(input => actor(input) === 'character:companion')).toHaveLength(1)
}, 60000)

it('reserves the shared autonomous budget before dispatching multiple due roles', async () => {
  const f = await fixture(
    (role, _pack, config) => {
      config.characters.push({ ...role, characterId: 'character:companion' })
    },
    { autonomyNpcCalls: 3, autonomyReactionWaves: 0 },
  )
  f.setDecision(input => (input.continuation ? { decision: 'abstain' } : move('location:back-room')))
  const state = await f.runtime.submit('自行安排')
  expect(state.error).toBe(false)
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 2, terminalReason: 'call_limit' })
  expect(f.requests.map(actor)).toEqual(['character:companion', 'character:companion'])
  expect(currentLocation(f.events(), 'character:companion')).toBe('location:back-room')
}, 60000)

it('replans an autonomous move after an ordinary actor arrives, without duplicating the opportunity or leaking private speech', async () => {
  const f = await fixture(undefined, { autonomyNpcCalls: 4, autonomyReactionWaves: 0 })
  const autonomousStarted = deferred(),
    releaseOldPlan = deferred()
  let plans = 0,
    sawArrival = false
  f.setDecision(async input => {
    if (input.continuation) return { decision: 'abstain' }
    if (!context(input).autonomy) {
      await autonomousStarted.promise
      return move('location:back-room')
    }
    if (++plans === 1) {
      autonomousStarted.resolve()
      await releaseOldPlan.promise
    } else sawArrival = JSON.stringify(object(context(input).scene).people).includes('character:companion')
    return move('location:front-room')
  })
  const pending = f.runtime.submit(
    '/act speak {"text":"私语暗号霜叶","scope":"private","addresseeIds":["character:companion"]}',
  )
  await autonomousStarted.promise
  await vi.waitFor(() => expect(currentLocation(f.events(), 'character:companion')).toBe('location:back-room'))
  releaseOldPlan.resolve()
  const state = await pending
  expect(state.error).toBe(false)
  expect(plans).toBe(2)
  expect(sawArrival).toBe(true)
  expect(JSON.stringify(autonomous(f.requests))).not.toContain('私语暗号霜叶')
  expect(state.debug.autonomy).toMatchObject({
    autonomousCalls: 3,
    activations: [{ result: { status: 'stale' } }, { result: { status: 'abstained' } }],
  })
  const moves = f
    .events()
    .filter(event => event.eventType === 'action.resolved' && object(event.data).actionType === 'move')
  expect(moves.map(event => object(event.data).actorId)).toEqual(['character:companion', 'character:friend'])
  expect(currentLocation(f.events(), 'character:friend')).toBe('location:front-room')
}, 60000)

it('cancels both in-flight modes on player interruption and keeps the committed autonomous action', async () => {
  const f = await fixture(
    (role, pack) => {
      role.interactions = ['status:take']
      role.targetIds = ['entity:brass-key']
      const entities = JSON.parse(readFileSync(join(pack, 'entities.json'), 'utf8'))
      entities.entities[0].locationId = 'location:back-room'
      writeFileSync(join(pack, 'entities.json'), JSON.stringify(entities))
    },
    { autonomyReactionWaves: 0 },
  )
  const foreground = deferred(),
    autonomousContinuation = deferred(),
    releaseOld = deferred()
  f.setDecision(async input => {
    if (!context(input).autonomy) {
      foreground.resolve()
      await releaseOld.promise
      return publish('迟到回复不得提交')
    }
    if (!input.continuation) return take()
    autonomousContinuation.resolve()
    await releaseOld.promise
    return publish('迟到自主续写不得提交')
  })
  const old = f.runtime.submit('开始安排')
  await Promise.all([foreground.promise, autonomousContinuation.promise])
  expect(currentEntityState(f.events(), 'entity:brass-key')?.holderId).toBe('character:friend')
  f.setDecision(() => ({ decision: 'abstain' }))
  const state = await f.runtime.submit('/act speak {"text":"我继续自己的笔记。","scope":"self","addresseeIds":[]}')
  releaseOld.resolve()
  await old
  expect(state.error).toBe(false)
  expect(currentEntityState(f.events(), 'entity:brass-key')?.holderId).toBe('character:friend')
  const actions = f
    .events()
    .filter(
      event =>
        event.eventType === 'action.resolved' &&
        object(event.data).actorId === 'character:friend' &&
        object(event.data).actionType === 'interact',
    )
  expect(actions).toHaveLength(1)
  expect(JSON.stringify(f.events())).not.toContain('迟到回复不得提交')
  expect(JSON.stringify(f.events())).not.toContain('迟到自主续写不得提交')
}, 60000)

it('retains the staged-autonomy measurement control while ordinary dispatch stays dynamic', async () => {
  const f = await fixture(undefined, {}, { stagedAutonomy: true }),
    foreground = deferred(),
    releaseForeground = deferred()
  f.setDecision(async input => {
    if (!context(input).autonomy) {
      foreground.resolve()
      await releaseForeground.promise
    }
    return { decision: 'abstain' }
  })
  const pending = f.runtime.submit('先处理前台')
  await foreground.promise
  expect(autonomous(f.requests)).toHaveLength(0)
  releaseForeground.resolve()
  await pending
  expect(autonomous(f.requests)).toHaveLength(1)
}, 60000)

it('rejects invalid creator declarations and ignores an unregistered local autonomy file', async () => {
  const packPath = resolve('examples/world-packs/character-autonomy')
  const pack = await compileWorldPackSource(
    packPath,
    createInstalledInteractionPackages().map(interactionPackageDescription),
  )
  const value = JSON.parse(readFileSync(join(packPath, 'autonomy.json'), 'utf8'))
  for (const patch of [
    { characterId: 'character:player' },
    { everyPlayerTurns: 0 },
    { locationIds: ['missing'] },
    { interactions: ['missing'] },
    { targetIds: ['missing'] },
    { unknown: 1 },
  ]) {
    expect(() =>
      PackAutonomy.parse({ characters: [{ ...value.characters[0], ...patch }] }, pack, 'character:player'),
    ).toThrow()
  }
  expect(PackAutonomy.load(packPath, { ...pack, assets: [] }, 'character:player')).toBeUndefined()
})
