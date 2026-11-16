import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandId } from '@perspectra/sdk/contracts'
import type {
  CharacterLoopActivation,
  CharacterLoopInstance,
  DecisionInstance,
  KnowledgeInstance,
  SchedulerInstance,
  SchedulerResult,
  SchedulerRound,
  SeamProvider,
  WorldServices,
} from '@perspectra/sdk'
import { WorldStore } from '@perspectra/core/store'
import { afterEach, expect, it, vi } from 'vitest'
import { loadHostPlugins, type HostPlugins } from '../../apps/host/src/host-plugins.ts'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { WorldHostRuntime, type WorldHostOptions } from '../../apps/host/src/runtime/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const PACK = resolve('examples/world-packs/dynamic-scheduling')
const MOVE_FRONT = '/act move {"locationId":"location:front-room"}'
const WITNESS = brandId('character:witness', 'CharacterId')
const QUIET: SchedulerResult = {
  calls: 0,
  wave: 0,
  terminalReason: 'quiescent',
  activations: [],
}

const roots: string[] = [],
  runtimes: WorldHostRuntime[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = [],
  sessions: HostPlugins[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined)
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root() {
  const path = mkdtempSync(join(tmpdir(), 'perspectra-provider-lifecycle-'))
  roots.push(path)
  return path
}

function knowledge(close?: () => void | Promise<void>): SeamProvider<KnowledgeInstance> {
  return {
    id: 'test-knowledge',
    version: '1.0.0',
    open: async () => ({ select: () => undefined, ...(close ? { close } : {}) }),
  }
}

function scheduler(run: SchedulerInstance['run']): SeamProvider<SchedulerInstance> {
  return {
    id: 'test-scheduler',
    version: '1.0.0',
    open: async () => ({ run }),
  }
}

async function start(path: string, options: Partial<WorldHostOptions> = {}) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const { composition, plugins, ...rest } = options
  const runtime = await WorldHostRuntime.create({
    dataDirectory: path,
    packPath: PACK,
    models: fakeModels(server.endpoint),
    providerCleanupTimeoutMs: 20,
    composition:
      composition ??
      assembleRoleplay({
        knowledge: knowledge(),
        scheduler: scheduler(async () => QUIET),
        ...plugins,
      }),
    ...rest,
  })
  runtimes.push(runtime)
  return { runtime, server, path }
}

