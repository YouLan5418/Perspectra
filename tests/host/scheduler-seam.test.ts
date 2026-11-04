import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SchedulerInstance, SchedulerRound, SeamProvider, WorldServices } from '@harness-world/plugin-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { loadHostPlugins, type HostPlugins } from '../../desktop/host-plugins.ts'
import { officialSeams } from '../../desktop/official-bundle.ts'
import { playSettings } from '../../desktop/play-settings.ts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { WorldHostRuntime, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
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

async function start(
  scheduler: SeamProvider<SchedulerInstance>,
  dataDirectory?: string,
  pack = 'dynamic-scheduling',
  controls: Partial<WorldHostOptions> = {},
) {
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
    packPath: resolve('examples/world-packs', pack),
    models: fakeModels('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/chat/completions'),
    timeoutMs: 5000,
    plugins: { scheduler },
    ...controls,
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

it('lets the same scheduler choose a single staged autonomous opportunity', async () => {
  const phases: string[] = []
  const { runtime, actors } = await start(
    provider(async round => {
      phases.push(round.phase ?? 'scene')
      if (!round.autonomy) return quiet
      const id = round.autonomy!.roles[0]!.characterId
      const result = await round.turn(id, {
        kind: 'autonomous',
        signal: round.signal,
        stimulusSeqs: round.observationSeqs(id, round.afterSeq, round.headSeq()),
        maxCalls: 2,
      })
      return { ...quiet, calls: result.calls, activations: [{ characterId: id, result }] }
    }),
    undefined,
    'autonomy-scheduling',
    { serialScheduling: true },
  )
  const state = await runtime.submit('你好')
  expect(state.error).toBe(false)
  expect(phases).toEqual(['scene'])
  expect(actors).toEqual(['character:friend'])
})

it('lets a scheduler defer an activity while refusing an illegal participant', async () => {
  let activityRounds = 0
  const { runtime, actors } = await start(
    provider(async round => {
      if (round.phase !== 'activity') return quiet
      activityRounds++
      expect(round.activity!.next()).toBe('character:companion')
      await expect(
        round.turn('character:friend' as never, {
          signal: round.signal,
          stimulusSeqs: [],
          maxCalls: 2,
        }),
      ).rejects.toThrow('activity')
      return quiet
    }),
    undefined,
    'scripted-performance',
  )
  const state = await runtime.activityAction({
    activityKey: 'default',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'scheduler-activity',
  })
  expect(activityRounds).toBe(1)
  expect(state.activity?.game).toMatchObject({ phase: 'opening', turn: 'character:companion' })
  expect(actors).toEqual([])
})

it('charges repeated decision middleware sends to the official staged budget', async () => {
  const scheduler = officialSeams().scheduler
  const { runtime, actors } = await start(scheduler, undefined, 'autonomy-scheduling', {
    serialScheduling: true,
    playSettings: playSettings({ autonomyNpcCalls: 2, autonomyOpportunities: 2, autonomyReactionWaves: 0 }),
    plugins: {
      scheduler,
      decisions: [
        {
          id: 'retrying-decision',
          version: '1.0.0',
          open: async () => ({
            decide: async (request, next) => {
              if (!request.context.autonomy) return { decision: 'abstain' }
              await next(request)
              await next(request)
              return next(request)
            },
          }),
        },
      ],
    },
  })
  const state = await runtime.submit('你好')
  expect(actors).toEqual(['character:friend', 'character:friend'])
  expect(state.debug.autonomy).toMatchObject({ autonomousCalls: 2, terminalReason: 'call_limit' })
})

it('does not apply the official autonomous budget to a third-party scheduler', async () => {
  const custom = provider(async round => {
    if (!round.autonomy) return quiet
    const id = round.autonomy!.roles[0]!.characterId
    for (let n = 0; n < 3; n++)
      await round.turn(id, {
        kind: 'autonomous',
        signal: round.signal,
        maxCalls: 2,
        stimulusSeqs: round.observationSeqs(id, round.afterSeq, round.headSeq()),
      })
    return quiet
  })
  const { runtime, actors } = await start(custom, undefined, 'autonomy-scheduling', {
    serialScheduling: true,
    playSettings: playSettings({ autonomyNpcCalls: 2, autonomyOpportunities: 1 }),
  })
  expect((await runtime.submit('你好')).error).toBe(false)
  expect(actors).toEqual(['character:friend', 'character:friend', 'character:friend'])
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
  const regenerated = await runtime.state()
  const beforeSelection = opened
  await runtime.selectCandidate(regenerated.tailRound!.id!, state.tailRound!.candidateIds![0]!, 'scheduler-select')
  expect(opened).toBeGreaterThan(beforeSelection)
  await runtime.close()
  runtimes.length = 0
  expect(closed).toBe(opened)
})

it('opens and closes an independent scheduler instance when restoring a story node', async () => {
  const instances: { candidate: boolean; closed: boolean }[] = []
  const scheduler = provider(async () => quiet, {
    open: async world => {
      const instance = { candidate: world.candidate, closed: false }
      instances.push(instance)
      return { run: async () => quiet, close: () => void (instance.closed = true) }
    },
  })
  const { runtime, root } = await start(scheduler, undefined, 'dynamic-scheduling', { storyNodes: true })
  await runtime.submit(MOVE)
  const node = await runtime.saveNode('调度实例')
  await runtime.close()
  const before = instances.length
  const target = mkdtempSync(join(tmpdir(), 'perspectra-scheduler-node-'))
  roots.push(target)
  restoreStoryNode(root, node.id, target, node.packHash)
  const restored = await start(scheduler, target)
  expect(instances.length).toBeGreaterThan(before)
  expect(instances.slice(before).some(instance => !instance.candidate && !instance.closed)).toBe(true)
  await restored.runtime.close()
  expect(instances.every(instance => instance.closed)).toBe(true)
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

it('waits for turns a scheduler left running before it closes the round', async () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => void rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  let settled = false
  try {
    const { runtime } = await start(
      provider(async round => {
        const seqs = round
          .observationsSince(round.afterSeq, round.headSeq())
          .filter(observation => String(observation.characterId) === WITNESS)
          .map(observation => observation.seq)
        void round
          .turn(WITNESS as never, { signal: round.signal, stimulusSeqs: seqs, maxCalls: 2 })
          .catch(() => undefined)
          .finally(() => {
            settled = true
          })
        void round.turn(WITNESS as never, { signal: round.signal, stimulusSeqs: [-1], maxCalls: 2 })
        return quiet
      }),
    )
    await runtime.submit(MOVE)
    expect(settled).toBe(true)
    await new Promise(done => setTimeout(done, 20))
    expect(rejections).toEqual([])
    expect((await runtime.submit('还在吗？')).error).toBeFalsy()
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

it('refuses a turn started after the scheduler returned', async () => {
  let late: SchedulerRound | undefined
  const { runtime } = await start(
    provider(async round => {
      late = round
      return quiet
    }),
  )
  await runtime.submit(MOVE)
  await expect(
    late!.turn(WITNESS as never, { signal: new AbortController().signal, stimulusSeqs: [], maxCalls: 2 }),
  ).rejects.toThrow(TypeError)
})

it('still closes the world when the scheduler throws synchronously on close', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime, root } = await start(
    provider(async () => quiet, {
      open: async () => ({
        run: async () => quiet,
        close: () => {
          throw new Error('close bug')
        },
      }),
    }),
  )
  await runtime.close()
  runtimes.length = 0
  rmSync(root, { recursive: true, force: true })
})

it('keeps the plugin notice and skips autonomy when the scheduler throws in a pack with autonomous roles', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { runtime, actors } = await start(
    provider(async () => {
      throw new Error('plugin bug')
    }),
    undefined,
    'autonomy-scheduling',
  )
  const state = await runtime.submit('你好')
  expect(state.error).toBe(true)
  expect(state.notice).toContain('调度器插件')
  expect(actors).toEqual([])
})

it('does not report an unknown reason as a budget limit in a pack with autonomous roles', async () => {
  const { runtime } = await start(
    provider(async () => ({ ...quiet, terminalReason: 'my_done' })),
    undefined,
    'autonomy-scheduling',
  )
  const state = await runtime.submit('你好')
  expect(state.notice).not.toContain('预算上限')
  expect(state.error).toBeFalsy()
})

it('treats an activation with a null result as an invalid result', async () => {
  const { runtime } = await start(
    provider(async () => ({
      ...quiet,
      terminalReason: 'failed',
      activations: [{ characterId: WITNESS, result: null }],
    })),
  )
  const state = await runtime.submit(MOVE)
  expect(state.error).toBeFalsy()
  expect(state.notice).toContain('本轮角色处理已结束')
})
