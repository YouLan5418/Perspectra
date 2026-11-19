import type { ExecutionSchedulerRound } from './scheduler-round.ts'
import type { SchedulerRound, SchedulerResult } from '@perspectra/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { HostCallbackErrors, hostCallback } from '@perspectra/core/runtime'
import { WorldApplication } from './world-application.ts'
import { brandId } from '@perspectra/sdk/contracts'
import { AuthorizedSourceStore } from '@perspectra/core/memory'
import { createSchedulerRound } from './scheduler-round.ts'
import { WorldStore } from '@perspectra/core/store'
import { frozenInteractionWorld, basicInteractionPackage } from '../../../../tests/fixtures/frozen-interaction-world.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(callbacks?: HostCallbackErrors) {
  const root = mkdtempSync(join(tmpdir(), 'public-execution-'))
  const app = new WorldApplication({
    worldPath: join(root, 'world.sqlite'),
    sessionPath: join(root, 'session.sqlite'),
    memoryPath: join(root, 'memory.sqlite'),
    interactionPackages: [basicInteractionPackage],
  })
  cleanup.push(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  const world = frozenInteractionWorld()
  app.activate(world)
  const scope = await app.createInstanceScope()
  const engine = await app.createExecutionEngine({
    scope,
    address: world.manifest.address,
    ...(callbacks ? { callbacks } : {}),
  })
  const request = engine.beginRequest()
  return { root, app, scope, engine, request, address: world.manifest.address }
}

it('runs a system cycle with no player input and commits hooks in stable order, then reacts within the same grant', async () => {
  const { app, engine, request, address } = await fixture()
  const before = await app.head(address)
  const order: string[] = []
  const hook = (pluginId: string) => ({
    pluginId,
    hookId: 'end',
    resolve: () => {
      order.push(pluginId)
      return { events: [], authority: { pluginId } }
    },
  })
  engine.registerCoreCycleEndHook(hook('z'))
  engine.registerCoreCycleEndHook(hook('a'))
  const cycle = request.openCycle()
  const react = vi.fn(async (control: import('./execution-engine.ts').ExecutionCycleControl) => {
    const result = await control.activate(brandId('character:npc', 'CharacterId'), async () => ({
      status: 'abstained',
      calls: 0,
      controlledCommitted: false,
      publicationCommitted: false,
    }))
    expect(result.status).toBe('abstained')
  })
  expect((await cycle.complete(react)).status).toBe('completed')
  expect(order).toEqual(['a', 'z'])
  expect((await app.head(address)).tick).toBe(before.tick + 2)
  expect(react).toHaveBeenCalledOnce()
  expect(request.snapshot().usedActivations).toBe(1)
})

it('preserves earlier atomic settlements and safely reports a failing or invalid later hook', async () => {
  const { app, engine, request, address } = await fixture()
  const before = await app.head(address)
  engine.registerCoreCycleEndHook({
    pluginId: 'a',
    hookId: 'end',
    resolve: () => ({ events: [], authority: { ok: true } }),
  })
  const remove = engine.registerCoreCycleEndHook({
    pluginId: 'b',
    hookId: 'end',
    resolve: () => {
      throw new Error('PRIVATE_NATIVE_CONTEXT')
    },
  })
  const later = vi.fn(() => undefined)
  engine.registerCoreCycleEndHook({ pluginId: 'c', hookId: 'end', resolve: later })
  const result = await request.runCycle(async () => {})
  expect(result).toMatchObject({
    status: 'failed',
    failure: { origin: 'plugin', pluginId: 'b', operation: 'onCycleEnd' },
  })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_CONTEXT')
  expect((await app.head(address)).tick).toBe(before.tick + 1)
  expect(later).not.toHaveBeenCalled()
  remove()
  engine.registerCoreCycleEndHook({
    pluginId: 'b',
    hookId: 'end',
    resolve: () => ({
      events: [{ eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: 999 } }],
      authority: {},
    }),
  })
  const invalid = await request.runCycle(async () => {})
  expect(invalid.status).toBe('failed')
  expect(invalid.failure).toMatchObject({ pluginId: 'b' })
  expect((await app.head(address)).tick).toBe(before.tick + 2)
})

