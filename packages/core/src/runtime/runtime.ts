import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { failWorld, worldAddressKey, type WorldAddress, type WorldHash } from '@perspectra/sdk/contracts'
import { cleanupWithin, resolveCleanupTimeoutMs } from './instance-scope.ts'

const branchScope = Symbol('harness-world.branch-scope')

interface ScopedCordisEvents {
  on(name: string | symbol, listener: (...args: any[]) => any): () => void
  emit(thisArg: unknown, name: string | symbol, ...args: any[]): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worldRuntimeRegistry: WorldRuntimeRegistry
    worldKernel: BranchComponentService
    worldStore: BranchComponentService
    worldAgents: BranchComponentService
    worldPresentation: BranchComponentService
  }
}

export type BranchOwnedComponent = object

function hasDisposer(component: BranchOwnedComponent): component is { dispose(): void | Promise<void> } {
  return 'dispose' in component && typeof component.dispose === 'function'
}

function hasCloser(component: BranchOwnedComponent): component is { close(): void | Promise<void> } {
  return 'close' in component && typeof component.close === 'function'
}

async function disposeBranchComponents(
  components: readonly {
    readonly name: string
    readonly component: BranchOwnedComponent
  }[],
  cleanupTimeoutMs: number,
): Promise<void> {
  const errors: unknown[] = []
  for (const { name, component } of components) {
    if (!hasDisposer(component) && !hasCloser(component)) continue
    const outcome = await cleanupWithin(name, cleanupTimeoutMs, () =>
      hasDisposer(component) ? component.dispose() : component.close(),
    )
    if (outcome.status === 'failed') errors.push(outcome.error)
    else if (outcome.status === 'timedOut') errors.push(outcome.error)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'branch runtime component cleanup failed')
}

export interface BranchRuntimeComponents {
  readonly kernel: BranchOwnedComponent
  readonly store: BranchOwnedComponent
  readonly agents: BranchOwnedComponent
  readonly presentation: BranchOwnedComponent
}

export interface BranchExecutionLane {
  readonly address: WorldAddress
  readonly manifestHash: WorldHash
  enqueueRound<T>(work: () => Promise<T>): Promise<T>
  onEvent(name: string | symbol, listener: (...args: any[]) => any): () => void
  emitEvent(name: string | symbol, ...args: any[]): void
}

export interface BranchComponentFactory {
  create(scope: BranchExecutionLane): BranchRuntimeComponents
}

/** Cordis-owned service handle around one real branch component. */
export class BranchComponentService extends Service {
  constructor(
    ctx: Context,
    name: 'worldKernel' | 'worldStore' | 'worldAgents' | 'worldPresentation',
    readonly ownerKey: string,
    readonly component: BranchOwnedComponent,
  ) {
    super(ctx, name)
  }
}

class SerialRoundLane implements BranchExecutionLane {
  #disposed = false
  #roundTail: Promise<void> = Promise.resolve()

  constructor(
    readonly address: WorldAddress,
    readonly manifestHash: WorldHash,
    private context: Context,
  ) {}

  bindContext(context: Context): void {
    this.context = context
  }

  enqueueRound<T>(work: () => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error('branch runtime slot is disposed'))
    const execution = this.#roundTail.then(work, work)
    this.#roundTail = execution.then(
      () => undefined,
      () => undefined,
    )
    return execution
  }

  onEvent(name: string | symbol, listener: (...args: any[]) => any): () => void {
    return (this.context as unknown as ScopedCordisEvents).on(name, listener)
  }

  emitEvent(name: string | symbol, ...args: any[]): void {
    ;(this.context as unknown as ScopedCordisEvents).emit(this.context, name, ...args)
  }

  dispose(): void {
    this.#disposed = true
  }
}

export interface BranchServices {
  readonly kernel: BranchComponentService
  readonly store: BranchComponentService
  readonly agents: BranchComponentService
  readonly presentation: BranchComponentService
}

/** One isolated Cordis child context for an active world branch. */
export class BranchRuntimeSlot {
  readonly addressKey: string
  readonly services: BranchServices
  readonly components: BranchRuntimeComponents
  #fiber: Fiber
  #disposed = false
  readonly #lane: SerialRoundLane
  readonly #cleanupComponents: () => Promise<void>
  readonly #markExplicitDispose: () => void

  private constructor(
    readonly address: WorldAddress,
    readonly manifestHash: WorldHash,
    context: Context,
    fiber: Fiber,
    lane: SerialRoundLane,
    services: BranchServices,
    components: BranchRuntimeComponents,
    cleanupComponents: () => Promise<void>,
    markExplicitDispose: () => void,
  ) {
    this.addressKey = worldAddressKey(address)
    this.#fiber = fiber
    this.#lane = lane
    this.services = services
    this.components = components
    this.#cleanupComponents = cleanupComponents
    this.#markExplicitDispose = markExplicitDispose
  }

