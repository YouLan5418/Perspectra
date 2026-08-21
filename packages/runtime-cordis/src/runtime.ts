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
    worldKernel: BranchProbeService
    worldStore: BranchProbeService
    worldAgents: BranchProbeService
    worldDirector: BranchProbeService
  }

  interface Events {
    /** @mode emit */
    'world/probe'(value: string): void
  }
}

/** P0 stateful service used to prove Cordis service and effect isolation. */
export class BranchProbeService extends Service {
  readonly records: string[] = []

  constructor(ctx: Context, name: 'worldKernel' | 'worldStore' | 'worldAgents' | 'worldDirector', readonly ownerKey: string) {
    super(ctx, name)
  }

  /** Record a branch-local probe delivery. */
  record(value: string): void {
    this.records.push(value)
  }
}

export interface BranchServices {
  readonly kernel: BranchProbeService
  readonly store: BranchProbeService
  readonly agents: BranchProbeService
  readonly director: BranchProbeService
}

/** One isolated Cordis child context for an active world branch. */
export class BranchRuntimeSlot {
  readonly addressKey: string
  readonly context: Context
  readonly services: BranchServices
  #fiber: Fiber
  #disposed = false

  private constructor(address: WorldAddress, readonly manifestHash: WorldHash, context: Context, fiber: Fiber, services: BranchServices) {
    this.addressKey = worldAddressKey(address)
    this.context = context
    this.#fiber = fiber
    this.services = services
  }

  /** Mount the four branch-owned services below isolated Cordis labels. */
  static async create(root: Context, address: WorldAddress, manifestHash: WorldHash): Promise<BranchRuntimeSlot> {
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
    let services!: BranchServices
    const fiber = context.plugin(function branchRuntimePlugin(ctx) {
      const kernel = new BranchProbeService(ctx, 'worldKernel', addressKey)
      const store = new BranchProbeService(ctx, 'worldStore', addressKey)
      const agents = new BranchProbeService(ctx, 'worldAgents', addressKey)
      const director = new BranchProbeService(ctx, 'worldDirector', addressKey)
      services = { kernel, store, agents, director }
      ctx.on('world/probe', value => kernel.record(value))
    })
    await fiber
    return new BranchRuntimeSlot(address, manifestHash, context, fiber, services)
  }

  /** Emit through the branch context so Cordis applies its listener filter. */
  emitProbe(value: string): void {
    if (this.#disposed) throw new Error('branch runtime slot is disposed')
    this.context.emit(this.context, 'world/probe', value)
  }

  /** Unwind every service, listener, and effect owned by this slot. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#fiber.dispose()
  }
}

export interface BranchRuntimeLease {
  readonly slot: BranchRuntimeSlot
  readonly fencingToken: number
  dispose(): Promise<void>
}

interface SlotEntry {
  readonly slot: BranchRuntimeSlot
  readonly fencingToken: number
  references: number
}

/** Root-scoped router that stores no world domain state inside Cordis services. */
export class WorldRuntimeRegistry extends Service {
  readonly #slots = new Map<string, Promise<SlotEntry>>()
  #nextFencingToken = 1

  constructor(ctx: Context) {
    super(ctx, 'worldRuntimeRegistry')
  }

  /** Acquire or join the one active slot for an exact WorldAddress. */
  async acquire(address: WorldAddress, manifestHash: WorldHash): Promise<BranchRuntimeLease> {
    const key = worldAddressKey(address)
    let pending = this.#slots.get(key)
    if (pending === undefined) {
      const fencingToken = this.#nextFencingToken
      this.#nextFencingToken += 1
      pending = BranchRuntimeSlot.create(this.ctx.root, address, manifestHash)
        .then(slot => ({ slot, fencingToken, references: 0 }))
        .catch((error: unknown) => {
          this.#slots.delete(key)
          throw error
        })
      this.#slots.set(key, pending)
    }
    const entry = await pending
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
    entry.references += 1
    let released = false
    return {
      slot: entry.slot,
      fencingToken: entry.fencingToken,
      dispose: async () => {
        if (released) return
        released = true
        entry.references -= 1
        if (entry.references !== 0) return
        this.#slots.delete(key)
        await entry.slot.dispose()
      },
    }
  }

  /** Number of address entries, including a slot still being mounted. */
  get activeSlotCount(): number {
    return this.#slots.size
  }
}
