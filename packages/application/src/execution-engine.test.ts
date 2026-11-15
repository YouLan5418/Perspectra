import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { createWorldInstanceScope } from '@harness-world/runtime-cordis'
import { WorldExecutionEngine, type ExecutionCycleControl } from './execution-engine.ts'
import {
  recordExecutionModelSend,
  recordExecutionModelObservation,
  withoutExecutionObservation,
} from './execution-observation.ts'

const npc = brandId('character:npc', 'CharacterId')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0).reverse()) await close()
})
const abstain = () =>
  Promise.resolve({
    status: 'abstained' as const,
    calls: 0,
    controlledCommitted: false,
    publicationCommitted: false,
    lastDecision: { decision: 'abstain' as const },
  })
async function fixture(limits = {}) {
  const scope = await createWorldInstanceScope(new Context())
  const settle = vi.fn(async () => undefined)
  const engine = new WorldExecutionEngine({ scope, characters: [npc], defaults: limits, settle })
  cleanups.push(() => scope.close())
  cleanups.push(async () => engine.close())
  const request = engine.beginRequest()
  return { engine, request, scope, settle }
}

it('atomically admits only the last available slot and keeps quota across cycle boundaries', async () => {
  const { request } = await fixture({ maxActivations: 1 })
  const cycle = request.openCycle()
  const run = vi.fn(abstain)
  const results = await Promise.all([cycle.control.activate(npc, run), cycle.control.activate(npc, run)])
  expect(results.map(row => row.status)).toEqual(['abstained', 'budget_exhausted'])
  expect(run).toHaveBeenCalledOnce()
  expect((await cycle.complete()).status).toBe('budget_exhausted')
  const next = await request.runCycle(async control => {
    expect((await control.activate(npc, run)).status).toBe('budget_exhausted')
  })
  expect(next.status).toBe('budget_exhausted')
  expect(run).toHaveBeenCalledOnce()
  expect(Object.isFrozen(request.limits)).toBe(true)
})

it('holds concurrency until the real runner settles even when cancellation is ignored', async () => {
  const { request } = await fixture({ maxConcurrentActivations: 1 })
  const cycle = request.openCycle()
  let entered!: () => void, finish!: () => void
  const ready = new Promise<void>(resolve => {
    entered = resolve
  })
  const pending = cycle.control.activate(npc, async () => {
    entered()
    await new Promise<void>(resolve => {
      finish = resolve
    })
    return abstain()
  })
  await ready
  const run = vi.fn(abstain)
  expect((await cycle.control.activate(npc, run)).status).toBe('budget_exhausted')
  await cycle.complete()
  expect((await pending).status).toBe('interrupted')
  expect(request.snapshot().runningActivations).toBe(1)
  finish()
  await vi.waitFor(() => expect(request.snapshot().runningActivations).toBe(0))
  expect(run).not.toHaveBeenCalled()
})

it('uses one hard deadline across cycles and refuses a new runner after same-tick cancellation', async () => {
  vi.useFakeTimers()
  const { request, settle, engine } = await fixture({ deadlineMs: 30 })
  engine.registerCoreCycleEndHook({ pluginId: 'test', hookId: 'settle', resolve: () => undefined })
  await request.runCycle(async control => {
    await control.activate(npc, abstain)
  })
  await vi.advanceTimersByTimeAsync(31)
  const run = vi.fn(abstain)
  const result = await request.runCycle(async control => {
    await control.activate(npc, run)
  })
  expect(result.status).toBe('budget_exhausted')
  expect(settle).toHaveBeenCalledOnce()
  expect(run).not.toHaveBeenCalled()
  const next = engine.beginRequest()
  const cycle = next.openCycle()
  const pending = cycle.control.activate(npc, run)
  next.close()
  expect((await pending).status).toBe('interrupted')
  await cycle.complete()
  expect(run).not.toHaveBeenCalled()
})

it('preserves actual commit progress when a later publication hangs and the request is cancelled', async () => {
  const { request } = await fixture()
  const cycle = request.openCycle()
  let ready!: () => void
  const entered = new Promise<void>(resolve => {
    ready = resolve
  })
  const operation = cycle.control.activate(npc, async (_signal, progress) => {
    progress({
      calls: 2,
      controlledCommitted: true,
      publicationCommitted: false,
      performResult: { status: 'accepted', secret: 'private' },
      lastDecision: { decision: 'perform', status: 'accepted', controlledCommitted: true, publicationRejected: false },
    })
    ready()
    return new Promise(() => {})
  })
  await entered
  request.close()
  expect(await operation).toMatchObject({
    status: 'interrupted',
    controlledCommitted: true,
    publicationCommitted: false,
    calls: 2,
    performResult: { secret: 'private' },
  })
  const result = await cycle.complete()
  expect(result.activations[0]?.lastDecision?.decision).toBe('perform')
})

