import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RulesInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { WorldStore } from '@harness-world/store-sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const FRONT = 'location:front-room'
const MOVE_FRONT = `/act move {"locationId":"${FRONT}"}`

function provider(instance: RulesInstance, id = 'test-rules', version = '1.0.0'): SeamProvider<RulesInstance> {
  return { id, version, open: async () => instance }
}

/** Refuses any move to a room, and takes it off the list of destinations. */
const locked = (locationId: string, seen?: string[]): RulesInstance => ({
  resolve: (context, next) => {
    seen?.push(String(context.action.actionType))
    return context.action.actionType === 'move' &&
      (context.action.parameters as { locationId?: string } | undefined)?.locationId === locationId
      ? { status: 'rejected', events: [], reason: 'plugin:门锁着。' }
      : next(context)
  },
  affordances: (context, next) =>
    next(context).map(affordance =>
      affordance.destinations
        ? { ...affordance, destinations: affordance.destinations.filter(place => place.locationId !== locationId) }
        : affordance,
    ),
})

async function start(
  rules: readonly SeamProvider<RulesInstance>[],
  answer: unknown = { decision: 'abstain' },
  extra: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'perspectra-rules-seam-'))
  roots.push(root)
  const contexts: Record<string, unknown>[] = []
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      // A format retry's last message is a plain correction, not a request body.
      const last = String(JSON.parse(body).messages.at(-1).content)
      if (last.startsWith('{')) contexts.push(JSON.parse(last).context)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const models = fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions')
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models,
    timeoutMs: 5000,
    plugins: { rules },
    ...extra,
  })
  runtimes.push(runtime)
  const moves = () => {
    const store = new WorldStore(join(root, 'world.sqlite'))
    try {
      return store
        .readEvents(runtime.address)
        .filter(event => event.eventType === 'character.moved')
        .map(event => (event.data as { toLocationId: string }).toLocationId)
    } finally {
      store.close()
    }
  }
  return { runtime, root, models, contexts, moves }
}

it('refuses a character move through a rule layer', async () => {
  const seen: string[] = []
  const answer = { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:front-room' } }
  // Only `resolve`: an option taken off the list never reaches the rules, the format check refuses it first.
  const { resolve: refuse } = locked('location:front-room', seen)
  const { runtime, moves } = await start([provider({ resolve: refuse! })], answer, { serialScheduling: true })
  const before = moves()
  await runtime.submit('你们好。')
  expect(seen).toContain('move')
  expect(moves().filter(to => to === 'location:front-room')).toEqual(before.filter(to => to === 'location:front-room'))
})

it('refuses a player move through the same layer', async () => {
  const seen: string[] = []
  const { runtime, moves } = await start([provider(locked(FRONT, seen))])
  const state = await runtime.submit(MOVE_FRONT)
  expect(seen).toContain('move')
  expect(state.notice).toContain('门锁着')
  expect(moves()).not.toContain(FRONT)
})

it('binds inside a running activity too', async () => {
  const seen: string[] = []
  const { runtime } = await start(
    [provider(locked(FRONT, seen))],
    { decision: 'abstain' },
    { packPath: resolve('examples/world-packs/scripted-performance') },
  )
  const activity = ((await runtime.state()).activities as { activityKey: string }[])[0]!
  await runtime.activityAction({
    activityKey: activity.activityKey,
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'rules-seam',
  })
  seen.length = 0
  await runtime.submit('你好。')
  expect(seen).toContain('speak')
})

it('removes an option through affordances', async () => {
  const { runtime, contexts } = await start(
    [provider(locked('location:front-room'))],
    { decision: 'abstain' },
    {
      serialScheduling: true,
    },
  )
  await runtime.submit('你们好。')
  const offered = JSON.stringify(contexts[0]!.affordances ?? [])
  expect(offered).toContain('move')
  expect(offered).not.toContain('location:front-room"')
  expect(JSON.stringify((await runtime.state()).availableActions)).not.toContain(`"locationId":"${FRONT}"`)
})

it('applies layers in load order, the first outermost', async () => {
  const order: string[] = []
  const layer = (name: string): RulesInstance => ({
    resolve: (context, next) => {
      order.push(name)
      return next(context)
    },
  })
  const { runtime } = await start([provider(layer('first'), 'first'), provider(layer('second'), 'second')])
  await runtime.submit(MOVE_FRONT)
  expect(order.slice(0, 2)).toEqual(['first', 'second'])
})

it('refuses a character action when a layer throws, and logs the error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const answer = { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:front-room' } }
  const { runtime, moves } = await start(
    [
      provider(
        {
          resolve: (context, next) => {
            if (context.action.actionType === 'move') throw new Error('rule bug')
            return next(context)
          },
        },
        'buggy-rules',
      ),
    ],
    answer,
    { serialScheduling: true },
  )
  const before = moves().length
  const state = await runtime.submit('你们好。')
  expect(state.transcript.some(line => line.player)).toBe(true)
  expect(moves()).toHaveLength(before)
  expect(log.mock.calls.flat().map(String).join(' ')).toContain('rule bug')
  expect((await runtime.submit('还在吗？')).transcript.some(line => line.text === '还在吗？')).toBe(true)
})