function eventCount(path: string, runtime: WorldHostRuntime) {
  const store = new WorldStore(join(path, 'world.sqlite'))
  try {
    return store.readEvents(runtime.address).length
  } finally {
    store.close()
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function logText(entries: unknown[]): string {
  return entries
    .map(entry => {
      const values = Array.isArray(entry) ? entry : [entry]
      return values
        .map(value =>
          value instanceof Error
            ? [value.name, value.message, value.stack, value.cause === undefined ? '' : String(value.cause)].join('\n')
            : String(value),
        )
        .join(' ')
    })
    .join('\n')
}

it('stops on the selected scheduler failure and closes resources opened before it', async () => {
  const path = root()
  const close = vi.fn()
  let opens = 0
  const broken: SeamProvider<SchedulerInstance> = {
    id: 'broken-scheduler',
    version: '1.0.0',
    open: async () => {
      opens += 1
      throw new TypeError('FAKE_OPEN_FAILURE')
    },
  }

  await expect(
    start(path, {
      composition: assembleRoleplay({ knowledge: knowledge(close), scheduler: broken }),
    }),
  ).rejects.toMatchObject({
    origin: 'plugin',
    pluginId: 'broken-scheduler',
    operation: 'open',
    invalidResult: false,
  })
  expect(opens).toBe(1)
  expect(close).toHaveBeenCalledOnce()

  const store = new WorldStore(join(path, 'world.sqlite'))
  store.close()
})

it('closes one world without changing its sibling world', async () => {
  const resources: { closed: boolean }[] = []
  const shared: SeamProvider<SchedulerInstance> = {
    id: 'shared-scheduler',
    version: '1.0.0',
    open: async () => {
      const resource = { closed: false }
      resources.push(resource)
      return {
        run: async () => QUIET,
        close: () => {
          resource.closed = true
        },
      }
    },
  }
  const aPath = root(),
    bPath = root()
  const a = await start(aPath, { plugins: { scheduler: shared } })
  const b = await start(bPath, { plugins: { scheduler: shared } })
  await a.runtime.submit('A 世界。')
  await b.runtime.submit('B 世界。')

  await a.runtime.close()
  runtimes.splice(runtimes.indexOf(a.runtime), 1)
  expect(resources[0]!.closed).toBe(true)
  expect(resources[1]!.closed).toBe(false)

  const before = eventCount(bPath, b.runtime)
  const state = await b.runtime.submit('B 仍然可以继续。')
  expect(state.error).toBe(false)
  expect(state.transcript.some(line => line.text === 'B 仍然可以继续。')).toBe(true)
  expect(eventCount(bPath, b.runtime)).toBeGreaterThan(before)
  expect(resources[1]!.closed).toBe(false)
})

it('ends a paused scheduler wait and rejects its late turn without changing the world', async () => {
  const entered = deferred(),
    release = deferred()
  let lateError: unknown
  const paused = scheduler(async round => {
    entered.resolve()
    await release.promise
    try {
      await round.turn(WITNESS, {
        signal: round.signal,
        stimulusSeqs: round.observationSeqs(WITNESS, round.afterSeq, round.headSeq()),
        maxCalls: 1,
      })
    } catch (error) {
      lateError = error
      throw error
    }
    return QUIET
  })
  const world = await start(root(), { plugins: { scheduler: paused } })
  const submitting = world.runtime.submit(MOVE_FRONT)
  await entered.promise
  await world.runtime.pause()
  await expect(within(submitting)).resolves.toBeDefined()

  const before = eventCount(world.path, world.runtime)
  release.resolve()
  await vi.waitFor(() => expect(lateError).toBeDefined())
  expect(eventCount(world.path, world.runtime)).toBe(before)
})

it('actively ends an ignored decision wait on close and rejects its late submission', async () => {
  const schedulerEntered = deferred(),
    loopEntered = deferred(),
    decisionEntered = deferred(),
    releaseDecision = deferred()
  let activation!: CharacterLoopActivation, loopError: unknown
  const waitingDecision: SeamProvider<DecisionInstance> = {
    id: 'waiting-decision',
    version: '1.0.0',
    open: async () => ({
      decide: async () => {
        decisionEntered.resolve()
        await releaseDecision.promise
        return { decision: 'abstain' }
      },
    }),
  }
  const controllingLoop: SeamProvider<CharacterLoopInstance> = {
    id: 'test-character-loop',
    version: '1.0.0',
    open: async () => ({
      run: async current => {
        activation = current
        loopEntered.resolve()
        try {
          current.prepare({ continuation: false, canPerform: false })
          const decision = await current.decide()
          await current.submit(decision)
        } catch (error) {
          loopError = error
        }
        return 'failed'
      },
    }),
  }
  const turnScheduler = scheduler(async round => {
    schedulerEntered.resolve()
    const id = WITNESS
    const result = await round.turn(id, {
      signal: round.signal,
      stimulusSeqs: round.observationSeqs(id, round.afterSeq, round.headSeq()),
      maxCalls: 1,
    })
    return {
      calls: result.calls,
      wave: 1,
      terminalReason: 'quiescent',
      activations: [{ characterId: id, result }],
    }
  })
  const world = await start(root(), {
    plugins: {
      scheduler: turnScheduler,
      decisions: [waitingDecision],
      decisionOrder: [],
      characterLoop: controllingLoop,
    },
  })
  const submitting = world.runtime.submit(MOVE_FRONT)
  await within(schedulerEntered.promise, 5_000, 'scheduler entry')
  await within(loopEntered.promise, 5_000, 'character loop entry')
  await within(decisionEntered.promise, 5_000, 'decision entry')
  const closing = world.runtime.close()
  runtimes.splice(runtimes.indexOf(world.runtime), 1)

  const submission = await within(
    submitting.then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    ),
  )
  if (submission.status === 'rejected') expect(submission.error).not.toMatchObject({ origin: 'plugin' })
  await expect(within(closing)).resolves.toBeUndefined()
  const before = eventCount(world.path, world.runtime)
  await expect(
    activation.submit({
      decision: 'publish',
      segments: [{ type: 'speech', text: 'FAKE_LATE_SUBMISSION' }],
    }),
  ).rejects.toBeDefined()
  expect(eventCount(world.path, world.runtime)).toBe(before)

  releaseDecision.resolve()
  await vi.waitFor(() => expect(loopError).toBeDefined())
})

it('reclaims a late open and keeps closing after a provider close throws or hangs', async () => {
  const latePath = root(),
    openEntered = deferred(),
    lateOpen = deferred<SchedulerInstance>()
  const openDeadline = new AbortController(),
    originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeoutSpy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation(milliseconds => (milliseconds === 30_000 ? openDeadline.signal : originalTimeout(milliseconds)))
  const lateProvider: SeamProvider<SchedulerInstance> = {
    id: 'late-scheduler',
    version: '1.0.0',
    open: async () => {
      openEntered.resolve()
      return lateOpen.promise
    },
  }
  const creating = start(latePath, {
    composition: assembleRoleplay({ knowledge: knowledge(), scheduler: lateProvider }),
  })
  await within(openEntered.promise, 5_000, 'late open entry')
  const deadlineReason = new Error('test open deadline')
  openDeadline.abort(deadlineReason)
  await expect(creating).rejects.toBe(deadlineReason)
  timeoutSpy.mockRestore()

  const lateClose = vi.fn()
  lateOpen.resolve({ run: async () => QUIET, close: lateClose })
  await vi.waitFor(() => expect(lateClose).toHaveBeenCalledOnce())

  const closeFailure = new Error('FAKE_PRIVATE_CLOSE_FAILURE')
  const schedulerClose = vi.fn(),
    decisionClose = vi.fn(() => new Promise<void>(() => {}))
  const decisions: SeamProvider<DecisionInstance> = {
    id: 'hanging-decision',
    version: '1.0.0',
    open: async () => ({ close: decisionClose }),
  }
  const closingScheduler: SeamProvider<SchedulerInstance> = {
    id: 'closing-scheduler',
    version: '1.0.0',
    open: async () => ({ run: async () => QUIET, close: schedulerClose }),
  }
  const errors: unknown[] = []
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
  const closingWorld = await start(root(), {
    composition: assembleRoleplay({
      knowledge: knowledge(() => {
        throw closeFailure
      }),
      decisions: [decisions],
      decisionOrder: [],
      scheduler: closingScheduler,
    }),
  })
  await expect(within(closingWorld.runtime.close(), 1_000, 'world close')).resolves.toBeUndefined()
  runtimes.splice(runtimes.indexOf(closingWorld.runtime), 1)
  expect(schedulerClose).toHaveBeenCalledOnce()
  expect(decisionClose).toHaveBeenCalledOnce()
  expect(errors.join(' ')).not.toContain(closeFailure.message)

  const store = new WorldStore(join(closingWorld.path, 'world.sqlite'))
  store.close()
  expect(() => rmSync(closingWorld.path, { recursive: true, force: true })).not.toThrow()
  roots.splice(roots.indexOf(closingWorld.path), 1)
})

it('turns native throws and invalid returns into safe PluginFaults without leaking private text', async () => {
  const logs: unknown[] = []
  for (const method of ['error', 'warn', 'log'] as const)
    vi.spyOn(console, method).mockImplementation((...args) => void logs.push(args))
  const cases = [
    {
      name: 'throws',
      body: 'throw new TypeError("FAKE_PRIVATE_MARKER")',
      operation: 'open',
      invalidResult: false,
    },
    {
      name: 'invalid',
      body: 'return { run: "FAKE_PRIVATE_MARKER" }',
      operation: 'open:run',
      invalidResult: true,
    },
  ] as const

  for (const entry of cases) {
    const path = root(),
      id = `native-${entry.name}`,
      modulePath = join(path, `${id}.mjs`)
    writeFileSync(
      modulePath,
      [
        "export const hostApi = '2.0'",
        'export default ctx => ctx.effect(() => ctx.scheduler.register({',
        `  id: '${id}',`,
        "  version: '1.0.0',",
        '  open: async () => {',
        `    ${entry.body}`,
        '  },',
        '}))',
      ].join('\n'),
    )
    writeFileSync(
      join(path, `${id}.plugin.json`),
      JSON.stringify({ id, name: id, version: '1.0.0', services: ['scheduler'] }),
    )
    const session = await loadHostPlugins([{ id, path: modulePath, nativeAllowed: true, enabled: true }])
    sessions.push(session)

    let failure: unknown
    try {
      const unexpected = await start(root(), { plugins: { scheduler: session.seams.scheduler } })
      await unexpected.runtime.close()
      runtimes.splice(runtimes.indexOf(unexpected.runtime), 1)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'PluginFault',
      origin: 'plugin',
      pluginId: id,
      operation: entry.operation,
      invalidResult: entry.invalidResult,
    })
    expect(String((failure as Error).message)).not.toContain('FAKE_PRIVATE_MARKER')
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect((failure as Error).cause).toBeUndefined()

    await session.close()
    sessions.splice(sessions.indexOf(session), 1)
  }
  expect(logText(logs)).not.toContain('FAKE_PRIVATE_MARKER')
})

