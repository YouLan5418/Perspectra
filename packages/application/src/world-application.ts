import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  assertProtocolString,
  canonicalizeWorldJson,
  compareWorldText,
  failWorld,
  hashWorldJson,
  resolutionAuthority,
  WorldError,
  worldAddressKey,
  type CharacterId,
  type RuntimeAvailabilityState,
  type InteractionRoundId,
  type ReactionCycleId,
  type ReactionCycleStatus,
  type ReactionCycleView,
  type ReactionListQuery,
  type CharacterView,
  type DeliveryId,
  type FaultInjector,
  type SessionId,
  type StoredRoundAuthority,
  type RecallTokenizerId,
  type StoredWorldEvent,
  type TransactionId,
  type WorldAddress,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  WorldBootstrap,
  WorldSpecCompiler,
  createCoreRulebookRegistry,
  manifestUsesPhase8Contracts,
  parsePlayerRoundResult,
  parsePlayerActionInput,
  reactionPolicyFromManifest,
  runtimeManifestFromStored,
  runtimeManifestFromStoredRecord,
  type CompiledWorldManifest,
  type CompiledWorldManifestV5,
  type CompiledWorldSpec,
  type PlayerActionInput,
  type PlayerRoundResult,
  type RulebookRegistry,
} from '@harness-world/kernel'
import {
  CognitiveMemoryService,
  type RecallCandidateDiagnostics,
  type RecalledMemory,
} from '@harness-world/memory'
import {
  ContextReceiptStore,
  ContinuityCheckpointService,
  ProviderCallStore,
  ProviderQualityStore,
} from '@harness-world/agents'
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
import { PlayerIntentWorker, type PlayerIntentProfile } from './player-intent-worker.ts'
import { preparePlayerIntent } from './player-intent-preparation.ts'
import { PlayerInputJobs, PLAYER_INPUT_TRANSITIONS, type PlayerInputJob, type PlayerInputStatus } from '@harness-world/store-sqlite'
import {
  RoundCoordinator,
  type AcceptedRoundStep,
  type RoundParticipant,
  type SubmitCoordinatedRoundRequest,
} from './round-coordinator.ts'
import { SceneDecisionService } from './scene-decision.ts'
import { ApplicationRuntimeMetrics } from './runtime-metrics.ts'
import { Phase8ContextPipeline } from './context-pipeline.ts'
import {
  ReactionScheduler,
  type ReactionParticipantBinding,
  type ReactionSchedulerOptions,
  type ReactionWaveResult,
  type ReactionWriterLeasePort,
} from './reaction-scheduler.ts'
import { ReactionCycleWorker, type ReactionDrainResult, type ReactionExecutionLane } from './reaction-worker.ts'

function assertCompatibleContentPackVersion(
  existing: { readonly manifest: WorldJsonValue } | undefined,
  candidate: CompiledWorldManifest,
): void {
  if (existing === undefined || candidate.contentPack === undefined) return
  const stored = runtimeManifestFromStored(existing.manifest).contentPack
  if (stored === undefined || stored.packId !== candidate.contentPack.packId
    || stored.packVersion !== candidate.contentPack.packVersion
    || stored.packHash === candidate.contentPack.packHash) return
  failWorld({
    errorCode: 'PACK_VERSION_DIVERGED', category: 'admission',
    message: 'same packId and packVersion resolve to different packHash values', retryable: false,
    correlationId: `activate:${worldAddressKey(candidate.address)}`, address: candidate.address,
    details: {
      packId: candidate.contentPack.packId,
      packVersion: candidate.contentPack.packVersion,
      existingPackHash: stored.packHash,
      candidatePackHash: candidate.contentPack.packHash,
    },
  })
}

function contextPathFor(options: Pick<WorldApplicationOptions, 'contextPath' | 'memoryPath'>): string | undefined {
  return options.contextPath ?? (options.memoryPath === undefined ? undefined : `${options.memoryPath}.context.sqlite`)
}