it('propagates commit failures as the original core error and closes grants with the owning scope', async () => {
  const { app, engine, request, address, scope } = await fixture()
  const before = await app.head(address)
  const failure = new Error('core storage failed')
  engine.registerCoreCycleEndHook({ pluginId: 'test', hookId: 'end', resolve: () => ({ events: [], authority: {} }) })
  vi.spyOn(WorldStore.prototype, 'commitRound').mockRejectedValueOnce(failure)
  await expect(request.runCycle(async () => {})).rejects.toBe(failure)
  expect(await app.head(address)).toEqual(before)
  await scope.close()
  expect(request.signal.aborted).toBe(true)
  expect(() => engine.beginRequest()).toThrow('closed')
})

it('discards limited settlement effects when the request is cancelled during adjudication', async () => {
  const { app, engine, address } = await fixture()
  const controller = new AbortController()
  const request = engine.beginRequest({ signal: controller.signal })
  const before = await app.head(address)
  const limited = vi.fn(() => {
    controller.abort()
    return { events: [], authority: { earned: true } }
  })
  engine.registerCoreCycleEndHook({
    pluginId: 'test',
    hookId: 'clock',
    resolve: () => undefined,
    resolveOnCallLimit: limited,
  })
  const cycle = request.openCycle()
  cycle.control.observe('call_limit')
  await cycle.complete()
  expect(limited).toHaveBeenCalledOnce()
  expect(await app.head(address)).toEqual(before)
})

it('rejects a foreign application scope before mounting a world', async () => {
  const { app, address } = await fixture()
  const other = new WorldApplication({ worldPath: 'unused-world', sessionPath: 'unused-session' })
  cleanup.push(() => other.close())
  const scope = await other.createInstanceScope()
  await expect(app.createExecutionEngine({ scope, address })).rejects.toThrow('another application')
})

it('drives real bound CharacterTurns with an installed scheduler through the public headless cycle entry', async () => {
  const { app, engine, scope, address } = await fixture()
  const request = engine.beginRequest({ budget: { maxActivations: 1 } })
  try {
    const result = await app.withExecutionResources({ scope, address }, async resources => {
      const turn = resources.createTurn({
        loop: {
          async run(a) {
            a.prepare({ canPerform: true, continuation: false })
            await a.submit({ decision: 'abstain' })
            return 'abstained'
          },
        },
        decide: async () => {
          throw new Error('no model expected')
        },
        rulebooks: (await import('@perspectra/core/kernel')).createCoreRulebookRegistry({
          interactionPackages: [basicInteractionPackage],
        }),
      })
      const round = createSchedulerRound({
        store: resources.store,
        address,
        turn,
        afterSeq: 0,
        characterIds: [brandId('character:npc', 'CharacterId')],
        signal: request.signal,
        limits: { maximumWaves: 2, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
        allowConcurrent: true,
        world: {
          readEvents: () => [],
          characterObservations: () => [],
          head: () => resources.store.head(address),
          eventTicks: () => [],
          authorizedSources: () => [],
        },
      })
      return request.runScheduledCycle({
        pluginId: 'headless-test',
        rounds: [round, round],
        scheduler: {
          async run(capabilities) {
            const result = await capabilities.turn(brandId('character:npc', 'CharacterId'), {
              signal: capabilities.signal,
              stimulusSeqs: [],
              maxCalls: 2,
            })
            return {
              calls: result.calls,
              wave: 1,
              terminalReason: 'quiescent',
              activations: [{ characterId: brandId('character:npc', 'CharacterId'), result }],
            }
          },
        },
      })
    })
    expect(result.status).toBe('budget_exhausted')
    expect(result.activations).toMatchObject([
      { status: 'abstained', lastDecision: { decision: 'abstain' }, controlledCommitted: false },
      { status: 'budget_exhausted' },
    ])
    expect(request.snapshot().usedActivations).toBe(1)
  } finally {
    request.close()
  }
})

it('captures committed cycle observations through the existing durable cognitive path', async () => {
  const { app, engine, request, root, address } = await fixture()
  const npc = brandId('character:npc', 'CharacterId')
  engine.registerCoreCycleEndHook({
    pluginId: 'core-test',
    hookId: 'observe',
    resolve: () => ({
      authority: { kind: 'test-observation' },
      events: [
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: {
            id: 'cycle-observation',
            value: { observerId: npc, content: { status: 'accepted', text: '听到一声钟响。' } },
          },
        },
      ],
    }),
  })
  expect((await request.runCycle(async () => {})).status).toBe('completed')
  const store = new WorldStore(join(root, 'world.sqlite')),
    memory = new AuthorizedSourceStore(join(root, 'memory.sqlite'), store)
  try {
    expect(memory.watermark(address, npc)?.capturedThroughSeq).toBe((await app.head(address)).headSeq)
  } finally {
    memory.close()
    store.close()
  }
})

