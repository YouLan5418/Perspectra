import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { SeamProvider, WorldServices } from '@harness-world/plugin-sdk'

const instanceScope = Symbol('harness-world.instance-scope')

export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000

export interface ProviderCleanupReport {
  readonly closed: readonly string[]
  readonly failed: readonly { readonly resource: string; readonly error: unknown }[]
  readonly timedOut: readonly string[]
}

interface MutableCleanupReport {
  readonly closed: string[]
  readonly failed: { resource: string; error: unknown }[]
  readonly timedOut: string[]
}

export interface WorldInstanceScope {
  readonly context: Context
  readonly signal: AbortSignal
  readonly active: boolean
  assertActive(signal?: AbortSignal): void
  open<T>(binding: string, provider: SeamProvider<T>, services: WorldServices, signal?: AbortSignal): Promise<T>
  invoke<T>(work: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T>
  own<T extends object>(binding: string, resource: T, close: () => void | Promise<void>): T
  resolve(binding: string): unknown
  close(): Promise<ProviderCleanupReport>
}

export interface WorldInstanceScopeOptions {
  readonly cleanupTimeoutMs?: number
}

export class CleanupTimeoutError extends Error {
  constructor(
    readonly resource: string,
    readonly timeoutMs: number,
  ) {
    super(`cleanup timed out for ${resource} after ${timeoutMs}ms`)
    this.name = 'CleanupTimeoutError'
  }
}

export type CleanupOutcome =
  | { readonly status: 'closed' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timedOut'; readonly error: CleanupTimeoutError }

interface OwnedResource {
  readonly binding: string
  readonly resource: unknown
  readonly cleanup: () => Promise<CleanupOutcome>
  readonly unprovide: (() => unknown) | undefined
}

function closedError(): Error {
  return new Error('WorldInstanceScope is closed')
}

function abortedError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('WorldInstanceScope operation aborted', 'AbortError')
}

function validateBinding(binding: string): void {
  if (typeof binding !== 'string' || binding.trim().length === 0)
    throw new TypeError('binding must be a non-empty string')
}

export function resolveCleanupTimeoutMs(value: number | undefined = DEFAULT_CLEANUP_TIMEOUT_MS): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('cleanupTimeoutMs must be a positive safe integer')
  return value
}

export async function cleanupWithin(
  resource: string,
  timeoutMs: number,
  work: () => void | PromiseLike<void>,
): Promise<CleanupOutcome> {
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (ok: boolean, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (ok) resolve()
        else reject(value)
      }
      timer = setTimeout(() => finish(false, new CleanupTimeoutError(resource, timeoutMs)), timeoutMs)
      let result: void | PromiseLike<void>
      try {
        result = work()
      } catch (error: unknown) {
        finish(false, error)
        return
      }
      Promise.resolve(result).then(
        () => finish(true),
        error => finish(false, error),
      )
    })
    return { status: 'closed' }
  } catch (error: unknown) {
    return error instanceof CleanupTimeoutError ? { status: 'timedOut', error } : { status: 'failed', error }
  }
}

async function closeProviderResource(resource: unknown): Promise<void> {
  if ((typeof resource !== 'object' && typeof resource !== 'function') || resource === null) return
  if ('close' in resource && typeof resource.close === 'function') {
    await resource.close()
    return
  }
  if ('dispose' in resource && typeof resource.dispose === 'function') await resource.dispose()
}

function onceAsync(work: () => void | Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined
  return () => (result ??= Promise.resolve().then(work))
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    onAbort?.()
    return Promise.reject(abortedError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', handleAbort)
      callback()
    }
    const handleAbort = () =>
      finish(() => {
        onAbort?.()
        reject(abortedError(signal))
      })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) {
      handleAbort()
      return
    }
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function isolationMap(root: Context): Context[typeof Context.isolate] {
  const labels = new Map<string, symbol>()
  const inherited = Object.create(root[Context.isolate]) as Context[typeof Context.isolate]
  return new Proxy(inherited, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      let label = labels.get(property)
      if (label === undefined) {
        label = Symbol(property)
        labels.set(property, label)
      }
      return label
    },
  })
}

