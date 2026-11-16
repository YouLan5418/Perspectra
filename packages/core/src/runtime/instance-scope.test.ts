import { Context } from '@deepseek-ai/cordis'
import type { SeamProvider, WorldServices } from '@perspectra/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createWorldInstanceScope, DEFAULT_CLEANUP_TIMEOUT_MS } from './instance-scope.ts'

const services = {} as WorldServices

function provider<T>(open: (signal: AbortSignal) => Promise<T>): SeamProvider<T> {
  return {
    id: 'test-provider',
    version: '1.0.0',
    open: (_services, signal) => open(signal),
  }
}

describe('WorldInstanceScope', () => {
  it('isolates the same binding in sibling scopes and closes only the selected scope', async () => {
    const root = new Context()
    const scopeA = await createWorldInstanceScope(root)
    const scopeB = await createWorldInstanceScope(root)
    const closeA = vi.fn()
    const closeB = vi.fn()
    const a = { owner: 'a', close: closeA }
    const b = { owner: 'b', close: closeB }

    await scopeA.open(
      'test.seam',
      provider(async () => a),
      services,
    )
    await scopeB.open(
      'test.seam',
      provider(async () => b),
      services,
    )

    expect(scopeA.context.get('test.seam')).toBe(a)
    expect(scopeB.context.get('test.seam')).toBe(b)
    expect(scopeA.resolve('test.seam')).toBe(a)
    expect(scopeB.resolve('test.seam')).toBe(b)
    expect(root.get('test.seam')).toBeUndefined()

    const closing = scopeA.close()
    expect(scopeA.resolve('test.seam')).toBeUndefined()
    expect(scopeA.context.get('test.seam')).toBeUndefined()
    const report = await closing
    expect(report.closed).toContain('test.seam')
    expect(closeA).toHaveBeenCalledOnce()
    expect(scopeA.active).toBe(false)
    expect(scopeA.signal.aborted).toBe(true)
    expect(scopeA.resolve('test.seam')).toBeUndefined()
    expect(scopeB.resolve('test.seam')).toBe(b)
    expect(closeB).not.toHaveBeenCalled()

    await scopeB.close()
    expect(closeB).toHaveBeenCalledOnce()
  })

  it('actively cancels ignored open and invoke work, then reclaims a late resource', async () => {
    const scope = await createWorldInstanceScope(new Context())
    const controller = new AbortController()
    const close = vi.fn()
    let resolveOpen!: (value: { close: () => void }) => void
    const opened = new Promise<{ close: () => void }>(resolve => {
      resolveOpen = resolve
    })
    const openStarted = vi.fn()
    const opening = scope.open(
      'late.seam',
      provider(signal => {
        openStarted(signal)
        return opened
      }),
      services,
      controller.signal,
    )
    await vi.waitFor(() => expect(openStarted).toHaveBeenCalledOnce())
    controller.abort()
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })

    resolveOpen({ close })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(scope.resolve('late.seam')).toBeUndefined()

    const invokeController = new AbortController()
    let resolveWork!: (value: string) => void
    const work = new Promise<string>(resolve => {
      resolveWork = resolve
    })
    const invoking = scope.invoke(() => work, invokeController.signal)
    invokeController.abort()
    await expect(invoking).rejects.toMatchObject({ name: 'AbortError' })
    resolveWork('late result')

    await scope.close()
  })

  it('does not enter invoke work when close wins the same turn', async () => {
    const scope = await createWorldInstanceScope(new Context())
    const work = vi.fn(() => 'should not run')
    const invoking = scope.invoke(work)
    const closing = scope.close()

    await expect(invoking).rejects.toMatchObject({ name: 'AbortError' })
    expect(work).not.toHaveBeenCalled()
    await closing
  })

  it('reports bounded late-resource close failures and timeouts', async () => {
    const scope = await createWorldInstanceScope(new Context(), { cleanupTimeoutMs: 10 })
    const throwController = new AbortController()
    const hangController = new AbortController()
    const closeFailure = new Error('late close failed')
    let resolveThrowing!: (value: { close: () => Promise<void> }) => void
    let resolveHanging!: (value: { close: () => Promise<void> }) => void
    const throwing = new Promise<{ close: () => Promise<void> }>(resolve => {
      resolveThrowing = resolve
    })
    const hanging = new Promise<{ close: () => Promise<void> }>(resolve => {
      resolveHanging = resolve
    })
    const openingThrowing = scope.open(
      'late.throwing',
      provider(() => throwing),
      services,
      throwController.signal,
    )
    const openingHanging = scope.open(
      'late.hanging',
      provider(() => hanging),
      services,
      hangController.signal,
    )
    throwController.abort()
    hangController.abort()
    await expect(openingThrowing).rejects.toMatchObject({ name: 'AbortError' })
    await expect(openingHanging).rejects.toMatchObject({ name: 'AbortError' })
    const report = await scope.close()

    resolveThrowing({
      close: async () => {
        throw closeFailure
      },
    })
    resolveHanging({
      close: () => new Promise<void>(() => {}),
    })
    await vi.waitFor(() => expect(report.failed).toContainEqual({ resource: 'late.throwing', error: closeFailure }))
    await vi.waitFor(() => expect(report.timedOut).toContain('late.hanging'))
  })

  it('keeps a later same-name reservation when the cancelled open finishes late', async () => {
    const scope = await createWorldInstanceScope(new Context(), { cleanupTimeoutMs: 10 })
    const firstController = new AbortController()
    let firstSignal!: AbortSignal
    let resolveFirst!: (value: { close: () => void }) => void
    const first = new Promise<{ close: () => void }>(resolve => {
      resolveFirst = resolve
    })
    const openingFirst = scope.open(
      'retry.seam',
      provider(signal => {
        firstSignal = signal
        return first
      }),
      services,
      firstController.signal,
    )
    const second = { owner: 'second' }
    let resolveSecond!: (value: typeof second) => void
    const secondResource = new Promise<typeof second>(resolve => {
      resolveSecond = resolve
    })
    let openingSecond!: Promise<typeof second>
    // Retry inside abort dispatch: the first call's finally has not run yet.
    firstSignal.addEventListener('abort', () => {
      openingSecond = scope.open(
        'retry.seam',
        provider(() => secondResource),
        services,
      )
    })
    firstController.abort()
    await expect(openingFirst).rejects.toMatchObject({ name: 'AbortError' })
    const thirdOpen = vi.fn(async () => ({ owner: 'third' }))
    await expect(scope.open('retry.seam', provider(thirdOpen), services)).rejects.toThrow('already owned')
    expect(thirdOpen).not.toHaveBeenCalled()
    resolveSecond(second)
    await expect(openingSecond).resolves.toBe(second)
    resolveFirst({ close: () => {} })
    await vi.waitFor(() => expect(scope.resolve('retry.seam')).toBe(second))
    await scope.close()
  })

  it('closes owned resources when the owning Fiber is disposed directly', async () => {
    const scope = await createWorldInstanceScope(new Context())
    const close = vi.fn(() => {
      expect(scope.active).toBe(false)
      expect(scope.signal.aborted).toBe(true)
      expect(scope.resolve('fiber.owned')).toBeUndefined()
    })
    scope.own('fiber.owned', {}, close)
    const work = vi.fn(() => 'should not run')

    await scope.context.fiber.dispose()
    expect(scope.active).toBe(false)
    expect(scope.signal.aborted).toBe(true)
    expect(scope.resolve('fiber.owned')).toBeUndefined()
    expect(scope.context.get('fiber.owned')).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    await expect(scope.invoke(work)).rejects.toThrow('WorldInstanceScope is closed')
    expect(work).not.toHaveBeenCalled()
    const report = await scope.close()
    expect(report.closed).toContain('fiber.owned')
    expect(close).toHaveBeenCalledOnce()
  })

  it('deactivates the scope when the owning root Fiber is disposed', async () => {
    const root = new Context()
    const scope = await createWorldInstanceScope(root)
    const close = vi.fn()
    scope.own('root.owned', {}, close)

    await root.fiber.dispose()
    expect(scope.active).toBe(false)
    expect(scope.signal.aborted).toBe(true)
    expect(scope.resolve('root.owned')).toBeUndefined()
    expect(scope.context.get('root.owned')).toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    await scope.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds owned-resource cleanup during direct Fiber disposal', async () => {
    const scope = await createWorldInstanceScope(new Context(), { cleanupTimeoutMs: 10 })
    const close = vi.fn(() => new Promise<void>(() => {}))
    scope.own('fiber.hanging', {}, close)

    await scope.context.fiber.dispose()
    const report = await scope.close()
    expect(close).toHaveBeenCalledOnce()
    expect(report.timedOut).toContain('fiber.hanging')
  })

  it('records bounded Fiber disposal rejection and timeout diagnostics', async () => {
    const rejectedScope = await createWorldInstanceScope(new Context(), { cleanupTimeoutMs: 10 })
    const failure = new Error('fiber dispose failed')
    vi.spyOn(rejectedScope.context.fiber, 'dispose').mockRejectedValueOnce(failure)

    const rejectedReport = await rejectedScope.close()
    expect(rejectedReport.failed).toContainEqual({ resource: 'scope:fiber', error: failure })

    const hangingScope = await createWorldInstanceScope(new Context(), { cleanupTimeoutMs: 10 })
    vi.spyOn(hangingScope.context.fiber, 'dispose').mockImplementationOnce(() => new Promise<void>(() => {}))

    const hangingReport = await hangingScope.close()
    expect(hangingReport.timedOut).toContain('scope:fiber')
  })

  it('continues bounded reverse cleanup after a throw and a hang', async () => {
    const scope = await createWorldInstanceScope(new Context(), { cleanupTimeoutMs: 10 })
    const order: string[] = []
    const failure = new Error('close failed')
    scope.own('base', {}, () => {
      expect(scope.active).toBe(false)
      expect(scope.resolve('base')).toBeUndefined()
      order.push('base')
    })
    scope.own('throwing', {}, () => {
      order.push('throwing')
      throw failure
    })
    scope.own('hanging', {}, () => {
      order.push('hanging')
      return new Promise<void>(() => {})
    })

    const report = await scope.close()
    expect(order).toEqual(['hanging', 'throwing', 'base'])
    expect(report.closed).toContain('base')
    expect(report.failed).toContainEqual({ resource: 'throwing', error: failure })
    expect(report.timedOut).toContain('hanging')
  })

  it('records a rejected cleanup without a reason as failed instead of closed', async () => {
    const scope = await createWorldInstanceScope(new Context())
    scope.own('no-reason', {}, () => Promise.reject())

    const report = await scope.close()
    expect(report.failed).toContainEqual({ resource: 'no-reason', error: undefined })
    expect(report.closed).not.toContain('no-reason')
  })

  it('uses and exposes a five second default cleanup bound', () => {
    expect(DEFAULT_CLEANUP_TIMEOUT_MS).toBe(5_000)
  })
})