it.each(['direct', 'cycle'] as const)('preserves a real turn commit error racing cancellation (%s)', async mode => {
  const { app, scope, engine, address } = await fixture()
  const controller = new AbortController()
  const request = engine.beginRequest({ signal: controller.signal })
  const failure = new Error('core commit failure')
  const before = await app.head(address)
  try {
    await app.withExecutionResources({ scope, address }, async resources => {
      const turn = resources.createTurn({
        loop: {
          async run(activation) {
            activation.prepare({ canPerform: false, continuation: false })
            await activation.submit({ decision: 'publish', segments: [{ type: 'speech', text: '未提交的发言' }] })
            return 'published'
          },
        },
        decide: async () => {
          throw new Error('no model expected')
        },
        rulebooks: (await import('@perspectra/core/kernel')).createCoreRulebookRegistry({
          interactionPackages: [basicInteractionPackage],
        }),
      })
      vi.spyOn(resources.store, 'commitRound').mockImplementationOnce(async () => {
        controller.abort()
        throw failure
      })
      const npc = brandId('character:npc', 'CharacterId')
      const operation =
        mode === 'direct'
          ? turn.run(npc, { signal: request.signal })
          : request.runCycle(async control => {
              await control.activate(npc, (signal, onProgress) => turn.run(npc, { signal, onProgress }))
            })
      await expect(operation).rejects.toBe(failure)
    })
    expect(await app.head(address)).toEqual(before)
  } finally {
    request.close()
  }
})

it.each([false, true])(
  'drives settlement observations through the public cycle with one shared grant (factory=%s)',
  async fresh => {
    const { app, scope, engine, address } = await fixture()
    const request = engine.beginRequest({ budget: { maxActivations: 1 } })
    const npc = brandId('character:npc', 'CharacterId')
    const settle = vi.fn(() => ({
      authority: { kind: 'test-observation' },
      events: [
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: {
            id: 'settlement-driver-observation',
            value: { observerId: npc, content: { status: 'accepted', text: '钟响了。' } },
          },
        },
      ],
    }))
    engine.registerCoreCycleEndHook({ pluginId: 'core-test', hookId: 'observe', resolve: settle })
    try {
      await app.withExecutionResources({ scope, address }, async ({ store, createTurn }) => {
        const before = store.head(address).headSeq
        const observed: number[] = []
        const turn = createTurn({
          loop: {
            async run(activation) {
              activation.prepare({ canPerform: false, continuation: false })
              await activation.submit({ decision: 'abstain' })
              return 'abstained'
            },
          },
          decide: async () => {
            throw new Error('no model expected')
          },
          rulebooks: (await import('@perspectra/core/kernel')).createCoreRulebookRegistry({
            interactionPackages: [basicInteractionPackage],
          }),
        })
        const roundAt = (afterSeq: number) =>
          createSchedulerRound({
            store,
            address,
            turn,
            afterSeq,
            characterIds: [npc],
            signal: request.signal,
            limits: { maximumWaves: 2, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
            allowConcurrent: true,
            world: {
              readEvents: () => [],
              characterObservations: () => [],
              head: () => store.head(address),
              eventTicks: () => [],
              authorizedSources: () => [],
            },
          })
        let runs = 0
        const result = await request.runScheduledCycle({
          pluginId: 'test-scheduler',
          rounds: fresh ? [] : [roundAt(before)],
          ...(fresh
            ? {
                settlementRounds: (afterSeq: number) => {
                  expect(afterSeq).toBe(before)
                  return [roundAt(afterSeq)]
                },
              }
            : {}),
          scheduler: {
            async run(round) {
              runs++
              const seqs = round.observationSeqs(npc, round.afterSeq, round.headSeq())
              observed.push(...seqs)
              if (seqs.length) await round.turn(npc, { signal: round.signal, stimulusSeqs: seqs, maxCalls: 2 })
              return { calls: 0, wave: 1, terminalReason: 'quiescent', activations: [] }
            },
          },
        })
        const observation = store
          .readEvents(address)
          .find(
            event =>
              event.eventType === 'observation.upsert' &&
              (event.data as { id?: string }).id === 'settlement-driver-observation',
          )
        expect(observation).toBeDefined()
        expect(observed).toContain(observation!.seq)
        expect(result.status).toBe('completed')
        expect(result.activations).toMatchObject([{ characterId: npc, status: 'abstained' }])
        expect(request.snapshot()).toMatchObject({ usedActivations: 1, remainingActivations: 0, runningActivations: 0 })
        expect(settle).toHaveBeenCalledOnce()
        expect(runs).toBe(fresh ? 1 : 2)
      })
    } finally {
      request.close()
    }
  },
)

