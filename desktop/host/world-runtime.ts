import {
  characterTurnCall,
  presetCall,
  presetContext,
  presetDisplay,
  presetOutput,
  RequestInspector,
  type ChatCallObservation,
  type RolePreset,
} from '@harness-world/provider-chat'
import { CreatorRecords, type CreatorRecordsQuery } from './creator-records.ts'
import { creatorHistory, creatorHistoryQuery, type CreatorHistoryQuery } from './creator-history.ts'
import {
  creatorInspectionQuery,
  type CreatorInspectionQuery,
  type CreatorInspectionSnapshot,
} from './creator-inspection.ts'
import {
  createCoreRulebookRegistry,
  currentCharacterLifecycle,
  currentEntityState,
  currentLocation,
  currentSceneStates,
  RulebookRegistry,
} from '@harness-world/kernel'
import {
  playSettings,
  DEFAULT_READING,
  DEFAULT_AUDIO,
  type PlaySettings,
  type ReadingPreferences,
  type AudioPreferences,
} from '../play-settings.ts'
import type { RuntimeModel } from '../model-connections.ts'
import { createRoleProviders, type ModelOptions, type RoleProviders } from './role-providers.ts'
import { TailRoundRuntime } from './tail-runtime.ts'
import { assertSettled, snapshotTail } from '../tail-storage.ts'
import {
  CharacterPresetError,
  CharacterTurn,
  characterExecutionResult,
  characterVisibleItems,
  recentExecutionContext,
  rejectionReasonText,
  runCharacterActivations,
  SceneDecisionService,
  WorldApplication,
  type ActivationTurn,
  type CharacterTurnRequest,
  type CharacterTurnResult,
  type RecallShadowObservation,
} from '@harness-world/application'
import { saveStoryNode, readStoryNodes } from '../story-nodes.ts'
import { existsSync, unlinkSync } from 'node:fs'
import { CoreMemoryAdapter, type MemoryContextBudget, type MemoryBuildOptions } from './memory/core-memory.ts'
import { assertCoreEnvironment, coreRunnerGroups, type CoreRunner, type MemoryRunners } from './memory/python-worker.ts'
import { activityWorldFromEvents, type ActivityRequest, type ActivityWorld } from './pack-activity.ts'
import { decideWithFormatRetry } from './decision-format.ts'
import { PackActivities } from './pack-activities.ts'
import { KNOWN_STATUS_NOTE, PackStatus, pauseRounds, publicStatusChanges } from './pack-status.ts'
import { PackKnowledge } from './pack-knowledge.ts'
import { PackAutonomy, type AutonomousRole } from './pack-autonomy.ts'
import { CrossSceneCommunication, communicationInstruction, loadCommunicationConfig } from './pack-communication.ts'
import { auditBeforePublication, type InterventionOptions } from './jev-publication-intervention.ts'
import { JevShadow, type ShadowOptions } from './jev-shadow.ts'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, relative, basename } from 'node:path'
import {
  brandId,
  interactionPackageDescription,
  RECALL_KEYWORD_TOKENIZER_ID,
  type CharacterId,
  type StoredWorldEvent,
  type WorldJsonObject,
  type WorldAddress,
} from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { gatewayTurnCall } from './gateway-turn-call.ts'
import {
  CharacterViewBuilder,
  CharacterRuntimeAvailabilityService,
  PlayerInputJobs,
  WorldStore,
  WriterLeaseService,
} from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { actionText, HostBusyError, isWait, type HostAction, type HostRuntime, type HostState } from './http-server.ts'
import { modelCharacters, playerTranscript, sceneChangedAt } from './player-transcript.ts'
import { DEFAULT_RUNTIME_TUNING, type RuntimeTuning } from './runtime-tuning.ts'
import { PackModules, lockedPackAsset } from './pack-modules.ts'
import { CapabilitySession, type CapabilityCatalog } from '../host-capabilities.ts'