it('does not hide a real runner error merely because cancellation happened concurrently', async () => {
  const { request } = await fixture()
  const error = new Error('core failure')
  const cycle = request.openCycle()
  const result = cycle.control.activate(npc, async () => {
    request.close()
    throw error
  })
  await expect(result).rejects.toBe(error)
  const request2 = request.engine.beginRequest()
  await expect(
    request2.runCycle(async () => {
      request2.close()
      throw error
    }),
  ).rejects.toBe(error)
  await expect(cycle.complete()).rejects.toBe(error)
})

it('revokes old cycle controls, validates actors and skips settlement after actual failure', async () => {
  const { engine, request, scope, settle } = await fixture()
  engine.registerCoreCycleEndHook({ pluginId: 'test', hookId: 'settle', resolve: () => undefined })
  let saved!: ExecutionCycleControl
  const result = await request.runCycle(async control => {
    saved = control
    await control.activate(npc, async () => ({ ...(await abstain()), status: 'failed' }))
    control.observe('quiescent')
  })
  expect(result.status).toBe('failed')
  expect(settle).not.toHaveBeenCalled()
  await expect(saved.activate(npc, abstain)).rejects.toThrow('ended')
  expect(() => saved.observe('completed')).toThrow('ended')
  const next = request.openCycle()
  expect(() => next.control.activate(brandId('player', 'CharacterId'), abstain)).toThrow('NPC')
  await next.complete()
  await scope.close()
  expect(() => engine.beginRequest()).toThrow('closed')
})

it('counts real sends separately from decisions, retries, opaque calls and unknown usage', async () => {
  const { request } = await fixture()
  const result = await request.runCycle(async control => {
    await control.activate(npc, async () => {
      recordExecutionModelSend()
      recordExecutionModelObservation({ httpAttempts: 2, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } })
      recordExecutionModelSend()
      recordExecutionModelObservation({ httpAttempts: 1 })
      recordExecutionModelSend()
      withoutExecutionObservation(() => recordExecutionModelSend())
      return { ...(await abstain()), calls: 4 }
    })
  })
  expect(result.calls).toBe(4)
  expect(result.usage).toEqual({
    sends: 3,
    observedHttpAttempts: 3,
    observedHttpRetries: 1,
    opaqueTransportCalls: 1,
    usageReported: 1,
    usageMissing: 2,
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  })
})

it('revokes unfinished post-settlement activations before returning a cycle result', async () => {
  const { scope } = await fixture()
  const engine = new WorldExecutionEngine({ scope, characters: [npc], settle: async () => ({ afterSeq: 0 }) })
  cleanups.push(async () => engine.close())
  engine.registerCoreCycleEndHook({ pluginId: 'core-test', hookId: 'end', resolve: () => undefined })
  const request = engine.beginRequest(),
    cycle = request.openCycle()
  let activation!: Promise<unknown>
  const result = await cycle.complete(async control => {
    activation = control.activate(npc, async () => new Promise(() => {}))
    await Promise.resolve()
  })
  expect(result.status).toBe('failed')
  expect(await activation).toMatchObject({ status: 'interrupted' })
})

it('settles after a stale attempt is successfully replanned, while respecting a final scheduler interruption', async () => {
  const { request, engine, settle } = await fixture()
  engine.registerCoreCycleEndHook({ pluginId: 'core-test', hookId: 'end', resolve: () => undefined })
  const result = await request.runCycle(async control => {
    await control.activate(npc, async () => ({ ...(await abstain()), status: 'stale' }))
    await control.activate(npc, abstain)
    control.observe('quiescent')
  })
  expect(result.status).toBe('completed')
  expect(result.activations.map(activation => activation.status)).toEqual(['stale', 'abstained'])
  expect(settle).toHaveBeenCalledOnce()
  const interrupted = await request.runCycle(async control => {
    await control.activate(npc, async () => ({ ...(await abstain()), status: 'stale' }))
    control.observe('interrupted')
  })
  expect(interrupted.status).toBe('interrupted')
  expect(settle).toHaveBeenCalledOnce()
})
