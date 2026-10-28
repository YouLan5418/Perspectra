import { type Server } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { projectPlayerView } from '../../desktop/host/frontend-adapter.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const PLAYER = 'character:player'
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

// `raise` sets a public flag the autoStart hooks read; `wait` changes nothing. Both are ordinary player rounds.
const statusScript = `globalThis.statusScript = {
  definition: {
    statuses: [
      { key: 'round', label: '回合', type: 'number', owner: 'public', alwaysKnown: true },
      { key: 'flag', label: '标记', type: 'number', owner: 'public', alwaysKnown: true },
    ],
    operations: ['raise', 'wait'].map(id => ({ id, label: id, actors: 'player', schema: { type: 'object', additionalProperties: false, properties: {} } })),
  },
  initialize(ids) { return { public: { round: 0, flag: 0 }, characters: Object.fromEntries(ids.map(id => [id, {}])) } },
  policy() { return { operations: ['raise', 'wait'] } },
  resolve(truth, actorId, operation) {
    return { changes: operation === 'raise' ? [{ holderId: null, key: 'flag', value: truth.public.flag + 1 }] : [],
      reveals: [], description: operation + '。', audience: 'self' }
  },
  onRoundEnd(truth) { return { changes: [{ holderId: null, key: 'round', value: truth.public.round + 1 }], reveals: [] } },
}`

/** Two activities with the companion; each may carry an autoStart hook body `(truth, world, previous) => ...`. */
async function fixture(
  hooks: { guess?: string; other?: string },
  dynamicOther = false,
  openings: { guess?: string; other?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'auto-start-'))
  roots.push(root)
  const pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/launcher-demo'), pack, { recursive: true })
  mkdirSync(join(pack, 'scripts/activities'))
  const original = readFileSync(join(pack, 'scripts/activity.js'), 'utf8').replace(
    'const answer = 1 + Math.floor(Math.random() * 100);',
    'const answer = 73;',
  )
  for (const key of ['guess', 'other'] as const) {
    let source = original.replace(
      "title: '轮流猜数字'",
      "title: '" + key + "'" + (openings[key] === undefined ? '' : ', opening: ' + JSON.stringify(openings[key])),
    )
    if (key === 'other' && dynamicOther)
      source = source.replace(
        "npcIds: ['character:companion']",
        "participants: { mode: 'player-select', min: 1, max: 1 }",
      )
    if (hooks[key] !== undefined) source += '\nactivityScript.autoStart = ' + hooks[key] + ';\n'
    writeFileSync(join(pack, 'scripts/activities', key + '.js'), source)
  }
  writeFileSync(join(pack, 'scripts/status.js'), statusScript)
  const manifest = JSON.parse(readFileSync(join(pack, 'worldpack.source.json'), 'utf8'))
  manifest.assetFiles = ['scripts/activities/guess.js', 'scripts/activities/other.js', 'scripts/status.js']
  writeFileSync(join(pack, 'worldpack.source.json'), JSON.stringify(manifest))
  const inputs: WorldJsonObject[] = []
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const wire = JSON.parse(body)
      inputs.push(JSON.parse(wire.messages.findLast((message: { role: string }) => message.role === 'user').content))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'submit_actions', arguments: JSON.stringify({ decision: 'abstain' }) } },
                ],
              },
            },
          ],
        }),
      )
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const runtime = await WorldHostRuntime.create({
    packPath: pack,
    models: fakeModels('http://127.0.0.1:' + port + '/v1/chat/completions', 'openai', 'fixture'),
    timeoutMs: 5000,
    dataDirectory: data,
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
  const starts = () =>
    events().filter(
      event => event.eventType === 'activity.updated' && (event.data as WorldJsonObject).operation === 'start',
    )
  return { runtime, inputs, events, starts }
}
const data = (event: { data: unknown }) => event.data as WorldJsonObject

it('starts an activity whose conditions all hold after the player round, once, without counting a player round', async () => {
  const f = await fixture({
    other: '(truth, world, previous) => ({ when: [truth.public.flag >= 1, previous === null] })',
  })
  await f.runtime.submit('/status wait {}')
  expect(f.starts()).toHaveLength(0)
  await f.runtime.submit('/status raise {}')
  const [start] = f.starts()
  expect(start && data(start)).toMatchObject({ activityKey: 'other', source: 'auto' })
  const sameTransaction = f.events().filter(event => event.transactionId === start!.transactionId)
  expect(sameTransaction.find(event => event.eventType === 'action.resolved')?.data).toMatchObject({
    sourceRole: 'director',
  })
  // Delivered exactly like a manual start: player and companion observe the opening.
  expect(
    sameTransaction
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => (data(event).value as WorldJsonObject).observerId)
      .sort(),
  ).toEqual(['character:companion', PLAYER])
  // Two player rounds were submitted; the automatic start is not a third.
  const rounds = f
    .events()
    .filter(event => event.eventType === 'status.updated' && (data(event).source as WorldJsonObject).kind === 'round')
  expect(rounds.map(event => (data(event).source as WorldJsonObject).round)).toEqual([1, 2])
  // Ended by its own rules; `previous` now keeps it from starting again.
  const state = await f.runtime.state()
  const other = state.activities!.find(activity => activity.activityKey === 'other')!
  await f.runtime.activityAction({
    activityKey: 'other',
    activityId: String(other.id),
    revision: Number(other.revision),
    operation: 'quit',
    parameters: {},
    requestId: 'quit',
  })
  await f.runtime.submit('/status wait {}')
  expect(f.starts()).toHaveLength(1)
})

