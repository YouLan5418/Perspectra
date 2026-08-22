import { Context } from '@deepseek-ai/cordis'
import {
  failWorld,
  worldAddressKey,
  type CharacterId,
  type CharacterView,
  type SessionId,
  type WorldAddress,
} from '@harness-world/contracts'
import {
  WorldBootstrap,
  parsePlayerRoundResult,
  type CompiledWorldSpec,
  type PlayerRoundResult,
} from '@harness-world/kernel'
import {
  DeterministicPresenter,
  type PresentationResult,
  type PresenterOptions,
} from '@harness-world/presentation'
import {
  WorldRuntimeRegistry,
  type BranchComponentFactory,
  type BranchExecutionLane,
  type BranchRuntimeLease,
} from '@harness-world/runtime-cordis'
import {
  BranchAdministration,
  CharacterViewBuilder,
  RoundInbox,
  SessionDeliveryAdapter,
  SessionOutboxWorker,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import {
  BranchOperationCoordinator,
  type ArchiveBranchResult,
  type ForkAtHeadResult,
} from './branch-operation-coordinator.ts'
import {
  RoundCoordinator,
  type RoundParticipant,
  type SubmitCoordinatedRoundRequest,
} from './round-coordinator.ts'

export interface WorldApplicationOptions {
  readonly worldPath: string
  readonly sessionPath: string
  readonly participants?: (address: WorldAddress) => readonly RoundParticipant[]
  readonly modelBudgetTokens?: number
  readonly outboxMaxAttempts?: number
}

/** Real branch-owned Store aggregate; all handles close with its Cordis Fiber. */
export class BranchStoreComponent {
  readonly store: WorldStore
  readonly inbox: RoundInbox
  readonly leases: WriterLeaseService
  readonly administration: BranchAdministration
  readonly outbox: WorldOutbox
  readonly session: SessionDeliveryAdapter
  readonly #worker: SessionOutboxWorker

  constructor(worldPath: string, sessionPath: string, maxAttempts: number) {
    this.store = new WorldStore(worldPath)
    this.inbox = new RoundInbox(worldPath)
    this.leases = new WriterLeaseService(worldPath)
    this.administration = new BranchAdministration(worldPath)
    this.outbox = new WorldOutbox(worldPath)
    this.session = new SessionDeliveryAdapter(sessionPath)
    this.#worker = new SessionOutboxWorker(this.outbox, this.session, maxAttempts)
  }

  async drainCritical(correlationId: string): Promise<number> {
    let delivered = 0
    while (true) {
      const result = await this.#worker.runOnce(correlationId)
      if (result.status === 'idle') return delivered
      if (result.status !== 'delivered') throw new Error(`critical Outbox drain stopped at ${result.status}`)
      delivered += 1
    }
  }

  close(): void {
    this.session.close()
    this.outbox.close()
    this.administration.close()
    this.inbox.close()
    this.leases.close()
    this.store.close()
  }
}

export class BranchAgentComponent {
  constructor(readonly participants: readonly RoundParticipant[]) {}
}

export class BranchDirectorComponent {
  readonly presenter = new DeterministicPresenter()

  constructor(readonly participants: readonly RoundParticipant[]) {}
}

/** Application-owned factory that mounts real stateful components into each Cordis Branch Slot. */
export class WorldBranchComponentFactory implements BranchComponentFactory {
  constructor(private readonly options: WorldApplicationOptions) {}

  create(scope: BranchExecutionLane) {
    const participants = this.options.participants?.(scope.address) ?? []
    const agents = new BranchAgentComponent(participants.filter(value => value.role === 'agent'))
    const director = new BranchDirectorComponent(participants.filter(value => value.role === 'director'))
    const store = new BranchStoreComponent(
      this.options.worldPath,
      this.options.sessionPath,
      this.options.outboxMaxAttempts ?? 3,
    )
    try {
      const kernel = new RoundCoordinator({
        store: store.store,
        inbox: store.inbox,
        leases: store.leases,
        runtimeLane: scope,
        ownerId: `coordinator:${worldAddressKey(scope.address)}`,
        participants: [...agents.participants, ...director.participants],
        modelBudgetTokens: this.options.modelBudgetTokens ?? 0,
      })
      return { kernel, store, agents, director }
    } catch (error: unknown) {
      store.close()
      throw error
    }
  }
}

interface MountedBranch {
  readonly lease: BranchRuntimeLease
  readonly kernel: RoundCoordinator
  readonly store: BranchStoreComponent
  readonly agents: BranchAgentComponent
  readonly director: BranchDirectorComponent
}

/** Local composition root and the only production entrypoint into branch-owned state. */
export class WorldApplication {
  readonly #root = new Context()
  readonly #branches = new Map<string, Promise<MountedBranch>>()
  readonly runtimeRegistry: WorldRuntimeRegistry
  #closed = false

  constructor(private readonly options: WorldApplicationOptions) {
    this.runtimeRegistry = new WorldRuntimeRegistry(this.#root, new WorldBranchComponentFactory(options))
  }

  activate(compiled: CompiledWorldSpec) {
    this.#assertOpen()
    const store = new WorldStore(this.options.worldPath)
    try {
      return new WorldBootstrap(store).activate(compiled)
    } finally {
      store.close()
    }
  }

  async submit(address: WorldAddress, request: SubmitCoordinatedRoundRequest): Promise<PlayerRoundResult> {
    return (await this.#branch(address)).kernel.submit(request)
  }

  async roundResult(address: WorldAddress, idempotencyKey: string): Promise<PlayerRoundResult | undefined> {
    const result = (await this.#branch(address)).store.inbox.readCompleted(address, idempotencyKey)
    return result === undefined ? undefined : parsePlayerRoundResult(result)
  }

  async head(address: WorldAddress) {
    return (await this.#branch(address)).store.store.head(address)
  }

  async characterView(address: WorldAddress, characterId: CharacterId, asOfWorldSeq?: number): Promise<CharacterView> {
    const branch = await this.#branch(address)
    const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
    return new CharacterViewBuilder(branch.store.store).rebuildAt(address, characterId, asOf)
  }

  async deliver(address: WorldAddress, correlationId: string): Promise<number> {
    return (await this.#branch(address)).store.drainCritical(correlationId)
  }

  async renderSession(
    address: WorldAddress,
    sessionId: SessionId,
    sessionEventSeq: number,
    presenterOptions?: PresenterOptions,
  ): Promise<PresentationResult> {
    const branch = await this.#branch(address)
    const event = branch.store.session.readEvent(sessionId, sessionEventSeq)
    if (event === undefined) throw new Error(`Session event ${sessionEventSeq} is missing`)
    return branch.director.presenter.render(event.payload, presenterOptions)
  }

  async forkAtHead(
    parent: WorldAddress,
    child: WorldAddress,
    reason: string,
    correlationId: string,
  ): Promise<ForkAtHeadResult> {
    const branch = await this.#branch(parent)
    return new BranchOperationCoordinator(branch.store.store, branch.store.administration, branch.kernel, branch.store)
      .forkAtHead({ parent, child, reason, correlationId })
  }

  async archive(address: WorldAddress, reason: string, correlationId: string): Promise<ArchiveBranchResult> {
    const branch = await this.#branch(address)
    const result = await new BranchOperationCoordinator(branch.store.store, branch.store.administration, branch.kernel, branch.store)
      .archive({ address, reason, correlationId })
    await this.release(address)
    return result
  }

  async release(address: WorldAddress): Promise<void> {
    const key = worldAddressKey(address)
    const pending = this.#branches.get(key)
    if (pending === undefined) return
    this.#branches.delete(key)
    const branch = await pending
    await branch.lease.dispose()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const pending = [...this.#branches.values()]
    this.#branches.clear()
    const settled = await Promise.allSettled(pending)
    for (const result of settled) {
      if (result.status === 'fulfilled') await result.value.lease.dispose()
    }
  }

  get activeBranchCount(): number {
    return this.runtimeRegistry.activeSlotCount
  }

  async #branch(address: WorldAddress): Promise<MountedBranch> {
    this.#assertOpen()
    const key = worldAddressKey(address)
    const current = this.#branches.get(key)
    if (current !== undefined) return current
    const pending = this.#mount(address)
    this.#branches.set(key, pending)
    try {
      return await pending
    } catch (error: unknown) {
      if (this.#branches.get(key) === pending) this.#branches.delete(key)
      throw error
    }
  }

  async #mount(address: WorldAddress): Promise<MountedBranch> {
    const manifestStore = new WorldStore(this.options.worldPath)
    const manifest = manifestStore.readManifest(address)
    manifestStore.close()
    if (manifest === undefined) {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE',
        category: 'integrity',
        message: 'world branch has no active Compiled Manifest',
        retryable: false,
        correlationId: `application:${worldAddressKey(address)}`,
        address,
      })
    }
    const lease = await this.runtimeRegistry.acquire(address, manifest.manifestHash)
    const components = lease.slot.components
    if (!(components.kernel instanceof RoundCoordinator)
      || !(components.store instanceof BranchStoreComponent)
      || !(components.agents instanceof BranchAgentComponent)
      || !(components.director instanceof BranchDirectorComponent)) {
      await lease.dispose()
      throw new Error('Branch Component Factory returned an incompatible component set')
    }
    return {
      lease,
      kernel: components.kernel,
      store: components.store,
      agents: components.agents,
      director: components.director,
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('WorldApplication is closed')
  }
}
