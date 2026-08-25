import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  assertProtocolString,
  canonicalizeWorldJson,
  failWorld,
  hashWorldJson,
  WorldError,
  worldAddressKey,
  type CharacterId,
  type RuntimeAvailabilityState,
  type InteractionRoundId,
  type CharacterView,
  type DeliveryId,
  type FaultInjector,
  type SessionId,
  type StoredRoundAuthority,
  type StoredWorldEvent,
  type TransactionId,
  type WorldAddress,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  WorldBootstrap,
  WorldSpecCompiler,
  createCoreRulebookRegistry,
  parsePlayerRoundResult,
  parsePlayerActionInput,
  runtimeManifestFromStored,
  runtimeManifestFromStoredRecord,
  type CompiledWorldManifest,
  type CompiledWorldSpec,
  type PlayerActionInput,
  type PlayerRoundResult,
  type RulebookRegistry,
} from '@harness-world/kernel'
import { CognitiveMemoryService, type RecalledMemory } from '@harness-world/memory'
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
  BranchQuarantineService,
  CharacterRuntimeAvailabilityService,
  CharacterViewBuilder,
  type DeadLetterRecord,
  ProjectionRebuilder,
  RoundInbox,
  SessionDeliveryAdapter,
  SessionOutboxWorker,
  SnapshotStore,
  WorldArchiveService,
  WorldLogicalTransferService,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import {
  BranchOperationCoordinator,
  type ArchiveBranchResult,
  type ForkAtHeadResult,
} from './branch-operation-coordinator.ts'
import { PlayerInputInterpreter, type PlayerInputInterpretation } from './player-input.ts'
import {
  RoundCoordinator,
  type RoundParticipant,
  type SubmitCoordinatedRoundRequest,
} from './round-coordinator.ts'
import { SceneDecisionService } from './scene-decision.ts'
import { ApplicationRuntimeMetrics } from './runtime-metrics.ts'

export interface WorldApplicationOptions {
  readonly worldPath: string
  readonly sessionPath: string
  readonly participants?: (address: WorldAddress) => readonly RoundParticipant[]
  readonly modelBudgetTokens?: number
  readonly outboxMaxAttempts?: number
  readonly runtimeOwnerId?: string
  readonly leaseTtlMs?: number
  readonly faultInjector?: FaultInjector
  readonly rulebooks?: RulebookRegistry
  readonly memoryPath?: string
}

export interface SubmitTextRequest {
  readonly text: string
  readonly idempotencyKey: string
  readonly principalId: string
  readonly correlationId: string
}

export interface PlayerChatScope {
  readonly address: WorldAddress
  readonly principalId: string
  readonly characterId: CharacterId
}

export type SubmitTextResult =
  | Extract<PlayerInputInterpretation, { readonly status: 'clarification_required' }>
  | { readonly status: 'submitted'; readonly action: PlayerActionInput; readonly result: PlayerRoundResult }

function validateApplicationManifest(
  manifest: CompiledWorldManifest,
  address: WorldAddress,
  correlationId: string,
  memoryPath: string | undefined,
): { readonly sceneEnabled: boolean; readonly contextEnabled: boolean } {
  const scenePolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:scene-decision')
  const contextPolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:agent-context')
  const unsupported = scenePolicy !== undefined && scenePolicy.version !== '1.0.0'
    ? `unsupported Scene decision policy ${scenePolicy.version}`
    : contextPolicy !== undefined && contextPolicy.version !== '2.0.0'
    ? `unsupported Agent Context policy ${contextPolicy.version}`
    : contextPolicy !== undefined && scenePolicy === undefined
    ? 'Agent Context v2 requires Scene decision v1'
    : contextPolicy !== undefined && memoryPath === undefined
    ? 'memoryPath must be configured for Agent Context v2'
    : undefined
  if (unsupported !== undefined) {
    failWorld({
      errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime', message: unsupported, retryable: false,
      correlationId, address,
    })
  }
  return { sceneEnabled: scenePolicy !== undefined, contextEnabled: contextPolicy !== undefined }
}