it('protects scheduler onCommitted while preserving the speech already committed', async () => {
  const marker = 'FAKE_PRIVATE_ON_COMMITTED'
  const world = await start(root(), {
    plugins: {
      characterLoop: {
        id: 'publishing-loop',
        version: '1.0.0',
        open: async () => ({
          run: async current => {
            current.prepare({ continuation: false, canPerform: false })
            await current.submit({ decision: 'publish', segments: [{ type: 'speech', text: '回调前已经提交。' }] })
            return 'published'
          },
        }),
      },
      scheduler: scheduler(async round => {
        await round.turn(WITNESS, {
          signal: round.signal,
          stimulusSeqs: round.observationSeqs(WITNESS, round.afterSeq, round.headSeq()),
          maxCalls: 1,
          onCommitted: () => {
            throw new TypeError(marker)
          },
        })
        return QUIET
      }),
    },
  })
  const state = await world.runtime.submit(MOVE_FRONT)
  expect(JSON.stringify(state)).not.toContain(marker)
  expect(state.transcript.some(line => line.text === '回调前已经提交。')).toBe(true)
})

it('preserves scheduler read errors and expires all retained reads at the end of the round', async () => {
  let saved!: SchedulerRound
  let fail = true
  const failure = new Error('core scheduler read failed')
  const world = await start(root(), {
    plugins: {
      scheduler: scheduler(async round => {
        saved = round
        if (fail) {
          fail = false
          const head = vi.spyOn(WorldStore.prototype, 'head').mockImplementationOnce(() => {
            throw failure
          })
          try {
            round.headSeq()
          } finally {
            head.mockRestore()
          }
        }
        return QUIET
      }),
    },
  })
  await expect(world.runtime.submit(MOVE_FRONT)).rejects.toBe(failure)
  await world.runtime.submit('新的输入。')
  expect(() => saved.headSeq()).toThrow('scheduler round has ended')
  expect(() => saved.world.head()).toThrow('scheduler round has ended')
  await world.runtime.close()
  expect(() => saved.world.head()).toThrow('WorldInstanceScope is closed')
})

it('propagates host core and SQLite callback errors by identity through a scheduler plugin', async () => {
  const path = root()
  let phase = 0
  let services!: WorldServices
  const callbackErrors: unknown[] = []
  const failing: SeamProvider<SchedulerInstance> = {
    id: 'callback-error-scheduler',
    version: '1.0.0',
    open: async world => {
      services = world
      return {
        run: async round => {
          try {
            if (phase === 0) {
              phase = 1
              await round.turn(WITNESS, { signal: round.signal, stimulusSeqs: [-1], maxCalls: 1 })
            } else {
              phase = 2
              const database = new DatabaseSync(join(path, 'world.sqlite'))
              database.exec('DROP TABLE heads')
              database.close()
              services.world.head()
            }
          } catch (error) {
            callbackErrors.push(error)
            throw error
          }
          return QUIET
        },
      }
    },
  }
  const world = await start(path, { plugins: { scheduler: failing } })

  const coreFailure = await world.runtime.submit(MOVE_FRONT).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(coreFailure).toBe(callbackErrors[0])

  const storageFailure = await world.runtime.submit('触发存储故障。').then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(storageFailure).toBe(callbackErrors[1])
  expect(storageFailure).toMatchObject({ code: 'ERR_SQLITE_ERROR' })
})
