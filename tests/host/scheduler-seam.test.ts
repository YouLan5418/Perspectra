import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SchedulerInstance, SchedulerRound, SeamProvider, WorldServices } from '@harness-world/plugin-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { officialSeams } from '../../desktop/official-bundle.ts'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { createChatServer, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  servers: Server[] = [],
  runtimes: WorldHostRuntime[] = [],
  sessions: HostPlugins[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const session of sessions.splice(0)) await session.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MOVE = '/act move {"locationId":"location:front-room"}'
const WITNESS = 'character:witness'
const quiet = { calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }

function provider(
  run: (round: SchedulerRound) => unknown,
  overrides: Partial<SeamProvider<SchedulerInstance>> = {},
): SeamProvider<SchedulerInstance> {
  return {
    id: 'test-scheduler',
    version: '1.0.0',
    open: async () => ({ run: run as SchedulerInstance['run'] }),
    ...overrides,
  }
}

async function start(scheduler: SeamProvider<SchedulerInstance>, dataDirectory?: string) {
  const root = dataDirectory ?? mkdtempSync(join(tmpdir(), 'perspectra-scheduler-seam-'))
  if (!dataDirectory) roots.push(root)
  const actors: string[] = []
  const server = createChatServer((request, response) => {
    let body = ''
    request.on('data', chunk => {
      body += String(chunk)
    })
    request.on('end', () => {
      const input = JSON.parse(JSON.parse(body).messages.at(-1).content)
      actors.push(String(input.context.character.characterId))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          message: {
            content: JSON.stringify({ decision: 'publish', segments: [{ type: 'speech', text: '听到了。' }] }),
          },
        }),
      )
    })
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const runtime = await WorldHostRuntime.create({
    dataDirectory: root,
    packPath: resolve('examples/world-packs/dynamic-scheduling'),
    models: fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions'),
    timeoutMs: 5000,
    plugins: { scheduler },
  })
  runtimes.push(runtime)
  return { runtime, actors, root }
}

/** Offer the witness one opportunity using only the public round. */
async function witnessOnly(round: SchedulerRound) {
  const seqs = round
    .observationsSince(round.afterSeq, round.headSeq())
    .filter(observation => String(observation.characterId) === WITNESS)
    .map(observation => observation.seq)
  const result = await round.turn(WITNESS as never, { signal: round.signal, stimulusSeqs: seqs, maxCalls: 2 })
  return { calls: result.calls, wave: 1, terminalReason: 'quiescent', activations: [{ characterId: WITNESS, result }] }
}

it('runs the configured scheduler instead of the official one', async () => {
  const { runtime, actors } = await start(provider(witnessOnly))
  const state = await runtime.submit(MOVE)
  expect(state.error).toBeFalsy()
  expect(new Set(actors)).toEqual(new Set([WITNESS]))
})

it('keeps player input and continues the next round when the scheduler throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let fail = true
  const { runtime } = await start(
    provider(async () => {
      if (fail) throw new Error('plugin bug')
      return quiet
    }),
  )
  const failed = await runtime.submit(MOVE)
  expect(failed.error).toBe(true)
  expect(failed.notice).toContain('调度器插件')
  fail = false
  const next = await runtime.submit('还在吗？')
  expect(next.error).toBeFalsy()
  expect(next.transcript.some(line => line.player && line.text === '还在吗？')).toBe(true)
})

it('treats an invalid result as a finished round', async () => {
  const { runtime } = await start(provider(async () => ({ nope: true })))
  const state = await runtime.submit(MOVE)
  expect(state.error).toBeFalsy()
  expect(state.notice).toContain('本轮角色处理已结束')
})

it('falls back to the official scheduler when open fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime, actors } = await start(
    provider(async () => quiet, {
      open: async () => {
        throw new Error('cannot open')
      },
    }),
  )
  expect((await runtime.state()).notice).toContain('已改用官方调度')
  await runtime.submit(MOVE)
  expect(actors.length).toBeGreaterThan(0)
})

it('opens a separate instance for each regeneration candidate and closes it', async () => {
  let opened = 0,
    closed = 0
  const { runtime } = await start(
    provider(async () => quiet, {
      open: async () => {
        opened++
        return { run: witnessOnly as unknown as SchedulerInstance['run'], close: () => void closed++ }
      },
    }),
  )
  const state = await runtime.submit(MOVE)
  const before = opened
  expect(before).toBeGreaterThan(0)
  await runtime.regenerate(state.tailRound!.id!, 'scheduler-seam-regeneration')
  expect(opened).toBeGreaterThan(before)
  await runtime.close()
  runtimes.length = 0
  expect(closed).toBe(opened)
})

it('gives the plugin read access scoped to its own world', async () => {
  let services: WorldServices | undefined,
    head = 0
  const { runtime, root } = await start(
    provider(async () => quiet, {
      open: async world => {
        services = world
        return {
          run: async round => {
            head = round.headSeq()
            return quiet
          },
        }
      },
    }),
  )
  await runtime.submit(MOVE)
  expect(services!.dataDirectory).toBe(join(root, 'plugins', 'test-scheduler'))
  expect(services!.world.readEvents(0, head, ['observation.upsert']).length).toBeGreaterThan(0)
  expect(services!.world.characterObservations(WITNESS as never, head).length).toBeGreaterThan(0)
})

it('aborts the round signal when the game closes', async () => {
  let started!: () => void
  const running = new Promise<void>(done => {
    started = done
  })
  let aborted = false
  const { runtime } = await start(
    provider(async round => {
      started()
      await new Promise<void>(done => round.signal.addEventListener('abort', () => done(), { once: true }))
      aborted = true
      return quiet
    }),
  )
  const submitting = runtime.submit(MOVE).catch(() => undefined)
  await running
  await runtime.close()
  runtimes.length = 0
  await submitting
  expect(aborted).toBe(true)
})

const EXAMPLE = resolve('examples/host-plugins/impulsive-scheduler.mjs')

async function loadExample(priority: string) {
  const plugins = await loadHostPlugins([
    { id: 'impulsive-scheduler', path: EXAMPLE, enabled: true, config: { priority } },
  ])
  sessions.push(plugins)
  expect(plugins.skipped).toEqual([])
  return plugins.seams.scheduler
}

it('lets the example plugin put impatient characters first', async () => {
  const { runtime, actors } = await start(await loadExample(WITNESS))
  const state = await runtime.submit(MOVE)
  expect(state.error).toBeFalsy()
  expect(actors[0]).toBe(WITNESS)
  expect(new Set(actors).size).toBeGreaterThan(1)
})

it('reopens a save without the plugin under the official scheduler', async () => {
  const first = await start(await loadExample(WITNESS))
  const played = await first.runtime.submit(MOVE)
  const transcript = played.transcript.map(line => [line.seq, line.text])
  await first.runtime.close()
  runtimes.length = 0
  const reopened = await start(officialSeams().scheduler, first.root)
  expect((await reopened.runtime.state()).transcript.map(line => [line.seq, line.text])).toEqual(transcript)
  await reopened.runtime.submit('还有人吗？')
  expect(reopened.actors.length).toBeGreaterThan(0)
})

it('aborts the round signal on pause', async () => {
  let started!: () => void
  const running = new Promise<void>(done => {
    started = done
  })
  let aborted = false
  const { runtime } = await start(
    provider(async round => {
      started()
      await new Promise<void>(done => round.signal.addEventListener('abort', () => done(), { once: true }))
      aborted = true
      return quiet
    }),
  )
  const submitting = runtime.submit(MOVE)
  await running
  await runtime.pause()
  await submitting
  expect(aborted).toBe(true)
})
