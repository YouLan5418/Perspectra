import { Context } from '@deepseek-ai/cordis'
import {
  WorldError,
  assertProtocolString,
  canonicalizeWorldJson,
  failWorld,
  hashWorldJson,
  resolutionAuthority,
  worldAddressKey,
  type CharacterId,
  type CharacterView,
  type DeliveryId,
  type FaultInjector,
  type InteractionPackageImplementation,
  type InteractionRoundId,
  type RecallTokenizerId,
  type WorldAddress,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import {
  FrozenInteractionRulebook,
  WorldBootstrap,
  createCoreRulebookRegistry,
  parsePlayerActionInput,
  runtimeManifestFromStored,
  runtimeManifestFromStoredRecord,
  type ActionAffordance,
  type CompiledWorldManifest,
  type CompiledWorldSpec,
  type PlayerActionInput,
  type RulebookRegistry,
} from '@harness-world/kernel'
import { CognitiveMemoryService } from '@harness-world/memory'
import { DeterministicPresenter } from '@harness-world/presentation'
import {
  WorldRuntimeRegistry,
  type BranchComponentFactory,
  type BranchExecutionLane,
} from '@harness-world/runtime-cordis'
import {
  BranchAdministration,
  BranchQuarantineService,
  CharacterRuntimeAvailabilityService,
  CharacterViewBuilder,
  PLAYER_INPUT_TRANSITIONS,
  PlayerInputJobs,
  RoundInbox,
  SessionDeliveryAdapter,
  SessionOutboxWorker,
  WorldOutbox,
  WorldStore,
  WriterLeaseService,
  type DeadLetterRecord,
  type PlayerInputJob,
  type PlayerInputStatus,
} from '@harness-world/store-sqlite'
import { randomUUID } from 'node:crypto'
import { PlayerInputInterpreter, type PlayerInputInterpretation } from './player-input.ts'
import { preparePlayerIntent } from './player-intent-preparation.ts'
import { PlayerIntentWorker, type PlayerIntentProfile } from './player-intent-worker.ts'
import {
  RoundCoordinator,
  parsePlayerRoundResult,
  type AcceptedRoundStep,
  type PlayerRoundResult,
  type SubmitCoordinatedRoundRequest,
} from './round-coordinator.ts'
import { ApplicationRuntimeMetrics } from './runtime-metrics.ts'
import { SceneDecisionService } from './scene-decision.ts'
import { WorldAdministration } from './world-administration.ts'
import type { MountedBranch, WorldBranchAccess } from './world-branch-access.ts'
import { WorldReadQueries } from './world-read-queries.ts'

function assertCompatibleContentPackVersion(
  existing: { readonly manifest: WorldJsonValue } | undefined,
  candidate: CompiledWorldManifest,
): void {
  if (existing === undefined || candidate.contentPack === undefined) return
  const stored = runtimeManifestFromStored(existing.manifest).contentPack
  if (
    stored === undefined ||
    stored.packId !== candidate.contentPack.packId ||
    stored.packVersion !== candidate.contentPack.packVersion ||
    stored.packHash === candidate.contentPack.packHash
  )
    return
  failWorld({
    errorCode: 'PACK_VERSION_DIVERGED',
    category: 'admission',
    message: 'same packId and packVersion resolve to different packHash values',
    retryable: false,
    correlationId: `activate:${worldAddressKey(candidate.address)}`,
    address: candidate.address,
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

/**
 * The first-batch trusted pack, installed unless a Host says otherwise. It is the Host's decision, not
 * the world's: a world names locks and can only select what the Host already installed.
 */
const DEFAULT_INTERACTION_PACKAGES: readonly InteractionPackageImplementation[] = Object.freeze([
  createBasicInteractionPackage(),
])

export interface WorldApplicationOptions {
  readonly playerIntent?: {
    readonly profile: PlayerIntentProfile
    readonly dispatch: (
      request: WorldJsonValue,
      profile: PlayerIntentProfile,
      signal: AbortSignal,
    ) => Promise<WorldJsonValue>
  }
  readonly worldPath: string
  readonly sessionPath: string
  readonly modelBudgetTokens?: number
  readonly outboxMaxAttempts?: number
  readonly runtimeOwnerId?: string
  readonly leaseTtlMs?: number
  readonly faultInjector?: FaultInjector
  readonly rulebooks?: RulebookRegistry
  /**
   * The trusted interaction packages this Host installs. A v10 world selects among them by lock and can
   * never add one, so a Host that installs nothing refuses to activate a v10 world rather than opening
   * a world whose actions it cannot resolve. Omitted means the first-batch basic package.
   */
  readonly interactionPackages?: readonly InteractionPackageImplementation[]
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
  | { readonly status: 'service_failed'; readonly reason: string }
  | Extract<PlayerInputInterpretation, { readonly status: 'clarification_required' }>
  | { readonly status: 'submitted'; readonly action: PlayerActionInput; readonly result: PlayerRoundResult }

function validateApplicationManifest(
  manifest: CompiledWorldManifest,
  address: WorldAddress,
  correlationId: string,
  memoryPath: string | undefined,
): { readonly sceneEnabled: boolean; readonly contextEnabled: boolean; readonly memoryVersion: 1 | 2 } {
  const scenePolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:scene-decision')
  const contextPolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:agent-context')
  const unsupported =
    scenePolicy !== undefined && scenePolicy.version !== '2.0.0'
      ? `unsupported Scene decision policy ${scenePolicy.version}`
      : scenePolicy !== undefined && manifest.contentPack?.runtimeCapabilities.sceneDecisionVersion !== 2
        ? `Scene decision policy ${scenePolicy.version} requires runtime capability sceneDecisionVersion 2`
        : contextPolicy !== undefined && contextPolicy.version !== '2.0.0'
          ? `unsupported Agent Context policy ${contextPolicy.version}`
          : contextPolicy !== undefined && scenePolicy === undefined
            ? 'Agent Context v2 requires Scene decision policy selection'
            : contextPolicy !== undefined && memoryPath === undefined
              ? 'memoryPath must be configured for Agent Context v2'
              : undefined
  if (unsupported !== undefined) {
    failWorld({
      errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE',
      category: 'runtime',
      message: unsupported,
      retryable: false,
      correlationId,
      address,
    })
  }
  const contextEnabled = contextPolicy !== undefined
  const memoryVersion =
    manifest.contentPack?.runtimeCapabilities.cognitiveMemoryVersion === 2 ? (2 as const) : (1 as const)
  return { sceneEnabled: scenePolicy !== undefined, contextEnabled, memoryVersion }
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

/** Branch-owned authorized memory capture used by player commits and explicit recall. */
export class BranchAgentComponent {
  constructor(readonly cognitiveMemory?: CognitiveMemoryService) {}
  close(): void {
    this.cognitiveMemory?.close()
  }
}

/** Deterministic presentation for the session-rendering API. */
export class BranchPresentationComponent {
  readonly presenter = new DeterministicPresenter()
}

/** Application-owned factory that mounts real stateful components into each Cordis Branch Slot. */
export class WorldBranchComponentFactory implements BranchComponentFactory {
  readonly #runtimeOwnerId: string

  constructor(
    private readonly options: WorldApplicationOptions & {
      readonly rulebooks: RulebookRegistry
    },
  ) {
    const label = options.runtimeOwnerId ?? 'application'
    assertProtocolString(label, 'runtimeOwnerId diagnostic label')
    this.#runtimeOwnerId = `${label}:instance:${randomUUID()}`
  }

  create(scope: BranchExecutionLane) {
    const store = new BranchStoreComponent(
      scope.address,
      this.options.worldPath,
      this.options.sessionPath,
      this.options.outboxMaxAttempts ?? 12,
      this.options.faultInjector,
    )
    let cognitiveMemory: CognitiveMemoryService | undefined
    try {
      const manifest = runtimeManifestFromStoredRecord(store.store.readManifest(scope.address))
      const policies = validateApplicationManifest(
        manifest,
        scope.address,
        `manifest-runtime:${worldAddressKey(scope.address)}`,
        this.options.memoryPath,
      )
      cognitiveMemory = !policies.contextEnabled
        ? undefined
        : new CognitiveMemoryService(
            this.options.memoryPath!,
            store.store,
            this.options.faultInjector,
            policies.memoryVersion,
            this.options.recallTokenizer,
            this.options.recallDictionary ?? false,
          )
      const agents = new BranchAgentComponent(cognitiveMemory)
      const presentation = new BranchPresentationComponent()
      const players = new Set(manifest.playerBindings.map(value => value.characterId))
      store.availability.initialize(
        scope.address,
        manifest.characters.map(character => ({
          characterId: character.characterId,
          state: players.has(character.characterId)
            ? manifest.runtimePolicy.playerInitialAvailability
            : manifest.runtimePolicy.npcInitialAvailability,
        })),
      )
      const sceneDecision = policies.sceneEnabled
        ? new SceneDecisionService(store.store, store.availability)
        : undefined
      const kernel = new RoundCoordinator({
        store: store.store,
        inbox: store.inbox,
        leases: store.leases,
        availability: store.availability,
        runtimeLane: scope,
        ownerId: `${this.#runtimeOwnerId}:branch:${hashWorldJson('writer-owner-address', scope.address)}`,
        rulebooks: this.options.rulebooks,
        ...(sceneDecision === undefined ? {} : { sceneDecision }),
        ...(cognitiveMemory === undefined ? {} : { cognitiveMemory }),
        ...(this.options.faultInjector === undefined ? {} : { faultInjector: this.options.faultInjector }),
        ...(this.options.leaseTtlMs === undefined ? {} : { leaseTtlMs: this.options.leaseTtlMs }),
      })
      try {
        kernel.processCognitiveJobs()
      } catch (error: unknown) {
        kernel.close()
        throw error
      }
      return { kernel, store, agents, presentation }
    } catch (error: unknown) {
      cognitiveMemory?.close()
      store.close()
      throw error
    }
  }
}

/** One durable player input transition chain, one player Round, or idle. */
export type BranchWorkStep =
  | { readonly status: 'idle' }
  | {
      readonly status: 'player_input'
      readonly inputId: string
      readonly inputStatus: PlayerInputStatus
      readonly round: PlayerRoundResult | null
    }
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

  readonly #interactionPackages: readonly InteractionPackageImplementation[]
  /**
   * One frozen path for the whole application: the registry adjudicates through it, and activation uses
   * it to prove a world's selection closes against the Host's declared install. A caller that supplies
   * its own `rulebooks` keeps responsibility for that registry, but activation still validates against
   * the packages declared here, which is why both live on the same instance.
   */
  readonly #frozenInteractions: FrozenInteractionRulebook

  /** Creator, debug and operator reads that do not change world state. */
  readonly read: WorldReadQueries
  /** Operator actions such as backups, forks, archive, maintenance and quarantine recovery. */
  readonly admin: WorldAdministration

  constructor(private readonly options: WorldApplicationOptions) {
    const access: WorldBranchAccess = {
      options,
      assertOpen: () => this.#assertOpen(),
      branch: address => this.#branch(address),
      release: address => this.release(address),
      integrityGuard: (address, source, operation) => this.#integrityGuard(address, source, operation),
      projectionRead: (address, correlationId, operation) => this.#projectionRead(address, correlationId, operation),
    }
    this.read = new WorldReadQueries(access)
    this.admin = new WorldAdministration(access)
    this.#interactionPackages = options.interactionPackages ?? DEFAULT_INTERACTION_PACKAGES
    this.#frozenInteractions = new FrozenInteractionRulebook(this.#interactionPackages)
    this.#rulebooks = options.rulebooks ?? createCoreRulebookRegistry({ frozenInteractions: this.#frozenInteractions })
    this.runtimeRegistry = new WorldRuntimeRegistry(
      this.#root,
      new WorldBranchComponentFactory({
        ...options,
        rulebooks: this.#rulebooks,
      }),
    )
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
      validateApplicationManifest(
        compiled.manifest,
        compiled.manifest.address,
        `activate:${worldAddressKey(compiled.manifest.address)}`,
        this.options.memoryPath,
      )
      return new WorldBootstrap(store, true, this.#frozenInteractions).activate(compiled)
    } finally {
      store.close()
    }
  }

  async submit(address: WorldAddress, request: SubmitCoordinatedRoundRequest): Promise<PlayerRoundResult> {
    if (this.#intentEnabled(address)) {
      const outcome = await this.#submitIntent(
        address,
        { ...request, text: JSON.stringify(request.action) },
        request.action,
      )
      if (outcome.status === 'submitted') return outcome.result
      failWorld({
        errorCode: 'INVALID_REQUEST',
        category: 'admission',
        retryable: false,
        address,
        correlationId: request.correlationId,
        message: outcome.reason,
      })
    }
    return this.#integrityGuard(address, 'round.submit', async branch => {
      return branch.kernel.submit(request)
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
    ] as const)
      assertProtocolString(value, name)
    const clarificationInput = { principalId: request.principalId, text: request.text }
    const replay = await this.#durableReadGuard(address, 'round.clarify', () => {
      const clarificationStore = new WorldStore(this.options.worldPath)
      try {
        return clarificationStore.readClarification(
          address,
          request.idempotencyKey,
          clarificationInput,
          request.correlationId,
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
        const record = store.readManifest(address)!
        const manifest = runtimeManifestFromStoredRecord(record)
        const binding = manifest.playerBindings.find(value => value.principalId === request.principalId)
        if (binding === undefined) {
          failWorld({
            errorCode: 'UNAUTHORIZED',
            category: 'admission',
            message: 'principal has no PlayerBinding in this world',
            retryable: false,
            correlationId: request.correlationId,
            address,
          })
        }
        const resolver = this.#rulebooks.resolve(
          manifest.rulebook.rulebookId,
          manifest.rulebook.version,
          request.correlationId,
          address,
        )
        const head = store.head(address)
        const events = store.readEvents(address, head.headSeq)
        return new PlayerInputInterpreter().interpret(
          request.text,
          resolver.affordances({
            manifest,
            events,
            characterId: binding.characterId,
            manifestHash: record.manifestHash,
            asOfWorldSeq: head.headSeq,
            resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
          }),
        )
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
      return manifest.playerInputPolicy?.version === 'player-intent/v1'
    } finally {
      store.close()
    }
  }

  async #submitIntent(
    address: WorldAddress,
    request: SubmitTextRequest,
    action?: PlayerActionInput,
  ): Promise<SubmitTextResult> {
    for (const name of ['text', 'idempotencyKey', 'principalId', 'correlationId'] as const)
      assertProtocolString(request[name], name)
    const store = new WorldStore(this.options.worldPath)
    const jobs = new PlayerInputJobs(this.options.worldPath)
    try {
      const manifest = runtimeManifestFromStoredRecord(store.readManifest(address))
      if (!manifest.playerBindings.some(value => value.principalId === request.principalId)) {
        failWorld({
          errorCode: 'UNAUTHORIZED',
          category: 'admission',
          retryable: false,
          address,
          correlationId: request.correlationId,
          message: 'principal has no PlayerBinding in this world',
        })
      }
      if (action !== undefined) parsePlayerActionInput(action)
      const received = jobs.receive(
        address,
        request.principalId,
        request.idempotencyKey,
        { text: request.text, ...(action === undefined ? {} : { action }) },
        manifest.roundQueueLimit,
      )
      this.options.faultInjector?.hit('player-input.after-received')
      let current = jobs.read(address, received.idempotencyKey)!
      while (PLAYER_INPUT_TRANSITIONS[current.status].length > 0) {
        await this.#queueNextPlayerInput(address, request.correlationId)
        current = jobs.read(address, received.idempotencyKey)!
      }
      if (current.status !== 'completed' && current.status !== 'clarification_required') {
        const detail =
          current.status === 'invalid_response'
            ? (current.records.invalid_response as { reason?: string } | undefined)?.reason
            : undefined
        return {
          status: 'service_failed',
          reason: detail === 'candidate_source_order_invalid' ? 'candidate_source_order_invalid' : current.status,
        }
      }
      if (current.status !== 'completed') {
        const reason = (current.records[current.status] as { reason: string }).reason
        if (
          ['player_intent_provider_unavailable', 'invalid_player_intent_profile', 'budget_exhausted'].includes(reason)
        ) {
          return { status: 'service_failed', reason }
        }
        return { status: 'clarification_required' as const, reason, candidates: [] }
      }
      const submission = current.records.validated as unknown as { actions: PlayerActionInput[] }
      return {
        status: 'submitted' as const,
        action: { actionType: submission.actions[0]!.actionType, parameters: submission.actions[0]!.parameters },
        result: parsePlayerRoundResult(current.records.completed!),
      }
    } finally {
      jobs.close()
      store.close()
    }
  }

  #queueNextPlayerInput(address: WorldAddress, correlationId: string): Promise<PlayerInputJob | undefined> {
    const key = worldAddressKey(address)
    const previous = this.#inputTails.get(key) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(() =>
        this.#integrityGuard(address, 'player-input.process', branch =>
          this.#playerIntentWorker(branch, address, correlationId).processNext(),
        ),
      )
    this.#inputTails.set(key, run)
    return run.finally(() => {
      if (this.#inputTails.get(key) === run) this.#inputTails.delete(key)
    })
  }

  #playerIntentWorker(branch: MountedBranch, address: WorldAddress, correlationId: string): PlayerIntentWorker {
    return new PlayerIntentWorker({
      worldPath: this.options.worldPath,
      contextPath: contextPathFor(this.options) ?? `${this.options.worldPath}.context.sqlite`,
      address,
      // The worker renews this as its heartbeat, starting before the interpretation is dispatched, so
      // this is where a Host that was idle takes its lease back rather than failing the player's turn.
      renewLease: () => {
        branch.kernel.refreshWriterLease()
        return branch.kernel.writerLease
      },
      prepare: job => {
        const stored = branch.store.store.readManifest(address)!
        if (stored.manifestHash !== job.acceptedManifestHash) {
          failWorld({
            errorCode: 'BUNDLE_HASH_MISMATCH',
            category: 'integrity',
            retryable: false,
            address,
            correlationId,
            message: 'player input accepted Manifest no longer matches branch authority',
          })
        }
        const current = runtimeManifestFromStoredRecord(stored)
        const history = branch.store.store.readEvents(address, job.acceptedHeadSeq)
        const acceptedHash = history.at(-1)?.eventHash
        if (history.length !== job.acceptedHeadSeq || acceptedHash !== job.acceptedHeadHash) {
          failWorld({
            errorCode: 'BUNDLE_HASH_MISMATCH',
            category: 'integrity',
            retryable: false,
            address,
            correlationId,
            message: 'player input accepted Head no longer matches World Event authority',
          })
        }
        const prepared = preparePlayerIntent(
          job,
          current,
          history,
          this.#rulebooks.resolve(current.rulebook.rulebookId, current.rulebook.version, correlationId, address),
          this.options.playerIntent?.profile,
          this.options.modelBudgetTokens ?? 0,
          stored.manifestHash,
          job.acceptedHeadSeq,
        )
        return 'request' in prepared
          ? {
              ...prepared,
              request: {
                body: prepared.request,
                asOfWorldSeq: job.acceptedHeadSeq,
                baseHeadHash: job.acceptedHeadHash,
              },
            }
          : prepared
      },
      dispatch: (input, profile, signal) => this.options.playerIntent!.dispatch(input, profile, signal),
      enqueue: job => {
        const manifest = runtimeManifestFromStoredRecord(branch.store.store.readManifest(address))
        return branch.store.inbox.enqueue(
          {
            address,
            idempotencyKey: job.idempotencyKey,
            principalId: job.principalId,
            correlationId,
            playerInputId: job.inputId,
            input: { playerInputId: job.inputId },
          },
          manifest.roundQueueLimit,
        ) as unknown as WorldJsonValue
      },
      complete: async job => {
        while (branch.store.inbox.readCompleted(address, job.idempotencyKey) === undefined) {
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
    ] as const)
      assertProtocolString(value, name)
    parsePlayerActionInput(request.action)
    return this.#durableReadGuard(address, 'round.accept', () => {
      const store = new WorldStore(this.options.worldPath)
      const inbox = new RoundInbox(this.options.worldPath)
      try {
        const stored = store.readManifest(address)
        if (stored === undefined) throw new Error('world branch has no active Compiled Manifest')
        const manifest = runtimeManifestFromStored(stored.manifest)
        this.#rulebooks.resolve(manifest.rulebook.rulebookId, manifest.rulebook.version, request.correlationId, address)
        if (!manifest.playerBindings.some(value => value.principalId === request.principalId)) {
          failWorld({
            errorCode: 'UNAUTHORIZED',
            category: 'admission',
            message: 'principal has no PlayerBinding in this world',
            retryable: false,
            correlationId: request.correlationId,
            address,
          })
        }
        const queued = inbox.enqueue(
          {
            address,
            idempotencyKey: request.idempotencyKey,
            principalId: request.principalId,
            input: request.action,
            correlationId: request.correlationId,
          },
          manifest.roundQueueLimit,
        )
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

  /** Execute one FIFO player input or accepted player Round, else return idle. */
  async processNextBranchWork(address: WorldAddress, correlationId: string): Promise<BranchWorkStep> {
    const input = await this.#queueNextPlayerInput(address, correlationId)
    if (input !== undefined)
      return {
        status: 'player_input',
        inputId: input.inputId,
        inputStatus: input.status,
        round: input.status === 'completed' ? parsePlayerRoundResult(input.records.completed!) : null,
      }
    return this.#integrityGuard(address, 'round.process', async branch => {
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

  async roundStatus(
    address: WorldAddress,
    lookup: { readonly idempotencyKey?: string; readonly roundId?: InteractionRoundId },
  ) {
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
    return this.#integrityGuard(address, 'round.cancel-queued', branch =>
      branch.store.inbox.cancelQueued(address, lookup, correlationId),
    )
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

  /** Current player options use the same Rulebook candidate snapshot as command interpretation. */
  async playerAffordancesForPrincipal(
    address: WorldAddress,
    principalId: string,
    characterId: CharacterId,
    asOfWorldSeq?: number,
  ): Promise<readonly ActionAffordance[]> {
    assertProtocolString(principalId, 'principalId')
    return this.#integrityGuard(address, 'view.affordances', branch => {
      const record = branch.store.store.readManifest(address)
      if (record === undefined) throw new Error('active world has no Manifest')
      const manifest = runtimeManifestFromStoredRecord(record)
      if (
        !manifest.playerBindings.some(
          binding => binding.principalId === principalId && binding.characterId === characterId,
        )
      ) {
        failWorld({
          errorCode: 'UNAUTHORIZED',
          category: 'admission',
          message: 'principal is not bound to the requested affordances',
          retryable: false,
          correlationId: `affordances:${principalId}:${characterId}`,
          address,
        })
      }
      const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
      const resolver = this.#rulebooks.resolve(
        manifest.rulebook.rulebookId,
        manifest.rulebook.version,
        `affordances:${principalId}:${characterId}`,
        address,
      )
      return resolver.affordances({
        manifest,
        events: branch.store.store.readEvents(address, asOf),
        characterId,
        manifestHash: record.manifestHash,
        asOfWorldSeq: asOf,
        resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
      })
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
      if (
        !manifest.playerBindings.some(
          binding => binding.principalId === principalId && binding.characterId === characterId,
        )
      ) {
        failWorld({
          errorCode: 'UNAUTHORIZED',
          category: 'admission',
          message: 'principal is not bound to the requested CharacterView',
          retryable: false,
          correlationId: `view:${principalId}:${characterId}`,
          address,
        })
      }
      return this.#projectionRead(address, `view:${worldAddressKey(address)}:${characterId}`, () => {
        const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
        return new CharacterViewBuilder(branch.store.store).rebuildAt(address, characterId, asOf)
      })
    })
  }

  async deliver(address: WorldAddress, correlationId: string): Promise<number> {
    try {
      return await this.#integrityGuard(address, 'outbox.drain', branch => branch.store.drainCritical(correlationId))
    } catch (error: unknown) {
      this.runtimeMetrics.recordSessionDeliveryFailure()
      throw error
    }
  }

  /** Yield only the writer lease; the next application operation resumes the same branch components. */
  async yieldWriter(address: WorldAddress): Promise<void> {
    const pending = this.#branches.get(worldAddressKey(address))
    if (pending === undefined) return
    const branch = await pending
    branch.kernel.yieldWriter()
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
    await Promise.all(
      pending.map(branch =>
        branch.then(
          value => value.lease.dispose(),
          () => undefined,
        ),
      ),
    )
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
        errorCode: 'PROJECTION_INVARIANT_FAILED',
        category: 'integrity',
        message: `Projection rebuild failed: ${String(error)}`,
        retryable: false,
        correlationId,
        address,
      })
    }
  }

  async #branch(address: WorldAddress): Promise<MountedBranch> {
    this.#assertOpen()
    const key = worldAddressKey(address)
    const current = this.#branches.get(key)
    if (current !== undefined) {
      const branch = await current
      try {
        branch.kernel.resumeWriter()
        return branch
      } catch (error) {
        await this.release(address)
        throw error
      }
    }
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
    if (
      !(components.kernel instanceof RoundCoordinator) ||
      !(components.store instanceof BranchStoreComponent) ||
      !(components.agents instanceof BranchAgentComponent) ||
      !(components.presentation instanceof BranchPresentationComponent)
    ) {
      await lease.dispose()
      throw new Error('Branch Component Factory returned an incompatible component set')
    }
    return {
      lease,
      kernel: components.kernel,
      store: components.store,
      agents: components.agents,
      presentation: components.presentation,
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('WorldApplication is closed')
  }
}