it('keeps offering options when a layer fails on them', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime } = await start([
    provider({
      affordances: () => {
        throw new Error('rule bug')
      },
    }),
  ])
  expect(JSON.stringify((await runtime.state()).availableActions)).toContain('move')
})

it('closes open layers when a later one cannot open', async () => {
  const close = vi.fn()
  await expect(
    start([
      provider({ close }, 'first'),
      {
        id: 'broken-rules',
        version: '1.0.0',
        open: async () => {
          throw new Error('cannot open')
        },
      },
    ]),
  ).rejects.toThrow('broken-rules')
  expect(close).toHaveBeenCalledTimes(1)
})

it('refuses to regenerate after the rule layers changed', async () => {
  const original = provider({}, 'rules-a')
  const { runtime, root, models } = await start([original])
  const state = await runtime.submit(MOVE_FRONT)
  await runtime.close()
  runtimes.length = 0
  const reopen = (rules: SeamProvider<RulesInstance>) =>
    start([rules], { decision: 'abstain' }, { dataDirectory: root, models })
  const { runtime: changed } = await reopen(provider({}, 'rules-b'))
  await expect(changed.regenerate(state.tailRound!.id!, 'rules-seam-changed')).rejects.toThrow('环境')
  await changed.close()
  runtimes.length = 0
  const { runtime: same } = await reopen(original)
  await expect(same.regenerate(state.tailRound!.id!, 'rules-seam-same')).resolves.toBeDefined()
})

it('hands the next layer the same resolution when a layer only passes through', async () => {
  const results: unknown[] = []
  const { runtime, moves } = await start([
    provider({
      resolve: (context, next) => {
        const resolution = next(context)
        results.push(resolution)
        return resolution
      },
    }),
  ])
  await runtime.submit(MOVE_FRONT)
  expect(results.length).toBeGreaterThan(0)
  expect(moves()).toContain(FRONT)
})

it('tells the player which plugin failed on their own action, then continues', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let fail = true
  const { runtime, moves } = await start([
    provider(
      {
        resolve: (context, next) => {
          if (fail && context.action.actionType === 'move') throw new Error('rule bug')
          return next(context)
        },
      },
      'buggy-rules',
    ),
  ])
  const outcome = await runtime.submit(MOVE_FRONT).then(
    state => JSON.stringify(state.notice),
    (error: Error) => error.message,
  )
  expect(outcome).toContain('buggy-rules')
  expect(moves()).not.toContain(FRONT)
  fail = false
  await runtime.submit(MOVE_FRONT)
  expect(moves()).toContain(FRONT)
})

it("reads a rule layer's refusal to the player inside an activity that allows moving", async () => {
  const pack = mkdtempSync(join(tmpdir(), 'perspectra-rules-pack-'))
  roots.push(pack)
  cpSync(resolve('examples/world-packs/scripted-performance'), pack, { recursive: true })
  const script = join(pack, 'scripts', 'activity.js')
  writeFileSync(script, readFileSync(script, 'utf8').replace('move: false', 'move: true'))
  const { runtime, moves } = await start([provider(locked(FRONT))], { decision: 'abstain' }, { packPath: pack })
  const activity = ((await runtime.state()).activities as { activityKey: string }[])[0]!
  await runtime.activityAction({
    activityKey: activity.activityKey,
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'rules-seam-move',
  })
  await expect(runtime.submit(MOVE_FRONT)).rejects.toThrow('门锁着')
  expect(moves()).not.toContain(FRONT)
})

it('refuses a rule layer whose accepted result contradicts committed custody, instead of poisoning the log', async () => {
  const forged: RulesInstance = {
    resolve: (context, next) =>
      context.action.actionType === 'move'
        ? {
            status: 'accepted',
            events: [
              {
                eventType: 'entity.transferred',
                eventVersion: 1,
                data: {
                  entityId: 'entity:not-here',
                  characterId: context.characterId,
                  interactionId: 'forged',
                  fromHolderId: null,
                  fromLocationId: 'location:nowhere',
                  toHolderId: context.characterId,
                  toLocationId: null,
                },
              },
            ],
          }
        : next(context),
  }
  const { runtime, root, moves } = await start([provider(forged)])
  const state = await runtime.submit(MOVE_FRONT)
  expect(state.notice).toContain('规则插件 test-rules 出错')
  expect(moves()).not.toContain(FRONT)
  const store = new WorldStore(join(root, 'world.sqlite'))
  try {
    expect(store.readEvents(runtime.address).some(event => event.eventType === 'entity.transferred')).toBe(false)
  } finally {
    store.close()
  }
})