  /** Mount four injected branch-owned components below isolated Cordis labels. */
  static async create(
    root: Context,
    address: WorldAddress,
    manifestHash: WorldHash,
    factory: BranchComponentFactory,
    cleanupTimeoutMs = resolveCleanupTimeoutMs(),
  ): Promise<BranchRuntimeSlot> {
    cleanupTimeoutMs = resolveCleanupTimeoutMs(cleanupTimeoutMs)
    const addressKey = worldAddressKey(address)
    const scopeLabel = Symbol(addressKey)
    let context = root
    for (const service of ['worldKernel', 'worldStore', 'worldAgents', 'worldPresentation'] as const) {
      context = context.isolate(service)
    }
    context = context.extend({
      [branchScope]: scopeLabel,
      [Context.filter]: (listenerContext: Context) => Reflect.get(listenerContext, branchScope) === scopeLabel,
    })
    const lane = new SerialRoundLane(address, manifestHash, context)
    let services!: BranchServices
    let components!: BranchRuntimeComponents
    let cleanupComponents!: () => Promise<void>
    let explicitDispose = false
    const fiber = context.plugin(function branchRuntimePlugin(ctx) {
      lane.bindContext(ctx)
      components = factory.create(lane)
      const kernel = new BranchComponentService(ctx, 'worldKernel', addressKey, components.kernel)
      const store = new BranchComponentService(ctx, 'worldStore', addressKey, components.store)
      const agents = new BranchComponentService(ctx, 'worldAgents', addressKey, components.agents)
      const presentation = new BranchComponentService(ctx, 'worldPresentation', addressKey, components.presentation)
      services = { kernel, store, agents, presentation }
      let cleanup: Promise<void> | undefined
      cleanupComponents = () =>
        (cleanup ??= disposeBranchComponents(
          [
            { name: 'worldKernel', component: components.kernel },
            { name: 'worldPresentation', component: components.presentation },
            { name: 'worldAgents', component: components.agents },
            { name: 'worldStore', component: components.store },
          ],
          cleanupTimeoutMs,
        ))
      ctx.effect(
        () => async () => {
          try {
            await cleanupComponents()
          } catch (error: unknown) {
            if (!explicitDispose) throw error
          }
        },
        `world-runtime:${addressKey}`,
      )
    })
    await fiber
    return new BranchRuntimeSlot(
      address,
      manifestHash,
      context,
      fiber,
      lane,
      services,
      components,
      cleanupComponents,
      () => {
        explicitDispose = true
      },
    )
  }

  /** Serialize process-local Round work without poisoning the FIFO after a failed item. */
  enqueueRound<T>(work: () => Promise<T>): Promise<T> {
    return this.#lane.enqueueRound(work)
  }

  /** Emit only through the branch-scoped Cordis dispatch identity. */
  emitEvent(name: string | symbol, ...args: any[]): void {
    this.#lane.emitEvent(name, ...args)
  }

  /** Unwind every service, listener, and effect owned by this slot. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#lane.dispose()
    this.#markExplicitDispose()
    let cleanupFailed = false
    let cleanupError: unknown
    try {
      await this.#cleanupComponents()
    } catch (error: unknown) {
      cleanupFailed = true
      cleanupError = error
    }
    let fiberFailed = false
    let fiberError: unknown
    try {
      await this.#fiber.dispose()
    } catch (error: unknown) {
      fiberFailed = true
      fiberError = error
    }
    const errors: unknown[] = []
    if (cleanupFailed) errors.push(cleanupError)
    if (fiberFailed) errors.push(fiberError)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'branch runtime cleanup failed')
  }
}

export interface BranchRuntimeLease {
  readonly slot: BranchRuntimeSlot
  dispose(): Promise<void>
}

interface SlotEntry {
  readonly slot: BranchRuntimeSlot
}

interface SlotReservation {
  readonly pending: Promise<SlotEntry>
  references: number
}

export interface WorldRuntimeRegistryOptions {
  readonly cleanupTimeoutMs?: number
}

/** Root-scoped router that stores no world domain state inside Cordis services. */
export class WorldRuntimeRegistry extends Service {
  readonly #slots = new Map<string, SlotReservation>()
  readonly #cleanupTimeoutMs: number

  constructor(
    ctx: Context,
    private readonly factory: BranchComponentFactory,
    options: WorldRuntimeRegistryOptions = {},
  ) {
    super(ctx, 'worldRuntimeRegistry')
    this.#cleanupTimeoutMs = resolveCleanupTimeoutMs(options.cleanupTimeoutMs)
  }

  /** Acquire or join the one active slot for an exact WorldAddress. */
  async acquire(address: WorldAddress, manifestHash: WorldHash): Promise<BranchRuntimeLease> {
    const key = worldAddressKey(address)
    let reservation = this.#slots.get(key)
    if (reservation === undefined) {
      reservation = {
        pending: BranchRuntimeSlot.create(
          this.ctx.root,
          address,
          manifestHash,
          this.factory,
          this.#cleanupTimeoutMs,
        ).then(slot => ({ slot })),
        references: 0,
      }
      this.#slots.set(key, reservation)
    }
    reservation.references += 1
    let entry: SlotEntry
    try {
      entry = await reservation.pending
      if (entry.slot.manifestHash !== manifestHash) {
        failWorld({
          errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE',
          category: 'integrity',
          message: 'active branch slot uses a different manifest hash',
          retryable: false,
          correlationId: `runtime:${key}`,
          address,
        })
      }
    } catch (error: unknown) {
      await this.#release(key, reservation)
      throw error
    }
    let released = false
    return {
      slot: entry.slot,
      dispose: async () => {
        if (released) return
        released = true
        await this.#release(key, reservation)
      },
    }
  }

  /** Number of address entries, including a slot still being mounted. */
  get activeSlotCount(): number {
    return this.#slots.size
  }

  async #release(key: string, reservation: SlotReservation): Promise<void> {
    reservation.references -= 1
    if (reservation.references !== 0 || this.#slots.get(key) !== reservation) return
    this.#slots.delete(key)
    let entry: SlotEntry
    try {
      entry = await reservation.pending
    } catch {
      return
    }
    await entry.slot.dispose()
  }
}
