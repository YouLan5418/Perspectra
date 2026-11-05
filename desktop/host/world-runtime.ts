import { createWorldCast } from './world-cast.ts'
import { AutonomyRuntime } from './autonomy-runtime.ts'
import { CommunicationRuntime } from './communication-runtime.ts'
import { guardedCommunication, guardedAutonomy, guardedPacing, guardedStatus } from './gameplay-services.ts'
import type {
  ActivitiesInstance,
  AutonomyInstance,
  CommunicationInstance,
  KnowledgeInstance,
  PacingInstance,
  PacingSource,
  SeamProvider,
  StatusInstance,
} from '@harness-world/plugin-sdk'
import { loadAutonomySource, loadCommunicationSource } from './gameplay-source.ts'
import { guardedActivities } from './activity-service.ts'
import { loadActivitySource } from './activity-source.ts'
import { loadStatusSource } from './status-source.ts'
import { loadPacingSource } from './pacing-source.ts'
import { PacingRuntime } from './pacing-runtime.ts'
import { StatusRuntime } from './status-runtime.ts'
import { loadKnowledgeSource } from './knowledge-source.ts'
import { assembleRoleplay, officialWorldOrder, type WorldComposition } from '../official-bundle.ts'
import { RequestInspector, type ChatCallObservation, type ChatProvider } from '@harness-world/provider-chat'
import { CreatorRecords, type CreatorRecordsQuery } from './creator-records.ts'
import { type CreatorHistoryQuery } from './creator-history.ts'
import { type CreatorInspectionQuery, type CreatorInspectionSnapshot } from './creator-inspection.ts'
import {
  currentLocation,
  RulebookRegistry,
  type ActionAffordance,
  type CompiledWorldManifest,
} from '@harness-world/kernel'
import {
  playSettings,
  DEFAULT_READING,
  DEFAULT_AUDIO,
  type PlaySettings,
  type ReadingPreferences,
  type AudioPreferences,
} from '../play-settings.ts'
import type { RuntimeRoleModels } from '../model-connections.ts'
import { TailRoundRuntime } from './tail-runtime.ts'
import { assertSettled, snapshotTail } from '../tail-storage.ts'
import {
  CharacterTurn,
  CharacterLoopError,
  characterVisibleItems,
  recentExecutionContext,
  createSchedulerRound,
  SceneDecisionService,
  WorldApplication,
  type ActivationTurn,
  type CharacterTurnRequest,
  type CharacterTurnResult,
} from '@harness-world/application'
import { saveStoryNode, readStoryNodes } from '../story-nodes.ts'
import { existsSync, unlinkSync } from 'node:fs'
import { activityWorldFromEvents, type ActivityWorld } from '@harness-world/application'
import type { ActivityRequest } from '@harness-world/contracts'
import {
  guardedDecision,
  guardedLlm,
  runDecision,
  wrapDecision,
  type DecisionParts,
  type ReportPluginFailure,
} from './character-decision.ts'
import { guardedRules, layeredCoreRules } from './rule-layers.ts'
import { WorldAdapters } from './world-adapters.ts'
import { pluginSetChanges, readPluginSet, writePluginSet } from './plugin-set.ts'
import { creatorHistorySnapshot, creatorInspectionSnapshot, type CreatorQueryHost } from './creator-queries.ts'
import { routeGameplayInput } from './player-input.ts'
import { projectStatus, withMessageActions } from './gameplay-projection.ts'
import { createActivityRound } from './activity-round.ts'
import { createAutonomyRound } from './autonomy-round.ts'
import {
  activityNotice,
  autonomyNotice,
  playerResolutionNotice,
  reactionNotice,
  type RoundStatus,
} from './round-notices.ts'
export { providerFailureNotice } from './round-notices.ts'
import { ActivitiesRuntime } from './activities-runtime.ts'
import type { ActivityDefinitionView, AutoStartEvaluation } from '@harness-world/contracts'
import { pauseRounds } from '@harness-world/application'
import type { StatusDefinition, StatusOperation } from '@harness-world/contracts'
import type { AutonomousRole } from '@harness-world/contracts'
import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, relative, basename } from 'node:path'
import {
  brandId,
  interactionPackageDescription,
  resolutionAuthority,
  type CharacterId,
  type CharacterView,
  type StoredWorldEvent,
  type WorldJsonObject,
  type WorldAddress,
} from '@harness-world/contracts'
import {
  CharacterViewBuilder,
  CharacterRuntimeAvailabilityService,
  PlayerInputJobs,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { actionText, HostBusyError, isWait, type HostAction, type HostRuntime, type HostState } from './http-server.ts'
import { modelCharacters, playerTranscript, sceneChangedAt } from './player-transcript.ts'
import { DEFAULT_RUNTIME_TUNING, type RuntimeTuning } from './runtime-tuning.ts'
import { PackModules } from './pack-modules.ts'
import { CapabilitySession, type CapabilityCatalog } from '../host-capabilities.ts'
import { CORE_MEMORY_ID, llmTimeoutMs, type HostSeams, type ModelOptions } from '../official-bundle.ts'
import { normalizeSchedulerResult, trackSchedulerTurns } from './scheduler-result.ts'
import { createWorldReader } from './world-reader.ts'
import type {
  DecisionInstance,
  LlmInstance,
  LlmTransportInstance,
  MemoryInstance,
  RulesInstance,
  SchedulerInstance,
  SchedulerResult,
  SchedulerRound,
  WorldServices,
} from '@harness-world/plugin-sdk'

export interface WorldHostOptions extends Omit<ModelOptions, 'models' | 'playSettings'> {
  /** Opened as a regeneration candidate; told to plugins through WorldServices. */
  readonly candidate?: boolean
  readonly models: RuntimeRoleModels
  readonly playSettings?: PlaySettings
  readonly capabilities?: CapabilityCatalog
  /** The implementation in force for each replaceable seam; defaults to the official bundle. */
  readonly plugins?: Partial<HostSeams>
  /** Complete entry selection; omitted optional mechanisms stay disabled. Do not combine with plugins. */
  readonly composition?: WorldComposition
  /** Receives the player's transcript after each projection; read-only, it cannot affect the world. */
  readonly playerFeed?: { publish(transcript: HostState['transcript']): void }
  readonly dataDirectory: string
  /** The v5 Pack directory: the world the author wrote, compiled here with the Host's installed packages. */
  readonly packPath: string
  readonly reading?: ReadingPreferences
  readonly appearance?: 'system' | 'light' | 'dark'
  /** Expression names each character may pick per segment, from the pack's stage.json. */
  readonly stageExpressions?: Readonly<Record<string, readonly string[]>>
  readonly audio?: AudioPreferences
  readonly tuning?: RuntimeTuning
  readonly storyNodes?: boolean
  readonly storyParentNodeId?: string
  readonly worldVersion?: string
  readonly logicalDirectory?: string
  /** Experiment control for comparing the former wave scheduler with dynamic dispatch. */
  readonly serialScheduling?: boolean
  /** Measurement control: ordinary work stays dynamic, autonomy waits for it to finish. */
  readonly stagedAutonomy?: boolean
  /** Experiment only: one bounded decision after a pre-action publication; default off. */
  readonly continueAfterPublish?: boolean
  readonly beforeActionExpression?: boolean
  /** Read-only recent execution presentation; no planning calls or persistent strategy. */
  readonly recentExecutionEvidence?: boolean
}

export type WorldHostCoreOptions = WorldHostOptions & { readonly composition: WorldComposition }

/** Whether a Pack directory is a v5 source, which is the one this runtime plays. */
export function isV5SourcePackDirectory(packPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(resolve(packPath, 'worldpack.source.json'), 'utf8')) as {
      readonly sourceSchemaVersion?: string
    }
    return manifest.sourceSchemaVersion === 'worldpack-source/v5'
  } catch {
    return false
  }
}

/** Player submission commits first; ordinary NPC work then uses bounded dynamic dispatch. */

/** What one committed player input means for its turn: whether to go on, and whether anyone reacts. */
interface InputOutcome {
  readonly accepted: boolean
  readonly react: boolean
  readonly notice?: string
}