it('offers no manual start while the autoStart conditions are unmet, and refuses one sent anyway', async () => {
  const f = await fixture({ other: '(truth) => ({ when: [truth.public.flag >= 1] })' })
  const labels = projectPlayerView(await f.runtime.state()).actions.map(action => action.label)
  expect(labels).toContain('开始 guess')
  expect(labels).not.toContain('开始 other')
  await expect(
    f.runtime.activityAction({
      activityKey: 'other',
      activityId: null,
      revision: 0,
      operation: 'start',
      parameters: {},
      requestId: 'manual',
    }),
  ).rejects.toThrow('开始条件尚未满足')
  expect(f.events().filter(event => event.eventType === 'activity.updated')).toHaveLength(0)
})

it('prefers the candidate with more conditions and breaks ties with the recorded round random', async () => {
  const more = await fixture({ guess: '() => ({ when: [true] })', other: '() => ({ when: [true, true] })' })
  await more.runtime.submit('/status wait {}')
  expect(more.starts().map(event => data(event).activityKey)).toEqual(['other'])

  const tied = { guess: '() => ({ when: [true, true] })', other: '() => ({ when: [true, true] })' }
  const low = await fixture(tied)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  await low.runtime.submit('/status wait {}')
  expect(low.starts().map(event => data(event).activityKey)).toEqual(['guess'])

  const high = await fixture(tied)
  vi.spyOn(Math, 'random').mockReturnValue(0.99)
  const round = await high.runtime.submit('/status wait {}')
  expect(high.starts().map(event => data(event).activityKey)).toEqual(['other'])
  // Regenerating the round replays the recorded draw instead of drawing again.
  vi.spyOn(Math, 'random').mockReturnValue(0)
  await high.runtime.regenerate(round.tailRound!.id!, 'regenerate-tie')
  expect(high.starts().map(event => data(event).activityKey)).toEqual(['other'])
})

it('does not check while an activity runs, and commits nothing for unmet conditions', async () => {
  const f = await fixture({ guess: '() => ({ when: [false, true] })', other: '() => ({ when: [true] })' })
  const state = await f.runtime.activityAction({
    activityKey: 'other',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'manual',
  })
  const other = state.activities!.find(activity => activity.activityKey === 'other')!
  await f.runtime.activityAction({
    activityKey: 'other',
    activityId: String(other.id),
    revision: Number(other.revision),
    operation: 'guess',
    parameters: { value: 5 },
    requestId: 'guess',
  })
  expect(f.starts().map(event => data(event).source ?? 'manual')).toEqual(['manual'])
})

it('rejects malformed hook results and host-refused starts without committing anything', async () => {
  for (const [hook, dynamic] of [
    ['() => ({ when: [] })', false],
    ['() => ({ when: [1] })', false],
    ["() => ({ when: [true], npcIds: ['character:companion'] })", false],
    ["() => ({ when: [true], npcIds: ['character:nobody'] })", true],
    ['() => { throw new Error("broken") }', false],
  ] as const) {
    const f = await fixture({ other: hook }, dynamic)
    await f.runtime.submit('/status wait {}')
    expect(f.events().filter(event => event.eventType === 'activity.updated')).toHaveLength(0)
    expect(((await f.runtime.state()).debug as WorldJsonObject).autoStartError).toEqual(expect.any(String))
  }
})

it('replaces the fixed opening line with the author notice for the player only', async () => {
  const f = await fixture({ other: "() => ({ when: [true], notice: '同伴朝你走了过来。' })" })
  await f.runtime.submit('/status wait {}')
  const [start] = f.starts()
  const openings = f
    .events()
    .filter(event => event.transactionId === start!.transactionId && event.eventType === 'observation.upsert')
    .map(event => {
      const value = data(event).value as WorldJsonObject
      return value.observerId + '：' + (value.content as WorldJsonObject).resultDescription
    })
    .sort()
  // One line each: the player reads the notice instead of "other开始。", the companion keeps the fixed line.
  expect(openings).toEqual(['character:companion：other开始。', PLAYER + '：同伴朝你走了过来。'])
  expect(JSON.stringify(f.inputs)).not.toContain('同伴朝你走了过来')
})

it('uses the declared opening line for a manual start, and the notice still wins for an automatic one', async () => {
  const openingsOf = (f: Awaited<ReturnType<typeof fixture>>) => {
    const [start] = f.starts()
    return f
      .events()
      .filter(event => event.transactionId === start!.transactionId && event.eventType === 'observation.upsert')
      .map(event => {
        const value = data(event).value as WorldJsonObject
        return value.observerId + '：' + (value.content as WorldJsonObject).resultDescription
      })
      .sort()
  }
  const manual = await fixture({}, false, { other: '同伴把骰子推到你面前。' })
  await manual.runtime.activityAction({
    activityKey: 'other',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'manual',
  })
  expect(openingsOf(manual)).toEqual(['character:companion：other开始。', PLAYER + '：同伴把骰子推到你面前。'])
  expect(JSON.stringify(manual.inputs)).not.toContain('骰子推到你面前')

  const auto = await fixture({ other: "() => ({ when: [true], notice: '同伴朝你走了过来。' })" }, false, {
    other: '同伴把骰子推到你面前。',
  })
  await auto.runtime.submit('/status wait {}')
  expect(openingsOf(auto)).toEqual(['character:companion：other开始。', PLAYER + '：同伴朝你走了过来。'])

  // An empty opening is an author error caught when the pack loads.
  await expect(fixture({}, false, { other: '' })).rejects.toThrow()
}, 30000)