/** Real branch-owned Store aggregate; all handles close with its Cordis Fiber. */
export class BranchStoreComponent {
  readonly store: WorldStore
  readonly inbox: RoundInbox
  readonly leases: WriterLeaseService
  readonly administration: BranchAdministration
  readonly quarantine: BranchQuarantineService
  readonly availability: CharacterRuntimeAvailabilityService
  readonly outbox: WorldOutbox
  readonly session: SessionDeliveryAdapter
  readonly #worker: SessionOutboxWorker

  constructor(
    readonly address: WorldAddress,
    worldPath: string,
    sessionPath: string,
    maxAttempts: number,
    faultInjector?: FaultInjector,
  ) {
    this.store = new WorldStore(worldPath, faultInjector)
    this.inbox = new RoundInbox(worldPath)
    this.leases = new WriterLeaseService(worldPath)
    this.administration = new BranchAdministration(worldPath)
    this.quarantine = new BranchQuarantineService(worldPath)
    this.availability = new CharacterRuntimeAvailabilityService(worldPath)
    this.outbox = new WorldOutbox(worldPath)
    this.session = new SessionDeliveryAdapter(sessionPath, faultInjector)
    this.#worker = new SessionOutboxWorker(this.outbox, this.session, address, maxAttempts)
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

  deadLetters(): DeadLetterRecord[] {
    return this.outbox.deadLetters(this.address)
  }

  retryDeadLetter(deliveryId: DeliveryId, correlationId: string): void {
    this.outbox.retryDeadLetter(this.address, deliveryId, correlationId)
  }

  close(): void {
    this.session.close()
    this.outbox.close()
    this.availability.close()
    this.quarantine.close()
    this.administration.close()
    this.inbox.close()
    this.leases.close()
    this.store.close()
  }
}

export class BranchAgentComponent {
  constructor(
    readonly participants: readonly RoundParticipant[],
    readonly cognitiveMemory?: CognitiveMemoryService,
  ) {}

  close(): void {
    this.cognitiveMemory?.close()
  }
}

export class BranchDirectorComponent {
  readonly presenter = new DeterministicPresenter()

  constructor(readonly participants: readonly RoundParticipant[]) {}
}

/** Application-owned factory that mounts real stateful components into each Cordis Branch Slot. */
export class WorldBranchComponentFactory implements BranchComponentFactory {
  readonly #runtimeOwnerId: string

  constructor(private readonly options: WorldApplicationOptions & {
    readonly rulebooks: RulebookRegistry
    readonly runtimeMetrics: ApplicationRuntimeMetrics
  }) {
    const label = options.runtimeOwnerId ?? 'application'
    assertProtocolString(label, 'runtimeOwnerId diagnostic label')
    this.#runtimeOwnerId = `${label}:instance:${randomUUID()}`
  }

  create(scope: BranchExecutionLane) {
    const participants = this.options.participants?.(scope.address) ?? []
    const store = new BranchStoreComponent(
      scope.address,
      this.options.worldPath,
      this.options.sessionPath,
      this.options.outboxMaxAttempts ?? 12,
      this.options.faultInjector,
    )
    let cognitiveMemory: CognitiveMemoryService | undefined
    try {
      if (participants.length > 0 && this.options.modelBudgetTokens === undefined) {
        throw new TypeError('modelBudgetTokens must be configured when Round participants are enabled')
      }
      const manifest = runtimeManifestFromStoredRecord(store.store.readManifest(scope.address))
      const policies = validateApplicationManifest(
        manifest, scope.address, `manifest-runtime:${worldAddressKey(scope.address)}`, this.options.memoryPath,
      )
      cognitiveMemory = !policies.contextEnabled
        ? undefined
        : new CognitiveMemoryService(this.options.memoryPath!, store.store, this.options.faultInjector)
      const agents = new BranchAgentComponent(participants.filter(value => value.role === 'agent'), cognitiveMemory)
      const director = new BranchDirectorComponent(participants.filter(value => value.role === 'director'))
      const players = new Set(manifest.playerBindings.map(value => value.characterId))
      store.availability.initialize(scope.address, manifest.characters.map(character => ({
        characterId: character.characterId,
        state: players.has(character.characterId)
          ? manifest.runtimePolicy.playerInitialAvailability
          : manifest.runtimePolicy.npcInitialAvailability,
      })))
      const kernel = new RoundCoordinator({
        store: store.store,
        inbox: store.inbox,
        leases: store.leases,
        availability: store.availability,
        runtimeLane: scope,
        ownerId: `${this.#runtimeOwnerId}:branch:${hashWorldJson('writer-owner-address', scope.address)}`,
        participants: [...agents.participants, ...director.participants],
        modelBudgetTokens: this.options.modelBudgetTokens ?? 0,
        rulebooks: this.options.rulebooks,
        ...(!policies.sceneEnabled ? {} : { sceneDecision: new SceneDecisionService(store.store, store.availability) }),
        ...(cognitiveMemory === undefined ? {} : { cognitiveMemory }),
        runtimeMetrics: this.options.runtimeMetrics,
        ...(this.options.leaseTtlMs === undefined ? {} : { leaseTtlMs: this.options.leaseTtlMs }),
      })
      try {
        kernel.processCognitiveJobs()
      } catch (error: unknown) {
        kernel.close()
        throw error
      }
      return { kernel, store, agents, director }
    } catch (error: unknown) {
      cognitiveMemory?.close()
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
  readonly #rulebooks: RulebookRegistry
  readonly runtimeRegistry: WorldRuntimeRegistry
  readonly runtimeMetrics = new ApplicationRuntimeMetrics()
  #closed = false

  constructor(private readonly options: WorldApplicationOptions) {
    this.#rulebooks = options.rulebooks ?? createCoreRulebookRegistry()
    this.runtimeRegistry = new WorldRuntimeRegistry(this.#root, new WorldBranchComponentFactory({
      ...options,
      rulebooks: this.#rulebooks,
      runtimeMetrics: this.runtimeMetrics,
    }))
  }