class CordisWorldInstanceScope implements WorldInstanceScope {
  readonly context: Context
  readonly signal: AbortSignal
  readonly #controller = new AbortController()
  readonly #fiber: Fiber
  readonly #cleanupTimeoutMs: number
  readonly #resources: OwnedResource[] = []
  readonly #reservedBindings = new Map<string, symbol>()
  readonly #report: MutableCleanupReport = {
    closed: [],
    failed: [],
    timedOut: [],
  }
  #active = true
  #fiberDisposeStarted = false
  #closePromise: Promise<ProviderCleanupReport> | undefined

  static async create(root: Context, options: WorldInstanceScopeOptions = {}): Promise<WorldInstanceScope> {
    const cleanupTimeoutMs = resolveCleanupTimeoutMs(options.cleanupTimeoutMs)
    const scopeLabel = Symbol('harness-world.instance-scope')
    const parent = root.extend({
      [Context.isolate]: isolationMap(root),
      [instanceScope]: scopeLabel,
      [Context.filter]: (listenerContext: Context) => Reflect.get(listenerContext, instanceScope) === scopeLabel,
    })
    let mounted: Context | undefined
    let notifyFiberDisposed = () => {}
    const fiber = parent.plugin(function worldInstanceScopePlugin(ctx) {
      mounted = ctx
      ctx.on('internal/plugin', disposedFiber => {
        if (disposedFiber === ctx.fiber && disposedFiber.uid === null) notifyFiberDisposed()
      })
    })
    await fiber
    if (mounted === undefined) throw new Error('WorldInstanceScope Fiber did not mount')
    const scope = new CordisWorldInstanceScope(mounted, fiber, cleanupTimeoutMs)
    notifyFiberDisposed = () => scope.#handleFiberDisposal()
    return scope
  }

  private constructor(context: Context, fiber: Fiber, cleanupTimeoutMs: number) {
    this.context = context
    this.signal = this.#controller.signal
    this.#fiber = fiber
    this.#cleanupTimeoutMs = cleanupTimeoutMs
  }

  get active(): boolean {
    return this.#active
  }

  assertActive(signal?: AbortSignal): void {
    if (!this.#active) throw closedError()
    if (signal?.aborted === true) throw abortedError(signal)
  }

  async open<T>(binding: string, provider: SeamProvider<T>, services: WorldServices, signal?: AbortSignal): Promise<T> {
    this.assertActive(signal)
    validateBinding(binding)
    const reservation = this.#reserveBinding(binding)
    const operationSignal = signal === undefined ? this.signal : AbortSignal.any([this.signal, signal])
    const opening = (async () => {
      const resource = await provider.open(services, operationSignal)
      if (!this.#active || operationSignal.aborted) {
        this.#cleanupDetachedResource(binding, resource)
        throw abortedError(operationSignal)
      }
      const owned = this.#attachResource(binding, resource, () => closeProviderResource(resource))
      if (!this.#active || operationSignal.aborted) {
        void this.#cleanupOwnedResources([owned])
        throw abortedError(operationSignal)
      }
      this.#resources.push(owned)
      return resource
    })()
    try {
      return await waitForAbort(opening, operationSignal, () => this.#releaseBindingReservation(binding, reservation))
    } finally {
      this.#releaseBindingReservation(binding, reservation)
    }
  }

  async invoke<T>(work: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    this.assertActive(signal)
    const operationSignal = signal === undefined ? this.signal : AbortSignal.any([this.signal, signal])
    const execution = Promise.resolve().then(() => {
      this.assertActive(operationSignal)
      return work(operationSignal)
    })
    return waitForAbort(execution, operationSignal)
  }

  own<T extends object>(binding: string, resource: T, close: () => void | Promise<void>): T {
    this.assertActive()
    validateBinding(binding)
    this.#assertBindingAvailable(binding)
    const owned = this.#attachResource(binding, resource, async () => close())
    if (!this.#active) {
      void this.#cleanupOwnedResources([owned])
      throw closedError()
    }
    this.#resources.push(owned)
    return resource
  }

  resolve(binding: string): unknown {
    if (!this.#active) return undefined
    return this.context.get(binding)
  }

  close(): Promise<ProviderCleanupReport> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#deactivate()
    this.#closePromise = this.#finishClose().then(() => this.#report)
    return this.#closePromise
  }

  #deactivate(): void {
    if (!this.#active && this.signal.aborted) return
    this.#active = false
    this.#controller.abort()
    this.#reservedBindings.clear()
  }

  #handleFiberDisposal(): void {
    if (this.#fiberDisposeStarted) return
    this.#fiberDisposeStarted = true
    const resources = this.#resources.splice(0)
    this.#deactivate()
    const cleanup = this.#cleanupOwnedResources(resources).catch((error: unknown) => {
      this.#report.failed.push({ resource: 'scope:cleanup', error })
    })
    if (this.#closePromise === undefined) this.#closePromise = cleanup.then(() => this.#report)
  }

  #assertBindingAvailable(binding: string): void {
    if (this.#reservedBindings.has(binding) || this.#resources.some(entry => entry.binding === binding))
      throw new Error(`binding is already owned: ${binding}`)
  }

  #reserveBinding(binding: string): symbol {
    this.#assertBindingAvailable(binding)
    const reservation = Symbol(binding)
    this.#reservedBindings.set(binding, reservation)
    return reservation
  }

  #releaseBindingReservation(binding: string, reservation: symbol): void {
    if (this.#reservedBindings.get(binding) === reservation) this.#reservedBindings.delete(binding)
  }

  #attachResource(binding: string, resource: unknown, close: () => Promise<void>): OwnedResource {
    const closeOnce = onceAsync(close)
    let cleanupOutcome: Promise<CleanupOutcome> | undefined
    const cleanup = () => (cleanupOutcome ??= cleanupWithin(binding, this.#cleanupTimeoutMs, closeOnce))
    try {
      this.context.effect(
        () => async () => {
          await cleanup()
        },
        `world-instance-resource:${binding}`,
      )
    } catch (error: unknown) {
      this.#cleanupDetachedResource(binding, resource)
      throw error
    }
    let unprovide: (() => unknown) | undefined
    try {
      unprovide = this.context.provide(binding, resource)
    } catch (error: unknown) {
      void this.#cleanupOwnedResources([{ binding, resource, cleanup, unprovide }])
      throw error
    }
    return { binding, resource, cleanup, unprovide }
  }

  #cleanupDetachedResource(binding: string, resource: unknown): void {
    void cleanupWithin(binding, this.#cleanupTimeoutMs, () => closeProviderResource(resource)).then(outcome =>
      this.#recordOutcome(binding, outcome),
    )
  }

  async #cleanupOwnedResources(resources: readonly OwnedResource[]): Promise<void> {
    const ordered = [...resources].reverse()
    const unregisters = new Map<OwnedResource, CleanupOutcome>()
    await Promise.all(
      ordered.map(async entry => {
        const outcome =
          entry.unprovide === undefined
            ? ({ status: 'closed' } as const)
            : await cleanupWithin(entry.binding, this.#cleanupTimeoutMs, async () => {
                await entry.unprovide!()
              })
        unregisters.set(entry, outcome)
      }),
    )
    for (const entry of ordered) {
      const closed = await entry.cleanup()
      const unregister = unregisters.get(entry)!
      this.#recordResourceOutcomes(entry.binding, unregister, closed)
    }
  }

  #recordResourceOutcomes(binding: string, unregister: CleanupOutcome, close: CleanupOutcome): void {
    const outcomes = [unregister, close]
    const errors = outcomes.flatMap(outcome => (outcome.status === 'failed' ? [outcome.error] : []))
    if (outcomes.some(outcome => outcome.status === 'timedOut')) this.#recordResource(binding, 'timedOut')
    if (errors.length === 1) this.#report.failed.push({ resource: binding, error: errors[0] })
    else if (errors.length > 1)
      this.#report.failed.push({
        resource: binding,
        error: new AggregateError(errors, `cleanup failed for ${binding}`),
      })
    if (outcomes.every(outcome => outcome.status === 'closed')) this.#recordResource(binding, 'closed')
  }

  #recordOutcome(binding: string, outcome: CleanupOutcome): void {
    if (outcome.status === 'failed') this.#report.failed.push({ resource: binding, error: outcome.error })
    else this.#recordResource(binding, outcome.status)
  }

  #recordResource(binding: string, status: 'closed' | 'timedOut'): void {
    if (status === 'closed') this.#report.closed.push(binding)
    else this.#report.timedOut.push(binding)
  }

  async #finishClose(): Promise<void> {
    const resources = this.#resources.splice(0)
    await this.#cleanupOwnedResources(resources)
    await this.#awaitFiberDisposal()
  }

  async #awaitFiberDisposal(): Promise<void> {
    const disposal = Promise.resolve().then(() => this.#fiber.dispose())
    const outcome = await cleanupWithin('scope:fiber', this.#cleanupTimeoutMs, () => disposal)
    if (outcome.status === 'failed') {
      this.#report.failed.push({ resource: 'scope:fiber', error: outcome.error })
    } else if (outcome.status === 'timedOut') {
      this.#recordResource('scope:fiber', 'timedOut')
    }
    if (outcome.status !== 'failed')
      void disposal.catch(error => {
        this.#report.failed.push({ resource: 'scope:fiber', error })
      })
  }
}

export function createWorldInstanceScope(
  root: Context,
  options: WorldInstanceScopeOptions = {},
): Promise<WorldInstanceScope> {
  return CordisWorldInstanceScope.create(root, options)
}