export interface WorldApplicationOptions {
  readonly playerIntent?: {
    readonly profile: PlayerIntentProfile
    readonly dispatch: (request: WorldJsonValue, profile: PlayerIntentProfile, signal: AbortSignal) => Promise<WorldJsonValue>
  }
  readonly worldPath: string
  readonly sessionPath: string
  readonly participants?: (address: WorldAddress) => readonly RoundParticipant[]
  readonly reactionParticipants?: (address: WorldAddress) => readonly ReactionParticipantBinding[]
  readonly modelBudgetTokens?: number
  readonly outboxMaxAttempts?: number
  readonly runtimeOwnerId?: string
  readonly leaseTtlMs?: number
  readonly faultInjector?: FaultInjector
  readonly rulebooks?: RulebookRegistry
  readonly memoryPath?: string
  readonly contextPath?: string
  /**
   * Selects the versioned keyword Recall strategy for this instance, or leaves the frozen path in place
   * when omitted. This is an explicit, recorded selection and not a silent upgrade: the effective
   * strategy and tokenizer are written into every Recall receipt, so a rebuild that asked for a different
   * one fails closed instead of quietly changing what a character is shown. It stays until a world can
   * declare the strategy in its own content.
   */
  readonly recallTokenizer?: RecallTokenizerId
  /** Whether the derived proper-noun dictionary participates in ranking; off unless a caller asks. */
  readonly recallDictionary?: boolean
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
): { readonly sceneVersion?: 1 | 2; readonly contextEnabled: boolean; readonly memoryVersion: 1 | 2 } {
  const scenePolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:scene-decision')
  const contextPolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:agent-context')
  const requiredSceneVersion = manifest.contentPack?.runtimeCapabilities.sceneDecisionVersion === 2 ? 2 : 1
  const sceneVersion = scenePolicy === undefined ? undefined
    : scenePolicy.version === '1.0.0' ? 1
    : scenePolicy.version === '2.0.0' ? 2
    : undefined
  const unsupported = scenePolicy !== undefined && sceneVersion === undefined
    ? `unsupported Scene decision policy ${scenePolicy.version}`
    : scenePolicy !== undefined && sceneVersion !== requiredSceneVersion
    ? `Scene decision policy ${scenePolicy.version} does not match runtime capability version ${requiredSceneVersion}`
    : contextPolicy !== undefined && contextPolicy.version !== '2.0.0'
    ? `unsupported Agent Context policy ${contextPolicy.version}`
    : contextPolicy !== undefined && scenePolicy === undefined
    ? 'Agent Context v2 requires Scene decision policy selection'
    : contextPolicy !== undefined && memoryPath === undefined
    ? 'memoryPath must be configured for Agent Context v2'
    : undefined
  if (unsupported !== undefined) {
    failWorld({
      errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime', message: unsupported, retryable: false,
      correlationId, address,
    })
  }
  const contextEnabled = contextPolicy !== undefined
  const memoryVersion = manifest.contentPack?.runtimeCapabilities.cognitiveMemoryVersion === 2 ? 2 as const : 1 as const
  return { ...(sceneVersion === undefined ? {} : { sceneVersion }), contextEnabled, memoryVersion }
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
    readonly contextPipeline?: Phase8ContextPipeline,
    readonly providerCalls?: ProviderCallStore,
    readonly providerQuality?: ProviderQualityStore,
  ) {}

  close(): void {
    this.contextPipeline?.close()
    this.providerCalls?.close()
    this.providerQuality?.close()
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
  readonly #contextPath: string | undefined

  constructor(private readonly options: WorldApplicationOptions & {
    readonly rulebooks: RulebookRegistry
    readonly runtimeMetrics: ApplicationRuntimeMetrics
  }) {
    const label = options.runtimeOwnerId ?? 'application'
    assertProtocolString(label, 'runtimeOwnerId diagnostic label')
    this.#runtimeOwnerId = `${label}:instance:${randomUUID()}`
    this.#contextPath = contextPathFor(options)
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
    let contextPipeline: Phase8ContextPipeline | undefined
    let providerCalls: ProviderCallStore | undefined
    let providerQuality: ProviderQualityStore | undefined
    try {
      if (participants.length > 0 && this.options.modelBudgetTokens === undefined) {
        throw new TypeError('modelBudgetTokens must be configured when Round participants are enabled')
      }
      const manifest = runtimeManifestFromStoredRecord(store.store.readManifest(scope.address))
      const policies = validateApplicationManifest(
        manifest, scope.address, `manifest-runtime:${worldAddressKey(scope.address)}`,
        this.options.memoryPath,
      )
      cognitiveMemory = !policies.contextEnabled
        ? undefined
        : new CognitiveMemoryService(
          this.options.memoryPath!, store.store, this.options.faultInjector, policies.memoryVersion,
          this.options.recallTokenizer, this.options.recallDictionary ?? false,
        )
      if (manifestUsesPhase8Contracts(manifest) && policies.contextEnabled && policies.memoryVersion === 2) {
        contextPipeline = new Phase8ContextPipeline({
          path: this.#contextPath!, store: store.store, memory: cognitiveMemory!,
          availability: store.availability, manifest, manifestHash: scope.manifestHash,
          rulebook: this.options.rulebooks.resolve(
            manifest.rulebook.rulebookId, manifest.rulebook.version,
            `context-pipeline:${worldAddressKey(scope.address)}`, scope.address,
          ),
        })
        providerCalls = new ProviderCallStore(this.#contextPath!)
        providerQuality = new ProviderQualityStore(this.#contextPath!)
      }
      const agents = new BranchAgentComponent(
        participants.filter(value => value.role === 'agent'), cognitiveMemory, contextPipeline, providerCalls, providerQuality,
      )
      const director = new BranchDirectorComponent(participants.filter(value => value.role === 'director'))
      const players = new Set(manifest.playerBindings.map(value => value.characterId))
      store.availability.initialize(scope.address, manifest.characters.map(character => ({
        characterId: character.characterId,
        state: players.has(character.characterId)
          ? manifest.runtimePolicy.playerInitialAvailability
          : manifest.runtimePolicy.npcInitialAvailability,
      })))
      const sceneDecision = policies.sceneVersion === undefined ? undefined
        : new SceneDecisionService(store.store, store.availability, policies.sceneVersion)
      const reactionBindings = this.options.reactionParticipants?.(scope.address) ?? []
      const reactionPolicy = reactionPolicyFromManifest(manifest)
      if (reactionPolicy.mode === 'responsive') {
        const responsiveManifest = manifest as CompiledWorldManifestV5
        const requiredActors = responsiveManifest.characters
          .filter(character => !players.has(character.characterId)
            && character.lifecycle === 'active'
            && character.controllerClass !== 'manual')
          .map(character => character.characterId)
          .sort(compareWorldText)
        const registeredActors = reactionBindings.map(binding => binding.actorId).sort(compareWorldText)
        if (requiredActors.length !== registeredActors.length
          || requiredActors.some((actorId, index) => actorId !== registeredActors[index])) {
          throw new TypeError('responsive/v1 requires one Reaction participant binding for every active non-manual NPC')
        }
      }
      const reactionDraftBindings = reactionBindings.map(binding => ({
        actorId: binding.actorId,
        estimatedTokens: binding.estimatedTokens,
      }))
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
        ...(sceneDecision === undefined ? {} : { sceneDecision }),
        ...(cognitiveMemory === undefined ? {} : { cognitiveMemory }),
        ...(contextPipeline === undefined ? {} : { contextPipeline }),
        ...(providerCalls === undefined ? {} : { providerCalls }),
        ...(providerQuality === undefined ? {} : { providerQuality }),
        ...(this.options.faultInjector === undefined ? {} : { faultInjector: this.options.faultInjector }),
        runtimeMetrics: this.options.runtimeMetrics,
        ...(this.options.leaseTtlMs === undefined ? {} : { leaseTtlMs: this.options.leaseTtlMs }),
        ...(reactionDraftBindings.length === 0 ? {} : { reactionParticipants: reactionDraftBindings }),
      })
      try {
        kernel.processCognitiveJobs()
      } catch (error: unknown) {
        kernel.close()
        throw error
      }
      let reactionWorker: ReactionCycleWorker | undefined
      if (reactionPolicy.mode === 'responsive') {
        const writerPort: ReactionWriterLeasePort = {
          current: () => kernel.writerLease,
          renew: () => { kernel.renewWriterLease(); return kernel.writerLease },
        }
        const schedulerOptions: ReactionSchedulerOptions = {
          address: scope.address,
          manifest,
          store: store.store,
          availability: store.availability,
          sceneDecision: sceneDecision!,
          contextPipeline: contextPipeline!,
          providerCalls: providerCalls!,
          rulebooks: this.options.rulebooks,
          participants: reactionBindings,
          writer: writerPort,
          ...(this.options.faultInjector === undefined ? {} : { faultInjector: this.options.faultInjector }),
        }
        const scheduler = new ReactionScheduler(schedulerOptions)
        reactionWorker = new ReactionCycleWorker(scope as ReactionExecutionLane, scheduler)
      }
      return { kernel, store, agents, director, ...(reactionWorker === undefined ? {} : { reactionWorker }) }
    } catch (error: unknown) {
      contextPipeline?.close()
      providerCalls?.close()
      providerQuality?.close()
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
  readonly reactionWorker?: ReactionCycleWorker
}

/** One Reaction quantum (ADR-0079): whether the Branch may react, and the Wave it committed if it did. */
export type ReactionWaveStep =
  | { readonly status: 'unsupported' }
  | { readonly status: 'idle' }
  | ({ readonly status: 'wave' } & ReactionWaveResult)

function reactionWaveOf(step: Extract<ReactionWaveStep, { readonly status: 'wave' }>): ReactionWaveResult {
  return {
    cycleId: step.cycleId,
    rootRoundId: step.rootRoundId,
    wave: step.wave,
    roundId: step.roundId,
    transactionId: step.transactionId,
    headSeq: step.headSeq,
    tick: step.tick,
    terminalReason: step.terminalReason,
    actionCount: step.actionCount,
  }
}

/** One durable scheduling quantum: one accepted Player Input transition chain, one Wave, one player Round, or idle. */
export type BranchWorkStep =
  | { readonly status: 'idle' }
  | { readonly status: 'player_input'; readonly inputId: string; readonly inputStatus: PlayerInputStatus; readonly round: PlayerRoundResult | null }
  | ({ readonly status: 'reaction_wave' } & ReactionWaveResult)
  | ({ readonly status: 'player_round' } & AcceptedRoundStep)

/** Local composition root and the only production entrypoint into branch-owned state. */
export class WorldApplication {
  readonly #inputTails = new Map<string, Promise<unknown>>()
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
      assertCompatibleContentPackVersion(store.readManifest(compiled.manifest.address), compiled.manifest)
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
        `activate:${worldAddressKey(compiled.manifest.address)}`,
        this.options.memoryPath,
      )
      return new WorldBootstrap(store, true).activate(compiled)
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
    if (this.#intentEnabled(address)) {
      const outcome = await this.#submitIntent(address, { ...request, text: JSON.stringify(request.action) }, request.action)
      if (outcome.status === 'submitted') return outcome.result
      failWorld({ errorCode: 'INVALID_REQUEST', category: 'admission', retryable: false, address,
        correlationId: request.correlationId, message: outcome.reason })
    }
    return this.#integrityGuard(address, 'round.submit', async (branch) => {
      if (branch.reactionWorker === undefined) return branch.kernel.submit(request)
      branch.kernel.accept(request)
      const replay = branch.store.inbox.readCompleted(address, request.idempotencyKey)
      if (replay !== undefined) return parsePlayerRoundResult(replay)
      await branch.reactionWorker.drain()
      while (true) {
        await branch.kernel.processNextAccepted(request.correlationId)
        const result = branch.store.inbox.readCompleted(address, request.idempotencyKey)
        if (result !== undefined) return parsePlayerRoundResult(result)
        await branch.reactionWorker.drain()
      }
    })
  }

  async submitText(address: WorldAddress, request: SubmitTextRequest): Promise<SubmitTextResult> {
    this.#assertOpen()
    if (this.#intentEnabled(address)) return this.#submitIntent(address, request)
    for (const [name, value] of [
      ['text', request.text],
      ['idempotencyKey', request.idempotencyKey],
      ['principalId', request.principalId],
      ['correlationId', request.correlationId],
    ] as const) assertProtocolString(value, name)
    const clarificationInput = { principalId: request.principalId, text: request.text }
    const replay = await this.#durableReadGuard(address, 'round.clarify', () => {
      const clarificationStore = new WorldStore(this.options.worldPath)
      try {
        return clarificationStore.readClarification(
          address, request.idempotencyKey, clarificationInput, request.correlationId,
        )
      } finally {
        clarificationStore.close()
      }
    })
    if (replay !== undefined) {
      return replay as Extract<PlayerInputInterpretation, { readonly status: 'clarification_required' }>
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
          resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
        }))
      } finally {
        store.close()
      }
    })
    if (interpretation.status === 'clarification_required') {
      return await this.#durableReadGuard(address, 'round.clarify', () => {
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
      })
    }
    const result = await this.submit(address, {
      idempotencyKey: request.idempotencyKey,
      principalId: request.principalId,
      correlationId: request.correlationId,
      action: interpretation.action,
    })
    return { status: 'submitted', action: interpretation.action, result }
  }

  #intentEnabled(address: WorldAddress): boolean {
    this.#assertOpen()
    const store = new WorldStore(this.options.worldPath)
    try {
      const stored = store.readManifest(address)
      if (stored === undefined) return false
      const manifest = runtimeManifestFromStored(stored.manifest)
      return manifest.schemaVersion === 9 && (manifest.playerInputPolicy as { version: string } | undefined)?.version === 'player-intent/v1'
    } finally { store.close() }
  }

  async #submitIntent(address: WorldAddress, request: SubmitTextRequest, action?: PlayerActionInput): Promise<SubmitTextResult> {
    for (const name of ['text', 'idempotencyKey', 'principalId', 'correlationId'] as const) assertProtocolString(request[name], name)
    const store = new WorldStore(this.options.worldPath)
    const jobs = new PlayerInputJobs(this.options.worldPath)
    try {
      const manifest = runtimeManifestFromStoredRecord(store.readManifest(address))
      if (!manifest.playerBindings.some(value => value.principalId === request.principalId)) {
        failWorld({ errorCode: 'UNAUTHORIZED', category: 'admission', retryable: false, address,
          correlationId: request.correlationId, message: 'principal has no PlayerBinding in this world' })
      }
      if (action !== undefined) parsePlayerActionInput(action)
      const received = jobs.receive(address, request.principalId, request.idempotencyKey,
        { text: request.text, ...(action === undefined ? {} : { action }) }, manifest.roundQueueLimit)
      this.options.faultInjector?.hit('player-input.after-received')
      let current = jobs.read(address, received.idempotencyKey)!
      while (PLAYER_INPUT_TRANSITIONS[current.status].length > 0) {
        await this.#queueNextPlayerInput(address, request.correlationId)
        current = jobs.read(address, received.idempotencyKey)!
      }
      if (current.status !== 'completed') {
        return { status: 'clarification_required' as const, reason: (current.records[current.status] as { reason: string }).reason, candidates: [] }
      }
      const submission = current.records.validated as unknown as { actions: PlayerActionInput[] }
      return { status: 'submitted' as const, action: { actionType: submission.actions[0]!.actionType, parameters: submission.actions[0]!.parameters },
        result: parsePlayerRoundResult(current.records.completed!) }
    } finally { jobs.close(); store.close() }
  }

  #queueNextPlayerInput(address: WorldAddress, correlationId: string): Promise<PlayerInputJob | undefined> {
    const key = worldAddressKey(address)
    const previous = this.#inputTails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.#integrityGuard(address, 'player-input.process', branch =>
      this.#playerIntentWorker(branch, address, correlationId).processNext()))
    this.#inputTails.set(key, run)
    return run.finally(() => { if (this.#inputTails.get(key) === run) this.#inputTails.delete(key) })
  }

  #playerIntentWorker(branch: MountedBranch, address: WorldAddress, correlationId: string): PlayerIntentWorker {
    return new PlayerIntentWorker({ worldPath: this.options.worldPath,
      contextPath: contextPathFor(this.options) ?? `${this.options.worldPath}.context.sqlite`, address,
      renewLease: () => { branch.kernel.renewWriterLease(); return branch.kernel.writerLease },
      prepare: job => {
        const stored = branch.store.store.readManifest(address)!
        if (stored.manifestHash !== job.acceptedManifestHash) {
          failWorld({ errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false, address,
            correlationId, message: 'player input accepted Manifest no longer matches branch authority' })
        }
        const current = runtimeManifestFromStoredRecord(stored)
        const history = branch.store.store.readEvents(address, job.acceptedHeadSeq)
        const acceptedHash = history.at(-1)?.eventHash
        if (history.length !== job.acceptedHeadSeq || acceptedHash !== job.acceptedHeadHash) {
          failWorld({ errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false, address,
            correlationId, message: 'player input accepted Head no longer matches World Event authority' })
        }
        const prepared = preparePlayerIntent(job, current, history,
          this.#rulebooks.resolve(current.rulebook.rulebookId, current.rulebook.version, correlationId, address),
          this.options.playerIntent?.profile, this.options.modelBudgetTokens ?? 0)
        return 'request' in prepared ? { ...prepared, request: { body: prepared.request,
          asOfWorldSeq: job.acceptedHeadSeq, baseHeadHash: job.acceptedHeadHash } } : prepared
      },
      dispatch: (input, profile, signal) => this.options.playerIntent!.dispatch(input, profile, signal),
      enqueue: job => {
        const manifest = runtimeManifestFromStoredRecord(branch.store.store.readManifest(address))
        return branch.store.inbox.enqueue({ address, idempotencyKey: job.idempotencyKey, principalId: job.principalId,
          correlationId, playerInputId: job.inputId, input: { playerInputId: job.inputId } }, manifest.roundQueueLimit) as unknown as WorldJsonValue
      },
      complete: async job => {
        while (branch.store.inbox.readCompleted(address, job.idempotencyKey) === undefined) {
          await branch.reactionWorker?.drain()
          await branch.kernel.processNextAccepted(correlationId)
        }
        return branch.store.inbox.readCompleted(address, job.idempotencyKey)!
      },
      ...(this.options.faultInjector === undefined ? {} : { faultInjector: this.options.faultInjector }),
    })
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

  /** Run at most one frozen Wave; `unsupported` means this Manifest does not enable Reactions. */
  async processNextReactionWave(address: WorldAddress): Promise<ReactionWaveStep> {
    return this.#integrityGuard(address, 'reaction.process', async (branch) => {
      if (branch.reactionWorker === undefined) return { status: 'unsupported' }
      const wave = await branch.reactionWorker.runOneWave()
      return wave === undefined ? { status: 'idle' } : { ...wave, status: 'wave' }
    })
  }

  /** Execute one FIFO input item first, else one frozen Wave, else one accepted player Round, else idle. */
  async processNextBranchWork(address: WorldAddress, correlationId: string): Promise<BranchWorkStep> {
    const input = await this.#queueNextPlayerInput(address, correlationId)
    if (input !== undefined) return { status: 'player_input', inputId: input.inputId, inputStatus: input.status,
      round: input.status === 'completed' ? parsePlayerRoundResult(input.records.completed!) : null }
    const wave = await this.processNextReactionWave(address)
    if (wave.status === 'wave') return { ...wave, status: 'reaction_wave' }
    return this.#integrityGuard(address, 'round.process', async (branch) => {
      const round = await branch.kernel.processNextAcceptedStep(correlationId)
      return round === undefined ? { status: 'idle' } : { ...round, status: 'player_round' }
    })
  }

  async processAcceptedRounds(address: WorldAddress, correlationId: string): Promise<number> {
    let processed = 0
    while (true) {
      const step = await this.processNextBranchWork(address, correlationId)
      if (step.status === 'idle') return processed
      if (step.status === 'player_round' || (step.status === 'player_input' && step.round !== null)) processed += 1
    }
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

  async reactionCycle(address: WorldAddress, cycleId: ReactionCycleId): Promise<ReactionCycleView | undefined> {
    return this.#durableReadGuard(address, 'reaction.get', () => {
      const store = new WorldStore(this.options.worldPath)
      try {
        return store.reactionCycleView(address, cycleId)
      } finally {
        store.close()
      }
    })
  }

  async listReactionCycles(address: WorldAddress, query: ReactionListQuery = {}): Promise<ReactionCycleView[]> {
    return this.#durableReadGuard(address, 'reaction.list', () => {
      const status = query.status
      if (status !== undefined && !(['active', 'stop_requested', 'terminal'] as ReactionCycleStatus[]).includes(status)) {
        throw new TypeError('reaction.list status is invalid')
      }
      const limit = query.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError('reaction.list limit must be a safe integer from 1 through 100')
      }
      const store = new WorldStore(this.options.worldPath)
      try {
        return store.listReactionCycles(address)
          .filter(view => status === undefined || view.status === status).slice(0, limit)
      } finally {
        store.close()
      }
    })
  }

  async cancelReactionCycle(
    address: WorldAddress,
    cycleId: ReactionCycleId,
    correlationId: string,
  ): Promise<ReactionCycleView> {
    return this.#integrityGuard(address, 'reaction.cancel', branch => {
      const view = branch.store.store.cancelReactionCycle(address, cycleId)
      if (view === undefined) {
        failWorld({
          errorCode: 'INVALID_REQUEST',
          category: 'admission',
          message: 'Reaction Cycle does not exist in this branch',
          retryable: false,
          correlationId,
          address,
          details: { cycleId },
        })
      }
      return view
    })
  }

  async processReactionCycles(address: WorldAddress): Promise<ReactionDrainResult | null> {
    const first = await this.processNextReactionWave(address)
    if (first.status === 'unsupported') return null
    const waves: ReactionWaveResult[] = first.status === 'wave' ? [reactionWaveOf(first)] : []
    while (true) {
      const step = await this.processNextReactionWave(address)
      if (step.status !== 'wave') return { cycleId: waves[0]?.cycleId ?? null, waves }
      waves.push(reactionWaveOf(step))
    }
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
      const memory = this.#requireCognitiveMemory(branch.agents.cognitiveMemory, address, characterId, 'recall')
      const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
      return memory.recall(address, characterId, query, asOf)
    })
  }

  /**
   * Report how many Recall candidates this query matches before the default result limit, so an operator can
   * see what one Recall leaves unseen. Reading this writes no Recall or Context record of its own.
   */
  async diagnoseMemoryRecall(
    address: WorldAddress,
    characterId: CharacterId,
    query: string,
    asOfWorldSeq?: number,
  ): Promise<RecallCandidateDiagnostics> {
    return this.#integrityGuard(address, 'memory.diagnose', branch => {
      const memory = this.#requireCognitiveMemory(branch.agents.cognitiveMemory, address, characterId, 'diagnose')
      const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
      return memory.diagnoseRecall(address, characterId, query, asOf)
    })
  }

  #requireCognitiveMemory(
    memory: CognitiveMemoryService | undefined,
    address: WorldAddress,
    characterId: CharacterId,
    operation: 'recall' | 'diagnose',
  ): CognitiveMemoryService {
    if (memory === undefined) {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime',
        message: 'Cognitive Memory is not enabled by this Manifest', retryable: false,
        correlationId: `memory-${operation}:${characterId}`, address,
      })
    }
    return memory
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
      // A retryable Cycle barrier must not dispose the writer used by an in-flight Wave.
      if (branch.store.store.openReactionCycleId(address) === undefined) await this.release(address)
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
    let stoppedCycleId: string | null = null
    let settledWaves = 0
    let drainedRounds = 0
    while (true) {
      const stopped = branch.store.store.requestReactionCycleAdministrativeStop(address)
      if (stopped !== undefined) stoppedCycleId = stopped
      // A Root already running when the barrier closed may create its Cycle after the first stop request.
      await branch.lease.slot.enqueueRound(async () => {
        const opened = branch.store.store.requestReactionCycleAdministrativeStop(address)
        if (opened !== undefined) stoppedCycleId = opened
      })
      settledWaves += await this.#settleStoppedCycle(branch)
      const drained = await branch.kernel.processNextAcceptedStep(`${correlationId}:rounds`)
      if (drained === undefined) break
      drainedRounds += 1
    }
    await branch.store.drainCritical(`${correlationId}:outbox`)
    await this.release(address)
    const administration = new BranchAdministration(this.options.worldPath)
    try {
      return {
        drainedRounds,
        stoppedCycleId,
        settledWaves,
        state: administration.enterMaintenance(address, reason, `${correlationId}:enter`),
      }
    } finally {
      administration.close()
    }
  }

  /** Settle the frozen Wave of a stop-requested Cycle so maintenance never leaves it open (ADR-0079). */
  async #settleStoppedCycle(branch: MountedBranch): Promise<number> {
    if (branch.reactionWorker === undefined) return 0
    let settledWaves = 0
    while (await branch.reactionWorker.runOneWave() !== undefined) settledWaves += 1
    return settledWaves
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
            const memoryVersion = manifest.contentPack?.runtimeCapabilities.cognitiveMemoryVersion === 2 ? 2 : 1
            const memory = new CognitiveMemoryService(
              this.options.memoryPath, store, this.options.faultInjector, memoryVersion,
              this.options.recallTokenizer, this.options.recallDictionary ?? false,
            )
            try {
              memoryVerificationHash = memory.rebuildBranch(
                address, manifest.characters.map(character => character.characterId), world.headSeq, correlationId,
              )
              if (manifestUsesPhase8Contracts(manifest)) {
                const contextPath = contextPathFor(this.options)!
                const checkpoints = new ContinuityCheckpointService(contextPath, store, memory)
                const receipts = new ContextReceiptStore(contextPath)
                try {
                  receipts.reset(address)
                  for (const character of manifest.characters) checkpoints.reset(address, character.characterId)
                } finally {
                  receipts.close()
                  checkpoints.close()
                }
              }
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
    await Promise.allSettled(this.#inputTails.values())
    this.#branches.clear()
    await Promise.all(pending.map(branch => branch.then(value => value.lease.dispose(), () => undefined)))
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
      this.#branches.delete(key)
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
      || !(components.director instanceof BranchDirectorComponent)
      || (components.reactionWorker !== undefined && !(components.reactionWorker instanceof ReactionCycleWorker))) {
      await lease.dispose()
      throw new Error('Branch Component Factory returned an incompatible component set')
    }
    return {
      lease,
      kernel: components.kernel,
      store: components.store,
      agents: components.agents,
      director: components.director,
      ...(components.reactionWorker === undefined ? {} : { reactionWorker: components.reactionWorker }),
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('WorldApplication is closed')
  }
}
