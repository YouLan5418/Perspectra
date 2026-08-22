import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import {
  failWorld,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
} from '@harness-world/contracts'

const branchScope = Symbol('harness-world.branch-scope')

declare module '@deepseek-ai/cordis' {
  interface Context {
    worldRuntimeRegistry: WorldRuntimeRegistry
    worldKernel: BranchComponentService
    worldStore: BranchComponentService
    worldAgents: BranchComponentService
    worldDirector: BranchComponentService
  }
}

export type BranchOwnedComponent = object

function hasDisposer(component: BranchOwnedComponent): component is { dispose(): void | Promise<void> } {
  return 'dispose' in component && typeof component.dispose === 'function'
}

function hasCloser(component: BranchOwnedComponent): component is { close(): void | Promise<void> } {
  return 'close' in component && typeof component.close === 'function'
}

export interface BranchRuntimeComponents {
  readonly kernel: BranchOwnedComponent
  readonly store: BranchOwnedComponent
  readonly agents: BranchOwnedComponent
  readonly director: BranchOwnedComponent
}

export interface BranchExecutionLane {
  readonly address: WorldAddress
  readonly manifestHash: WorldHash
  readonly context: Context
  enqueueRound<T>(work: () => Promise<T>): Promise<T>
}

export interface BranchComponentFactory {
  create(scope: BranchExecutionLane): BranchRuntimeComponents
}

/** Cordis-owned service handle around one real branch component. */
export class BranchComponentService extends Service {
  constructor(
    ctx: Context,
    name: 'worldKernel' | 'worldStore' | 'worldAgents' | 'worldDirector',
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
    readonly context: Context,
  ) {}

  enqueueRound<T>(work: () => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error('branch runtime slot is disposed'))
    const execution = this.#roundTail.then(work, work)
    this.#roundTail = execution.then(() => undefined, () => undefined)
    return execution
  }

  dispose(): void {
    this.#disposed = true
  }
}

export interface BranchServices {
  readonly kernel: BranchComponentService
  readonly store: BranchComponentService
  readonly agents: BranchComponentService
  readonly director: BranchComponentService
}

/** One isolated Cordis child context for an active world branch. */
export class BranchRuntimeSlot {
  readonly addressKey: string
  readonly context: Context
  readonly services: BranchServices
  readonly components: BranchRuntimeComponents
  #fiber: Fiber
  #disposed = false
  readonly #lane: SerialRoundLane

  private constructor(
    readonly address: WorldAddress,
    readonly manifestHash: WorldHash,
    context: Context,
    fiber: Fiber,
    lane: SerialRoundLane,
    services: BranchServices,
    components: BranchRuntimeComponents,
  ) {
    this.addressKey = worldAddressKey(address)
    this.context = context
    this.#fiber = fiber
    this.#lane = lane
    this.services = services
    this.components = components
  }

  /** Mount four injected branch-owned components below isolated Cordis labels. */
  static async create(
    root: Context,
    address: WorldAddress,
    manifestHash: WorldHash,
    factory: BranchComponentFactory,
  ): Promise<BranchRuntimeSlot> {
    const addressKey = worldAddressKey(address)
    const scopeLabel = Symbol(addressKey)
    let context = root
    for (const service of ['worldKernel', 'worldStore', 'worldAgents', 'worldDirector'] as const) {
      context = context.isolate(service)
    }
    context = context.extend({
      [branchScope]: scopeLabel,
      [Context.filter]: (listenerContext: Context) => Reflect.get(listenerContext, branchScope) === scopeLabel,
    })
    const lane = new SerialRoundLane(address, manifestHash, context)
    let services!: BranchServices
    let components!: BranchRuntimeComponents
    const fiber = context.plugin(function branchRuntimePlugin(ctx) {
      components = factory.create({
        address,
        manifestHash,
        context: ctx,
        enqueueRound: work => lane.enqueueRound(work),
      })
      const kernel = new BranchComponentService(ctx, 'worldKernel', addressKey, components.kernel)
      const store = new BranchComponentService(ctx, 'worldStore', addressKey, components.store)
      const agents = new BranchComponentService(ctx, 'worldAgents', addressKey, components.agents)
      const director = new BranchComponentService(ctx, 'worldDirector', addressKey, components.director)
      services = { kernel, store, agents, director }
      ctx.effect(() => async () => {
        for (const component of [components.kernel, components.director, components.agents, components.store]) {
          if (hasDisposer(component)) await component.dispose()
          else if (hasCloser(component)) await component.close()
        }
      }, `world-runtime:${addressKey}`)
    })
    await fiber
    return new BranchRuntimeSlot(address, manifestHash, context, fiber, lane, services, components)
  }

  /** Serialize process-local Round work without poisoning the FIFO after a failed item. */
  enqueueRound<T>(work: () => Promise<T>): Promise<T> {
    return this.#lane.enqueueRound(work)
  }

  /** Unwind every service, listener, and effect owned by this slot. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#lane.dispose()
    await this.#fiber.dispose()
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

/** Root-scoped router that stores no world domain state inside Cordis services. */
export class WorldRuntimeRegistry extends Service {
  readonly #slots = new Map<string, SlotReservation>()

  constructor(ctx: Context, private readonly factory: BranchComponentFactory) {
    super(ctx, 'worldRuntimeRegistry')
  }

  /** Acquire or join the one active slot for an exact WorldAddress. */
  async acquire(address: WorldAddress, manifestHash: WorldHash): Promise<BranchRuntimeLease> {
    const key = worldAddressKey(address)
    let reservation = this.#slots.get(key)
    if (reservation === undefined) {
      reservation = {
        pending: BranchRuntimeSlot.create(this.ctx.root, address, manifestHash, this.factory).then(slot => ({ slot })),
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
    try {
      const entry = await reservation.pending
      await entry.slot.dispose()
    } catch {
      // A failed mount owns no resources after its Cordis Fiber rejects.
    }
  }
}