export interface WorldHostOptions extends ModelOptions {
  readonly capabilities?: CapabilityCatalog
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
  readonly shadowAudit?: ShadowOptions
  readonly memoryShadow?: boolean
  readonly memoryCore?: boolean
  readonly memoryCoreRun?: CoreRunner
  readonly memoryCoreBuildRun?: CoreRunner
  /** Starts the Core runners for one memory model; defaults to a lazy Python worker plus one-shot builds. */
  readonly memoryCoreRunners?: (environment: NodeJS.ProcessEnv) => MemoryRunners
  readonly memoryBuildConcurrency?: Omit<MemoryBuildOptions, 'run'>
  readonly memoryContextBudget?: MemoryContextBudget
  readonly storyNodes?: boolean
  readonly storyParentNodeId?: string
  readonly worldVersion?: string
  readonly logicalDirectory?: string
  readonly publicationAudit?: InterventionOptions
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

/**
 * The endpoint's own refusal text may echo the request, so it never reaches the notice. The HTTP status
 * class is enough to name the likely cause, which is what a creator debugging their own preset needs.
 */
export function providerFailureNotice(httpStatus: number | undefined): string {
  if (httpStatus === undefined) return '角色模型服务未完成请求'
  if (httpStatus === 400 || httpStatus === 422) {
    return `角色模型请求被服务拒绝（HTTP ${httpStatus}）；请检查预设中的生成参数（如 frequencyPenalty、presencePenalty、stop）与模型标识是否被该服务支持`
  }
  if (httpStatus === 401 || httpStatus === 403)
    return `角色模型服务拒绝认证（HTTP ${httpStatus}）；请在模型设置中检查该实例的凭证`
  if (httpStatus === 404) return `角色模型服务找不到该模型（HTTP ${httpStatus}）；请检查模型标识`
  if (httpStatus === 429) return `角色模型服务限流（HTTP ${httpStatus}）；请稍后重试或降低调用预算`
  return `角色模型服务未完成请求（HTTP ${httpStatus}）`
}

/** Player submission commits first; ordinary NPC work then uses bounded dynamic dispatch. */
/** `/status <operation>[@<item>] <json>`: a status operation, done to an item when one is named. */
function statusCommand(text: string): { operation: string; targetId?: string; parameters: WorldJsonObject } {
  const match = /^\/status ([a-z][a-z0-9-]*)(?:@(\S+))? (.+)$/su.exec(text)
  if (match === null) throw new TypeError('状态命令格式无效')
  return {
    operation: match[1]!,
    ...(match[2] === undefined ? {} : { targetId: match[2] }),
    parameters: JSON.parse(match[3]!) as WorldJsonObject,
  }
}

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
  creatorHistory(input: CreatorHistoryQuery = {}) {
    if (this.#closing) throw new TypeError('运行实例已关闭')
    const query = creatorHistoryQuery(input as Record<string, unknown>)
    if (query.characterId !== undefined && !this.#names.has(query.characterId)) throw new TypeError('未知角色')
    const store = new WorldStore(resolve(this.#dataDirectory, 'world.sqlite'))
    try {
      if (
        query.entityId !== undefined &&
        currentEntityState(store.readEvents(this.#address), query.entityId) === undefined
      )
        throw new TypeError('未知物品')
      return {
        ...creatorHistory(store, this.#address, this.#worldVersion, query),
        scope: structuredClone(this.#records.scope),
      }
    } finally {
      store.close()
    }
  }
  creatorInspection(input: CreatorInspectionQuery = {}): CreatorInspectionSnapshot {
    if (this.#closing) throw new TypeError('运行实例已关闭')
    const query = creatorInspectionQuery(input as Record<string, unknown>)
    if (query.characterId !== undefined && !this.#names.has(query.characterId)) throw new TypeError('未知角色')
    const store = new WorldStore(resolve(this.#dataDirectory, 'world.sqlite'))
    try {
      const head = store.head(this.#address),
        events = store.readEvents(this.#address, head.headSeq)
      if ((query.afterSeq ?? 0) > head.headSeq) throw new TypeError('查询游标超过当前世界时刻')
      const scenes = currentSceneStates(events),
        limit = query.limit ?? 50
      const characters = [...this.#names].map(([id, name]) => {
        const locationId = currentLocation(events, id) ?? null
        return {
          id,
          name,
          locationId,
          locationName: locationId === null ? null : (this.#locationNames.get(locationId) ?? locationId),
          sceneIds: scenes
            .filter(scene => scene.lifecycle !== 'closed' && scene.participantIds.includes(id))
            .map(scene => scene.sceneId),
          lifecycle: currentCharacterLifecycle(events, id) ?? 'unknown',
          lastMovementSeq:
            events.findLast(
              event => event.eventType === 'character.moved' && (event.data as WorldJsonObject).characterId === id,
            )?.seq ?? null,
          processing: {
            transport: this.#inspector.status(id),
            lastActivation:
              this.#activationCycle?.activations.findLast(activation => activation.characterId === id)?.result ?? null,
          },
        }
      })
      const entityIds = [
        ...new Set(
          events
            .filter(event => event.eventType === 'entity.upsert')
            .map(event => String((event.data as WorldJsonObject).entityId)),
        ),
      ]
      const entities = entityIds.map(id => {
        const state = currentEntityState(events, id)!
        const holderLocation = characters.find(character => character.id === state.holderId)?.locationId ?? null
        // 状态更新的 upsert 常常只写 kind / locationId，名称取最近一次写明 name 的记录。
        const named = events.findLast(
          event =>
            event.eventType === 'entity.upsert' &&
            (event.data as WorldJsonObject).entityId === id &&
            typeof (event.data as WorldJsonObject).name === 'string',
        )
        return {
          id,
          name: String((named?.data as WorldJsonObject | undefined)?.name ?? id),
          state,
          holderMeaning: 'custody' as const,
          effectiveLocationId: state.locationId ?? holderLocation,
          locationBasis:
            state.locationId !== null
              ? ('entity' as const)
              : holderLocation !== null
                ? ('holder' as const)
                : ('unknown' as const),
          lastChangeSeq: events.findLast(
            event => event.eventType.startsWith('entity.') && (event.data as WorldJsonObject).entityId === id,
          )!.seq,
        }
      })
      const selectedEvents =
        query.afterSeq === undefined
          ? events.slice(-limit)
          : events.filter(event => event.seq > query.afterSeq!).slice(0, limit)
      const nextAfterSeq = selectedEvents.at(-1)?.seq ?? query.afterSeq ?? head.headSeq
      // The creator sees true status values; players and roles only ever get their own known values.
      const truth = this.#status?.truth(events)
      const result: CreatorInspectionSnapshot = {
        capturedAt: new Date().toISOString(),
        address: this.#address,
        worldVersion: this.#worldVersion,
        title: this.#title,
        headSeq: head.headSeq,
        tick: head.tick,
        packHash: this.#packHash,
        storyParentNodeId: this.#storyParentNodeId,
        busy: this.#busy,
        paused: this.#paused,
        captureEnabled: this.#inspector.enabled,
        characters,
        entities,
        statusTruth: truth ? { public: truth.public, characters: truth.characters } : null,
        activities: this.#activity?.debugStates(events) ?? [],
        events: { items: selectedEvents, nextAfterSeq, hasMore: nextAfterSeq < head.headSeq },
        limitations: [
          'holderId 表示保管或携带，不证明法律所有权。',
          '物品随保管者的位置是推导值，不表示精确物理位置。',
          '事件中的 observation.upsert 记录实际信息接收者；对白的 addresseeIds 不等于全部观察者。',
          '调用状态是传输证据，lastActivation 是最近已完成周期结果；未采集或正在调度时不推测角色意图。',
          ...(truth ? ['状态为事件日志中的当前真实值；玩家和角色只看到各自上次确认的值。'] : []),
        ],
      }
      if (query.characterId !== undefined) {
        const id = query.characterId
        const archive = this.#memoryCore?.inspectArchive(id, query.memoryOffset ?? 0, limit)
        result.character = {
          id,
          currentView: new CharacterViewBuilder(store).rebuildAt(
            this.#address,
            brandId(id, 'CharacterId'),
            head.headSeq,
          ),
          latestRequest: this.#inspector.latest(id),
          contextNotice:
            'currentView 是当前授权视图；latestRequest 是启用采集后该角色最近一次实际请求，时刻可能早于当前世界。每角色保留最近一次，超出总容量会淘汰。',
          memory: {
            mode: this.#memoryCore ? 'core' : 'native',
            archivePrefix: archive?.archivePrefix ?? null,
            sections: archive?.sections ?? {},
            maintenance: archive?.maintenance ?? null,
            notice: this.#memoryCore
              ? '已安装档案分页，不触发整理或召回。本次实际召回见 latestRequest.contextParts 的 memories。'
              : '原生完整记忆档案尚未接入；授权经历见 currentView，本次召回见实际请求。',
          },
        }
      }
      return structuredClone(result)
    } finally {
      store.close()
    }
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
  readonly #model: string
  readonly #intentModel: string
  readonly #characterIds: readonly CharacterId[]
  readonly #effectivePresets: ReadonlyMap<string, RolePreset>
  #memoryCore: CoreMemoryAdapter | undefined
  #closeCore: (() => Promise<void>) | undefined
  #activity: PackActivities | undefined
  #modules: PackModules | undefined
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
    if (
      !this.#pluginsReady ||
      this.#closing ||
      !this.#modules?.characters.has(characterId) ||
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
  #autonomy: PackAutonomy | undefined
  /** The pack's SMS contacts; the rule wraps the core resolver anew for every resolver chain. */
  #communication: CrossSceneCommunication | undefined
  #autonomyCycle: Record<string, unknown> | undefined
  #modelCallBudget: { remaining: number; exhausted: boolean } | undefined
  #activityView: WorldJsonObject | undefined
  #activityViews: WorldJsonObject[] | undefined
  /** Whether the last refresh allowed a wait; polling must not reopen the store to ask. */
  #waitable = false
  #workDone: Promise<void> = Promise.resolve()
  #finishWork: (() => void) | undefined
  #escaping: Promise<HostState> | undefined
  #status: PackStatus | undefined
  #statusRoundError: string | undefined
  #autoStartError: string | undefined
  #knowledge: PackKnowledge | undefined
  #activationCycle: Awaited<ReturnType<typeof runCharacterActivations>> | undefined
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
  readonly #memoryShadowFile: string | undefined
  #transcript: HostState['transcript'] = []
  #availableActions: NonNullable<HostState['availableActions']> = []
  #statusBar: HostState['statusBar']
  #statusTruth: HostState['statusTruth']
  #currentScene: NonNullable<HostState['world']['currentScene']> | undefined
  #debug: Record<string, unknown> = {}
  #shadow: JevShadow | undefined
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
  #lastPlayerIntent: string | null = null
  #rootBeforeSeq = 0
  #continuationController: AbortController | undefined
  readonly #models: RoleProviders

  private constructor(
    options: WorldHostOptions,
    compiled: ReturnType<typeof adaptCompiledWorldPack>,
    intentEnabled: boolean,
  ) {
    this.#options = options
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
    this.#memoryShadowFile = options.memoryShadow ? resolve(options.dataDirectory, 'memory-shadow.jsonl') : undefined
    this.#manifestVersion = compiled.manifest.schemaVersion
    this.#intentEnabled = intentEnabled
    const binding = compiled.manifest.playerBindings[0]
    if (binding === undefined) throw new TypeError('world Pack has no PlayerBinding')
    this.#principalId = binding.principalId
    this.#playerId = binding.characterId
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
    const models = createRoleProviders(
      options,
      settings,
      characters,
      this.#inspector,
      observation => {
        this.#providerCalls += 1
        this.#lastCall = observation
      },
      (characterId, observation) => {
        this.#roleCalls.set(characterId, observation)
      },
    )
    this.#models = models
    const { shared: provider, presets: effectivePresets, timeoutMs } = models
    this.#model = models.model
    this.#intentModel = models.intentModel
    this.#effectivePresets = effectivePresets
    this.#characterIds = characters.map(character => character.actorId)
    if (options.memoryCore) {
      const defaultMemory: RuntimeModel = options.models.default.memory
      const groups = coreRunnerGroups(options.dataDirectory, options.memoryCoreRunners)
      const shared =
        options.memoryCoreRun === undefined || options.memoryCoreBuildRun === undefined
          ? groups.runnersFor(defaultMemory)
          : undefined
      const own =
        options.memoryCoreRun === undefined
          ? new Map(Object.entries(options.models.characters).map(([id, role]) => [id, groups.runnersFor(role.memory)]))
          : new Map<string, MemoryRunners>()
      this.#closeCore = groups.close
      this.#memoryCore = new CoreMemoryAdapter(
        options.dataDirectory,
        this.#address,
        options.memoryCoreRun ?? shared!.recall,
        options.memoryContextBudget ?? {
          triggerTokens: settings.memoryTriggerTokens,
          compactTokens: settings.memoryCompactTokens,
          minimumRecentTokens: settings.memoryRecentTokens,
        },
        {
          ...options.memoryBuildConcurrency,
          run: options.memoryCoreBuildRun ?? shared!.build,
          runFor: actor => own.get(actor),
          worldVersion: this.#worldVersion,
          versionValid: () => !this.#closing,
        },
        { maxItems: settings.memoryMaxItems, maxJsonChars: settings.memoryMaxJsonChars },
      )
    }
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
      interactionPackages: createInstalledInteractionPackages(),
      worldPath: resolve(options.dataDirectory, 'world.sqlite'),
      sessionPath: resolve(options.dataDirectory, 'session.sqlite'),
      memoryPath: resolve(options.dataDirectory, 'memory.sqlite'),
      contextPath: resolve(options.dataDirectory, 'context.sqlite'),
      recallTokenizer: RECALL_KEYWORD_TOKENIZER_ID,
      // The world's model budget has to cover the interpreter's own output ceiling, or the Host refuses to
      // dispatch an interpretation at all: the profile states the ceiling, this is what pays for it.
      modelBudgetTokens: 8_192,
      leaseTtlMs: 180_000,
      // The interpreter is the Host's; whether the world wants it is the world's own declaration, and a
      // world that declared the legacy route simply keeps reading free text as speech.
      playerIntent: {
        profile: intentProfile,
        dispatch: async (request, profile, signal) => await provider.dispatch(request, profile, signal),
      },
    })
  }

  /** One character decision: authorized context projection, preset, model call, format retry and optional audit. */
  async #decide(
    request: CharacterTurnRequest,
    signal: AbortSignal,
    reserveFormatRetry?: () => boolean,
  ): Promise<unknown> {
    if (this.#memoryCore) request = await this.#memoryCore.project(request, signal)
    if (this.#options.recentExecutionEvidence === true)
      request = { ...request, context: recentExecutionContext(request.context) }
    const character = request.context.character as WorldJsonObject
    const characterId = String(character.characterId)
    if (this.#status) {
      const store = new WorldStore(resolve(this.#options.dataDirectory, 'world.sqlite'))
      let events
      try {
        events = store.readEventsRange(this.#address, 0, store.head(this.#address).headSeq, [
          'status.updated',
          'action.resolved',
        ])
      } finally {
        store.close()
      }
      const updates = events.filter(event => event.eventType === 'status.updated')
      const known = this.#status.known(updates, characterId)
      const statusChanges = publicStatusChanges(this.#status, updates, events, characterId, known)
      request = {
        ...request,
        context: {
          ...request.context,
          knownStatus: known as unknown as WorldJsonObject[],
          knownStatusNote: KNOWN_STATUS_NOTE,
          ...(statusChanges.length ? { statusChanges: statusChanges as unknown as WorldJsonObject[] } : {}),
        },
      }
    }
    if (this.#knowledge)
      request = { ...request, context: { ...request.context, knowledge: this.#knowledge.select(request.context) } }
    const expressions = this.#options.stageExpressions?.[characterId]
    if (expressions?.length) request = { ...request, context: { ...request.context, expressions: [...expressions] } }
    this.#roleCalls.delete(characterId)
    const roleProvider = this.#models.byCharacter.get(characterId)
    if (!roleProvider) throw new TypeError('当前角色没有可调用的预设配置。')
    const effectivePreset = this.#effectivePresets.get(characterId)
    const prepare = async (visible: CharacterTurnRequest) => {
      try {
        const projected = await presetContext(visible, effectivePreset!, String(this.#playerId), signal)
        return presetCall(
          this.#models.protocols.get(characterId) !== 'google'
            ? gatewayTurnCall(projected)
            : characterTurnCall(projected),
          effectivePreset!,
          projected,
          this.#playerName,
          {
            character: this.#names.get(characterId) ?? characterId,
            scene:
              this.#locationNames.get(String((projected.context.scene as WorldJsonObject | undefined)?.locationId)) ??
              String((projected.context.scene as WorldJsonObject | undefined)?.locationId ?? ''),
          },
        )
      } catch (error) {
        signal.throwIfAborted()
        throw new CharacterPresetError('角色预设准备失败。', { cause: error })
      }
    }
    const prepared = await prepare(request)
    this.#memoryCore?.observeContext(
      request,
      prepared.messages.map(message => message.content).join('\n') +
        JSON.stringify(prepared.schema) +
        (effectivePreset?.prompt ?? ''),
    )
    const simulated = this.#activity?.simulate(request)
    const callProvider = async (call: typeof prepared) => {
      signal.throwIfAborted()
      if (this.#modelCallBudget) {
        if (this.#modelCallBudget.remaining <= 0) {
          this.#modelCallBudget.exhausted = true
          throw new Error('自主处理模型调用预算已耗尽')
        }
        this.#modelCallBudget.remaining--
      }
      return roleProvider.decide(call, signal)
    }
    // Preset output rules clean up model text. A scripted line is the author's exact text, which activity hooks
    // check verbatim on publication, so it bypasses them.
    const decide = async (call: typeof prepared) =>
      simulated !== undefined
        ? simulated
        : presetOutput(
            await callProvider(call),
            effectivePreset!,
            signal,
            request.context.expressionPolicy as WorldJsonObject | undefined,
            this.#playSettings.publicationCharacters,
          )
    const raw = await decideWithFormatRetry(
      prepared,
      decide,
      signal,
      characterTurnCall(request).schema,
      request.context.activity === undefined && simulated === undefined
        ? (reserveFormatRetry ?? (() => false))
        : undefined,
    )
    if (this.#inspector.enabled)
      this.#records.trace('decision', characterId, request.decisionId ?? null, {
        source: simulated === undefined ? 'model' : 'script',
        value: raw as WorldJsonObject,
      })
    this.#memoryCore?.recordDecision(request, raw)
    signal.throwIfAborted()
    if (this.#closing || this.#abortedWork) throw new Error('角色任务世界版本已失效。')
    if (this.#options.publicationAudit === undefined) return raw
    const store = new WorldStore(resolve(this.#options.dataDirectory, 'world.sqlite'))
    let history
    try {
      history = store.readEvents(this.#address)
    } finally {
      store.close()
    }
    return auditBeforePublication({
      request,
      raw,
      history,
      options: this.#options.publicationAudit,
      signal,
      decide: async revised => {
        const call = await prepare(revised),
          replacement = this.#activity?.simulate(revised)
        return presetOutput(
          replacement === undefined ? await callProvider(call) : replacement,
          effectivePreset!,
          signal,
          revised.context.expressionPolicy as WorldJsonObject | undefined,
        )
      },
    })
  }

  static async create(options: WorldHostOptions): Promise<WorldHostCore> {
    mkdirSync(resolve(options.dataDirectory), { recursive: true })
    const pack = (await compileWorldPackSource(
      resolve(options.packPath),
      createInstalledInteractionPackages().map(interactionPackageDescription),
    )) as CompiledWorldPackV5
    const modules = PackModules.load(options.packPath, pack, options.capabilities)
    const statusSource = modules?.statusSource(
      pack.assets.some(asset => asset.path === 'scripts/status.js')
        ? lockedPackAsset(options.packPath, pack, 'scripts/status.js')
        : undefined,
    )
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
      runtime.#packHash = pack.packHash
      runtime.#actionLabels = Object.fromEntries(
        [...pack.content.entities, ...pack.content.characters].flatMap(target =>
          (target.interactionBindings ?? []).flatMap(binding =>
            binding.label === undefined ? [] : [[binding.bindingId, binding.label]],
          ),
        ),
      )
      runtime.#storyParentNodeId = options.storyParentNodeId ?? null
      runtime.#autonomy = PackAutonomy.load(options.packPath, pack, runtime.#playerId)
      const communication = loadCommunicationConfig(options.packPath, pack)
      if (communication !== undefined)
        runtime.#communication = new CrossSceneCommunication(
          communication,
          compiled.manifest,
          runtime.#coreRules().resolve('builtin:speak-move', 2, 'communication', runtime.#address),
        )
      runtime.#application.activate(compiled)
      runtime.#modules = modules
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
      runtime.#status =
        statusSource === undefined ? PackStatus.load(options.packPath, pack) : PackStatus.fromSource(statusSource, pack)
      if (modules) {
        modules.bind(runtime.#status!, runtime.#capabilities!)
        runtime.#status!.externalActions = modules
      }
      await runtime.#status?.ensureInitial(
        resolve(options.dataDirectory, 'world.sqlite'),
        runtime.#address,
        runtime.#playerId,
      )
      runtime.#knowledge = PackKnowledge.load(options.packPath, pack)
      runtime.#activity = PackActivities.load(
        options.packPath,
        pack,
        resolve(options.dataDirectory, 'world.sqlite'),
        runtime.#address,
        runtime.#playerId,
        runtime.#status,
      )
      if (modules)
        runtime.#activity?.setActionResolver((context, adjudicate) =>
          modules.resolveAction(
            context,
            resolve(options.dataDirectory, 'world.sqlite'),
            runtime.#address,
            AbortSignal.timeout(10000),
            adjudicate,
          ),
        )
      await runtime.#refresh()
      const rebuildPath = resolve(options.dataDirectory, 'rebuild-memory.json')
      if (existsSync(rebuildPath)) {
        const rebuild = JSON.parse(readFileSync(rebuildPath, 'utf8')) as { headSeq: number; packHash: string }
        if (!runtime.#memoryCore || rebuild.packHash !== pack.packHash)
          throw new Error('故事线记忆恢复需要原游戏包与 Core 记忆。')
        const head = await runtime.#application.head(runtime.#address)
        if (head.headSeq !== rebuild.headSeq) throw new Error('故事节点的世界前缀不一致。')
        // Restoring derived archives must not hold a world writer across file installation.
        await runtime.#application.release(runtime.#address)
        const memoryPath = resolve(options.dataDirectory, 'core-memory.json')
        const archives = existsSync(memoryPath) ? (JSON.parse(readFileSync(memoryPath, 'utf8')) as WorldJsonObject) : {}
        if (!archives || typeof archives !== 'object' || Array.isArray(archives))
          throw new Error('故事节点记忆快照损坏。')
        runtime.#memoryCore.restoreArchives(archives, runtime.#characterIds)
        runtime.#memoryCore.snapshotAliases(runtime.#characterIds)
        unlinkSync(rebuildPath)
      }
      if (
        options.storyNodes &&
        runtime.supportsHistoryRestore() &&
        readStoryNodes(options.logicalDirectory ?? options.dataDirectory).length === 0
      )
        await runtime.saveNode('首次保存节点')
      if (options.shadowAudit !== undefined) {
        if (
          options.shadowAudit.items.some(
            item => !compiled.manifest.entities.some(entity => entity.entityId === item.entityId),
          )
        ) {
          throw new TypeError('shadow item is not declared in this Pack')
        }
        const head = await runtime.#application.head(runtime.#address)
        runtime.#shadow = new JevShadow({
          ...options.shadowAudit,
          address: runtime.#address,
          characters: compiled.manifest.characters.map(character => ({
            characterId: character.characterId,
            name: character.name,
          })),
          initialSeq: head.headSeq,
          readEvents: asOfSeq => {
            const store = new WorldStore(resolve(options.dataDirectory, 'world.sqlite'))
            try {
              return store.readEvents(runtime.#address, asOfSeq)
            } finally {
              store.close()
            }
          },
        })
      }
      runtime.#pluginsReady = true
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
    this.#memoryCore?.snapshotAliases(this.#characterIds)
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
      ...(this.#status
        ? {
            characterArguments: Object.fromEntries(
              this.#status.operations
                .filter(op => op.characterParameters.length)
                .map(op => ['status:' + op.id, [...op.characterParameters]]),
            ),
          }
        : {}),
      ...(this.#memoryCore ? { memoryMaintenance: this.#memoryCore.backgroundState() } : {}),
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
        provider: this.#models.protocol,
        model: this.#model,
        intentModel: this.#intentModel,
        providerCalls: this.#providerCalls,
        paused: this.#paused,
        lastPlayerIntent: this.#lastPlayerIntent,
        playerInputMode: this.#intentEnabled ? 'command-controlled' : 'legacy-speech',
        lastProviderCall: this.#lastCall,
        ...(this.#statusRoundError === undefined ? {} : { statusRoundError: this.#statusRoundError }),
        ...(this.#autoStartError === undefined ? {} : { autoStartError: this.#autoStartError }),
        ...(this.#status && Object.keys(this.#status.policyErrors).length
          ? { statusPolicyError: this.#status.policyErrors }
          : {}),
        ...(this.#shadow === undefined ? {} : { shadowAudit: this.#shadow.stats() }),
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
    if (this.#busy || this.#escaping || this.#closing) throw new HostBusyError('请等待当前行动完成。')
    if (this.#paused) {
      this.#notice = 'NPC 已暂停：这次输入没有提交。恢复后再试。'
      return this.state()
    }
    const inActivity = this.#activity?.current()?.game.active === true
    if (!inputs.length && !this.#canWait()) throw new TypeError('现在不能静观。')
    for (const text of inputs) {
      if (inActivity && text.startsWith('/') && !text.startsWith('/act ') && !text.startsWith('/status '))
        throw new TypeError('活动期间禁止变量调试与未声明命令。')
      if (text.startsWith('/status ') && !this.#status) throw new TypeError('本包没有状态脚本')
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
    await this.#application.release(this.#address)
    if (inActivity) {
      // A refusal throws: an activity commits nothing for a rejected player action.
      if (text.startsWith('/act ')) {
        const match = /^\/act (speak|move|interact) (.+)$/u.exec(text)
        if (match === null) throw new TypeError('动作命令格式无效')
        const parameters = JSON.parse(match[2]!) as WorldJsonObject
        await this.#activity!.worldAction({ actionType: match[1]!, parameters }, key)
      } else if (text.startsWith('/status ')) {
        // During an activity a status operation is an ordinary interaction under the activity's policy.
        const command = statusCommand(text)
        await this.#activity!.worldAction(
          {
            actionType: 'interact',
            parameters: {
              targetRef:
                command.targetId === undefined
                  ? { kind: 'character', id: this.#playerId }
                  : { kind: 'entity', id: command.targetId },
              bindingId: 'status',
              definitionRef: { id: 'status:' + command.operation, version: 1 },
              arguments: command.parameters,
            },
          },
          key,
        )
      } else await this.#activity!.speak(text, key)
      this.#notice = '操作已提交；单纯对白不消耗游戏行动回合。'
      return { accepted: true, react: true }
    }
    if (text.startsWith('/message ')) {
      if (!this.#communication) throw new TypeError('本包没有开启短信')
      const message = JSON.parse(text.slice('/message '.length)) as WorldJsonObject
      const recipientId = String(message.recipientId)
      if (typeof message.text !== 'string' || !message.text.trim())
        throw new TypeError(this.#communication.medium + '内容不能为空')
      if (message.text.length > this.#playSettings.publicationCharacters)
        throw new RangeError(this.#communication.medium + '太长了')
      const path = resolve(this.#dataDirectory, 'world.sqlite')
      const store = new WorldStore(path),
        leases = new WriterLeaseService(path)
      try {
        // Only an active contact is offered; the rule would record anything else as a refused message.
        if (
          !this.#communication
            .options(store.readEvents(this.#address), this.#playerId)
            .some(option => option.targetRef.id === recipientId)
        )
          throw new TypeError('不能给这个人发' + this.#communication.medium)
        await this.#communication.send({
          store,
          leases,
          address: this.#address,
          manifest: this.#entities,
          actorId: this.#playerId,
          recipientId,
          text: message.text,
        })
      } finally {
        leases.close()
        store.close()
      }
      this.#notice = this.#communication.medium + '已发出，不代表对方已读或同意。'
      return { accepted: true, react: true }
    }
    if (text.startsWith('/status ')) {
      const command = statusCommand(text)
      // A rejection throws with the reason; a retried request returns its original result and starts no round.
      const changed = await this.#status!.apply(
        resolve(this.#dataDirectory, 'world.sqlite'),
        this.#address,
        this.#playerId,
        command.operation,
        command.parameters,
        key,
        command.targetId,
      )
      this.#notice = changed ? '状态操作已提交。' : '已返回原提交结果，没有再次执行。'
      return { accepted: true, react: changed }
    }
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
      const notice = this.#playerResolutionNotice(key, result.result.headSeq)
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
    if (this.#busy || this.#escaping || this.#closing) throw new HostBusyError('请等待当前处理完成，或使用逃生按钮。')
    if (this.#paused) throw new TypeError('请先恢复 NPC，或使用逃生按钮。')
    if (!this.#activity) throw new TypeError('本包没有安装游戏脚本。')
    this.#beginWork()
    this.#error = false
    try {
      this.#rootBeforeSeq = (await this.#application.head(this.#address)).headSeq
      await this.#application.release(this.#address)
      const changed = await this.#activity.apply(request)
      const committed = (await this.#application.head(this.#address)).headSeq > this.#rootBeforeSeq
      this.#notice = changed ? '游戏操作已提交。' : '已返回原提交结果，没有再次执行。'
      if (changed) {
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
    if (!this.#activity || this.#escaping || this.#closing || this.#paused || this.#abortedWork) return
    await this.#application.release(this.#address)
    let started = false
    try {
      started = await this.#activity.autoStart()
      this.#autoStartError = undefined
    } catch (error: unknown) {
      if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error
      this.#autoStartError = error.message
    }
    // The participants get the same chance to react to the opening as after a manual start.
    if (started) await this.#activateCharacters(true)
  }
  /** The status hook runs once per accepted player round, recording (not retrying) a failure. */
  async #endStatusRound(pause = false): Promise<void> {
    if (!this.#status || this.#escaping || this.#closing) return
    await this.#application.release(this.#address)
    const result = await this.#status.endRound(
      resolve(this.#dataDirectory, 'world.sqlite'),
      this.#address,
      this.#rootBeforeSeq,
      pause,
    )
    this.#statusRoundError = result.ok ? undefined : result.error
  }
  /** Rounds are kept by the status script, and a running activity has its own turns. */
  #canWait(): boolean {
    return this.#status !== undefined && this.#activity?.current()?.game.active !== true
  }
  async saveNode(title: string) {
    if (!this.supportsHistoryRestore()) throw new TypeError('当前宿主能力尚不支持外部状态配对保存。')
    if (this.#busy || this.#escaping || this.#closing || this.#paused)
      throw new HostBusyError('请等待当前行动完成并恢复 NPC 后保存节点。')
    this.#savingNode = true
    this.#beginWork()
    try {
      this.#memoryCore?.cancelBackground()
      await this.#memoryCore?.waitForBackground()
      await this.#application.deliver(this.#address, 'story-node:deliver')
      await this.#application.release(this.#address)
      const aliases = this.#memoryCore?.snapshotAliases(this.#characterIds) ?? {}
      return await saveStoryNode(
        this.#dataDirectory,
        this.#address,
        this.#packHash,
        title,
        aliases,
        this.#storyParentNodeId,
        this.#options.logicalDirectory,
        this.#memoryCore?.snapshotArchives(this.#characterIds) ?? {},
      )
    } finally {
      this.#savingNode = false
      this.#endWork()
    }
  }
  beginRoundRandom(values?: readonly number[]): void {
    this.#activity?.beginRoundRandom(values)
  }
  roundRandom(): number[] {
    return this.#activity?.roundRandom() ?? []
  }
  holdCognition(): void {
    this.#roundHolds++
    this.#memoryCore?.holdInstallation()
  }
  releaseCognition(): void {
    this.#roundHolds = Math.max(0, this.#roundHolds - 1)
    this.#memoryCore?.releaseInstallation()
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
    await this.#application.release(this.#address)
    return assertSettled(this.#dataDirectory, this.#address)
  }
  async snapshotRound(target: string): Promise<void> {
    await this.settleRound()
    const aliases = this.#memoryCore?.snapshotAliases(this.#characterIds) ?? {}
    await snapshotTail(this.#dataDirectory, target, this.#address, aliases)
    this.#records.snapshotBase(basename(target))
  }
  async refreshMemory(): Promise<HostState> {
    if (this.#savingNode || this.#closing) throw new HostBusyError('正在保存节点。')
    if (!this.#memoryCore) throw new TypeError('本次运行没有开启 Core 记忆。')
    this.#memoryCore.startRefresh(this.#characterIds)
    this.#notice = '长期记忆已开始后台整理，可以继续游玩。'
    return this.state()
  }
  async cancelMemory(): Promise<HostState> {
    this.#memoryCore?.cancelBackground()
    this.#notice = '已取消未完成的后台整理；已安装档案和近期经历保留。'
    return this.state()
  }
  async waitForMemory(): Promise<void> {
    await this.#memoryCore?.waitForBackground()
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
      await this.#activity?.escape()
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
      const current = this.#activity
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
          ? this.#activity?.view(this.#playerId)
          : this.#activity?.views(this.#playerId).find(view => view.activityKey === action.parameters.activityKey)
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
  /** The round result names only its first action; report any later player action rejected in the same commit. */
  #playerResolutionNotice(idempotencyKey: string, headSeq: number): string | undefined {
    if (!this.#intentEnabled) return undefined
    const worldPath = resolve(this.#dataDirectory, 'world.sqlite')
    const jobs = new PlayerInputJobs(worldPath)
    const world = new WorldStore(worldPath)
    try {
      const validated = jobs.read(this.#address, idempotencyKey)?.records.validated as
        | {
            sourceText?: string
            actions?: readonly { actionId: string; actionType: string }[]
            sourceSpans?: readonly { actionId: string; endUtf16: number; text: string }[]
          }
        | undefined
      if (validated?.actions === undefined) return undefined
      const resolutions = new Map(
        world
          .readEvents(this.#address, headSeq)
          .filter(
            event => event.eventType === 'action.resolved' && (event.data as WorldJsonObject).sourceRole === 'player',
          )
          .map(event => {
            const data = event.data as WorldJsonObject
            return [data.actionId, data] as const
          }),
      )
      const failed = validated.actions.filter(action => resolutions.get(action.actionId)?.accepted !== true)
      const accepted = validated.actions.length - failed.length
      const details = failed
        .map(action => {
          const quote = validated.sourceSpans
            ?.filter(span => span.actionId === action.actionId)
            .map(span => span.text)
            .join('')
          const reason = resolutions.get(action.actionId)?.reason
          // Players read the shared plain-language wording; raw rejection codes stay out of the notice.
          const explained = typeof reason === 'string' ? rejectionReasonText(reason)?.replace(/。$/u, '') : undefined
          return `“${quote || action.actionType}”未执行${explained === undefined ? '' : `：${explained}`}`
        })
        .join('；')
      const lastEnd = Math.max(0, ...(validated.sourceSpans ?? []).map(span => span.endUtf16))
      const trailing = validated.sourceText?.slice(lastEnd).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '') ?? ''
      const omitted =
        trailing === ''
          ? ''
          : `句尾“${trailing.length > 80 ? `${trailing.slice(0, 80)}…` : trailing}”没有映射到本次动作或表达。`
      if (failed.length === 0 && omitted === '') return undefined
      const rejected =
        failed.length === 0 ? '' : `${accepted > 0 ? '玩家输入已部分提交' : '玩家动作未成功'}：${details}。`
      return `${rejected}${omitted}请以转录和当前场景为准。`
    } finally {
      world.close()
      jobs.close()
    }
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
    const closingMemory = this.#memoryCore?.close()
    await this.#workDone
    await closingCapabilities
    await closingMemory
    await this.#closeCore?.()
    await this.#shadow?.close()
    try {
      await this.#application.close()
    } finally {
      this.#activity?.close()
    }
  }

  #coreRules(): RulebookRegistry {
    return createCoreRulebookRegistry({ interactionPackages: createInstalledInteractionPackages() })
  }

  /** Resolver chain: core, then the pack's SMS, then status operations, then the running activity's permissions. */
  #rulebooks(worldPath: string): RulebookRegistry {
    const core = this.#communication?.registry() ?? this.#coreRules()
    if (!this.#status) return this.#activity?.rulebooks(this.#communication?.resolver()) ?? core
    const status = this.#status.resolver(
      core.resolve('builtin:speak-move', 2, 'status', this.#address),
      worldPath,
      this.#address,
      this.#playerId,
    )
    if (this.#activity) return this.#activity.rulebooks(status)
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, status)
    return registry
  }

  async #activateCharacters(
    activityOnly = false,
    requestedCharacter?: CharacterId,
    requestSignal?: AbortSignal,
  ): Promise<CharacterTurnResult | undefined> {
    await this.#application.release(this.#address)
    if (this.#escaping || this.#closing || this.#abortedWork) return
    const path = resolve(this.#dataDirectory, 'world.sqlite')
    const store = new WorldStore(path),
      leases = new WriterLeaseService(path)
    const availability = new CharacterRuntimeAvailabilityService(path)
    let memory: CognitiveMemoryService | undefined
    this.#continuationController = new AbortController()
    try {
      if (this.#paused) return
      memory = new CognitiveMemoryService(
        resolve(this.#dataDirectory, 'memory.sqlite'),
        store,
        undefined,
        2,
        RECALL_KEYWORD_TOKENIZER_ID,
      )
      const createTurn = this.#turnFactory(path, store, leases, availability, memory)
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
      const active = this.#activity?.current()
      const due =
        this.#playSettings.autonomyOpportunities === 0
          ? []
          : (
              this.#autonomy?.due(
                store,
                this.#address,
                this.#playerId,
                this.#rootBeforeSeq,
                store.head(this.#address).headSeq,
              ) ?? []
            )
              // Activity owns its participants' opportunities; autonomy never takes over its turn.
              .filter(role => !active?.game.active || !active.participants.includes(role.characterId))
      await this.#runActivityChain(store, turn)
      this.#allowInterruption = !this.#activity?.current()?.game.active
      if (activityOnly) {
        await this.#activateAutonomous(store, createTurn, due, new Map())
        return
      }
      await this.#runSceneReactions(store, turn, createTurn, due, active)
    } finally {
      this.#allowInterruption = false
      memory?.close()
      availability.close()
      leases.close()
      store.close()
      this.#continuationController = undefined
      this.#modelCallBudget = undefined
      if (!this.#paused && !this.#escaping) this.#memoryCore?.startPending()
    }
  }

  /** Build CharacterTurns that share this activation's store handles; `autonomous` swaps in the autonomy rules and prompt. */
  #turnFactory(
    path: string,
    store: WorldStore,
    leases: WriterLeaseService,
    availability: CharacterRuntimeAvailabilityService,
    memory: CognitiveMemoryService,
  ): (autonomous?: boolean) => CharacterTurn {
    const shadowFile = this.#memoryShadowFile
    return (autonomous = false) => {
      const base = this.#rulebooks(path)
      return new CharacterTurn({
        publicationCharacters: this.#playSettings.publicationCharacters,
        activationTimeoutMs: this.#playSettings.activationTimeoutSeconds * 1000,
        address: this.#address,
        store,
        leases,
        availability,
        ...(this.#memoryCore === undefined ? { memory } : {}),
        rulebooks: autonomous
          ? this.#autonomy!.rulebooks(base.resolve('builtin:speak-move', 2, 'autonomy', this.#address))
          : base,
        decide: (request, signal, reserveFormatRetry) => this.#decide(request, signal, reserveFormatRetry),
        ...(this.#modules
          ? {
              resolveAction: (
                context: import('@harness-world/kernel').RulebookResolutionContext,
                signal: AbortSignal,
                adjudicate: () => import('@harness-world/kernel').RulebookResolution,
              ) => this.#modules!.resolveAction(context, path, this.#address, signal, adjudicate),
            }
          : {}),
        onTrace: (kind, characterId, decisionId, data) => {
          if (this.#inspector.enabled) this.#records.trace(kind, characterId, decisionId, data)
        },
        continueAfterPublish:
          (this.#options.continueAfterPublish === true || this.#playSettings.continueAfterPublish === 1) &&
          !this.#activity?.current()?.game.active &&
          this.#options.publicationAudit === undefined,
        beforeActionExpression:
          this.#options.beforeActionExpression === true &&
          !this.#activity?.current()?.game.active &&
          this.#options.publicationAudit === undefined,
        onCommitted: async () => {
          this.#modules?.committed()
          await this.#projectCommitted(store)
        },
        onActionFailure: () => this.#modules?.failed(),
        allowUnrelatedCommits:
          !this.#options.serialScheduling &&
          !this.#activity?.current()?.game.active &&
          this.#options.publicationAudit === undefined,
        projectContext: (context: WorldJsonObject, canPerform: boolean) => {
          const activityContext = this.#activity?.projectContext(context, canPerform) ?? context
          const projected = this.#communication ? { ...activityContext, communicationInstruction } : activityContext
          return autonomous
            ? {
                ...projected,
                autonomy: {
                  instruction:
                    '现在是你自主处理自身目标的机会。依据自己的目标、经历和眼前情况决定是否行动；可以表达或 abstain。没有新消息不代表发生了你不知道的事；但 context.statusChanges 里的变化已经发生，例如时间已经推进，请按现在的时段与处境行动，不要接着已经过去的对话收尾。',
                },
              }
            : projected
        },
        ...(this.#activity === undefined
          ? {}
          : {
              validateDecision: (decision: WorldJsonObject, request: CharacterTurnRequest) =>
                this.#activity!.validateDecision(decision, request),
            }),
        ...(this.#activity === undefined && this.#status === undefined && this.#communication === undefined
          ? {}
          : {
              executionResult: (input: Parameters<typeof characterExecutionResult>[0]) =>
                (input.action.parameters as WorldJsonObject).bindingId === 'experiment:message'
                  ? this.#communication!.executionResult(input)
                  : (this.#status?.executionResult(input) ??
                    (this.#activity?.executionResult ?? characterExecutionResult)(input)),
            }),
        ...(this.#memoryCore === undefined
          ? {}
          : { shortTermAfterSeq: (actor: CharacterId) => this.#memoryCore!.shortTermAfterSeq(actor) }),
        recentObservations: this.#tuning.recentObservations,
        recentSelfObservations: this.#tuning.recentSelfObservations,
        ...(shadowFile === undefined
          ? {}
          : {
              onRecallShadow: (observation: RecallShadowObservation) =>
                appendFileSync(shadowFile, JSON.stringify(observation) + '\n'),
            }),
      })
    }
  }

  /** Let the running activity hand opportunities to its participants until it stops, its budget ends or it times out. */
  async #runActivityChain(store: WorldStore, turn: CharacterTurn): Promise<void> {
    const controller = this.#continuationController!
    let selected = this.#activity?.schedule()
    // Creator selects the next participant; the host bounds the entire chain.
    const activitySignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.#playSettings.activityDeadlineSeconds * 1000),
    ])
    for (
      let opportunity = 0;
      opportunity < this.#playSettings.activityOpportunities &&
      selected !== undefined &&
      !activitySignal.aborted &&
      !this.#paused;
      opportunity++
    ) {
      const result = await turn.run(brandId(selected, 'CharacterId'), {
        signal: activitySignal,
        maxCalls: 2,
        stimulus: new CharacterViewBuilder(store)
          .rebuildAt(this.#address, brandId(selected, 'CharacterId'), store.head(this.#address).headSeq)
          .observations.toSorted((left, right) => left.sourceSeq - right.sourceSeq)
          .slice(-8)
          .map(o => o.value as WorldJsonObject),
      })
      if (this.#capabilities?.resultUnknown) return
      this.#error = result.failure !== undefined
      this.#notice =
        result.failure === undefined
          ? result.status === 'abstained'
            ? '角色本次没有提交操作，当前轮次保留；可以再次请求处理或逃生。'
            : '角色处理已完成。'
          : result.failure === 'invalid_output'
            ? '角色返回格式无效，当前轮次没有推进；可重试或逃生。'
            : '角色决策处理未完成，当前轮次没有推进；可重试或逃生。'
      selected = activitySignal.aborted ? undefined : this.#activity!.outcome(result as unknown as WorldJsonObject)
      if (opportunity === this.#playSettings.activityOpportunities - 1 && selected !== undefined)
        this.#notice = '本次活动处理达到宿主预算上限；已提交结果保留，可再次请求处理或逃生。'
    }
    if (activitySignal.aborted) {
      this.#notice = '活动处理已取消或超时；已提交结果保留，未完成操作没有换手。'
      this.#error = true
    }
  }

  /** One bounded wave cycle for everyone who observed the committed input, then any autonomy left due. */
  async #runSceneReactions(
    store: WorldStore,
    turn: CharacterTurn,
    createTurn: (autonomous?: boolean) => CharacterTurn,
    due: AutonomousRole[],
    active: ReturnType<PackActivities['current']> | undefined,
  ): Promise<void> {
    const controller = this.#continuationController!
    const dynamic =
      !this.#options.serialScheduling &&
      !this.#activity?.current()?.game.active &&
      this.#options.publicationAudit === undefined
    const integratedAutonomy = dynamic && !this.#options.stagedAutonomy && due.length > 0
    const { autonomy, ...cycle } = await runCharacterActivations({
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
      ...(dynamic
        ? { locationId: (id: CharacterId) => currentLocation(store.readEvents(this.#address), id) ?? null }
        : {}),
      ...(integratedAutonomy
        ? {
            autonomy: {
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
              },
            },
          }
        : {}),
      strictCallBudget: true,
      limits: this.#tuning,
    })
    this.#activationCycle = cycle
    this.#autonomyCycle = autonomy
    this.#reactionNotice(cycle)
    if (autonomy) this.#autonomyNotice(autonomy.terminalReason)
    else if (!controller.signal.aborted) {
      const counts = new Map<CharacterId, number>()
      for (const activation of this.#activationCycle.activations)
        counts.set(activation.characterId, (counts.get(activation.characterId) ?? 0) + 1)
      await this.#activateAutonomous(store, createTurn, due, counts)
    }
  }

  /** Tell the player how the reaction cycle ended, without claiming more was committed than was. */
  #reactionNotice(cycle: Awaited<ReturnType<typeof runCharacterActivations>>): void {
    const terminal = cycle.terminalReason
    if (terminal === 'failed' || terminal === 'interrupted') {
      const failureStatus = terminal === 'interrupted' ? 'interrupted' : 'failed'
      const activation =
        cycle.activations.find(activation => activation.result.status === failureStatus) ?? cycle.activations.at(-1)
      const relevant = activation?.result
      const failedCall = activation === undefined ? undefined : this.#roleCalls.get(String(activation.characterId))
      const committed = relevant?.performResult !== undefined
      const cause =
        terminal === 'interrupted'
          ? '角色处理被打断或超时'
          : relevant?.failure === 'invalid_output'
            ? '角色返回格式无效'
            : relevant?.failure === 'preset_failed'
              ? '角色预设处理失败，请检查提示节点与文本规则'
              : relevant?.failure === 'provider_failed'
                ? providerFailureNotice(failedCall?.status === 'failed' ? failedCall.httpStatus : undefined)
                : '角色处理失败'
      this.#error = true
      this.#notice = `玩家输入已提交；${cause}。${
        committed
          ? '交互结果已提交，后续表达未完成；请看转录中的实际结果。可以继续行动，无需重发上一句。'
          : '已经发表的回应保留；尚未完成的角色行动或表达没有提交。可以继续行动，无需重发上一句。'
      }`
    } else if (terminal === 'call_limit' || terminal === 'wave_limit' || terminal === 'character_limit') {
      this.#notice = '玩家输入已提交；本轮角色反应达到预算上限，剩余反应没有继续执行。可以继续行动，无需重发上一句。'
    } else {
      this.#notice = '本轮角色处理已结束，可以继续行动；角色也可以选择不回应。'
    }
  }

  async #activateAutonomous(
    store: WorldStore,
    createTurn: (autonomous?: boolean) => CharacterTurn,
    due: AutonomousRole[],
    counts: Map<CharacterId, number>,
  ): Promise<void> {
    if (!due.length || this.#paused || this.#abortedWork || !this.#continuationController) return
    const settings = this.#playSettings
    const signal = AbortSignal.any([
      this.#continuationController.signal,
      AbortSignal.timeout(settings.autonomyDeadlineSeconds * 1000),
    ])
    const before = store.head(this.#address).headSeq
    const activations: { characterId: CharacterId; result: Awaited<ReturnType<CharacterTurn['run']>> }[] = []
    this.#modelCallBudget = { remaining: settings.autonomyNpcCalls, exhausted: false }
    let calls = 0,
      reason = 'quiescent'
    const turn = this.#track(createTurn(true))
    outer: for (let opportunity = 0; opportunity < settings.autonomyOpportunities; opportunity++) {
      for (const role of due) {
        if (opportunity >= role.opportunities) continue
        if (this.#paused || signal.aborted) {
          reason = 'interrupted'
          break outer
        }
        const remaining = Math.min(settings.autonomyNpcCalls - calls, this.#modelCallBudget.remaining)
        if (remaining < 2) {
          reason = 'call_limit'
          break outer
        }
        const stimulus = new CharacterViewBuilder(store)
          .rebuildAt(this.#address, role.characterId, store.head(this.#address).headSeq)
          .observations.filter(o => o.sourceSeq > this.#rootBeforeSeq)
          .map(o => o.value as WorldJsonObject)
        const result = await turn.run(role.characterId, { signal, maxCalls: 2, maxModelCalls: remaining, stimulus })
        calls += result.calls
        activations.push({ characterId: role.characterId, result })
        counts.set(role.characterId, (counts.get(role.characterId) ?? 0) + 1)
        if (result.status === 'failed' || result.status === 'interrupted') {
          reason = this.#modelCallBudget.exhausted ? 'call_limit' : result.status
          break outer
        }
      }
    }
    const autonomousCalls = settings.autonomyNpcCalls - this.#modelCallBudget.remaining
    let reactions: Awaited<ReturnType<typeof runCharacterActivations>> | undefined
    if (
      !signal.aborted &&
      !this.#paused &&
      reason !== 'failed' &&
      reason !== 'interrupted' &&
      settings.autonomyReactionWaves > 0
    ) {
      this.#modelCallBudget = { remaining: settings.autonomyReactionCalls, exhausted: false }
      const active = this.#activity?.current()
      reactions = await runCharacterActivations({
        store,
        address: this.#address,
        turn: this.#track(createTurn()),
        afterSeq: before,
        signal,
        characterIds: this.#characterIds.filter(
          id =>
            !due.some(role => role.characterId === id) && (!active?.game.active || !active.participants.includes(id)),
        ),
        presentCharacterIds: () => (this.#currentScene?.recipients ?? []).map(p => brandId(p.id, 'CharacterId')),
        ...(!this.#options.serialScheduling && !active?.game.active && this.#options.publicationAudit === undefined
          ? { locationId: (id: CharacterId) => currentLocation(store.readEvents(this.#address), id) ?? null }
          : {}),
        initialCounts: counts,
        strictCallBudget: true,
        limits: {
          maximumWaves: settings.autonomyReactionWaves,
          maximumNpcCalls: settings.autonomyReactionCalls,
          maximumCallsPerCharacter: settings.maximumCallsPerCharacter,
          reactionDeadlineSeconds: settings.autonomyDeadlineSeconds,
        },
      })
      if (this.#modelCallBudget.exhausted) reason = 'call_limit'
      else if (reactions.terminalReason !== 'quiescent') reason = reactions.terminalReason
    }
    if (signal.aborted) reason = 'interrupted'
    const reactionCalls = reactions === undefined ? 0 : settings.autonomyReactionCalls - this.#modelCallBudget.remaining
    this.#autonomyCycle = { activations, autonomousCalls, reactionCalls, reactions, terminalReason: reason }
    this.#modelCallBudget = undefined
    this.#autonomyNotice(reason)
  }

  #autonomyNotice(reason: string): void {
    if (reason === 'failed' || reason === 'interrupted') {
      this.#error = true
      this.#notice = '玩家输入及已提交的角色行动保留；自主处理失败或超时，未完成的机会已丢弃，可以继续行动。'
    } else if (reason !== 'quiescent') {
      this.#notice = '自主行动或后续反应达到预算上限；已提交结果保留，未使用机会不积攒，可以继续行动。'
    }
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
    const pauses = this.#status ? pauseRounds(events) : []
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
        playerTranscript(await presetDisplay(view, this.#effectivePresets), this.#names, this.#playerId, {
          entityNames: this.#entityNames,
          locationNames: this.#locationNames,
        }),
        events,
      )
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

  async #refresh(): Promise<void> {
    const [view, head] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
    ])
    this.#transcript = playerTranscript(
      await presetDisplay(view, this.#effectivePresets),
      this.#names,
      this.#playerId,
      { entityNames: this.#entityNames, locationNames: this.#locationNames },
    )
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
        if (this.#activity)
          activityWorld = activityWorldFromEvents(worldPath, this.#address, view.asOfWorldSeq, events, this.#entities)
        const scene = new SceneDecisionService(world, availability).decideFromEvents(
          this.#address,
          this.#playerId,
          events,
          view.asOfWorldSeq,
        )
        if (this.#status) {
          // The player is offered status operations under the same rules as an NPC; a running activity's
          // policy filter below applies to them as to any other interaction.
          this.#availableActions = this.#status.withOperations(
            this.#availableActions,
            events,
            this.#playerId,
            this.#playerId,
          )
          const named = <T extends { holderId: string | null }>(entry: T) =>
            entry.holderId === null
              ? entry
              : {
                  ...entry,
                  holderName: this.#names.get(entry.holderId) ?? entry.holderId,
                  ...(entry.holderId === this.#playerId ? { self: true } : {}),
                }
          this.#transcript = this.#withPauses(this.#transcript, events)
          // The bar shows what the author pinned; the stage lists the rest in its status drawer.
          const pinned = new Set(this.#status.statuses.filter(s => s.bar).map(s => s.key))
          this.#statusBar = this.#status
            .known(events, this.#playerId)
            .map(named)
            .map(entry => (pinned.has(entry.key) ? { ...entry, pinned: true as const } : entry))
          // Author opt-in only: these never enter any character's context.
          this.#statusTruth = this.#status.playerTruth(events).map(named)
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
        if (this.#communication) {
          // The player writes the text in the form; the label names the contact, who may be anywhere.
          const messages = this.#communication
            .options(events, this.#playerId, this.#playSettings.publicationCharacters)
            .map(option => ({
              ...option,
              arguments: {},
              label: '给 ' + (this.#names.get(option.targetRef.id) ?? option.targetRef.id) + ' 发' + option.medium,
            }))
          if (messages.length)
            this.#availableActions = [
              ...this.#availableActions,
              { actionType: 'interact', actionVersion: 2, interactions: messages },
            ]
        }
      } finally {
        availability.close()
      }
    } finally {
      world.close()
    }
    // Like transcript and affordances, serve the last refreshed committed projection.
    // Polling must not open a migrating writer while tail snapshots copy the database.
    this.#activityView = this.#activity?.view(this.#playerId, activityWorld)
    this.#activityViews = this.#activity?.views(this.#playerId, activityWorld)
    const activityState = this.#activity?.current()
    this.#waitable = this.#status !== undefined && activityState?.game.active !== true
    if (activityState?.game.active && activityState.participants.includes(this.#playerId)) {
      this.#availableActions = this.#activity!.filterAffordances(this.#availableActions, activityState, this.#playerId)
    }
    this.#debug = {
      headSeq: head.headSeq,
      tick: head.tick,
      worldVersion: this.#worldVersion,
      manifestVersion: this.#manifestVersion,
      outputProtocol: 'perform/publish(segments)/abstain',
      memoryMode: this.#memoryCore ? 'core' : 'native',
      activationCycle: this.#activationCycle ?? null,
      autonomy: this.#autonomyCycle ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
    }
    this.#shadow?.observe(head.headSeq)
    this.publishPlayerFeed()
  }
}

/** Public runtime owns one logical storyline and its replaceable tail. */
export class WorldHostRuntime extends TailRoundRuntime {
  static async create(options: WorldHostOptions): Promise<WorldHostRuntime> {
    // Only the default runners start Python; injected runners (tests, studies) bring their own.
    if (
      options.memoryCore &&
      options.memoryCoreRunners === undefined &&
      (options.memoryCoreRun === undefined || options.memoryCoreBuildRun === undefined)
    )
      assertCoreEnvironment()
    return TailRoundRuntime.open(options, value => WorldHostCore.create(value))
  }
}