  activate(compiled: CompiledWorldSpec) {
    this.#assertOpen()
    const store = new WorldStore(this.options.worldPath)
    try {
      this.#rulebooks.resolve(
        compiled.manifest.rulebook.rulebookId,
        compiled.manifest.rulebook.version,
        `activate:${worldAddressKey(compiled.manifest.address)}`,
        compiled.manifest.address,
      )
      if (compiled.manifest.rulebook.rulebookId === 'builtin:speak-move'
        && compiled.manifest.rulebook.version === 3
        && store.readManifest(compiled.manifest.address) === undefined) {
        failWorld({
          errorCode: 'INVALID_REQUEST', category: 'admission',
          message: 'Rulebook v3 is historical-only and cannot activate a new world', retryable: false,
          correlationId: `activate:${worldAddressKey(compiled.manifest.address)}`,
          address: compiled.manifest.address,
          details: { rulebookId: compiled.manifest.rulebook.rulebookId, version: 3 },
        })
      }
      validateApplicationManifest(
        compiled.manifest, compiled.manifest.address,
        `activate:${worldAddressKey(compiled.manifest.address)}`, this.options.memoryPath,
      )
      return new WorldBootstrap(store).activate(compiled)
    } finally {
      store.close()
    }
  }

  activateSpec(input: WorldJsonValue) {
    return this.activate(new WorldSpecCompiler().compile(input))
  }

  compileSpec(input: WorldJsonValue) {
    this.#assertOpen()
    return new WorldSpecCompiler().compile(input)
  }

  listWorlds() {
    this.#assertOpen()
    const store = new WorldStore(this.options.worldPath)
    try {
      const worlds = new Map<string, { tenantId: WorldAddress['tenantId']; worldId: WorldAddress['worldId']; branchCount: number }>()
      for (const address of store.listBranches()) {
        const key = `${address.tenantId}\u001f${address.worldId}`
        const current = worlds.get(key)
        worlds.set(key, current === undefined
          ? { tenantId: address.tenantId, worldId: address.worldId, branchCount: 1 }
          : { ...current, branchCount: current.branchCount + 1 })
      }
      return [...worlds.values()]
    } finally {
      store.close()
    }
  }

  /** Discover player-safe chat bindings without exposing full Manifests or NPC views. */
  listPlayerChatScopes(): PlayerChatScope[] {
    this.#assertOpen()
    const store = new WorldStore(this.options.worldPath)
    try {
      return store.listBranches().flatMap(address => {
        const record = store.readManifest(address)
        if (record === undefined) return []
        const manifest = runtimeManifestFromStored(record.manifest)
        return manifest.playerBindings.map(binding => ({
          address,
          principalId: binding.principalId,
          characterId: binding.characterId,
        }))
      })
    } finally {
      store.close()
    }
  }