it.each(['factory', 'iterator', 'deadline', 'aware'] as const)(
  'ends waiting for settlement preparation on cancellation or deadline (%s)',
  async mode => {
    const { app, engine, address } = await fixture()
    const request = engine.beginRequest({ budget: { deadlineMs: mode === 'deadline' ? 250 : 270_000 } })
    engine.registerCoreCycleEndHook({
      pluginId: 'core-test',
      hookId: 'end',
      resolve: () => ({ events: [], authority: {} }),
    })
    const before = await app.head(address)
    let ready!: () => void, release!: () => void
    const entered = new Promise<void>(done => {
      ready = done
    })
    const blocked = new Promise<void>(done => {
      release = done
    })
    const operation = request.runScheduledCycle({
      pluginId: 'test-scheduler',
      rounds: [],
      scheduler: {
        async run() {
          return { calls: 0, wave: 0, terminalReason: 'quiescent', activations: [] }
        },
      },
      settlementRounds:
        mode === 'iterator'
          ? () => ({
              async *[Symbol.asyncIterator]() {
                ready()
                await blocked
              },
            })
          : async (_afterSeq, signal) => {
              ready()
              if (mode === 'aware') {
                request.close()
                signal.throwIfAborted()
              }
              await blocked
              return []
            },
    })
    try {
      await entered
      if (mode === 'deadline') {
        if (!request.signal.aborted)
          await new Promise<void>(done => request.signal.addEventListener('abort', () => done(), { once: true }))
      } else request.close()
      const result = await Promise.race([operation, delay(100).then(() => undefined)])
      expect(result?.status).toBe(mode === 'deadline' ? 'budget_exhausted' : 'interrupted')
      expect((await app.head(address)).tick).toBe(before.tick + 1)
      expect(request.snapshot().usedActivations).toBe(0)
    } finally {
      release()
      await operation
      request.close()
    }
  },
)

it('preserves an observed core callback failure when cycle settlement also cancels', async () => {
  const callbacks = new HostCallbackErrors()
  const f = await fixture(callbacks)
  const controller = new AbortController()
  const request = f.engine.beginRequest({ signal: controller.signal })
  const failure = new Error('SQLite commit failed')
  const before = await f.app.head(f.address)
  f.engine.registerCoreCycleEndHook({
    pluginId: 'a',
    hookId: 'end',
    resolve: () => {
      controller.abort()
      return hostCallback(callbacks, () => {
        throw failure
      })
    },
  })
  const later = vi.fn(() => undefined)
  f.engine.registerCoreCycleEndHook({ pluginId: 'b', hookId: 'end', resolve: later })
  try {
    await expect(request.runCycle(async () => {})).rejects.toBe(failure)
  } finally {
    request.close()
  }
  expect(await f.app.head(f.address)).toEqual(before)
  expect(later).not.toHaveBeenCalled()
})

function idleSchedulerRound(signal: AbortSignal): ExecutionSchedulerRound {
  const round: ExecutionSchedulerRound = {
    phase: 'scene',
    characterIds: [brandId('character:npc', 'CharacterId')],
    afterSeq: 0,
    signal,
    limits: { maximumWaves: 2, maximumNpcCalls: 4, maximumCallsPerCharacter: 2 },
    initialCounts: new Map([[brandId('character:npc', 'CharacterId'), 1]]),
    opportunityLimits: {
      maximumNpcCalls: 2,
      deadlineSeconds: 10,
      reactionLimits: { maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1 },
    },
    allowConcurrent: false,
    headSeq: () => 0,
    observationsSince: () => [],
    observationSeqs: () => [],
    presentCharacterIds: () => [],
    locationOf: () => null,
    world: {
      readEvents: () => [],
      characterObservations: () => [],
      head: () => ({ headSeq: 0, tick: 0 }),
      eventTicks: () => [],
      authorizedSources: () => [],
    },
    validateTurn: () => {},
    forReactions: () => round,
    turn: async () => {
      throw new Error('unexpected activation')
    },
  }
  return round
}