export class WorldHostCore implements HostRuntime {
  readonly #worldVersion: string
  readonly #options: WorldHostOptions
  readonly #records: CreatorRecords
  readonly #inspector: RequestInspector
  requestInspection(enabled?: boolean) {
    if (enabled === undefined) return this.#inspector.snapshot()
    this.#records.configure(enabled)
    return this.#inspector.configure(enabled)
  }
  creatorRecords(query: CreatorRecordsQuery = {}) {
    return this.#records.query(query, this.#inspector.enabled)
  }
  inheritCreatorBase(baseId: string, branchId: string): void {
    this.#records.inheritBase(baseId, branchId)
  }
  /** Read fresh for each query, so that it sees the world as it is now. */
  #creatorQueryHost(): CreatorQueryHost {
    return {
      closing: this.#closing,
      names: this.#names,
      dataDirectory: this.#dataDirectory,
      address: this.#address,
      locationNames: this.#locationNames,
      inspector: this.#inspector,
      activationCycle: this.#activationCycle,
      statusTruth: events => this.#gameplay.status?.truth(events),
      activityStates: events => this.#gameplay.activity?.debugStates(events) ?? [],
      pacing: () => this.#gameplay.pacing?.lastDecision ?? null,
      worldVersion: this.#worldVersion,
      title: this.#title,
      packHash: this.#packHash,
      storyParentNodeId: this.#storyParentNodeId,
      busy: this.#busy,
      paused: this.#paused,
      memory: this.#memory,
      memoryIsCore: this.#memoryIsCore,
      records: this.#records,
    }
  }
  creatorHistory(input: CreatorHistoryQuery = {}) {
    return creatorHistorySnapshot(this.#creatorQueryHost(), input)
  }
  creatorInspection(input: CreatorInspectionQuery = {}): CreatorInspectionSnapshot {
    return creatorInspectionSnapshot(this.#creatorQueryHost(), input)
  }
  readonly #application: WorldApplication
  readonly #address
  readonly #principalId: string
  readonly #playerId: CharacterId
  readonly #names: ReadonlyMap<string, string>
  /** Author-declared Entity labels. Entities without `name` are absent and fall back to entityId at the projection. */
  readonly #entityNames: ReadonlyMap<string, string>
  readonly #entities: ReturnType<typeof adaptCompiledWorldPack>['manifest']
  #items: NonNullable<HostState['items']> = []
  #actionLabels: Readonly<Record<string, string>> = {}
  readonly #title: string
  readonly #playerName: string
  readonly #npcNames: readonly string[]
  readonly #locationNames: ReadonlyMap<string, string>
  #model: string
  readonly #intentModel: string
  readonly #characterIds: readonly CharacterId[]
  #status!: StatusInstance
  #communication!: CommunicationInstance
  #autonomy!: AutonomyInstance
  #pacing: PacingInstance | undefined
  #pacingSource: PacingSource | undefined
  #communicationSource: import('@harness-world/plugin-sdk').CommunicationSource | undefined
  #autonomySource: import('@harness-world/plugin-sdk').AutonomySource | undefined
  #activities!: ActivitiesInstance
  #activitySource: import('@harness-world/plugin-sdk').ActivitySource | undefined
  #statusSource: import('@harness-world/plugin-sdk').StatusSource | undefined
  #knowledge!: KnowledgeInstance
  #knowledgeSource: import('@harness-world/plugin-sdk').KnowledgeSource | undefined
  #llm!: LlmInstance
  /** The modules actually in force, which can differ from what was asked for when a scheduler falls back. */
  readonly #modulesInForce: Record<string, { id: string; version: string }[]> = {}
  readonly #gameplay: WorldAdapters
  #decisions: DecisionInstance[] = []
  #ruleLayers: RulesInstance[] = []
  readonly #coreRegistry: RulebookRegistry
  #memory: MemoryInstance | undefined
  #memoryIsCore = false
  #memoryId = ''
  #capabilities: CapabilitySession | undefined
  #pluginsReady = false
  #roundHolds = 0
  /** Hand the current player transcript to subscribers; tail candidates call this once installed. */
  publishPlayerFeed(): void {
    this.#options.playerFeed?.publish(this.#transcript)
  }
  supportsHistoryRestore(): boolean {
    return !this.#capabilities?.externalEffects
  }
  /** Native capabilities can request a declared role's normal turn; no raw Context or model key crosses this API. */
  async requestCharacter(characterId: string, signal?: AbortSignal): Promise<WorldJsonObject> {
    return WorldStore.withEventReadCache(() => this.#requestCharacter(characterId, signal))
  }
  async #requestCharacter(characterId: string, signal?: AbortSignal): Promise<WorldJsonObject> {
    if (
      !this.#pluginsReady ||
      this.#closing ||
      !this.#gameplay.modules?.characters.has(characterId) ||
      characterId === this.#playerId
    )
      throw new TypeError('Character is not bound to this plugin session')
    if (this.#busy || this.#escaping || this.#paused || this.#roundHolds > 0)
      throw new HostBusyError('当前实例不能处理新的角色请求。')
    this.#beginWork()
    try {
      const before = (await this.#application.head(this.#address)).headSeq
      const result = await this.#activateCharacters(false, brandId(characterId, 'CharacterId'), signal)
      await this.#refresh()
      const expressions = this.#transcript
        .filter(line => line.seq > before && line.speakerId === characterId)
        .map(line => ({
          speaker: line.speaker,
          speakerId: characterId,
          text: line.text,
          ...(line.segments ? { segments: line.segments } : {}),
        }))
      return {
        status: result?.status ?? 'inactive',
        calls: result?.calls ?? 0,
        expressions: expressions as unknown as WorldJsonObject[],
      }
    } finally {
      this.#endWork()
    }
  }
  /** The pack's SMS contacts; the rule wraps the core resolver anew for every resolver chain. */
  #autonomyCycle: Record<string, unknown> | undefined
  /** The round's notice and error flag, for the code that runs rounds outside this class. */
  readonly #roundStatus: RoundStatus = {
    set: (notice, error) => {
      if (notice !== undefined) this.#notice = notice
      if (error !== undefined) this.#error = error
    },
  }
  #activityView: WorldJsonObject | undefined
  #activityViews: WorldJsonObject[] | undefined
  /** Whether the last refresh allowed a wait; polling must not reopen the store to ask. */
  #waitable = false
  #workDone: Promise<void> = Promise.resolve()
  #finishWork: (() => void) | undefined
  #escaping: Promise<HostState> | undefined
  #statusRoundError: string | undefined
  #autoStartError: string | undefined
  #activationCycle: SchedulerResult | undefined
  #scheduler!: SchedulerInstance
  #characterLoop!: import('@harness-world/plugin-sdk').CharacterLoopInstance
  #schedulerIsOfficial = true
  readonly #manifestVersion: number
  readonly #intentEnabled: boolean
  readonly #dataDirectory: string
  #packHash = ''
  #storyParentNodeId: string | null = null
  #savingNode = false
  #closing = false
  #abortedWork = false
  readonly #playSettings: PlaySettings
  readonly #tuning: RuntimeTuning
  #transcript: HostState['transcript'] = []
  #availableActions: NonNullable<HostState['availableActions']> = []
  #statusBar: HostState['statusBar']
  #statusTruth: HostState['statusTruth']
  #currentScene: NonNullable<HostState['world']['currentScene']> | undefined
  #debug: Record<string, unknown> = {}
  #busy = false
  #allowInterruption = false
  /** Roles whose scheduled activation is running; only the host status reads it. */
  readonly #running = new Map<string, number>()
  #paused = false
  #notice = ''
  #error = false
  #phaseLabel = '可以输入'
  #providerCalls = 0
  #lastCall: ChatCallObservation | null = null
  readonly #roleCalls = new Map<string, ChatCallObservation>()
  /** Which plugin failed each character's latest decision, for the player's notice. */
  readonly #pluginFailures = new Map<string, string>()
  readonly #pluginFailureCauses = new Map<string, unknown>()
  readonly #reportPlugin: ReportPluginFailure = (pluginId, characterId, error) => {
    // Preserve the source of this exception through context wrappers, but allow a new outer failure to replace it.
    if (this.#pluginFailures.has(characterId) && this.#pluginFailureCauses.get(characterId) === error) return
    this.#pluginFailureCauses.set(characterId, error)
    console.error(`[插件 ${pluginId}] 角色决策失败：`, error)
    this.#pluginFailures.set(characterId, pluginId)
  }
  #lastPlayerIntent: string | null = null
  #rootBeforeSeq = 0
  #continuationController: AbortController | undefined

  private constructor(
    options: WorldHostCoreOptions,
    compiled: ReturnType<typeof adaptCompiledWorldPack>,
    intentEnabled: boolean,
  ) {
    this.#options = { ...options, plugins: options.composition.mechanisms }
    this.#coreRegistry = layeredCoreRules(() => this.#ruleLayers, options.composition.interactionPackages)
    this.#worldVersion = options.worldVersion ?? randomUUID()
    this.#address = compiled.manifest.address
    this.#dataDirectory = options.dataDirectory
    const logicalRoot = options.logicalDirectory ?? options.dataDirectory
    this.#records = new CreatorRecords(logicalRoot, {
      address: this.#address,
      worldVersion: this.#worldVersion,
      branchId: relative(logicalRoot, options.dataDirectory).replaceAll('\\', '/') || '.',
      runId: randomUUID(),
    })
    this.#inspector = new RequestInspector(request => this.#records.save(request))
    this.#inspector.configure(this.#records.captureEnabled())
    this.#playSettings = playSettings(options.playSettings ?? {})
    const settings = this.#playSettings
    this.#tuning = options.tuning ?? {
      ...DEFAULT_RUNTIME_TUNING,
      maximumWaves: settings.maximumWaves,
      maximumNpcCalls: settings.maximumNpcCalls,
      maximumCallsPerCharacter: settings.maximumCallsPerCharacter,
      reactionDeadlineSeconds: settings.reactionDeadlineSeconds,
    }
    this.#manifestVersion = compiled.manifest.schemaVersion
    this.#intentEnabled = intentEnabled
    const binding = compiled.manifest.playerBindings[0]
    if (binding === undefined) throw new TypeError('world Pack has no PlayerBinding')
    this.#principalId = binding.principalId
    this.#playerId = binding.characterId
    this.#gameplay = new WorldAdapters({
      address: this.#address,
      playerId: this.#playerId,
      worldPath: resolve(options.dataDirectory, 'world.sqlite'),
      coreRules: () => this.#coreRules(),
    })
    this.#names = new Map(compiled.manifest.characters.map(character => [character.characterId, character.name]))
    this.#locationNames = new Map(compiled.manifest.locations.map(location => [location.locationId, location.name]))
    this.#entityNames = new Map(
      compiled.manifest.entities.flatMap(entity =>
        typeof (entity as { name?: unknown }).name === 'string'
          ? [[entity.entityId, (entity as { name: string }).name]]
          : [],
      ),
    )
    this.#title = compiled.manifest.metadata.title
    this.#entities = compiled.manifest
    this.#playerName = this.#names.get(this.#playerId) ?? this.#playerId
    const characters = modelCharacters(compiled.manifest, this.#playerId)
    this.#model = options.models.default.decision.model
    this.#intentModel = this.#model
    const timeoutMs = llmTimeoutMs(options, settings)
    this.#characterIds = characters.map(character => character.actorId)
    this.#npcNames = characters.map(character => character.name)
    // The Host's interpretation profile is a contract with the world, and its deadline ceiling is part of
    // it: a longer call deadline is the adapter's business, not something to state in the profile.
    const intentProfile = {
      version: 'player-intent-profile/v1' as const,
      providerId: 'chat-completions',
      modelId: this.#intentModel,
      maxOutputTokens: 1_024,
      timeoutMs: Math.min(timeoutMs, 60_000),
    }
    this.#application = new WorldApplication({
      interactionPackages: options.composition.interactionPackages,
      rulebooks: this.#coreRegistry,
      worldPath: resolve(options.dataDirectory, 'world.sqlite'),
      sessionPath: resolve(options.dataDirectory, 'session.sqlite'),
      memoryPath: resolve(options.dataDirectory, 'memory.sqlite'),
      contextPath: resolve(options.dataDirectory, 'context.sqlite'),
      // The world's model budget has to cover the interpreter's own output ceiling, or the Host refuses to
      // dispatch an interpretation at all: the profile states the ceiling, this is what pays for it.
      modelBudgetTokens: 8_192,
      leaseTtlMs: 180_000,
      // The interpreter is the Host's; whether the world wants it is the world's own declaration, and a
      // world that declared the legacy route simply keeps reading free text as speech.
      playerIntent: {
        profile: intentProfile,
        dispatch: async (request, profile, signal) => {
          if (!this.#llm.dispatch) throw new Error('当前模型通道不支持玩家意图解释。')
          return (await this.#llm.dispatch(request, profile as unknown as WorldJsonObject, signal)) as Awaited<
            ReturnType<ChatProvider['dispatch']>
          >
        },
      },
    })
  }

  #displayView(view: CharacterView): Promise<CharacterView> {
    return this.#llm.display ? this.#llm.display(view) : Promise.resolve(view)
  }

  /** One character decision: authorized context projection, preset, model call, format retry and optional audit. */
  async #decide(
    request: CharacterTurnRequest,
    signal: AbortSignal,
    reserveFormatRetry?: () => boolean,
    beforeModelCall?: () => void,
  ): Promise<unknown> {
    const characterId = String((request.context.character as WorldJsonObject).characterId)
    this.#roleCalls.delete(characterId)
    this.#pluginFailures.delete(characterId)
    this.#pluginFailureCauses.delete(characterId)
    for (const decision of this.#decisions) if (decision.context) request = await decision.context(request, signal)
    const parts: DecisionParts = {
      llm: this.#llm,
      memory: this.#memory,
      presetsPrepare: this.#options.plugins?.llm === undefined,
      simulate: visible => this.#gameplay.activity?.simulate(visible),
      spendCall: beforeModelCall ?? (() => {}),
      trace: (id, visible, source, raw) => {
        if (this.#inspector.enabled)
          this.#records.trace('decision', id, visible.decisionId ?? null, { source, value: raw as WorldJsonObject })
      },
    }
    const inner = async (visible: CharacterTurnRequest) => {
      const raw = await runDecision(parts, visible, signal, reserveFormatRetry)
      if (this.#closing || this.#abortedWork) throw new Error('角色任务世界版本已失效。')
      return raw
    }
    return wrapDecision(this.#decisions, inner, signal)(request)
  }

  static async create(options: WorldHostCoreOptions): Promise<WorldHostCore> {
    if (!options.composition?.mechanisms.scheduler || !options.composition.mechanisms.characterLoop)
      throw new TypeError('世界组合必须明确提供 scheduler 和 characterLoop')
    if (!options.composition.mechanisms.llm && !options.composition.modelChannel)
      throw new TypeError('世界组合必须明确提供模型通道或模型装配器')
    mkdirSync(resolve(options.dataDirectory), { recursive: true })
    const pack = (await compileWorldPackSource(
      resolve(options.packPath),
      options.composition.interactionPackages.map(interactionPackageDescription),
    )) as CompiledWorldPackV5
    const modules = PackModules.load(options.packPath, pack, options.capabilities)
    const compiled = adaptCompiledWorldPack(pack, {
      address: {
        tenantId: brandId('tenant:web-playtest', 'TenantId'),
        worldId: brandId(`world:web-playtest:${pack.packHash.slice(7, 23)}`, 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      },
      principalId: 'principal:web-playtest',
      sessionId: brandId('session:web-playtest', 'SessionId'),
    })
    const intentEnabled =
      (compiled.manifest as { readonly playerInputPolicy?: { readonly version: string } }).playerInputPolicy
        ?.version === 'player-intent/v1'
    const runtime = new WorldHostCore(options, compiled, intentEnabled)
    try {
      runtime.#communicationSource = loadCommunicationSource(options.packPath, pack)
      runtime.#autonomySource = loadAutonomySource(options.packPath, pack)
      runtime.#activitySource = loadActivitySource(options.packPath, pack)
      runtime.#knowledgeSource = loadKnowledgeSource(options.packPath, pack)
      runtime.#statusSource = loadStatusSource(options.packPath, pack, modules?.sources)
      runtime.#pacingSource = loadPacingSource(options.packPath, pack)
      const open = {
        knowledge: () => runtime.#openKnowledge(),
        status: () => runtime.#openStatus(),
        activities: () => runtime.#openActivities(),
        communication: () => runtime.#openCommunication(),
        autonomy: () => runtime.#openAutonomy(),
        pacing: () => runtime.#openPacing(),
        llm: () => runtime.#openLlm(),
        rules: () => runtime.#openRules(),
        memory: () => runtime.#openMemory(),
        decisions: () => runtime.#openDecisions(),
        scheduler: () => runtime.#openScheduler(),
        characterLoop: () => runtime.#openCharacterLoop(),
      }
      for (const service of officialWorldOrder) await open[service]()
      runtime.#packHash = pack.packHash
      runtime.#actionLabels = Object.fromEntries(
        [...pack.content.entities, ...pack.content.characters].flatMap(target =>
          (target.interactionBindings ?? []).flatMap(binding =>
            binding.label === undefined ? [] : [[binding.bindingId, binding.label]],
          ),
        ),
      )
      runtime.#storyParentNodeId = options.storyParentNodeId ?? null
      runtime.#gameplay.communication =
        runtime.#communication?.definition === undefined
          ? undefined
          : new CommunicationRuntime(
              runtime.#communication,
              compiled.manifest,
              runtime.#coreRules().resolve('builtin:speak-move', 2, 'communication', runtime.#address),
            )
      runtime.#gameplay.autonomy =
        runtime.#autonomySource === undefined
          ? undefined
          : new AutonomyRuntime(runtime.#autonomy!, runtime.#autonomySource, String(runtime.#playerId))
      const status =
        runtime.#statusSource === undefined
          ? undefined
          : new StatusRuntime(
              runtime.#status,
              pack.content.characters.map(character => character.characterId),
              pack.content.entities ?? [],
            )
      if (modules && status) modules.describe(status)
      runtime.#application.activate(compiled)
      runtime.#gameplay.modules = modules
      if (modules) {
        const scope = {
          address: runtime.#address,
          worldVersion: runtime.#worldVersion,
          requestCharacter: (characterId: string, signal?: AbortSignal) =>
            runtime.requestCharacter(characterId, signal),
        }
        runtime.#capabilities = options.capabilities
          ? await options.capabilities.attach(scope, modules.requirements)
          : await CapabilitySession.open(scope, modules.requirements, new Map(), () => {})
      }
      runtime.#gameplay.status = status
      if (modules) {
        modules.bind(status!, runtime.#capabilities!)
        status!.externalActions = modules
      }
      await status?.ensureInitial(resolve(runtime.#dataDirectory, 'world.sqlite'), runtime.#address, runtime.#playerId)
      runtime.#gameplay.activity =
        runtime.#activities === undefined
          ? undefined
          : ActivitiesRuntime.open(
              runtime.#activities,
              resolve(runtime.#dataDirectory, 'world.sqlite'),
              runtime.#address,
              runtime.#playerId,
              status,
              runtime.#coreRules(),
            )
      if (modules)
        runtime.#gameplay.activity?.setActionResolver((context, adjudicate) =>
          modules.resolveAction(
            context,
            resolve(runtime.#dataDirectory, 'world.sqlite'),
            runtime.#address,
            AbortSignal.any([AbortSignal.timeout(10000), runtime.#gameplay.activity!.signal]),
            adjudicate,
          ),
        )
      runtime.#gameplay.pacing =
        runtime.#pacing && (runtime.#pacing.managedActivities.length || runtime.#pacing.beats.length)
          ? new PacingRuntime({
              mechanism: runtime.#pacing,
              worldPath: resolve(runtime.#dataDirectory, 'world.sqlite'),
              address: runtime.#address,
              playerId: String(runtime.#playerId),
              activities: runtime.#gameplay.activity,
              status: runtime.#gameplay.status,
            })
          : undefined
      await runtime.#refresh()
      const rebuildPath = resolve(options.dataDirectory, 'rebuild-memory.json')
      if (existsSync(rebuildPath)) {
        const rebuild = JSON.parse(readFileSync(rebuildPath, 'utf8')) as {
          headSeq: number
          packHash: string
          memoryProvider?: string
        }
        if (rebuild.packHash !== pack.packHash) throw new Error('故事线记忆恢复需要原游戏包。')
        const head = await runtime.#application.head(runtime.#address)
        if (head.headSeq !== rebuild.headSeq) throw new Error('故事节点的世界前缀不一致。')
        // Restoring derived archives must not hold a world writer across file installation.
        await runtime.#application.release(runtime.#address)
        if (runtime.#memory?.restoreArchives) {
          const memoryPath = resolve(options.dataDirectory, 'core-memory.json')
          // Archives only mean something to the memory that wrote them; another one starts without them.
          const written = (rebuild.memoryProvider ?? CORE_MEMORY_ID) === runtime.#memoryId
          const archives =
            written && existsSync(memoryPath) ? (JSON.parse(readFileSync(memoryPath, 'utf8')) as WorldJsonObject) : {}
          if (!archives || typeof archives !== 'object' || Array.isArray(archives))
            throw new Error('故事节点记忆快照损坏。')
          runtime.#memory.restoreArchives(archives, runtime.#characterIds)
          runtime.#memory.snapshotAliases?.(runtime.#characterIds)
        }
        unlinkSync(rebuildPath)
      }
      if (
        options.storyNodes &&
        runtime.supportsHistoryRestore() &&
        readStoryNodes(options.logicalDirectory ?? options.dataDirectory).length === 0
      )
        await runtime.saveNode('首次保存节点')
      runtime.#notePluginSet()
      runtime.#pluginsReady = true
      if (runtime.#decisions.some(decision => decision.committed)) {
        const { headSeq } = await runtime.#application.head(runtime.#address)
        for (const decision of runtime.#decisions) decision.committed?.(headSeq)
      }
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  }

  /** The world this session serves, so a caller can read it back without re-deriving the address. */
  get packHash(): string {
    return this.#packHash
  }
  validateCognition(): void {
    this.#memory?.snapshotAliases?.(this.#characterIds)
  }
  get address(): WorldAddress {
    return this.#address
  }

  async state(): Promise<HostState> {
    const canInterrupt =
      this.#busy && this.#allowInterruption && !this.#abortedWork && !this.#paused && !this.#escaping && !this.#closing
    // The player waits only for roles in their own scene. Off-scene work never names its role.
    const present = new Set((this.#currentScene?.recipients ?? []).map(person => person.id))
    const running = [...this.#running.keys()]
    const responders = running.filter(id => present.has(id)).map(id => this.#names.get(id) ?? id)
    return {
      playerFeedback: { phase: this.#phaseLabel, message: this.#notice },
      busy: this.#busy,
      canInterrupt,
      background: canInterrupt && running.length > 0 && responders.length === 0,
      responders,
      paused: this.#paused,
      phaseLabel: this.#phaseLabel,
      notice: this.#notice,
      error: this.#error,
      transcript: this.#transcript,
      items: this.#items,
      ...(this.#waitable ? { canWait: true } : {}),
      playerSettings: {
        inputCharacters: this.#playSettings.playerInputCharacters,
        reading: this.#options.reading ?? DEFAULT_READING,
        audio: { ...(this.#options.audio ?? DEFAULT_AUDIO) },
        ...(this.#options.appearance ? { appearance: this.#options.appearance } : {}),
      },
      availableActions: this.#availableActions,
      actionLabels: this.#actionLabels,
      actionNames: Object.fromEntries(
        this.#availableActions.flatMap(a =>
          (a.interactions ?? []).flatMap(option => {
            const recipient = (option.arguments as WorldJsonObject | undefined)?.recipientId
            const target = (option.targetRef as WorldJsonObject | undefined)?.id
            return [recipient, target]
              .filter(
                (id): id is string => typeof id === 'string' && (this.#names.has(id) || this.#entityNames.has(id)),
              )
              .map(id => [id, this.#names.get(id) ?? this.#entityNames.get(id)!])
          }),
        ),
      ),
      ...(this.#gameplay.status
        ? {
            characterArguments: Object.fromEntries(
              this.#gameplay.status.operations
                .filter(op => op.characterParameters.length)
                .map(op => ['status:' + op.id, [...op.characterParameters]]),
            ),
          }
        : {}),
      ...(this.#memory?.backgroundState ? { memoryMaintenance: this.#memory.backgroundState() } : {}),
      ...(this.#activityView ? { activity: structuredClone(this.#activityView) } : {}),
      ...(this.#activityViews ? { activities: structuredClone(this.#activityViews) } : {}),
      ...(this.#statusBar ? { statusBar: structuredClone(this.#statusBar) } : {}),
      ...(this.#statusTruth?.length ? { statusTruth: structuredClone(this.#statusTruth) } : {}),
      world: {
        title: this.#title,
        playerName: this.#playerName,
        npcNames: this.#npcNames,
        ...(this.#currentScene === undefined ? {} : { currentScene: this.#currentScene }),
      },
      debug: {
        ...this.#debug,
        worldVersion: this.#worldVersion,
        provider: this.#options.models.default.decision.protocol,
        model: this.#model,
        intentModel: this.#intentModel,
        providerCalls: this.#providerCalls,
        paused: this.#paused,
        lastPlayerIntent: this.#lastPlayerIntent,
        playerInputMode: this.#intentEnabled ? 'command-controlled' : 'legacy-speech',
        lastProviderCall: this.#lastCall,
        ...(this.#statusRoundError === undefined ? {} : { statusRoundError: this.#statusRoundError }),
        ...(this.#autoStartError === undefined ? {} : { autoStartError: this.#autoStartError }),
        ...(this.#gameplay.status && Object.keys(this.#gameplay.status.policyErrors).length
          ? { statusPolicyError: this.#gameplay.status.policyErrors }
          : {}),
        ...Object.assign({}, ...this.#decisions.map(decision => decision.debug?.())),
      },
    }
  }

  /**
   * One player turn. A caller that is retrying an input the world already recorded passes that input's own
   * key: the store is idempotent by key, so the retry completes the queued input instead of adding another.
   */
  async submit(text: string, idempotencyKey?: string): Promise<HostState> {
    return this.turn([text], idempotencyKey)
  }

  /**
   * One player turn of several inputs, such as a line and an action. Each input is adjudicated and committed
   * on its own path; the characters react once, to all of them. An input that is not accepted drops the
   * inputs after it, so a line meant to follow a refused action is never said; what the earlier inputs
   * committed still gets its reactions. No inputs is waiting: the round passes, then those who act on their
   * own get their turn.
   */
  async turn(inputs: readonly string[], idempotencyKey?: string): Promise<HostState> {
    return WorldStore.withEventReadCache(() => this.#turn(inputs, idempotencyKey))
  }
  async #turn(inputs: readonly string[], idempotencyKey?: string): Promise<HostState> {
    if (this.#busy || this.#escaping || this.#closing) throw new HostBusyError('请等待当前行动完成。')
    if (this.#paused) {
      this.#notice = 'NPC 已暂停：这次输入没有提交。恢复后再试。'
      return this.state()
    }
    const inActivity = this.#gameplay.activity?.current()?.game.active === true
    if (!inputs.length && !this.#canWait()) throw new TypeError('现在不能静观。')
    for (const text of inputs) {
      if (inActivity && text.startsWith('/') && !text.startsWith('/act ') && !text.startsWith('/status '))
        throw new TypeError('活动期间禁止变量调试与未声明命令。')
      if (text.startsWith('/status ') && !this.#gameplay.status) throw new TypeError('本包没有状态脚本')
    }
    this.#beginWork()
    this.#error = false
    this.#notice = ''
    this.#activationCycle = undefined
    const base = idempotencyKey ?? (inActivity ? randomUUID() : `web-playtest:${randomUUID()}`)
    let failed = false
    try {
      this.#rootBeforeSeq = (await this.#application.head(this.#address)).headSeq
      if (!inputs.length) await this.#endStatusRound(true)
      let react = !inputs.length
      const notices: string[] = []
      for (const [index, text] of inputs.entries()) {
        let outcome: InputOutcome
        try {
          outcome = await this.#commitInput(text, inputs.length === 1 ? base : `${base}:${index}`, inActivity)
        } catch (error: unknown) {
          // A rule refusing a later input ends the turn here; the first input's refusal stays an error.
          if (index === 0 || !(error instanceof TypeError || error instanceof RangeError)) throw error
          notices.push(error.message)
          break
        }
        react ||= outcome.react
        if (outcome.notice !== undefined) notices.push(outcome.notice)
        if (!outcome.accepted) break
      }
      const committed = (await this.#application.head(this.#address)).headSeq > this.#rootBeforeSeq
      if (react) {
        await this.#refresh()
        await this.#activateCharacters(inActivity)
      }
      if (committed) await (inputs.length ? this.#endPlayerRound() : this.#autoStartActivity())
      if (notices.length) this.#notice = [...notices, this.#notice].filter(Boolean).join(' ')
    } catch (error: unknown) {
      failed = true
      throw error
    } finally {
      try {
        await (failed ? this.#refresh().catch(() => {}) : this.#refresh())
      } finally {
        this.#endWork()
      }
    }
    return this.state()
  }

  /** Commits one input without letting anyone react. `accepted` is false when the world refused or never took it. */
  async #commitInput(text: string, key: string, inActivity: boolean): Promise<InputOutcome> {
    await this.#application.yieldWriter(this.#address)
    const routed = await routeGameplayInput({
      gameplay: this.#gameplay,
      status: this.#roundStatus,
      worldPath: resolve(this.#dataDirectory, 'world.sqlite'),
      address: this.#address,
      playerId: this.#playerId,
      manifest: this.#entities,
      publicationCharacters: this.#playSettings.publicationCharacters,
      signal: this.#continuationController!.signal,
      text,
      key,
      inActivity,
    })
    if (routed) return routed
    this.#phaseLabel = text.startsWith('/') ? '正在执行命令' : '正在提交发言'
    this.#lastPlayerIntent = text.startsWith('/') ? 'command' : 'natural-language'
    try {
      const result = await this.#application.submitText(this.#address, {
        text,
        idempotencyKey: key,
        principalId: this.#principalId,
        correlationId: key,
      })
      // A clarification is a durable answer, not a failure: nothing was spent and the world did not move.
      if (result.status === 'service_failed') {
        this.#error = true
        if (result.reason === 'candidate_source_order_invalid') {
          this.#notice =
            '模型把你的动作按与原文不符的顺序排列，这次输入没有提交。原文已保留；可以拆成“先表现、再移动”两句重试。'
          this.#lastPlayerIntent = 'model-output-invalid'
        } else if (result.reason === 'invalid_response') {
          this.#notice = '模型返回的输入解释格式无效，这次输入没有提交。原文已保留；可以重试或拆成两句。'
          this.#lastPlayerIntent = 'model-output-invalid'
        } else {
          this.#notice = '模型服务暂时无法完成请求，这次输入没有提交。请检查服务可用性后重试；无需改写输入。'
          this.#lastPlayerIntent = 'service-failed'
        }
        return { accepted: false, react: false }
      }
      if (result.status === 'clarification_required') {
        this.#notice = `${result.reason}（这次命令没有提交；请检查命令参数，或用 /act 指定完整交互。）`
        this.#lastPlayerIntent = 'clarification'
        return { accepted: false, react: false }
      }
      const notice = this.#intentEnabled
        ? playerResolutionNotice(
            resolve(this.#dataDirectory, 'world.sqlite'),
            this.#address,
            key,
            result.result.headSeq,
          )
        : undefined
      return {
        accepted: result.result.status === 'accepted',
        react: true,
        ...(notice === undefined ? {} : { notice }),
      }
    } catch (error: unknown) {
      this.#error = true
      this.#notice = await this.#whatBecameOf(key)
      console.error('Game host turn failed:', error instanceof Error ? error.message : 'unknown error')
      throw error
    }
  }

  #beginWork(): void {
    if (this.#capabilities?.resultUnknown) throw new TypeError('外部执行结果尚未确认，请检查外部游戏后重新启动实例。')
    this.#allowInterruption = false
    this.#autonomyCycle = undefined
    this.#abortedWork = false
    this.#continuationController = new AbortController()
    this.#busy = true
    this.#phaseLabel = '正在提交操作'
    this.#workDone = new Promise<void>(done => {
      this.#finishWork = done
    })
  }
  #endWork(): void {
    this.#allowInterruption = false
    this.#busy = false
    this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
    this.#finishWork?.()
    this.#finishWork = undefined
  }
  async activityAction(request: ActivityRequest): Promise<HostState> {
    return WorldStore.withEventReadCache(() => this.#activityAction(request))
  }
  async #activityAction(request: ActivityRequest): Promise<HostState> {
    if (this.#busy || this.#escaping || this.#closing) throw new HostBusyError('请等待当前处理完成，或使用逃生按钮。')
    if (this.#paused) throw new TypeError('请先恢复 NPC，或使用逃生按钮。')
    if (!this.#gameplay.activity) throw new TypeError('本包没有安装游戏脚本。')
    this.#beginWork()
    this.#error = false
    try {
      this.#rootBeforeSeq = (await this.#application.head(this.#address)).headSeq
      await this.#application.yieldWriter(this.#address)
      const changed = await this.#gameplay.activity.apply(request)
      const committed = (await this.#application.head(this.#address)).headSeq > this.#rootBeforeSeq
      this.#notice = changed ? '游戏操作已提交。' : '已返回原提交结果，没有再次执行。'
      if (changed) {
        // Show the operation's result before the next participant spends its model call.
        const store = new WorldStore(resolve(this.#dataDirectory, 'world.sqlite'))
        try {
          await this.#projectCommitted(store)
        } finally {
          store.close()
        }
        await this.#activateCharacters(true)
        if (committed) await this.#endPlayerRound()
      }
    } finally {
      try {
        await this.#refresh()
      } finally {
        this.#endWork()
      }
    }
    return this.state()
  }
  /** The accepted player input's round is over: the status hook, then at most one author-conditioned activity start. */
  async #endPlayerRound(): Promise<void> {
    if (this.#capabilities?.resultUnknown) throw new TypeError('外部执行结果尚未确认，本轮不再自动推进。')
    await this.#endStatusRound()
    await this.#autoStartActivity()
  }
  /** Script and start-validation failures are recorded, not retried, and commit nothing; storage faults still throw. */
  async #autoStartActivity(): Promise<void> {
    if (
      (!this.#gameplay.activity && !this.#gameplay.pacing) ||
      this.#escaping ||
      this.#closing ||
      this.#paused ||
      this.#abortedWork
    )
      return
    await this.#application.yieldWriter(this.#address)
    let started = false,
      beatFrom: number | undefined
    try {
      if (this.#gameplay.pacing) ({ started, beatFrom } = await this.#gameplay.pacing.endOfRound(this.#rootBeforeSeq))
      else started = await this.#gameplay.activity!.autoStart()
      this.#autoStartError = undefined
    } catch (error: unknown) {
      if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error
      this.#autoStartError = error.message
    }
    // The participants get the same chance to react to the opening as after a manual start.
    if (started) await this.#activateCharacters(true)
    if (beatFrom !== undefined) {
      // Show what happened before anyone spends a model call on it; only this beat's observations wake characters.
      const store = new WorldStore(resolve(this.#dataDirectory, 'world.sqlite'))
      try {
        await this.#projectCommitted(store)
      } finally {
        store.close()
      }
      this.#rootBeforeSeq = beatFrom
      await this.#activateCharacters(false)
    }
  }
  /** The status hook runs once per accepted player round, recording (not retrying) a failure. */
  async #endStatusRound(pause = false): Promise<void> {
    if (!this.#gameplay.status || this.#escaping || this.#closing) return
    await this.#application.yieldWriter(this.#address)
    const result = await this.#gameplay.status.endRound(
      resolve(this.#dataDirectory, 'world.sqlite'),
      this.#address,
      this.#rootBeforeSeq,
      pause,
    )
    this.#statusRoundError = result.ok ? undefined : result.error
  }
  /** Rounds are kept by the status script, and a running activity has its own turns. */
  #canWait(): boolean {
    return this.#gameplay.status !== undefined && this.#gameplay.activity?.current()?.game.active !== true
  }
  async saveNode(title: string) {
    if (!this.supportsHistoryRestore()) throw new TypeError('当前宿主能力尚不支持外部状态配对保存。')
    if (this.#busy || this.#escaping || this.#closing || this.#paused)
      throw new HostBusyError('请等待当前行动完成并恢复 NPC 后保存节点。')
    this.#savingNode = true
    this.#beginWork()
    try {
      this.#memory?.cancelBackground?.()
      await this.#memory?.waitForBackground?.()
      await this.#application.deliver(this.#address, 'story-node:deliver')
      await this.#application.release(this.#address)
      const aliases = this.#memory?.snapshotAliases?.(this.#characterIds) ?? {}
      return await saveStoryNode(
        this.#dataDirectory,
        this.#address,
        this.#packHash,
        title,
        aliases,
        this.#storyParentNodeId,
        this.#options.logicalDirectory,
        this.#memory?.snapshotArchives?.(this.#characterIds) ?? {},
        this.#memoryId,
      )
    } finally {
      this.#savingNode = false
      this.#endWork()
    }
  }
  /** Automatic-start checks for the pack lens: the last round's, or recomputed now without starting anything. */
  autoStartEvaluations(mode: 'last' | 'now'): readonly AutoStartEvaluation[] {
    return (
      (mode === 'last' ? this.#gameplay.activity?.lastAutoStart() : this.#gameplay.activity?.evaluateAutoStart()) ?? []
    )
  }
  /** The author's status definition (statuses and operations) from the loaded status script, for the pack lens. */
  statusDefinition(): {
    readonly statuses: readonly StatusDefinition[]
    readonly operations: readonly StatusOperation[]
    readonly hasRoundHook: boolean
  } {
    return {
      statuses: this.#gameplay.status?.statuses ?? [],
      operations: this.#gameplay.status?.operations ?? [],
      hasRoundHook: this.#gameplay.status?.hasRoundHook ?? false,
    }
  }
  activityDefinitions(): readonly ActivityDefinitionView[] {
    return this.#gameplay.activity?.definitions() ?? []
  }
  /**
   * What a non-player character would be offered right now, for the pack lens: the same resolver chain and context
   * her turn request uses (core, communication, status policy, running activity), narrowed by her autonomy
   * whitelist when she is an autonomous role. Reads committed events only; nothing is resolved or written.
   */
  characterAffordances(characterId: string): readonly ActionAffordance[] {
    const path = resolve(this.#dataDirectory, 'world.sqlite')
    const store = new WorldStore(path)
    try {
      const stored = store.readManifest(this.#address)
      if (!stored) throw new Error('世界尚未初始化')
      const manifest = stored.manifest as CompiledWorldManifest
      const { rulebookId, version } = manifest.rulebook
      const base = this.#gameplay.rulebooks(path)
      const rules = this.#gameplay.autonomy?.roles.some(role => role.characterId === characterId)
        ? this.#gameplay.autonomy.rulebooks(base.resolve(rulebookId, version, 'lens', this.#address))
        : base
      return rules.resolve(rulebookId, version, 'lens', this.#address).affordances({
        manifest,
        manifestHash: stored.manifestHash,
        events: store.readEvents(this.#address),
        characterId,
        asOfWorldSeq: store.head(this.#address).headSeq,
        publicationCharacters: this.#playSettings.publicationCharacters,
        resolutionAuthority: resolutionAuthority('agent', 'standard'),
      })
    } finally {
      store.close()
    }
  }
  beginRoundRandom(values?: readonly number[]): void {
    this.#gameplay.activity?.beginRoundRandom(values)
    this.#gameplay.pacing?.beginRoundRandom(values)
  }
  /** Why the last round did or did not bring an event; for the creator's tools only. */
  pacingDecision() {
    return this.#gameplay.pacing?.lastDecision ?? null
  }
  roundRandom(): number[] {
    return this.#gameplay.activity?.roundRandom() ?? this.#gameplay.pacing?.roundRandom() ?? []
  }
  holdCognition(): void {
    this.#roundHolds++
    this.#memory?.holdInstallation?.()
  }
  releaseCognition(): void {
    this.#roundHolds = Math.max(0, this.#roundHolds - 1)
    this.#memory?.releaseInstallation?.()
  }
  #track(turn: ActivationTurn): ActivationTurn {
    return {
      run: (characterId, options) => {
        const id = String(characterId)
        this.#running.set(id, (this.#running.get(id) ?? 0) + 1)
        return turn.run(characterId, options).finally(() => {
          const left = (this.#running.get(id) ?? 1) - 1
          if (left > 0) this.#running.set(id, left)
          else this.#running.delete(id)
        })
      },
    }
  }
  abortWork(): void {
    this.#abortedWork = true
    this.#capabilities?.cancelPending()
    this.#continuationController?.abort()
  }
  async settleRound() {
    if (this.#busy || this.#escaping || this.#paused) throw new HostBusyError('当前玩家回合尚未完成。')
    await this.#application.deliver(this.#address, 'tail-round:deliver')
    await this.#application.yieldWriter(this.#address)
    return assertSettled(this.#dataDirectory, this.#address)
  }
  async snapshotRound(target: string): Promise<void> {
    await this.settleRound()
    const aliases = this.#memory?.snapshotAliases?.(this.#characterIds) ?? {}
    await snapshotTail(this.#dataDirectory, target, this.#address, aliases)
    this.#records.snapshotBase(basename(target))
  }
  async refreshMemory(): Promise<HostState> {
    if (this.#savingNode || this.#closing) throw new HostBusyError('正在保存节点。')
    if (!this.#memory?.startRefresh) throw new TypeError('本次运行没有开启 Core 记忆。')
    this.#memory.startRefresh(this.#characterIds)
    this.#notice = '长期记忆已开始后台整理，可以继续游玩。'
    return this.state()
  }
  async cancelMemory(): Promise<HostState> {
    this.#memory?.cancelBackground?.()
    this.#notice = '已取消未完成的后台整理；已安装档案和近期经历保留。'
    return this.state()
  }
  async waitForMemory(): Promise<void> {
    await this.#memory?.waitForBackground?.()
  }
  async escape(): Promise<HostState> {
    if (this.#savingNode || this.#closing) throw new HostBusyError('正在保存节点。')
    if (this.#escaping) return this.#escaping
    // Set the override before awaiting anything. Late model outputs are cancelled,
    // and the host waits for the in-flight writer to release its lease.
    this.#capabilities?.cancelPending()
    this.#continuationController?.abort()
    this.#escaping = (async () => {
      await this.#workDone
      await this.#application.release(this.#address)
      await this.#gameplay.activity?.escape()
      this.#paused = false
      this.#error = false
      this.#phaseLabel = '可以输入'
      this.#notice = '已逃离活动，恢复原本合法的交互能力；已经提交的经历保留。'
      await this.#refresh()
      return this.state()
    })()
    try {
      return await this.#escaping
    } finally {
      this.#escaping = undefined
    }
  }

  /** Structured UI choices remain proposals and follow the same Rulebook path as /act. */
  async perform(action: HostAction): Promise<HostState> {
    if (isWait(action)) return this.turn([])
    if (
      action.actionType === 'interact' &&
      (action.parameters.definitionRef as WorldJsonObject | undefined)?.id === 'host:activity-quick'
    ) {
      const operation = String(action.parameters.operation)
      const current = this.#gameplay.activity
        ?.views(this.#playerId)
        ?.find(view => view.activityKey === action.parameters.activityKey)
      if (!current || !(current.quickOperations as WorldJsonObject[] | undefined)?.some(op => op.id === operation))
        throw new TypeError('活动入口已失效，请刷新')
      return this.activityAction({
        activityKey: String(current.activityKey),
        activityId: null,
        revision: 0,
        operation,
        parameters: {},
        requestId: randomUUID(),
      })
    }
    if (
      action.actionType === 'interact' &&
      [
        'host:activity-start',
        'host:activity-retry',
        'host:activity-suspend',
        'host:activity-resume',
        'host:activity-abandon',
      ].includes(String((action.parameters.definitionRef as WorldJsonObject | undefined)?.id))
    ) {
      const current =
        action.parameters.activityKey === undefined
          ? this.#gameplay.activity?.view(this.#playerId)
          : this.#gameplay.activity
              ?.views(this.#playerId)
              .find(view => view.activityKey === action.parameters.activityKey)
      if (
        !current ||
        (current.id ?? null) !== action.parameters.previousId ||
        (current.revision ?? 0) !== action.parameters.previousRevision
      )
        throw new TypeError('活动入口已失效，请刷新')
      const operation = String((action.parameters.definitionRef as WorldJsonObject).id).slice('host:activity-'.length)
      if (operation !== 'start' && action.parameters.startParameters !== undefined)
        throw new TypeError('只有开始活动可选择参与者')
      const startParameters = action.parameters.startParameters
      if (
        startParameters !== undefined &&
        (!startParameters || typeof startParameters !== 'object' || Array.isArray(startParameters))
      )
        throw new TypeError('开始参数无效')
      return this.activityAction({
        activityKey: String(current.activityKey),
        activityId: operation === 'start' ? null : String(current.id),
        revision: operation === 'start' ? 0 : Number(current.revision),
        operation,
        parameters: (startParameters as WorldJsonObject | undefined) ?? {},
        requestId: randomUUID(),
      })
    }
    return this.submit(actionText(action))
  }
  /**
   * What actually became of an input whose turn failed.
   *
   * A turn can fail after the input was durably recorded - a Host that lost its writer lease while the page
   * sat idle, an interrupted process - and the durable input queue completes it later. Telling the player
   * to say it another way then invites a second submission, and the world does the same thing twice; so the
   * player is told the state instead. An input the world never received is the case where retrying is right.
   */
  async #whatBecameOf(idempotencyKey: string): Promise<string> {
    const jobs = new PlayerInputJobs(resolve(this.#dataDirectory, 'world.sqlite'))
    try {
      const job = jobs.read(this.#address, idempotencyKey)
      if (job === undefined) return '本轮失败，这条输入没有被世界受理；可以重新说一次。'
      return job.status === 'completed'
        ? '这一轮其实已经完成了，请看转录。'
        : `你的输入已被世界记录（状态 ${job.status}），它会在世界能写入时完成——请不要重发。`
    } catch {
      return '本轮失败，详情只保留在本机终端。'
    } finally {
      jobs.close()
    }
  }

  async pause(): Promise<HostState> {
    this.#paused = true
    this.#capabilities?.cancelPending()
    this.#continuationController?.abort()
    this.#notice = 'NPC 已暂停：暂停期间的输入不会推进世界。'
    return this.state()
  }

  async resume(): Promise<HostState> {
    this.#paused = false
    this.#notice = '已恢复。'
    this.#phaseLabel = '可以输入'
    await this.#refresh().catch(() => {})
    return this.state()
  }

  async close(): Promise<void> {
    this.#closing = true
    this.#pluginsReady = false
    const closingCapabilities = this.#capabilities?.close()
    this.#inspector.configure(false)
    this.#continuationController?.abort()
    this.#gameplay.activity?.close()
    const closingMemory = (async () => this.#memory?.close?.())().catch(error =>
      console.error('[记忆] 关闭失败：', error),
    )
    await this.#workDone
    await closingCapabilities
    await closingMemory
    try {
      await this.#scheduler?.close?.()
    } catch (error) {
      console.error('[调度器插件] 关闭失败：', error)
    }
    try {
      await this.#characterLoop?.close?.()
    } catch (error) {
      console.error('[角色循环插件] 关闭失败：', error)
    }
    try {
      await this.#llm?.close?.()
    } catch (error) {
      console.error('[模型通道插件] 关闭失败：', error)
    }
    try {
      await this.#knowledge?.close?.()
    } catch (error) {
      console.error('[知识机制] 关闭失败：', error)
    }
    for (const [name, instance] of [
      ['通信', this.#communication],
      ['自主', this.#autonomy],
      ['节奏', this.#pacing],
    ] as const) {
      try {
        await instance?.close?.()
      } catch (error) {
        console.error(`[${name}机制] 关闭失败：`, error)
      }
    }
    try {
      await this.#activities?.close?.()
    } catch (error) {
      console.error('[活动机制] 关闭失败：', error)
    }
    try {
      await this.#status?.close?.()
    } catch (error) {
      console.error('[状态机制] 关闭失败：', error)
    }
    for (const layer of [...this.#ruleLayers].reverse()) {
      try {
        await layer.close?.()
      } catch (error) {
        console.error('[规则插件] 关闭失败：', error)
      }
    }
    for (const decision of [...this.#decisions].reverse()) {
      try {
        await decision.close?.()
      } catch (error) {
        console.error('[决策插件] 关闭失败：', error)
      }
    }
    try {
      await this.#application.close()
    } finally {
      this.#gameplay.activity?.close()
    }
  }

  #coreRules(): RulebookRegistry {
    return this.#coreRegistry
  }

  async #activateCharacters(
    activityOnly = false,
    requestedCharacter?: CharacterId,
    requestSignal?: AbortSignal,
  ): Promise<CharacterTurnResult | undefined> {
    await this.#application.yieldWriter(this.#address)
    if (this.#escaping || this.#closing || this.#abortedWork) return
    const path = resolve(this.#dataDirectory, 'world.sqlite')
    const store = new WorldStore(path),
      leases = new WriterLeaseService(path)
    const availability = new CharacterRuntimeAvailabilityService(path)
    this.#continuationController = new AbortController()
    try {
      if (this.#paused) return
      const createTurn = this.#turnFactory(path, store, leases, availability)
      const turn = createTurn()
      if (requestedCharacter)
        return await turn.run(requestedCharacter, {
          signal: requestSignal
            ? AbortSignal.any([requestSignal, this.#continuationController.signal])
            : this.#continuationController.signal,
          maxCalls: 2,
          maxModelCalls: this.#playSettings.maximumNpcCalls,
        })
      this.#phaseLabel = '角色正在处理场景与行动结果'
      const active = this.#gameplay.activity?.current()
      const due =
        this.#playSettings.autonomyOpportunities === 0
          ? []
          : (
              this.#gameplay.autonomy?.due(
                store,
                this.#address,
                this.#playerId,
                this.#rootBeforeSeq,
                store.head(this.#address).headSeq,
              ) ?? []
            )
              // Activity owns its participants' opportunities; autonomy never takes over its turn.
              .filter(role => !active?.game.active || !active.participants.includes(role.characterId))
      let activityTurns = 0
      const trackedActivityTurn = this.#track(turn)
      const activity = createActivityRound({
        activity: this.#gameplay.activity,
        settings: this.#playSettings,
        address: this.#address,
        signal: this.#continuationController.signal,
        store,
        turn: {
          run: (id, options) => {
            activityTurns++
            return trackedActivityTurn.run(id, options)
          },
        },
        world: this.#worldReader(),
        resultUnknown: () => this.#capabilities?.resultUnknown === true,
      })
      if (activity) {
        const result = await this.#scheduleRound(activity)
        activityNotice(this.#roundStatus, result)
        if (
          !this.#schedulerIsOfficial &&
          activityTurns === 0 &&
          activity.activity?.next() !== undefined &&
          !this.#continuationController.signal.aborted &&
          !['plugin_failed', 'plugin_invalid', 'interrupted', 'result_unknown'].includes(result.terminalReason)
        ) {
          this.#notice = '当前调度器本次未安排活动角色处理，活动停留在当前轮次；可再次请求处理或更换调度器。'
          return
        }
        if (['plugin_failed', 'plugin_invalid'].includes(result.terminalReason) || this.#capabilities?.resultUnknown)
          return
      }
      this.#allowInterruption = !this.#gameplay.activity?.current()?.game.active
      if (activityOnly) {
        await this.#autonomousRound(store, createTurn, due, new Map())
        return
      }
      await this.#runSceneReactions(store, turn, createTurn, due, active)
    } finally {
      this.#allowInterruption = false
      availability.close()
      leases.close()
      store.close()
      this.#continuationController = undefined
      if (!this.#paused && !this.#escaping) this.#memory?.startPending?.()
    }
  }

  /** Build CharacterTurns that share this activation's store handles; `autonomous` swaps in the autonomy rules and prompt. */
  #turnFactory(
    path: string,
    store: WorldStore,
    leases: WriterLeaseService,
    availability: CharacterRuntimeAvailabilityService,
  ): (autonomous?: boolean) => CharacterTurn {
    const contextWindow = this.#decisions.find(decision => decision.shortTermAfterSeq)?.shortTermAfterSeq
    return (autonomous = false) => {
      const base = this.#gameplay.rulebooks(path)
      return new CharacterTurn({
        loop: this.#characterLoop,
        onLoopFailure: (characterId, error) =>
          this.#reportPlugin(this.#options.plugins!.characterLoop!.id, characterId, error),
        publicationCharacters: this.#playSettings.publicationCharacters,
        activationTimeoutMs: this.#playSettings.activationTimeoutSeconds * 1000,
        address: this.#address,
        store,
        leases,
        availability,
        rulebooks: autonomous
          ? this.#gameplay.autonomy!.rulebooks(base.resolve('builtin:speak-move', 2, 'autonomy', this.#address))
          : base,
        decide: (request, signal, reserveFormatRetry, beforeModelCall) =>
          this.#decide(request, signal, reserveFormatRetry, beforeModelCall),
        onTrace: (kind, characterId, decisionId, data) => {
          if (this.#inspector.enabled) this.#records.trace(kind, characterId, decisionId, data)
        },
        continueAfterPublish:
          (this.#options.continueAfterPublish === true || this.#playSettings.continueAfterPublish === 1) &&
          !this.#gameplay.activity?.current()?.game.active &&
          !this.#serialDecisions,
        beforeActionExpression:
          this.#options.beforeActionExpression === true &&
          !this.#gameplay.activity?.current()?.game.active &&
          !this.#serialDecisions,
        onCommitted: async () => {
          this.#gameplay.modules?.committed()
          await this.#projectCommitted(store)
        },
        onActionFailure: () => this.#gameplay.modules?.failed(),
        allowUnrelatedCommits:
          !this.#options.serialScheduling && !this.#gameplay.activity?.current()?.game.active && !this.#serialDecisions,
        projectContext: (context: WorldJsonObject, canPerform: boolean) =>
          this.#gameplay.projectContext(context, canPerform, autonomous),
        ...this.#gameplay.turnOptions(path),
        ...(contextWindow === undefined ? {} : { shortTermAfterSeq: contextWindow }),
        recentObservations: this.#tuning.recentObservations,
        recentSelfObservations: this.#tuning.recentSelfObservations,
      })
    }
  }

  /** One bounded wave cycle for everyone who observed the committed input, then any autonomy left due. */
  async #runSceneReactions(
    store: WorldStore,
    turn: CharacterTurn,
    createTurn: (autonomous?: boolean) => CharacterTurn,
    due: AutonomousRole[],
    active: ReturnType<ActivitiesRuntime['current']> | undefined,
  ): Promise<void> {
    const controller = this.#continuationController!
    const dynamic =
      !this.#options.serialScheduling && !this.#gameplay.activity?.current()?.game.active && !this.#serialDecisions
    const { autonomy, ...cycle } = await this.#schedule({
      store,
      address: this.#address,
      turn: this.#track(turn),
      afterSeq: this.#rootBeforeSeq,
      characterIds: this.#characterIds.filter(
        id => !due.some(role => role.characterId === id) && (!active?.game.active || !active.participants.includes(id)),
      ),
      signal: controller.signal,
      presentCharacterIds: () =>
        (this.#currentScene?.recipients ?? []).map(person => brandId(person.id, 'CharacterId')),
      allowConcurrent: dynamic,
      locationId: (id: CharacterId) => currentLocation(store.readEvents(this.#address), id) ?? null,
      ...(due.length > 0
        ? {
            autonomy: {
              staged: this.#options.stagedAutonomy === true,
              turn: this.#track(createTurn(true)),
              roles: due.map(role => ({
                characterId: role.characterId,
                opportunities: Math.min(role.opportunities, this.#playSettings.autonomyOpportunities),
              })),
              maximumNpcCalls: this.#playSettings.autonomyNpcCalls,
              deadlineSeconds: this.#playSettings.autonomyDeadlineSeconds,
              reactionLimits: {
                maximumWaves: this.#playSettings.autonomyReactionWaves,
                maximumNpcCalls: this.#playSettings.autonomyReactionCalls,
                maximumCallsPerCharacter: this.#playSettings.maximumCallsPerCharacter,
                reactionDeadlineSeconds: this.#playSettings.autonomyDeadlineSeconds,
              },
            },
          }
        : {}),
      limits: this.#tuning,
    })
    this.#activationCycle = cycle
    this.#autonomyCycle = autonomy
    reactionNotice(this.#roundStatus, cycle, this.#roleCalls, this.#pluginFailures)
    if (autonomy) autonomyNotice(this.#roundStatus, autonomy.terminalReason)
  }

  #services(id: string): WorldServices {
    return {
      address: this.#address,
      worldVersion: this.#worldVersion,
      dataDirectory: resolve(this.#dataDirectory, 'plugins', id),
      instanceDirectory: resolve(this.#dataDirectory),
      candidate: this.#options.candidate === true,
      cast: createWorldCast(this.#entities, String(this.#playerId), this.#characterIds),
      world: this.#worldReader(),
      contextSources: {
        memory: async (request, signal) => {
          try {
            if (!this.#memory) return request
            return await this.#memory.project(request, signal)
          } catch (error) {
            if (!signal.aborted)
              this.#reportPlugin(
                this.#memoryId!,
                String((request.context.character as WorldJsonObject).characterId),
                error,
              )
            throw error
          }
        },
        memoryAfterSeq: actor => this.#memory?.shortTermAfterSeq?.(actor),
        recentExecution: async request =>
          this.#options.recentExecutionEvidence === true
            ? { ...request, context: recentExecutionContext(request.context) }
            : request,
        status: async request =>
          this.#gameplay.statusContext(request, String((request.context.character as WorldJsonObject).characterId)),
        knowledge: async request => {
          try {
            const selected = this.#knowledge?.select(request.context)
            return selected === undefined
              ? request
              : { ...request, context: { ...request.context, knowledge: selected } }
          } catch (error) {
            this.#reportPlugin(
              this.#options.plugins!.knowledge!.id,
              String((request.context.character as WorldJsonObject).characterId),
              error,
            )
            throw error
          }
        },
        expressions: async request => {
          const characterId = String((request.context.character as WorldJsonObject).characterId)
          const expressions = this.#options.stageExpressions?.[characterId]
          return expressions?.length
            ? { ...request, context: { ...request.context, expressions: [...expressions] } }
            : request
        },
      },
    }
  }

  /** Tells the player when this save's modules changed since it last ran. Worth a notice, never worth refusing the
   * save, and a candidate is not the save itself. */
  #notePluginSet(): void {
    if (this.#options.candidate) return
    const directory = this.#options.logicalDirectory ?? this.#dataDirectory
    const current = { seams: this.#modulesInForce }
    const changes = pluginSetChanges(readPluginSet(directory), current)
    if (changes.length)
      this.#notice = [this.#notice, `这个存档使用的模块变了：${changes.join('；')}。世界事实不受影响。`]
        .filter(Boolean)
        .join(' ')
    if (this.#memory?.shortTermAfterSeq && !this.#decisions.some(decision => decision.shortTermAfterSeq))
      this.#notice = [this.#notice, '记忆扩充已被替换或停用，当前使用近期观察窗口；长期记忆交付由所选扩充实现负责。']
        .filter(Boolean)
        .join(' ')
    try {
      writePluginSet(directory, current)
    } catch (error) {
      console.error('[模块记录] 写入失败：', error)
    }
  }

  /** A player's story must not silently go to a different model, so a channel that cannot open stops the world. */
  async #openLlm(): Promise<void> {
    const full = this.#options.plugins?.llm
    const adapter = this.#options.plugins?.llmTransport
    if (full && adapter) throw new TypeError('完整模型通道与发送适配器不能同时启用。')
    let transport: LlmTransportInstance | undefined
    try {
      if (adapter) {
        transport = await adapter.open(this.#services(adapter.id), AbortSignal.timeout(30_000))
        if (
          !transport ||
          typeof transport.model !== 'string' ||
          !transport.model.trim() ||
          !['native', 'gateway'].includes(transport.schemaMode) ||
          typeof transport.send !== 'function'
        )
          throw new TypeError('发送适配器须声明 model、schemaMode 与 send')
      }
      const provider =
        full ??
        this.#options.composition!.modelChannel!({
          ...this.#options,
          settings: this.#playSettings,
          inspector: this.#inspector,
          ...(adapter && transport
            ? {
                transport: {
                  id: adapter.id,
                  instance: transport,
                  failure: (characterId: string, error: unknown) => this.#reportPlugin(adapter.id, characterId, error),
                },
              }
            : {}),
          onCall: observation => {
            this.#providerCalls++
            this.#lastCall = observation
          },
          onRoleCall: (characterId, observation) => {
            this.#roleCalls.set(characterId, observation)
          },
        })
      const opened = await provider.open(this.#services(provider.id), AbortSignal.timeout(30_000))
      this.#modulesInForce.llm = [
        { id: provider.id, version: provider.version },
        ...(adapter ? [{ id: adapter.id, version: adapter.version }] : []),
      ]
      this.#llm = full ? guardedLlm(opened, provider.id, this.#reportPlugin) : opened
      if (transport) this.#model = transport.model
    } catch (error) {
      await transport?.close?.()
      if (!full && !adapter) throw error
      throw new Error(
        `模型通道组合 ${full?.id ?? 'official-llm + ' + adapter!.id} 无法打开：${(error as Error).message}`,
        { cause: error },
      )
    }
  }

  /** A rule the player chose must hold, so one that cannot open stops the world. */
  async #openRules(): Promise<void> {
    for (const provider of this.#options.plugins?.rules ?? []) {
      try {
        const opened = await provider.open(this.#services(provider.id), AbortSignal.timeout(30_000))
        this.#ruleLayers.push(guardedRules(opened, provider.id, this.#reportPlugin))
        ;(this.#modulesInForce.rules ??= []).push({ id: provider.id, version: provider.version })
      } catch (error) {
        throw new Error(`规则插件 ${provider.id} 无法打开：${(error as Error).message}`, { cause: error })
      }
    }
  }

  /** Whoever asked to take part in decisions expects to, so one that cannot open stops the world. */
  async #openDecisions(): Promise<void> {
    for (const provider of this.#options.plugins!.decisions ?? []) {
      try {
        const opened = await provider.open(this.#services(provider.id), AbortSignal.timeout(30_000))
        if (
          opened.shortTermAfterSeq &&
          ((!opened.context && !opened.decide) || this.#decisions.some(decision => decision.shortTermAfterSeq))
        ) {
          await opened.close?.()
          throw new TypeError('a memory cutoff requires a single delivery implementation')
        }
        this.#decisions.push(guardedDecision(opened, provider.id, this.#reportPlugin))
        ;(this.#modulesInForce.decisions ??= []).push({ id: provider.id, version: provider.version })
      } catch (error) {
        throw new Error(`决策插件 ${provider.id} 无法打开：${(error as Error).message}`, { cause: error })
      }
    }
  }

  get #serialDecisions(): boolean {
    return this.#decisions.some(decision => decision.serial)
  }

  /** One selected mechanism for this world: pass its declared source, validate it, and close it if that fails. */
  async #openMechanism<T>(input: {
    readonly name: 'communication' | 'autonomy' | 'activities' | 'status' | 'knowledge' | 'pacing'
    readonly label: string
    readonly sourceKey: string
    readonly source: object | undefined
    /** A world that declares this source cannot run without the mechanism. */
    readonly required: boolean
    /** Assigned twice: the raw instance first, so a failing guard still leaves it to be closed. */
    readonly assign: (instance: T) => void
    readonly guard: (instance: T, id: string) => T
  }): Promise<void> {
    const { name, source } = input
    const provider = this.#options.plugins![name] as unknown as SeamProvider<T> | undefined
    if (!provider) {
      if (input.required && source !== undefined) throw new TypeError(`世界声明的 ${name} 需要对应机制`)
      return
    }
    try {
      const opened = await provider.open(
        {
          ...this.#services(provider.id),
          ...(source === undefined ? {} : { [input.sourceKey]: structuredClone(source) }),
        },
        AbortSignal.timeout(30_000),
      )
      input.assign(opened)
      input.assign(input.guard(opened, provider.id))
      this.#modulesInForce[name] = [{ id: provider.id, version: provider.version }]
    } catch (cause) {
      throw new Error(
        `${input.label}机制 ${provider.id} 无法打开：${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
  }
  #openCommunication(): Promise<void> {
    return this.#openMechanism<CommunicationInstance>({
      name: 'communication',
      label: '通信',
      sourceKey: 'communicationSource',
      source: this.#communicationSource,
      required: true,
      assign: instance => (this.#communication = instance),
      guard: (instance, id) =>
        guardedCommunication(instance, this.#communicationSource !== undefined, id, this.#reportPlugin),
    })
  }
  #openAutonomy(): Promise<void> {
    return this.#openMechanism<AutonomyInstance>({
      name: 'autonomy',
      label: '自主',
      sourceKey: 'autonomySource',
      source: this.#autonomySource,
      required: true,
      assign: instance => (this.#autonomy = instance),
      guard: (instance, id) => guardedAutonomy(instance, this.#autonomySource !== undefined, id, this.#reportPlugin),
    })
  }
  #openPacing(): Promise<void> {
    return this.#openMechanism<PacingInstance>({
      name: 'pacing',
      label: '节奏',
      sourceKey: 'pacingSource',
      source: this.#pacingSource,
      required: true,
      assign: instance => (this.#pacing = instance),
      guard: (instance, id) =>
        guardedPacing(instance, {
          hasSource: this.#pacingSource !== undefined,
          id,
          hasStatus: this.#statusSource !== undefined,
          statusKeys: ((this.#status?.definition as { statuses?: { key: string }[] } | undefined)?.statuses ?? []).map(
            status => status.key,
          ),
          activities: this.#activities,
          report: this.#reportPlugin,
        }),
    })
  }
  #openActivities(): Promise<void> {
    return this.#openMechanism<ActivitiesInstance>({
      name: 'activities',
      label: '活动',
      sourceKey: 'activitySource',
      source: this.#activitySource,
      required: true,
      assign: instance => (this.#activities = instance),
      guard: (instance, id) => guardedActivities(instance, this.#activitySource, id, this.#reportPlugin),
    })
  }
  #openStatus(): Promise<void> {
    return this.#openMechanism<StatusInstance>({
      name: 'status',
      label: '状态',
      sourceKey: 'statusSource',
      source: this.#statusSource,
      required: true,
      assign: instance => (this.#status = instance),
      guard: (instance, id) =>
        guardedStatus(instance, this.#statusSource !== undefined, id, String(this.#playerId), this.#reportPlugin),
    })
  }
  #openKnowledge(): Promise<void> {
    return this.#openMechanism<KnowledgeInstance>({
      name: 'knowledge',
      label: '知识',
      sourceKey: 'knowledgeSource',
      source: this.#knowledgeSource,
      required: false,
      assign: instance => (this.#knowledge = instance),
      guard: instance => {
        if (typeof instance.select !== 'function') throw new TypeError('knowledge requires select')
        return instance
      },
    })
  }

  async #openMemory(): Promise<void> {
    const provider = this.#options.plugins!.memory!
    if (!provider) return
    this.#memoryIsCore = provider.id === CORE_MEMORY_ID
    this.#memoryId = provider.id
    try {
      this.#memory = await provider.open(this.#services(provider.id), AbortSignal.timeout(30_000))
      this.#modulesInForce.memory = [{ id: provider.id, version: provider.version }]
    } catch (error) {
      if (this.#memoryIsCore) throw error
      throw new Error(`记忆插件 ${provider.id} 无法打开：${(error as Error).message}`, { cause: error })
    }
  }

  /** Each world instance gets its own scheduler; one that cannot open must not keep the world from opening. */
  async #openScheduler(): Promise<void> {
    const official = this.#options.composition!.fallbackScheduler
    const provider = this.#options.plugins!.scheduler!
    const signal = AbortSignal.timeout(30_000)
    this.#schedulerIsOfficial = provider === official
    try {
      this.#scheduler = await provider.open(this.#services(provider.id), signal)
      this.#modulesInForce.scheduler = [{ id: provider.id, version: provider.version }]
    } catch (error) {
      if (!official || provider === official) throw error
      console.error(`[调度器插件 ${provider.id}] 打开失败：`, error)
      this.#scheduler = await official.open(this.#services(official.id), signal)
      this.#modulesInForce.scheduler = [{ id: official.id, version: official.version }]
      this.#schedulerIsOfficial = true
      this.#notice = `调度器插件 ${provider.id} 无法打开，已改用官方调度。`
    }
  }

  async #openCharacterLoop(): Promise<void> {
    const provider = this.#options.plugins!.characterLoop!
    try {
      const opened = await provider.open(this.#services(provider.id), AbortSignal.timeout(30_000))
      this.#characterLoop = opened
      if (typeof opened.run !== 'function') throw new TypeError('character loop requires run')
      this.#modulesInForce.characterLoop = [{ id: provider.id, version: provider.version }]
      this.#characterLoop = {
        run: async activation => {
          let passedOn: unknown
          const capability = <T>(work: () => T): T => {
            try {
              return work()
            } catch (error) {
              passedOn = error
              throw error
            }
          }
          const asyncCapability = async <T>(work: () => Promise<T>): Promise<T> => {
            try {
              return await work()
            } catch (error) {
              passedOn = error
              throw error
            }
          }
          try {
            return await opened.run({
              ...activation,
              get calls() {
                return activation.calls
              },
              get performResult() {
                return activation.performResult
              },
              prepare: options => capability(() => activation.prepare(options)),
              decide: reserve => asyncCapability(() => activation.decide(reserve)),
              submit: decision => asyncCapability(() => activation.submit(decision)),
            })
          } catch (error) {
            if (!activation.signal.aborted && error !== passedOn) {
              throw new CharacterLoopError('character loop failed', { cause: error })
            }
            throw error
          }
        },
        ...(opened.close ? { close: () => opened.close!() } : {}),
      }
    } catch (error) {
      throw new Error(`角色循环插件 ${provider.id} 无法打开：${(error as Error).message}`, { cause: error })
    }
  }

  #worldReader() {
    return createWorldReader(resolve(this.#dataDirectory, 'world.sqlite'), this.#address)
  }

  /** A third-party scheduler failing costs the round's reactions, never what has been committed. */
  async #schedule(input: Omit<Parameters<typeof createSchedulerRound>[0], 'world'>): Promise<SchedulerResult> {
    return this.#scheduleRound(createSchedulerRound({ ...input, world: this.#worldReader() }))
  }

  async #scheduleRound(round: SchedulerRound): Promise<SchedulerResult> {
    if (this.#schedulerIsOfficial) return this.#scheduler.run(round)
    const tracked = trackSchedulerTurns(round)
    try {
      return normalizeSchedulerResult(await this.#scheduler.run(tracked.round))
    } catch (error) {
      console.error('[调度器插件] 本轮调度失败：', error)
      return { calls: 0, wave: 0, terminalReason: 'plugin_failed', activations: [] }
    } finally {
      // The store closes after this returns, so nothing the scheduler left running may outlive it.
      await tracked.settle()
    }
  }

  /** Each due character's own opportunities, then what the round left for the player to read. */
  async #autonomousRound(
    store: WorldStore,
    createTurn: (autonomous?: boolean) => CharacterTurn,
    due: AutonomousRole[],
    counts: Map<CharacterId, number>,
  ): Promise<void> {
    if (!due.length || this.#paused || this.#abortedWork || !this.#continuationController) return
    const active = this.#gameplay.activity?.current()
    const result = await this.#scheduleRound(
      createAutonomyRound({
        settings: this.#playSettings,
        address: this.#address,
        signal: this.#continuationController.signal,
        store,
        world: this.#worldReader(),
        turn: this.#track(createTurn()),
        autonomousTurn: this.#track(createTurn(true)),
        due,
        counts,
        rootBeforeSeq: this.#rootBeforeSeq,
        characterIds: this.#characterIds,
        activeParticipants: active?.game.active ? active.participants : [],
        allowConcurrent: !this.#options.serialScheduling && !active?.game.active && !this.#serialDecisions,
        recipients: () => (this.#currentScene?.recipients ?? []).map(person => brandId(person.id, 'CharacterId')),
      }),
    )
    this.#autonomyCycle = result.autonomy ?? { ...result }
    autonomyNotice(this.#roundStatus, result.terminalReason)
  }

  /** What the player can see of the items now, as a character would: in hand, on the ground here, or in the
   * hands of someone present since a handover the player saw. Never who holds something the player cannot see. */
  #visibleItems(
    events: readonly StoredWorldEvent[],
    observerIds: readonly CharacterId[],
  ): NonNullable<HostState['items']> {
    const { current } = characterVisibleItems(this.#entities, events, this.#playerId, observerIds) as {
      current: WorldJsonObject[]
    }
    return current.map(item => {
      const id = String(item.entityId),
        holderId = item.holderId as string | null
      return {
        id,
        name: this.#entityNames.get(id) ?? id,
        kind: String(item.kind),
        where:
          holderId === this.#playerId ? ('held' as const) : holderId === null ? ('here' as const) : ('with' as const),
        ...(holderId === null || holderId === this.#playerId
          ? {}
          : { holderId, holderName: this.#names.get(holderId) ?? holderId }),
      }
    })
  }

  /** The player's own waits, in order, as empty entries a frontend may show however it likes. */
  #withPauses(transcript: HostState['transcript'], events: readonly StoredWorldEvent[]): HostState['transcript'] {
    const pauses = this.#gameplay.status ? pauseRounds(events) : []
    if (!pauses.length) return transcript
    const name = this.#names.get(this.#playerId) ?? this.#playerId
    return [
      ...transcript,
      ...pauses.map(({ seq }) => ({
        seq,
        speaker: name,
        speakerId: this.#playerId,
        text: '',
        player: true,
        pause: true as const,
      })),
    ].sort((left, right) => left.seq - right.seq)
  }

  /** The active NPC owns the writer lease. Project its committed prefix without remounting the app. */
  async #projectCommitted(store: WorldStore): Promise<void> {
    const head = store.head(this.#address)
    const events = store.readEvents(this.#address, head.headSeq)
    const view = new CharacterViewBuilder(store).rebuildFromEvents(this.#address, this.#playerId, head.headSeq, events)
    const availability = new CharacterRuntimeAvailabilityService(resolve(this.#dataDirectory, 'world.sqlite'))
    try {
      const scene = new SceneDecisionService(store, availability).decideFromEvents(
        this.#address,
        this.#playerId,
        events,
        head.headSeq,
      )
      this.#transcript = this.#withPauses(
        playerTranscript(await this.#displayView(view), this.#names, this.#playerId, {
          entityNames: this.#entityNames,
          locationNames: this.#locationNames,
        }),
        events,
      )
      this.#items = this.#visibleItems(events, scene.observerIds)
      if (this.#gameplay.activity)
        this.#projectActivity(
          activityWorldFromEvents(
            resolve(this.#dataDirectory, 'world.sqlite'),
            this.#address,
            head.headSeq,
            events,
            this.#entities,
          ),
        )
      this.#currentScene = {
        ...(view.locationId === null ? {} : { locationId: view.locationId }),
        changedAt: sceneChangedAt(events, this.#playerId),
        locationName:
          view.locationId === null ? '未知地点' : (this.#locationNames.get(view.locationId) ?? view.locationId),
        recipients: scene.observerIds
          .filter(id => id !== this.#playerId)
          .map(id => ({ id, name: this.#names.get(id) ?? id })),
        presentNpcNames: scene.observerIds.filter(id => id !== this.#playerId).map(id => this.#names.get(id) ?? id),
      }
      this.#debug = {
        ...this.#debug,
        headSeq: head.headSeq,
        tick: head.tick,
        worldVersion: this.#worldVersion,
        visibleSceneIds: view.scenes.map(scene => scene.sceneId),
      }
      this.publishPlayerFeed()
    } finally {
      availability.close()
    }
  }

  /** The activity panel follows every commit in a round, e.g. the enemy's HP right after the player's attack. */
  #projectActivity(world: ActivityWorld | undefined): void {
    this.#activityView = this.#gameplay.activity?.view(this.#playerId, world)
    this.#activityViews = this.#gameplay.activity?.views(this.#playerId, world)
  }

  async #refresh(): Promise<void> {
    const [view, head] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
    ])
    this.#transcript = playerTranscript(await this.#displayView(view), this.#names, this.#playerId, {
      entityNames: this.#entityNames,
      locationNames: this.#locationNames,
    })
    this.#availableActions = await this.#application.playerAffordancesForPrincipal(
      this.#address,
      this.#principalId,
      this.#playerId,
      view.asOfWorldSeq,
    )

    const worldPath = resolve(this.#dataDirectory, 'world.sqlite')
    const world = new WorldStore(worldPath)
    let activityWorld: ActivityWorld | undefined
    try {
      const availability = new CharacterRuntimeAvailabilityService(worldPath)
      try {
        const events = world.readEvents(this.#address, view.asOfWorldSeq)
        if (this.#gameplay.activity)
          activityWorld = activityWorldFromEvents(worldPath, this.#address, view.asOfWorldSeq, events, this.#entities)
        const scene = new SceneDecisionService(world, availability).decideFromEvents(
          this.#address,
          this.#playerId,
          events,
          view.asOfWorldSeq,
        )
        if (this.#gameplay.status) {
          const projected = projectStatus(
            this.#gameplay.status,
            this.#availableActions,
            events,
            this.#playerId,
            this.#names,
          )
          this.#availableActions = projected.availableActions
          this.#transcript = this.#withPauses(this.#transcript, events)
          this.#statusBar = projected.statusBar
          this.#statusTruth = projected.statusTruth
        }
        this.#items = this.#visibleItems(events, scene.observerIds)
        this.#currentScene = {
          ...(view.locationId === null ? {} : { locationId: view.locationId }),
          changedAt: sceneChangedAt(events, this.#playerId),
          locationName:
            view.locationId === null ? '未知地点' : (this.#locationNames.get(view.locationId) ?? view.locationId),
          recipients: scene.observerIds
            .filter(id => id !== this.#playerId)
            .map(id => ({ id, name: this.#names.get(id) ?? id })),
          presentNpcNames: scene.observerIds.filter(id => id !== this.#playerId).map(id => this.#names.get(id) ?? id),
        }
        if (this.#gameplay.communication)
          this.#availableActions = withMessageActions(
            this.#gameplay.communication,
            this.#availableActions,
            events,
            this.#playerId,
            this.#playSettings.publicationCharacters,
            this.#names,
          )
      } finally {
        availability.close()
      }
    } finally {
      world.close()
    }
    // Like transcript and affordances, serve the last refreshed committed projection.
    // Polling must not open a migrating writer while tail snapshots copy the database.
    this.#projectActivity(activityWorld)
    const activityState = this.#gameplay.activity?.current()
    this.#waitable = this.#gameplay.status !== undefined && activityState?.game.active !== true
    if (activityState?.game.active && activityState.participants.includes(this.#playerId)) {
      this.#availableActions = this.#gameplay.activity!.filterAffordances(
        this.#availableActions,
        activityState,
        this.#playerId,
      )
    }
    this.#debug = {
      headSeq: head.headSeq,
      tick: head.tick,
      worldVersion: this.#worldVersion,
      manifestVersion: this.#manifestVersion,
      outputProtocol: 'perform/publish(segments)/abstain',
      memoryMode: this.#memoryIsCore ? 'core' : 'none',
      activationCycle: this.#activationCycle ?? null,
      autonomy: this.#autonomyCycle ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
    }
    if (this.#pluginsReady) for (const decision of this.#decisions) decision.committed?.(head.headSeq)
    this.publishPlayerFeed()
  }
}

/** Public runtime owns one logical storyline and its replaceable tail. */
export class WorldHostRuntime extends TailRoundRuntime {
  static async create(options: WorldHostOptions): Promise<WorldHostRuntime> {
    if (options.composition && options.plugins) throw new TypeError('请在 composition 内选择机制，不要同时传 plugins')
    const composition = options.composition ?? assembleRoleplay(options.plugins)
    return TailRoundRuntime.open({ ...options, composition, plugins: composition.mechanisms }, value =>
      WorldHostCore.create({ ...value, composition: value.composition! }),
    )
  }
}