  getWorld(address: WorldAddress) {
    this.#assertOpen()
    const store = new WorldStore(this.options.worldPath)
    const administration = new BranchAdministration(this.options.worldPath)
    try {
      const manifest = store.readManifest(address)
      if (manifest === undefined) throw new Error('world branch has no active Compiled Manifest')
      return {
        address,
        manifest: manifest.manifest,
        manifestHash: manifest.manifestHash,
        head: store.head(address),
        control: administration.status(address),
      }
    } finally {
      administration.close()
      store.close()
    }
  }

  async submit(address: WorldAddress, request: SubmitCoordinatedRoundRequest): Promise<PlayerRoundResult> {
    return this.#integrityGuard(address, 'round.submit', branch => branch.kernel.submit(request))
  }

  async submitText(address: WorldAddress, request: SubmitTextRequest): Promise<SubmitTextResult> {
    this.#assertOpen()
    for (const [name, value] of [
      ['text', request.text],
      ['idempotencyKey', request.idempotencyKey],
      ['principalId', request.principalId],
      ['correlationId', request.correlationId],
    ] as const) assertProtocolString(value, name)
    const clarificationInput = { principalId: request.principalId, text: request.text }
    const clarificationStore = new WorldStore(this.options.worldPath)
    try {
      const replay = clarificationStore.readClarification(
        address, request.idempotencyKey, clarificationInput, request.correlationId,
      )
      if (replay !== undefined) {
        return replay as Extract<PlayerInputInterpretation, { readonly status: 'clarification_required' }>
      }
    } finally {
      clarificationStore.close()
    }
    const interpretation = await this.#durableReadGuard(address, 'round.interpret', () => {
      const store = new WorldStore(this.options.worldPath)
      try {
        const manifest = runtimeManifestFromStoredRecord(store.readManifest(address))
        const binding = manifest.playerBindings.find(value => value.principalId === request.principalId)
        if (binding === undefined) {
          failWorld({
            errorCode: 'UNAUTHORIZED', category: 'admission',
            message: 'principal has no PlayerBinding in this world', retryable: false,
            correlationId: request.correlationId, address,
          })
        }
        const resolver = this.#rulebooks.resolve(
          manifest.rulebook.rulebookId,
          manifest.rulebook.version,
          request.correlationId,
          address,
        )
        const events = store.readEvents(address)
        return new PlayerInputInterpreter().interpret(request.text, resolver.affordances({
          manifest,
          events,
          characterId: binding.characterId,
        }))
      } finally {
        store.close()
      }
    })
    if (interpretation.status === 'clarification_required') {
      const store = new WorldStore(this.options.worldPath)
      try {
        return store.recordClarification(
          address,
          request.idempotencyKey,
          clarificationInput,
          interpretation,
          request.correlationId,
        ) as Extract<PlayerInputInterpretation, { readonly status: 'clarification_required' }>
      } finally {
        store.close()
      }
    }
    const result = await this.submit(address, {
      idempotencyKey: request.idempotencyKey,
      principalId: request.principalId,
      correlationId: request.correlationId,
      action: interpretation.action,
    })
    return { status: 'submitted', action: interpretation.action, result }
  }

  async acceptRound(address: WorldAddress, request: SubmitCoordinatedRoundRequest) {
    this.#assertOpen()
    canonicalizeWorldJson(request.action)
    for (const [name, value] of [
      ['idempotencyKey', request.idempotencyKey],
      ['principalId', request.principalId],
      ['correlationId', request.correlationId],
      ['action.actionType', request.action.actionType],
    ] as const) assertProtocolString(value, name)
    parsePlayerActionInput(request.action)
    return this.#durableReadGuard(address, 'round.accept', () => {
      const store = new WorldStore(this.options.worldPath)
      const inbox = new RoundInbox(this.options.worldPath)
      try {
        const stored = store.readManifest(address)
        if (stored === undefined) throw new Error('world branch has no active Compiled Manifest')
        const manifest = runtimeManifestFromStored(stored.manifest)
        this.#rulebooks.resolve(
          manifest.rulebook.rulebookId,
          manifest.rulebook.version,
          request.correlationId,
          address,
        )
        if (!manifest.playerBindings.some(value => value.principalId === request.principalId)) {
          failWorld({
            errorCode: 'UNAUTHORIZED', category: 'admission', message: 'principal has no PlayerBinding in this world',
            retryable: false, correlationId: request.correlationId, address,
          })
        }
        const queued = inbox.enqueue({
          address, idempotencyKey: request.idempotencyKey, principalId: request.principalId,
          input: request.action, correlationId: request.correlationId,
        }, manifest.roundQueueLimit)
        const durable = inbox.readStatus(address, { idempotencyKey: request.idempotencyKey })!
        return {
          status: durable.status,
          roundId: queued.roundId,
          inboxSeq: queued.inboxSeq,
          idempotencyKey: request.idempotencyKey,
        }
      } finally {
        inbox.close()
        store.close()
      }
    })
  }

  async processAcceptedRounds(address: WorldAddress, correlationId: string): Promise<number> {
    return this.#integrityGuard(address, 'round.process', branch => branch.kernel.drainAccepted(correlationId))
  }

  async roundStatus(address: WorldAddress, lookup: { readonly idempotencyKey?: string; readonly roundId?: InteractionRoundId }) {
    return this.#durableReadGuard(address, 'round.get', () => {
      const inbox = new RoundInbox(this.options.worldPath)
      try {
        return inbox.readStatus(address, lookup)
      } finally {
        inbox.close()
      }
    })
  }

  async cancelQueuedRound(
    address: WorldAddress,
    lookup: { readonly idempotencyKey?: string; readonly roundId?: InteractionRoundId },
    correlationId: string,
  ) {
    return this.#integrityGuard(address, 'round.cancel-queued', branch => branch.store.inbox.cancelQueued(address, lookup, correlationId))
  }

  async roundResult(address: WorldAddress, idempotencyKey: string): Promise<PlayerRoundResult | undefined> {
    return this.#durableReadGuard(address, 'round.get', () => {
      const inbox = new RoundInbox(this.options.worldPath)
      try {
        const result = inbox.readCompleted(address, idempotencyKey)
        return result === undefined ? undefined : parsePlayerRoundResult(result)
      } finally {
        inbox.close()
      }
    })
  }

  async head(address: WorldAddress) {
    return this.#integrityGuard(address, 'world.head', branch => branch.store.store.head(address))
  }

  /** Integrity-checked authority history for local authoring/debug composition; not exposed by the player RPC surface. */
  async eventHistory(address: WorldAddress, asOfWorldSeq?: number): Promise<StoredWorldEvent[]> {
    return this.#integrityGuard(address, 'world.events', branch => branch.store.store.readEvents(address, asOfWorldSeq))
  }

  /** Read the immutable Round Authority bound to a committed transaction. */
  async roundAuthority(address: WorldAddress, transactionId: TransactionId): Promise<StoredRoundAuthority | undefined> {
    return this.#integrityGuard(address, 'round.authority', branch => branch.store.store.readRoundAuthority(address, transactionId))
  }

  async characterView(address: WorldAddress, characterId: CharacterId, asOfWorldSeq?: number): Promise<CharacterView> {
    return this.#integrityGuard(address, 'view.character', branch => this.#projectionRead(
      address,
      `view:${worldAddressKey(address)}:${characterId}`,
      () => {
        const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
        return new CharacterViewBuilder(branch.store.store).rebuildAt(address, characterId, asOf)
      },
    ))
  }

  async recallMemory(
    address: WorldAddress,
    characterId: CharacterId,
    query: string,
    asOfWorldSeq?: number,
  ): Promise<RecalledMemory[]> {
    return this.#integrityGuard(address, 'memory.recall', branch => {
      const memory = branch.agents.cognitiveMemory
      if (memory === undefined) {
        failWorld({
          errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime',
          message: 'Cognitive Memory is not enabled by this Manifest', retryable: false,
          correlationId: `memory-recall:${characterId}`, address,
        })
      }
      const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
      return memory.recall(address, characterId, query, asOf)
    })
  }

  /** Player-facing view access: a principal may read only the Character bound to it by the frozen Manifest. */
  async characterViewForPrincipal(
    address: WorldAddress,
    principalId: string,
    characterId: CharacterId,
    asOfWorldSeq?: number,
  ): Promise<CharacterView> {
    assertProtocolString(principalId, 'principalId')
    return this.#integrityGuard(address, 'view.character', branch => {
      const manifest = runtimeManifestFromStoredRecord(branch.store.store.readManifest(address))
      if (!manifest.playerBindings.some(binding =>
        binding.principalId === principalId && binding.characterId === characterId)) {
        failWorld({
          errorCode: 'UNAUTHORIZED', category: 'admission',
          message: 'principal is not bound to the requested CharacterView', retryable: false,
          correlationId: `view:${principalId}:${characterId}`, address,
        })
      }
      return this.#projectionRead(address, `view:${worldAddressKey(address)}:${characterId}`, () => {
        const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
        return new CharacterViewBuilder(branch.store.store).rebuildAt(address, characterId, asOf)
      })
    })
  }

  async characterAvailability(address: WorldAddress, characterId: CharacterId) {
    return (await this.#branch(address)).store.availability.get(address, characterId)
  }

  async setCharacterAvailability(
    address: WorldAddress,
    characterId: CharacterId,
    state: RuntimeAvailabilityState,
    reason: string | null,
  ) {
    return (await this.#branch(address)).store.availability.set(address, characterId, state, reason)
  }

  async deliver(address: WorldAddress, correlationId: string): Promise<number> {
    try {
      return await this.#integrityGuard(address, 'outbox.drain', branch => branch.store.drainCritical(correlationId))
    } catch (error: unknown) {
      this.runtimeMetrics.recordSessionDeliveryFailure()
      throw error
    }
  }

  async deadLetters(address: WorldAddress): Promise<DeadLetterRecord[]> {
    return (await this.#branch(address)).store.deadLetters()
  }

  async retryDeadLetter(address: WorldAddress, deliveryId: DeliveryId, correlationId: string): Promise<void> {
    return (await this.#branch(address)).store.retryDeadLetter(deliveryId, correlationId)
  }

  async renderSession(
    address: WorldAddress,
    sessionId: SessionId,
    sessionEventSeq: number,
    presenterOptions?: PresenterOptions,
  ): Promise<PresentationResult> {
    return this.#integrityGuard(address, 'session.render', branch => {
      try {
        const event = branch.store.session.readEvent(sessionId, sessionEventSeq)
        if (event === undefined) throw new Error(`Session event ${sessionEventSeq} is missing`)
        return branch.director.presenter.render(event.payload, presenterOptions)
      } catch (error: unknown) {
        if (error instanceof WorldError || (error instanceof Error && error.message.includes(' is missing'))) throw error
        failWorld({
          errorCode: 'SESSION_DELIVERY_DIVERGED', category: 'integrity',
          message: `Session presentation source failed validation: ${String(error)}`, retryable: false,
          correlationId: `session-render:${sessionId}:${sessionEventSeq}`, address,
        })
      }
    })
  }

  async createSnapshot(address: WorldAddress, snapshotPath: string, correlationId: string) {
    return this.#integrityGuard(address, 'snapshot.create', branch => this.#projectionRead(address, correlationId, () => {
        const head = branch.store.store.head(address)
        const projection = new ProjectionRebuilder(branch.store.store).rebuildAt(address, head.headSeq)
        const snapshots = new SnapshotStore(snapshotPath)
        try {
          return snapshots.create(address, head.headSeq, { projection }, correlationId)
        } finally {
          snapshots.close()
        }
      }))
  }

  latestSnapshot(address: WorldAddress, snapshotPath: string) {
    this.#assertOpen()
    const snapshots = new SnapshotStore(snapshotPath)
    try {
      return snapshots.latest(address)
    } finally {
      snapshots.close()
    }
  }

  listSnapshots(address: WorldAddress, snapshotPath: string) {
    this.#assertOpen()
    const snapshots = new SnapshotStore(snapshotPath)
    try {
      return snapshots.list(address)
    } finally {
      snapshots.close()
    }
  }

  backup(targetPath: string, correlationId: string) {
    this.#assertOpen()
    return new WorldArchiveService(this.options.worldPath).backup(targetPath, correlationId)
  }

  restore(backupPath: string, targetPath: string, expectedHash: string, correlationId: string) {
    this.#assertOpen()
    return new WorldArchiveService(this.options.worldPath).restore(
      backupPath,
      targetPath,
      expectedHash as `sha256:${string}`,
      correlationId,
    )
  }

  exportPortable(exportPath: string, correlationId: string) {
    this.#assertOpen()
    return new WorldArchiveService(this.options.worldPath).exportPortable(exportPath, correlationId)
  }

  importPortable(exportPath: string, targetPath: string, correlationId: string) {
    this.#assertOpen()
    return new WorldArchiveService(this.options.worldPath).importPortable(exportPath, targetPath, correlationId)
  }

  exportAuthority(targetPath: string, correlationId: string) {
    this.#assertOpen()
    return new WorldLogicalTransferService(this.options.worldPath).exportAuthority(targetPath, correlationId)
  }

  importAuthority(exportPath: string, targetPath: string, correlationId: string) {
    this.#assertOpen()
    return new WorldLogicalTransferService(this.options.worldPath).importAuthority(exportPath, targetPath, correlationId)
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
    try {
      return await new BranchOperationCoordinator(branch.store.store, branch.store.administration, branch.kernel, branch.store)
        .archive({ address, reason, correlationId })
    } finally {
      await this.release(address)
    }
  }

  branchStatus(address: WorldAddress) {
    this.#assertOpen()
    const administration = new BranchAdministration(this.options.worldPath)
    try {
      return administration.status(address)
    } finally {
      administration.close()
    }
  }

  branchAudit(address: WorldAddress) {
    this.#assertOpen()
    const administration = new BranchAdministration(this.options.worldPath)
    try {
      return administration.readAudit(address)
    } finally {
      administration.close()
    }
  }

  async enterMaintenance(address: WorldAddress, reason: string, correlationId: string) {
    const branch = await this.#branch(address)
    branch.store.administration.setAdmission(address, 'draining', reason, `${correlationId}:drain`)
    const drainedRounds = await branch.kernel.drainAccepted(`${correlationId}:rounds`)
    await this.release(address)
    const administration = new BranchAdministration(this.options.worldPath)
    try {
      return {
        drainedRounds,
        state: administration.enterMaintenance(address, reason, `${correlationId}:enter`),
      }
    } finally {
      administration.close()
    }
  }

  async exitMaintenance(address: WorldAddress, reason: string, correlationId: string) {
    this.#assertOpen()
    await this.release(address)
    const administration = new BranchAdministration(this.options.worldPath)
    try {
      return administration.exitMaintenance(address, reason, `${correlationId}:exit`)
    } finally {
      administration.close()
    }
  }

  quarantineExplain(address: WorldAddress) {
    this.#assertOpen()
    const quarantine = new BranchQuarantineService(this.options.worldPath)
    try {
      return quarantine.explain(address)
    } finally {
      quarantine.close()
    }
  }

  async quarantineRecover(address: WorldAddress, correlationId: string) {
    this.#assertOpen()
    await this.release(address)
    const quarantine = new BranchQuarantineService(this.options.worldPath)
    try {
      return quarantine.recover(address, correlationId, () => {
        if (!existsSync(this.options.sessionPath)) {
          failWorld({
            errorCode: 'RECOVERY_VALIDATION_FAILED', category: 'integrity',
            message: 'Session database is missing during quarantine recovery', retryable: false,
            correlationId, address,
          })
        }
        const store = new WorldStore(this.options.worldPath)
        const outbox = new WorldOutbox(this.options.worldPath)
        const session = new SessionDeliveryAdapter(this.options.sessionPath)
        try {
          const world = store.verifyBranchIntegrity(address)
          const projection = new ProjectionRebuilder(store).rebuildAt(address, world.headSeq)
          const manifest = runtimeManifestFromStoredRecord(store.readManifest(address))
          const contextPolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:agent-context')
          let memoryVerificationHash
          if (contextPolicy !== undefined) {
            if (this.options.memoryPath === undefined) {
              failWorld({
                errorCode: 'RECOVERY_VALIDATION_FAILED', category: 'integrity',
                message: 'Memory database path is missing during quarantine recovery', retryable: false,
                correlationId, address,
              })
            }
            const memory = new CognitiveMemoryService(this.options.memoryPath, store, this.options.faultInjector)
            try {
              memoryVerificationHash = memory.rebuildBranch(
                address, manifest.characters.map(character => character.characterId), world.headSeq, correlationId,
              )
            } finally {
              memory.close()
            }
          }
          const sessionIntegrity = session.verifyIntegrity(address, correlationId)
          const bindings = session.deliveryBindings()
          const byDelivery = new Map(bindings.map(binding => [binding.deliveryId, binding]))
          const bySequence = new Map(bindings.map(binding => [`${binding.sessionId}\u001f${binding.sessionDeliverySeq}`, binding]))
          const ledger = outbox.deliveryLedger(address, correlationId)
          const expectedDeliveryIds = new Set<string>(ledger.map(delivery => delivery.deliveryId))
          const relevantSessionIds = new Set<SessionId>([
            ...manifest.playerBindings.map(binding => binding.sessionId),
            ...ledger.map(delivery => delivery.sessionId),
          ])
          for (const delivery of ledger) {
            const binding = byDelivery.get(delivery.deliveryId)
            const occupied = delivery.sessionDeliverySeq === null
              ? undefined
              : bySequence.get(`${delivery.sessionId}\u001f${delivery.sessionDeliverySeq}`)
            const bindingHash = binding === undefined ? undefined : hashWorldJson('session-delivery-binding', binding)
            const expectedBindingHash = hashWorldJson('session-delivery-binding', {
              sessionId: delivery.sessionId,
              sessionDeliverySeq: delivery.sessionDeliverySeq,
              deliveryId: delivery.deliveryId,
              payloadHash: delivery.payloadHash,
            })
            if ((bindingHash !== undefined && bindingHash !== expectedBindingHash)
              || (occupied !== undefined && occupied.deliveryId !== delivery.deliveryId)
              || (delivery.status === 'delivered' && binding === undefined)) {
              failWorld({
                errorCode: 'SESSION_DELIVERY_DIVERGED', category: 'integrity',
                message: 'World Outbox and Session delivery bindings are divergent', retryable: false,
                correlationId, address,
              })
            }
          }
          if (bindings.some(binding => relevantSessionIds.has(binding.sessionId) && !expectedDeliveryIds.has(binding.deliveryId))) {
            failWorld({
              errorCode: 'SESSION_DELIVERY_DIVERGED', category: 'integrity',
              message: 'Session contains a delivery that is absent from the restored World Outbox', retryable: false,
              correlationId, address,
            })
          }
          return {
            worldVerificationHash: world.verificationHash,
            projectionBundleHash: projection.bundleHash,
            sessionVerificationHash: sessionIntegrity.verificationHash,
            ...(memoryVerificationHash === undefined ? {} : { memoryVerificationHash }),
          }
        } finally {
          session.close()
          outbox.close()
          store.close()
        }
      })
    } finally {
      quarantine.close()
    }
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

  async #integrityGuard<T>(
    address: WorldAddress,
    source: string,
    operation: (branch: MountedBranch) => T | Promise<T>,
  ): Promise<T> {
    const branch = await this.#branch(address)
    try {
      return await operation(branch)
    } catch (error: unknown) {
      if (!(error instanceof WorldError) || error.envelope.category !== 'integrity') throw error
      try {
        branch.store.quarantine.quarantine({ address, error: error.envelope, source })
      } finally {
        await this.release(address)
      }
      throw error
    }
  }

  async #durableReadGuard<T>(address: WorldAddress, source: string, operation: () => T): Promise<T> {
    try {
      return operation()
    } catch (error: unknown) {
      if (!(error instanceof WorldError) || error.envelope.category !== 'integrity') throw error
      const quarantine = new BranchQuarantineService(this.options.worldPath)
      try {
        quarantine.quarantine({ address, error: error.envelope, source })
      } finally {
        quarantine.close()
        await this.release(address)
      }
      throw error
    }
  }

  #projectionRead<T>(address: WorldAddress, correlationId: string, operation: () => T): T {
    try {
      return operation()
    } catch (error: unknown) {
      if (error instanceof WorldError) throw error
      failWorld({
        errorCode: 'PROJECTION_INVARIANT_FAILED', category: 'integrity',
        message: `Projection rebuild failed: ${String(error)}`, retryable: false,
        correlationId, address,
      })
    }
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