it('detaches mutable scheduler configuration for both current and delayed callbacks', async () => {
  const { request } = await fixture()
  const round = idleSchedulerRound(request.signal)
  const before = structuredClone({
    ids: round.characterIds,
    limits: round.limits,
    counts: round.initialCounts,
    opportunity: round.opportunityLimits,
  })
  let exposed!: SchedulerRound
  const result = await request.runScheduledCycle({
    pluginId: 'mutating-scheduler',
    rounds: [round],
    scheduler: {
      async run(input) {
        exposed = input
        ;(input.characterIds as unknown as string[]).reverse()
        ;(input.limits as { maximumNpcCalls: number }).maximumNpcCalls = 999
        ;(input.initialCounts as unknown as Map<string, number>).clear()
        ;(input.opportunityLimits!.reactionLimits as { maximumWaves: number }).maximumWaves = 999
        return { calls: 0, wave: 0, activations: [], terminalReason: 'quiescent' }
      },
    },
  })
  expect(result.status).toBe('completed')
  ;(exposed.characterIds as unknown as string[]).push('character:extra')
  ;(exposed.opportunityLimits as { maximumNpcCalls: number }).maximumNpcCalls = 1000
  expect({
    ids: round.characterIds,
    limits: round.limits,
    counts: round.initialCounts,
    opportunity: round.opportunityLimits,
  }).toEqual(before)
})

it.each([
  { activations: [{ characterId: 'character:npc', result: { status: new String('abstained'), calls: 0 } }] },
  {
    activations: [
      { characterId: 'character:npc', result: { status: 'failed', calls: 0, failure: new String('provider_failed') } },
    ],
  },
  {
    activations: [
      { characterId: 'character:npc', result: { status: 'abstained', calls: 0, performResult: new Map() } },
    ],
  },
  {
    activations: [
      { characterId: 'character:npc', result: { status: 'abstained', calls: 0, performResult: { amount: 1n } } },
    ],
  },
  // Deliberate hole: Array.every must not silently skip a missing activation.
  // eslint-disable-next-line unicorn/no-new-array
  { activations: new Array(1) },
  { calls: -1 },
  { wave: -2 },
  { activations: [{ characterId: 'character:npc', result: {} }] },
  { activations: [{ characterId: 'character:npc', result: { status: 'abstained', calls: -1 } }] },
  { autonomy: {} },
  {
    autonomy: {
      activations: [],
      autonomousCalls: 0,
      reactionCalls: 0,
      terminalReason: 'quiescent',
      reactions: { calls: 0 },
    },
  },
])('rejects malformed scheduler output without granting settlement (case %#)', async invalid => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { request, engine } = await fixture()
  const settle = vi.fn(() => ({ events: [], authority: {} }))
  engine.registerCoreCycleEndHook({ pluginId: 'settlement', hookId: 'end', resolve: settle })
  const result = await request.runScheduledCycle({
    pluginId: 'bad-scheduler',
    rounds: [idleSchedulerRound(request.signal)],
    scheduler: {
      async run() {
        return { calls: 0, wave: 0, terminalReason: 'quiescent', activations: [], ...invalid } as SchedulerResult
      },
    },
  })
  expect(result.status).toBe('failed')
  expect(settle).not.toHaveBeenCalled()
})

it('keeps concurrent player-view reads from taking the writer lease before an NPC publishes', async () => {
  const { app, scope, engine, address } = await fixture()
  const gameplay = await app.createGameplayRuntime({ scope, address, engine, availableServices: [] })
  await gameplay.initialize()
  await app.withExecutionResources({ scope, address }, async resources => {
    const before = resources.store.head(address).headSeq
    const turn = resources.createTurn({
      loop: {
        async run(activation) {
          activation.prepare({ canPerform: false, continuation: false })
          // The browser refreshes PlayerView while an asynchronous model request is in flight.
          await gameplay.playerView('principal:player')
          const player = brandId('character:player', 'CharacterId')
          await app.head(address)
          await app.playerAffordancesForPrincipal(address, 'principal:player', player)
          await app.characterViewForPrincipal(address, 'principal:player', player)
          await app.read.eventHistory(address)
          await app.read.characterView(address, player)
          await app.read.characterAvailability(address, player)
          await app.admin.deadLetters(address)
          await activation.submit({ decision: 'publish', segments: [{ type: 'speech', text: '看到了。' }] })
          return 'published'
        },
      },
      decide: async () => {
        throw new Error('no model expected')
      },
      rulebooks: (await import('@perspectra/core/kernel')).createCoreRulebookRegistry({
        interactionPackages: [basicInteractionPackage],
      }),
    })
    const result = await turn.run(brandId('character:npc', 'CharacterId'))
    expect(result.publicationCommitted).toBe(true)
    expect(resources.store.head(address).headSeq).toBeGreaterThan(before)
  })
})
