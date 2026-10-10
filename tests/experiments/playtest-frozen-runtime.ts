import type { ThinkingLevel } from '../../packages/provider-chat/src/thinking.ts'
import { playSettings, DEFAULT_READING, type PlaySettings, type ReadingPreferences } from '../../desktop/play-settings.ts'
import { providerProtocol, type ProviderProtocol } from '../../packages/provider-chat/src/protocol.ts'
import { TailRoundRuntime } from './playtest-tail-runtime.ts'
import { assertSettled, snapshotTail } from '../../desktop/tail-storage.ts'
import { PrototypePresetError } from '../../packages/application/src/prototype-character-turn.ts'
import { saveStoryNode, readStoryNodes } from '../../desktop/story-nodes.ts'
import { existsSync, unlinkSync } from 'node:fs'
import { RequestInspector } from '../../packages/provider-chat/src/request-inspector.ts'
import { presetCall, presetContext, presetOutput, presetDisplay } from '../../packages/provider-chat/src/preset-runtime.ts'
import { rolePresetMapping, characterPreset, type RolePreset, type RolePresetMapping } from '../../packages/provider-chat/src/preset.ts'
import { PlaytestMemoryCore, type MemoryContextBudget, type MemoryBuildOptions } from './playtest-memory-core.ts'
import { createCoreWorker, coreRunner, type CoreRunner } from './hindsight-python.ts'
import { decideActivityFormat, type ActivityRequest } from './pack-activity.ts'
import { PackActivities } from './pack-activities.ts'
import { PackVariables } from './pack-variables.ts'
import { auditBeforePublication, type InterventionOptions } from './jev-publication-intervention.ts'
import { JevShadow, type ShadowOptions } from './jev-shadow.ts'
import { runPrototypeActivations } from '../../packages/application/src/prototype-activation-cycle.ts'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { SceneDecisionService, WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription, RECALL_KEYWORD_TOKENIZER_ID,
  type CharacterId, type WorldJsonObject,
  type WorldAddress } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { createChatProvider, prototypeTurnCall, type ChatCallObservation } from '@harness-world/provider-chat'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { CharacterViewBuilder, CharacterRuntimeAvailabilityService, PlayerInputJobs, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { CognitiveMemoryService } from '@harness-world/memory'
import { PrototypeCharacterTurn, type PrototypeRecallShadowObservation, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { PlaytestBusyError, type PlaytestAction, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'
import { playtestModelCharacters, playerTranscript } from './playtest-view.ts'
import { DEFAULT_PLAYTEST_TUNING, type PlaytestTuning } from './playtest-tuning.ts'

export interface FrozenPlaytestOptions {
  readonly dataDirectory: string
  /** The v5 Pack directory: the world the author wrote, compiled here with the Host's installed packages. */
  readonly packPath: string
  readonly protocol?: ProviderProtocol
  readonly thinkingLevel?: ThinkingLevel
  readonly provider: 'local' | 'deepseek' | 'ollama'
  readonly model?: string
  readonly preset?: RolePreset
  readonly presetMapping?: RolePresetMapping
  readonly intentModel?: string
  /** The Host's Secret, from the environment. It is never written to the data directory. */
  readonly apiKey?: string
  readonly utilityEndpoint?: string
  readonly timeoutMs?: number
  readonly playSettings?: PlaySettings
  readonly reading?: ReadingPreferences
  readonly tuning?: PlaytestTuning
  readonly shadowAudit?: ShadowOptions
  readonly memoryShadow?: boolean
  readonly memoryCore?: boolean
  readonly memoryCoreRun?: CoreRunner
  readonly memoryCoreBuildRun?: CoreRunner
  readonly memoryBuildConcurrency?: Omit<MemoryBuildOptions, 'run'>
  readonly memoryContextBudget?: MemoryContextBudget
  readonly storyNodes?: boolean
  readonly storyParentNodeId?: string
  readonly worldVersion?: string
  readonly logicalDirectory?: string
  readonly publicationAudit?: InterventionOptions
}

const LOCAL_ENDPOINT = 'http://127.0.0.1:8045/v1/chat/completions'
const LOCAL_MODEL = 'gemini-3.7-flash'
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-flash'
const OLLAMA_MODEL = 'qwen3:4b'
const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/api/chat'
/** Whether a Pack directory is a v5 source, which is the one this runtime plays. */
export function isFrozenPackDirectory(packPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(resolve(packPath, 'worldpack.source.json'), 'utf8')) as {
      readonly sourceSchemaVersion?: string }
    return manifest.sourceSchemaVersion === 'worldpack-source/v5'
  } catch {
    return false
  }
}

/** The prototype web host: player submission commits first, then bounded sequential NPC activations. */
export class FrozenWorldRuntimeCore implements PlaytestRuntime {
  readonly #worldVersion: string
  readonly #options: FrozenPlaytestOptions
  readonly #inspector = new RequestInspector()
  requestInspection(enabled?: boolean) { return enabled === undefined ? this.#inspector.snapshot() : this.#inspector.configure(enabled) }
  readonly #application: WorldApplication
  readonly #address
  readonly #principalId: string
  readonly #playerId: CharacterId
  readonly #names: ReadonlyMap<string, string>
  readonly #title: string
  readonly #playerName: string
  readonly #npcNames: readonly string[]
  readonly #locationNames: ReadonlyMap<string, string>
  readonly #sceneVersion: 1 | 2
  readonly #model: string
  readonly #intentModel: string
  readonly #characterIds: readonly CharacterId[]
  readonly #effectivePresets: ReadonlyMap<string, RolePreset>
  #memoryCore: PlaytestMemoryCore | undefined
  #closeCore: (() => Promise<void>) | undefined
  #activity: PackActivities | undefined
  #activityView: WorldJsonObject | undefined
  #activityViews: WorldJsonObject[] | undefined
  #workDone: Promise<void> = Promise.resolve()
  #finishWork: (() => void) | undefined
  #escaping: Promise<PlaytestState> | undefined
  #variables: PackVariables | undefined
  #activationCycle: Awaited<ReturnType<typeof runPrototypeActivations>> | undefined
  readonly #provider: 'local' | 'deepseek' | 'ollama'
  readonly #manifestVersion: number
  readonly #intentEnabled: boolean
  readonly #dataDirectory: string
  #packHash = ''
  #storyParentNodeId: string | null = null
  #savingNode = false
  #closing = false
  #abortedWork = false
  readonly #playSettings: PlaySettings
  readonly #tuning: PlaytestTuning
  readonly #memoryShadowFile: string | undefined
  #transcript: PlaytestState['transcript'] = []
  #availableActions: NonNullable<PlaytestState['availableActions']> = []
  #currentScene: NonNullable<PlaytestState['world']['currentScene']> | undefined
  #debug: Record<string, unknown> = {}
  #shadow: JevShadow | undefined
  #busy = false
  #paused = false
  #notice = ''
  #error = false
  #phaseLabel = '可以输入'
  #providerCalls = 0
  #lastCall: ChatCallObservation | null = null
  #lastPlayerIntent: string | null = null
  #rootBeforeSeq = 0
  #continuationController: AbortController | undefined
  readonly #decideContinuation: (request: PrototypeTurnRequest, signal: AbortSignal) => Promise<unknown>

  private constructor(options: FrozenPlaytestOptions, compiled: ReturnType<typeof adaptCompiledWorldPack>,
    intentEnabled: boolean) {
    this.#options = options
    this.#worldVersion = options.worldVersion ?? randomUUID()
    this.#address = compiled.manifest.address
    this.#dataDirectory = options.dataDirectory
    this.#playSettings = playSettings(options.playSettings??{})
    const settings=this.#playSettings
    this.#tuning = options.tuning ?? {...DEFAULT_PLAYTEST_TUNING,maximumWaves:settings.maximumWaves,maximumNpcCalls:settings.maximumNpcCalls,maximumCallsPerCharacter:settings.maximumCallsPerCharacter,reactionDeadlineSeconds:settings.reactionDeadlineSeconds}
    this.#memoryShadowFile = options.memoryShadow ? resolve(options.dataDirectory, 'memory-shadow.jsonl') : undefined
    this.#manifestVersion = compiled.manifest.schemaVersion
    this.#intentEnabled = intentEnabled
    const binding = compiled.manifest.playerBindings[0]
    if (binding === undefined) throw new TypeError('playtest Pack has no PlayerBinding')
    this.#principalId = binding.principalId
    this.#playerId = binding.characterId
    this.#names = new Map(compiled.manifest.characters.map(character => [character.characterId, character.name]))
    this.#locationNames = new Map(compiled.manifest.locations.map(location => [location.locationId, location.name]))
    this.#sceneVersion = compiled.manifest.contentPack?.runtimeCapabilities.sceneDecisionVersion === 2 ? 2 : 1
    this.#title = compiled.manifest.metadata.title
    this.#playerName = this.#names.get(this.#playerId) ?? this.#playerId
    this.#provider = options.provider
    this.#model = options.model ?? (options.provider === 'ollama' ? OLLAMA_MODEL
      : options.provider === 'deepseek' ? DEEPSEEK_MODEL : LOCAL_MODEL)
    this.#intentModel = options.intentModel ?? this.#model
    const timeoutMs = options.timeoutMs ?? (options.playSettings?settings.modelTimeoutSeconds*1000:options.provider === 'ollama' ? 120_000 : 60_000)
    const endpoint = options.provider === 'ollama'
      ? new URL(options.utilityEndpoint ?? OLLAMA_ENDPOINT)
      : options.provider === 'deepseek' ? new URL(DEEPSEEK_ENDPOINT)
        : new URL(options.utilityEndpoint ?? LOCAL_ENDPOINT)
    if (options.provider === 'deepseek' && options.apiKey === undefined) {
      throw new TypeError('DeepSeek credential unavailable')
    }
    const onCall = (observation: ChatCallObservation) => {
      this.#providerCalls += 1
      this.#lastCall = observation
    }
    const protocol = providerProtocol(options.protocol)
    if (protocol !== 'openai' && options.provider !== 'local') throw new TypeError('原生协议须使用 local 配置入口。')
    const providerOptions = { ...(options.thinkingLevel === undefined ? {} : {thinkingLevel:options.thinkingLevel}), protocol, endpoint, model: this.#model,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.preset===undefined?{}:{preset:options.preset}),
      inspector:this.#inspector, style: options.provider === 'ollama' ? 'format' as const : 'tool' as const, timeoutMs, onCall }
    const provider = createChatProvider(providerOptions)
    const characters = playtestModelCharacters(compiled.manifest, this.#playerId)
    const mapping=rolePresetMapping(options.presetMapping??{})
    if([...Object.keys(mapping.characters??{}),...Object.keys(mapping.memberships??{})].some(id=>!characters.some(c=>c.actorId===id)))throw new TypeError('预设引用了此包之外或不可调用的角色。')
    const effectivePresets=new Map(characters.map(c=>[String(c.actorId),characterPreset(options.preset??{},mapping,c.actorId)]))
    this.#effectivePresets=effectivePresets
    const roleProviders=new Map(characters.map(c=>[String(c.actorId),createChatProvider({...providerOptions,preset:effectivePresets.get(c.actorId)!})]))
    this.#characterIds = characters.map(character => character.actorId)
    if (options.memoryCore) {
      if (options.provider !== 'local') throw new TypeError('实验 Core 网页须使用 local 配置入口。')
      const coreEnvironment = {
        HCW_LOCAL_MODEL: this.#model, HCW_LOCAL_ENDPOINT: endpoint.href, HCW_MODEL_PROTOCOL: protocol,
        ...(options.apiKey === undefined ? {} : { HCW_LOCAL_API_KEY: options.apiKey }),
        HCW_HINDSIGHT_UTILITY_ATTEMPTS: resolve(options.dataDirectory, 'memory-core', 'utility-attempts.jsonl'),
      }
      const worker = options.memoryCoreRun === undefined ? createCoreWorker(coreEnvironment) : undefined
      this.#closeCore = worker?.close
      this.#memoryCore = new PlaytestMemoryCore(options.dataDirectory, this.#address, options.memoryCoreRun ?? worker!.run, options.memoryContextBudget ?? {triggerTokens:settings.memoryTriggerTokens,compactTokens:settings.memoryCompactTokens,minimumRecentTokens:settings.memoryRecentTokens},
        { ...options.memoryBuildConcurrency, run: options.memoryCoreBuildRun ?? coreRunner(coreEnvironment),
          worldVersion: this.#worldVersion, versionValid: () => !this.#closing }, {maxItems:settings.memoryMaxItems,maxJsonChars:settings.memoryMaxJsonChars})
    }
    this.#decideContinuation = async (request, signal) => {
      if (this.#memoryCore) request = await this.#memoryCore.project(request, signal)
      const character = request.context.character as WorldJsonObject
      const variables = this.#variables?.getVariables(String(character.characterId))
      if (variables) request = { ...request, context: { ...request.context,
        packVariables: { public: variables.public, private: variables.private } } }
      const characterId=String(character.characterId)
      const roleProvider=roleProviders.get(characterId)
      if(!roleProvider)throw new TypeError('当前角色没有可调用的预设配置。')
      const effectivePreset=effectivePresets.get(characterId)
      const prepare = async (visible: PrototypeTurnRequest) => {
        try {
          const projected = await presetContext(visible, effectivePreset!, String(this.#playerId), signal)
          return presetCall(options.provider === 'local' && protocol === 'openai' ? localPrototypeTurnCall(projected) : prototypeTurnCall(projected),
            effectivePreset!, projected, this.#playerName, {character:this.#names.get(characterId)??characterId,
              scene:this.#locationNames.get(String((projected.context.scene as WorldJsonObject | undefined)?.locationId))??String((projected.context.scene as WorldJsonObject | undefined)?.locationId??'')})
        } catch(error) { signal.throwIfAborted(); throw new PrototypePresetError('角色预设准备失败。', {cause:error}) }
      }
      const prepared = await prepare(request)
      this.#memoryCore?.observeContext(request, prepared.messages.map(message => message.content).join('\n')
        + JSON.stringify(prepared.schema)+(effectivePreset?.prompt??''))
      const simulated = this.#activity?.simulate(request)
      const decide = async (call: typeof prepared) => presetOutput(simulated === undefined ? await roleProvider.decide(call, signal) : simulated, effectivePreset!, signal,
        request.context.expressionPolicy as WorldJsonObject | undefined, settings.publicationCharacters)
      const raw = request.context.activity === undefined && simulated === undefined ? await decide(prepared)
        : await decideActivityFormat(prepared, decide, signal, prototypeTurnCall(request).schema)
      this.#memoryCore?.recordDecision(request, raw)
      signal.throwIfAborted()
      if (this.#closing || this.#abortedWork) throw new Error('角色任务世界版本已失效。')
      if (options.publicationAudit === undefined) return raw
      const store = new WorldStore(resolve(options.dataDirectory, 'world.sqlite'))
      let history
      try { history = store.readEvents(this.#address) } finally { store.close() }
      return auditBeforePublication({ request, raw, history, options: options.publicationAudit, signal,
        decide: async revised => {
          const call = await prepare(revised), replacement = this.#activity?.simulate(revised)
          return presetOutput(replacement === undefined ? await roleProvider.decide(call, signal) : replacement,
            effectivePreset!, signal, revised.context.expressionPolicy as WorldJsonObject | undefined)
        } })
    }
    this.#npcNames = characters.map(character => character.name)
    // The Host's interpretation profile is a contract with the world, and its deadline ceiling is part of
    // it: a longer call deadline is the adapter's business, not something to state in the profile.
    const intentProfile = { version: 'player-intent-profile/v1' as const, providerId: 'chat-completions',
      modelId: this.#intentModel, maxOutputTokens: 1_024, timeoutMs: Math.min(timeoutMs, 60_000) }
    this.#application = new WorldApplication({
      externalCharacterActivations: true,
      interactionPackages:createInstalledInteractionPackages(),
      worldPath: resolve(options.dataDirectory, 'world.sqlite'),
      sessionPath: resolve(options.dataDirectory, 'session.sqlite'),
      memoryPath: resolve(options.dataDirectory, 'memory.sqlite'),
      contextPath: resolve(options.dataDirectory, 'context.sqlite'),
      recallTokenizer: RECALL_KEYWORD_TOKENIZER_ID,
      // The world's model budget has to cover the interpreter's own output ceiling, or the Host refuses to
      // dispatch an interpretation at all: the profile states the ceiling, this is what pays for it.
      modelBudgetTokens: 8_192, leaseTtlMs: 180_000,
      // The interpreter is the Host's; whether the world wants it is the world's own declaration, and a
      // world that declared the legacy route simply keeps reading free text as speech.
      playerIntent: { profile: intentProfile,
        dispatch: async (request, profile, signal) => await provider.dispatch(request, profile, signal) },
    })
  }

  static async create(options: FrozenPlaytestOptions): Promise<FrozenWorldRuntimeCore> {
    mkdirSync(resolve(options.dataDirectory), { recursive: true })
    const pack = await compileWorldPackSource(resolve(options.packPath), createInstalledInteractionPackages().map(interactionPackageDescription)) as CompiledWorldPackV5
    const compiled = adaptCompiledWorldPack(pack, {
      address: { tenantId: brandId('tenant:web-playtest', 'TenantId'),
        worldId: brandId(`world:web-playtest:${pack.packHash.slice(7, 23)}`, 'WorldId'),
        branchId: brandId('branch:main', 'BranchId') },
      principalId: 'principal:web-playtest',
      sessionId: brandId('session:web-playtest', 'SessionId'),
    })
    const intentEnabled = (compiled.manifest as { readonly playerInputPolicy?: { readonly version: string } })
      .playerInputPolicy?.version === 'player-intent/v1'
    const runtime = new FrozenWorldRuntimeCore(options, compiled, intentEnabled)
    try {
      runtime.#packHash = pack.packHash
      runtime.#storyParentNodeId = options.storyParentNodeId ?? null
      runtime.#application.activate(compiled)
      runtime.#variables = PackVariables.load(options.packPath, options.dataDirectory, pack)
      runtime.#activity = PackActivities.load(options.packPath, pack, resolve(options.dataDirectory, 'world.sqlite'), runtime.#address, runtime.#playerId)
      await runtime.#refresh()
      const rebuildPath = resolve(options.dataDirectory, 'rebuild-memory.json')
      if (existsSync(rebuildPath)) {
        const rebuild = JSON.parse(readFileSync(rebuildPath, 'utf8')) as {headSeq:number;packHash:string}
        if (!runtime.#memoryCore || rebuild.packHash !== pack.packHash) throw new Error('故事线记忆恢复需要原游戏包与 Core 记忆。')
        const head = await runtime.#application.head(runtime.#address)
        if (head.headSeq !== rebuild.headSeq) throw new Error('故事节点的世界前缀不一致。')
        // Restoring derived archives must not hold a world writer across file installation.
        await runtime.#application.release(runtime.#address)
        const memoryPath = resolve(options.dataDirectory, 'core-memory.json')
        const archives = existsSync(memoryPath) ? JSON.parse(readFileSync(memoryPath, 'utf8')) as WorldJsonObject : {}
        if (!archives || typeof archives !== 'object' || Array.isArray(archives)) throw new Error('故事节点记忆快照损坏。')
        runtime.#memoryCore.restoreArchives(archives, runtime.#characterIds)
        runtime.#memoryCore.snapshotAliases(runtime.#characterIds)
        unlinkSync(rebuildPath)
      }
      if (options.storyNodes && readStoryNodes(options.logicalDirectory ?? options.dataDirectory).length === 0) await runtime.saveNode('首次保存节点')
      if (options.shadowAudit !== undefined) {
        if (options.shadowAudit.items.some(item => !compiled.manifest.entities.some(entity => entity.entityId === item.entityId))) {
          throw new TypeError('shadow item is not declared in this Pack')
        }
        const head = await runtime.#application.head(runtime.#address)
        runtime.#shadow = new JevShadow({ ...options.shadowAudit, address: runtime.#address,
          characters: compiled.manifest.characters.map(character => ({ characterId: character.characterId, name: character.name })),
          initialSeq: head.headSeq, readEvents: asOfSeq => {
            const store = new WorldStore(resolve(options.dataDirectory, 'world.sqlite'))
            try { return store.readEvents(runtime.#address, asOfSeq) } finally { store.close() }
          } })
      }
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  }

  /** The world this session serves, so a caller can read it back without re-deriving the address. */
  get packHash(): string { return this.#packHash }
  validateCognition(): void { this.#memoryCore?.snapshotAliases(this.#characterIds) }
  get address(): WorldAddress {
    return this.#address
  }

  async state(): Promise<PlaytestState> {
    return {
      playerFeedback: { phase: this.#phaseLabel, message: this.#notice },
      busy: this.#busy, paused: this.#paused, phaseLabel: this.#phaseLabel,
      notice: this.#notice, error: this.#error, transcript: this.#transcript,
      playerSettings: {inputCharacters:this.#playSettings.playerInputCharacters,reading:this.#options.reading??DEFAULT_READING},
      availableActions: this.#availableActions,
      actionNames: Object.fromEntries(this.#availableActions.flatMap(a => (a.interactions ?? []).flatMap(option => {
        const recipient = (option.arguments as WorldJsonObject | undefined)?.recipientId
        const target = (option.targetRef as WorldJsonObject | undefined)?.id
        return [recipient, target].filter((id): id is string => typeof id === 'string' && this.#names.has(id))
          .map(id => [id, this.#names.get(id)!])
      }))),
      ...(this.#memoryCore ? { memoryMaintenance: this.#memoryCore.backgroundState() } : {}),
      ...(this.#activityView ? { activity: structuredClone(this.#activityView) } : {}),
      ...(this.#activityViews ? { activities: structuredClone(this.#activityViews) } : {}),
      ...(this.#variables ? { packVariables: this.#variables.getVariables(this.#playerId) } : {}),
      world: { title: this.#title, playerName: this.#playerName, npcNames: this.#npcNames,
        ...(this.#currentScene === undefined ? {} : { currentScene: this.#currentScene }) },
      debug: { ...this.#debug, worldVersion: this.#worldVersion, provider: this.#provider, model: this.#model, intentModel: this.#intentModel,
        providerCalls: this.#providerCalls, paused: this.#paused, lastPlayerIntent: this.#lastPlayerIntent,
        playerInputMode: this.#intentEnabled ? 'command-controlled' : 'legacy-speech',
        lastProviderCall: this.#lastCall,
        ...(this.#shadow === undefined ? {} : { shadowAudit: this.#shadow.stats() }) },
    }
  }

  /**
   * One player turn. A caller that is retrying an input the world already recorded passes that input's own
   * key: the store is idempotent by key, so the retry completes the queued input instead of adding another.
   */
  async submit(text: string, idempotencyKey?: string): Promise<PlaytestState> {
    if (this.#busy || this.#escaping || this.#closing) throw new PlaytestBusyError('请等待当前行动完成。')
    if (this.#paused) {
      this.#notice = 'NPC 已暂停：这次输入没有提交。恢复后再试。'
      return this.state()
    }
    if (this.#activity?.current()?.game.active) {
      if (text.startsWith('/') && !text.startsWith('/act ')) throw new TypeError('活动期间禁止变量调试与未声明命令。')
      this.#beginWork()
      try {
        await this.#application.release(this.#address)
        if (text.startsWith('/act ')) {
          const match = /^\/act (speak|move|interact) (.+)$/u.exec(text)
          if (match === null) throw new TypeError('动作命令格式无效')
          const parameters = JSON.parse(match[2]!) as WorldJsonObject
          await this.#activity.worldAction({ actionType: match[1]!, parameters }, idempotencyKey ?? randomUUID())
        } else await this.#activity.speak(text, idempotencyKey ?? randomUUID())
        this.#notice = '操作已提交；单纯对白不消耗游戏行动回合。'
        await this.#activateCharacters(true)
      } finally { try { await this.#refresh() } finally { this.#endWork() } }
      return this.state()
    }
    if (text.startsWith('/vars ')) {
      if (!this.#variables) throw new TypeError('本包没有变量脚本')
      this.#variables.applyPatch(this.#playerId, JSON.parse(text.slice(6)))
      this.#notice = '包变量已更新。'
      return this.state()
    }
    this.#beginWork()
    this.#error = false
    this.#notice = ''
    this.#phaseLabel = text.startsWith('/') ? '正在执行命令' : '正在提交发言'
    const key = idempotencyKey ?? `web-playtest:${randomUUID()}`
    try {
      this.#activationCycle = undefined
      this.#rootBeforeSeq = (await this.#application.head(this.#address)).headSeq
      this.#lastPlayerIntent = text.startsWith('/') ? 'command' : 'natural-language'
      const result = await this.#application.submitText(this.#address, { text, idempotencyKey: key,
        principalId: this.#principalId, correlationId: key })
      // A clarification is a durable answer, not a failure: nothing was spent and the world did not move.
      if (result.status === 'service_failed') {
        this.#error = true
        if (result.reason === 'candidate_source_order_invalid') {
          this.#notice = '模型把你的动作按与原文不符的顺序排列，这次输入没有提交。原文已保留；可以拆成“先表现、再移动”两句重试。'
          this.#lastPlayerIntent = 'model-output-invalid'
        } else if (result.reason === 'invalid_response') {
          this.#notice = '模型返回的输入解释格式无效，这次输入没有提交。原文已保留；可以重试或拆成两句。'
          this.#lastPlayerIntent = 'model-output-invalid'
        } else {
          this.#notice = '模型服务暂时无法完成请求，这次输入没有提交。请检查服务可用性后重试；无需改写输入。'
          this.#lastPlayerIntent = 'service-failed'
        }
      } else if (result.status === 'clarification_required') {
        this.#notice = `${result.reason}（这次命令没有提交；请检查命令参数，或用 /act 指定完整交互。）`
        this.#lastPlayerIntent = 'clarification'
      } else {
        const playerNotice = this.#playerResolutionNotice(key, result.result.headSeq)
        await this.#refresh()
        await this.#activateCharacters()
        if (playerNotice !== undefined) this.#notice = [playerNotice, this.#notice].filter(Boolean).join(' ')
      }
    } catch (error: unknown) {
      this.#error = true
      this.#notice = await this.#whatBecameOf(key)
      console.error('Frozen playtest turn failed:', error instanceof Error ? error.message : 'unknown error')
      throw error
    } finally {
      this.#endWork()
      this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
      await this.#refresh().catch(() => {})
    }
    return this.state()
  }

  #beginWork(): void {
    this.#abortedWork = false
    this.#busy = true
    this.#phaseLabel = '正在提交操作'
    this.#workDone = new Promise<void>(done => { this.#finishWork = done })
  }
  #endWork(): void {
    this.#busy = false
    this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
    this.#finishWork?.(); this.#finishWork = undefined
  }
  async activityAction(request: ActivityRequest): Promise<PlaytestState> {
    if (this.#busy || this.#escaping || this.#closing) throw new PlaytestBusyError('请等待当前处理完成，或使用逃生按钮。')
    if (this.#paused) throw new TypeError('请先恢复 NPC，或使用逃生按钮。')
    if (!this.#activity) throw new TypeError('本包没有安装游戏脚本。')
    this.#beginWork(); this.#error = false
    try {
      await this.#application.release(this.#address)
      const changed = await this.#activity.apply(request)
      this.#notice = changed ? '游戏操作已提交。' : '已返回原提交结果，没有再次执行。'
      if (changed) await this.#activateCharacters(true)
    } finally { try { await this.#refresh() } finally { this.#endWork() } }
    return this.state()
  }
  async saveNode(title: string) {
    if (this.#busy || this.#escaping || this.#closing || this.#paused) throw new PlaytestBusyError('请等待当前行动完成并恢复 NPC 后保存节点。')
    this.#savingNode = true
    this.#beginWork()
    try {
      this.#memoryCore?.cancelBackground()
      await this.#memoryCore?.waitForBackground()
      await this.#application.deliver(this.#address, 'story-node:deliver')
      await this.#application.release(this.#address)
      const aliases = this.#memoryCore?.snapshotAliases(this.#characterIds) ?? {}
      return await saveStoryNode(this.#dataDirectory, this.#address, this.#packHash, title, aliases, this.#storyParentNodeId, this.#options.logicalDirectory, this.#memoryCore?.snapshotArchives(this.#characterIds) ?? {})
    } finally { this.#savingNode = false; this.#endWork() }
  }
  beginRoundRandom(values?: readonly number[]): void { this.#activity?.beginRoundRandom(values) }
  roundRandom(): number[] { return this.#activity?.roundRandom() ?? [] }
  holdCognition(): void { this.#memoryCore?.holdInstallation() }
  releaseCognition(): void { this.#memoryCore?.releaseInstallation() }
  abortWork(): void { this.#abortedWork = true; this.#continuationController?.abort() }
  async settleRound() {
    if (this.#busy || this.#escaping || this.#paused) throw new PlaytestBusyError('当前玩家回合尚未完成。')
    await this.#application.deliver(this.#address, 'tail-round:deliver')
    await this.#application.release(this.#address)
    return assertSettled(this.#dataDirectory, this.#address)
  }
  async snapshotRound(target: string): Promise<void> {
    await this.settleRound()
    const aliases = this.#memoryCore?.snapshotAliases(this.#characterIds) ?? {}
    await snapshotTail(this.#dataDirectory, target, this.#address, aliases)
  }
  async refreshMemory(): Promise<PlaytestState> {
    if (this.#savingNode || this.#closing) throw new PlaytestBusyError('正在保存节点。')
    if (!this.#memoryCore) throw new TypeError('本次试玩没有开启实验记忆。')
    this.#memoryCore.startRefresh(this.#characterIds)
    this.#notice = '长期记忆已开始后台整理，可以继续游玩。'
    return this.state()
  }
  async cancelMemory(): Promise<PlaytestState> {
    this.#memoryCore?.cancelBackground()
    this.#notice = '已取消未完成的后台整理；已安装档案和近期经历保留。'
    return this.state()
  }
  async waitForMemory(): Promise<void> { await this.#memoryCore?.waitForBackground() }
  async escape(): Promise<PlaytestState> {
    if (this.#savingNode || this.#closing) throw new PlaytestBusyError('正在保存节点。')
    if (this.#escaping) return this.#escaping
    // Set the override before awaiting anything. Late model outputs are cancelled,
    // and the host waits for the in-flight writer to release its lease.
    this.#continuationController?.abort()
    this.#escaping = (async () => {
      await this.#workDone
      await this.#application.release(this.#address)
      await this.#activity?.escape()
      this.#paused = false; this.#error = false; this.#phaseLabel = '可以输入'
      this.#notice = '已逃离活动，恢复原本合法的交互能力；已经提交的经历保留。'
      await this.#refresh()
      return this.state()
    })()
    try { return await this.#escaping } finally { this.#escaping = undefined }
  }

  /** Structured UI choices remain proposals and follow the same Rulebook path as /act. */
  async perform(action: PlaytestAction): Promise<PlaytestState> {
    if(action.actionType==='interact' && ['host:activity-start','host:activity-retry','host:activity-suspend','host:activity-resume','host:activity-abandon'].includes(String((action.parameters.definitionRef as WorldJsonObject|undefined)?.id))){
      const current=action.parameters.activityKey===undefined?this.#activity?.view(this.#playerId)
        :this.#activity?.views(this.#playerId).find(view=>view.activityKey===action.parameters.activityKey)
      if(!current || (current.id??null)!==action.parameters.previousId || (current.revision??0)!==action.parameters.previousRevision)
        throw new TypeError('活动入口已失效，请刷新')
      const operation=String((action.parameters.definitionRef as WorldJsonObject).id).slice('host:activity-'.length)
      if(operation!=='start'&&action.parameters.startParameters!==undefined)throw new TypeError('只有开始活动可选择参与者')
      const startParameters=action.parameters.startParameters
      if(startParameters!==undefined&&(!startParameters||typeof startParameters!=='object'||Array.isArray(startParameters)))throw new TypeError('开始参数无效')
      return this.activityAction({activityKey:String(current.activityKey),activityId:operation==='start'?null:String(current.id),revision:operation==='start'?0:Number(current.revision),operation,parameters:(startParameters as WorldJsonObject|undefined)??{},requestId:randomUUID()})
    }
    return this.submit(`/act ${action.actionType} ${JSON.stringify(action.parameters)}`)
  }
  /** The round result names only its first action; report any later player action rejected in the same commit. */
  #playerResolutionNotice(idempotencyKey: string, headSeq: number): string | undefined {
    if (!this.#intentEnabled) return undefined
    const worldPath = resolve(this.#dataDirectory, 'world.sqlite')
    const jobs = new PlayerInputJobs(worldPath)
    const world = new WorldStore(worldPath)
    try {
      const validated = jobs.read(this.#address, idempotencyKey)?.records.validated as {
        sourceText?: string
        actions?: readonly { actionId: string; actionType: string }[]
        sourceSpans?: readonly { actionId: string; endUtf16: number; text: string }[]
      } | undefined
      if (validated?.actions === undefined) return undefined
      const resolutions = new Map(world.readEvents(this.#address, headSeq)
        .filter(event => event.eventType === 'action.resolved' && (event.data as WorldJsonObject).sourceRole === 'player')
        .map(event => { const data = event.data as WorldJsonObject; return [data.actionId, data] as const }))
      const failed = validated.actions.filter(action => resolutions.get(action.actionId)?.accepted !== true)
      const accepted = validated.actions.length - failed.length
      const details = failed.map(action => {
        const quote = validated.sourceSpans?.filter(span => span.actionId === action.actionId).map(span => span.text).join('')
        const reason = resolutions.get(action.actionId)?.reason
        return `“${quote || action.actionType}”未执行${typeof reason === 'string' ? `（${reason}）` : ''}`
      }).join('；')
      const lastEnd = Math.max(0, ...(validated.sourceSpans ?? []).map(span => span.endUtf16))
      const trailing = validated.sourceText?.slice(lastEnd).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '') ?? ''
      const omitted = trailing === '' ? '' : `句尾“${trailing.length > 80 ? `${trailing.slice(0, 80)}…` : trailing}”没有映射到本次动作或表达。`
      if (failed.length === 0 && omitted === '') return undefined
      const rejected = failed.length === 0 ? '' : `${accepted > 0 ? '玩家输入已部分提交' : '玩家动作未成功'}：${details}。`
      return `${rejected}${omitted}请以转录和当前场景为准。`
    } finally { world.close(); jobs.close() }
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
    } finally { jobs.close() }
  }

  async pause(): Promise<PlaytestState> {
    this.#paused = true
    this.#continuationController?.abort()
    this.#notice = 'NPC 已暂停：暂停期间的输入不会推进世界。'
    return this.state()
  }

  async resume(): Promise<PlaytestState> {
    this.#paused = false
    this.#notice = '已恢复。'
    this.#phaseLabel = '可以输入'
    await this.#refresh().catch(() => {})
    return this.state()
  }

  async close(): Promise<void> {
    this.#closing = true
    this.#inspector.configure(false)
    this.#continuationController?.abort()
    const closingMemory = this.#memoryCore?.close()
    await this.#workDone
    await closingMemory
    await this.#closeCore?.()
    await this.#shadow?.close()
    await this.#application.close()
  }

  async #activateCharacters(activityOnly = false): Promise<void> {
    await this.#application.release(this.#address)
    if (this.#escaping || this.#closing || this.#abortedWork) return
    const path = resolve(this.#dataDirectory, 'world.sqlite')
    const store = new WorldStore(path), leases = new WriterLeaseService(path)
    const availability = new CharacterRuntimeAvailabilityService(path)
    let memory: CognitiveMemoryService | undefined
    this.#continuationController = new AbortController()
    try {
      if (this.#paused) return
      memory = new CognitiveMemoryService(resolve(this.#dataDirectory, 'memory.sqlite'),
        store, undefined, 2, RECALL_KEYWORD_TOKENIZER_ID)
      const shadowFile = this.#memoryShadowFile
      const turn = new PrototypeCharacterTurn({ publicationCharacters:this.#playSettings.publicationCharacters, activationTimeoutMs:this.#playSettings.activationTimeoutSeconds*1000, address: this.#address, store, leases, availability,
        ...(this.#memoryCore === undefined ? { memory } : {}),
        rulebooks: this.#activity?.rulebooks() ?? createCoreRulebookRegistry({ interactionPackages: createInstalledInteractionPackages() }),
        decide: this.#decideContinuation,
        onCommitted: async () => { await this.#projectCommitted(store) },
        ...(this.#activity === undefined ? {} : {
          projectContext: (context: WorldJsonObject, canPerform: boolean) => this.#activity!.projectContext(context, canPerform),
          validateDecision: (decision: WorldJsonObject, request: PrototypeTurnRequest) => this.#activity!.validateDecision(decision, request),
          executionResult: this.#activity.executionResult,
        }),
        ...(this.#memoryCore === undefined ? {} : { shortTermAfterSeq: (actor: CharacterId) => this.#memoryCore!.shortTermAfterSeq(actor) }),
        recentObservations: this.#tuning.recentObservations,
        recentSelfObservations: this.#tuning.recentSelfObservations,
        ...(shadowFile === undefined ? {} : { onRecallShadow: (observation: PrototypeRecallShadowObservation) =>
          appendFileSync(shadowFile, JSON.stringify(observation) + '\n') }), })
      this.#phaseLabel = '角色正在处理场景与行动结果'
      const active = this.#activity?.current()
      let selected = this.#activity?.schedule()
      // Creator selects the next participant; the host bounds the entire chain.
      const activitySignal = AbortSignal.any([this.#continuationController.signal, AbortSignal.timeout(this.#playSettings.activityDeadlineSeconds*1000)])
      for (let opportunity = 0; opportunity < this.#playSettings.activityOpportunities && selected !== undefined && !activitySignal.aborted && !this.#paused; opportunity++) {
        const result = await turn.run(brandId(selected, 'CharacterId'), {
          signal: activitySignal, maxCalls: 2,
          stimulus: new CharacterViewBuilder(store)
            .rebuildAt(this.#address, brandId(selected, 'CharacterId'), store.head(this.#address).headSeq)
            .observations.toSorted((left, right) => left.sourceSeq - right.sourceSeq)
            .slice(-8).map(o => o.value as WorldJsonObject),
        })
        this.#error = result.failure !== undefined
        this.#notice = result.failure === undefined ? (result.status === 'abstained'
          ? '角色本次没有提交操作，当前轮次保留；可以再次请求处理或逃生。' : '角色处理已完成。')
          : result.failure === 'invalid_output' ? '角色返回格式无效，当前轮次没有推进；可重试或逃生。'
            : '角色决策处理未完成，当前轮次没有推进；可重试或逃生。'
        selected = activitySignal.aborted ? undefined : this.#activity!.outcome(result as unknown as WorldJsonObject)
        if (opportunity === this.#playSettings.activityOpportunities-1 && selected !== undefined) this.#notice = '本次活动处理达到宿主预算上限；已提交结果保留，可再次请求处理或逃生。'
      }
      if (activitySignal.aborted) {
        this.#notice = '活动处理已取消或超时；已提交结果保留，未完成操作没有换手。'
        this.#error = true
      }
      if (activityOnly) return
      this.#activationCycle = await runPrototypeActivations({ store, address: this.#address, turn,
        afterSeq: this.#rootBeforeSeq, characterIds: this.#characterIds.filter(id => !active?.game.active || !active.participants.includes(id)), signal: this.#continuationController.signal,
        presentCharacterIds: () => (this.#currentScene?.recipients ?? []).map(person => brandId(person.id, 'CharacterId')),
        limits: this.#tuning })
      const terminal = this.#activationCycle.terminalReason
      if (terminal === 'failed' || terminal === 'interrupted') {
        const last = this.#activationCycle.activations.at(-1)?.result
        const committed = last?.performResult !== undefined
        const cause = terminal === 'interrupted' ? '角色处理被打断或超时'
          : last?.failure === 'invalid_output' ? '角色返回格式无效'
            : last?.failure === 'preset_failed' ? '角色预设处理失败，请检查提示节点与文本规则'
            : last?.failure === 'provider_failed' ? '角色模型服务未完成请求' : '角色处理失败'
        this.#error = true
        this.#notice = `玩家输入已提交；${cause}。${committed
          ? '交互结果已提交，后续表达未完成；请看转录中的实际结果。可以继续行动，无需重发上一句。'
          : '已经发表的回应保留；尚未完成的角色行动或表达没有提交。可以继续行动，无需重发上一句。'}`
      } else if (terminal === 'call_limit' || terminal === 'wave_limit' || terminal === 'character_limit') {
        this.#notice = '玩家输入已提交；本轮角色反应达到预算上限，剩余反应没有继续执行。可以继续行动，无需重发上一句。'
      } else {
        this.#notice = '本轮角色处理已结束，可以继续行动；角色也可以选择不回应。'
      }
    } finally {
      memory?.close(); availability.close(); leases.close(); store.close()
      this.#continuationController = undefined
      if (!this.#paused && !this.#escaping) this.#memoryCore?.startPending()
    }
  }

  /** The active NPC owns the writer lease. Project its committed prefix without remounting the app. */
  async #projectCommitted(store: WorldStore): Promise<void> {
    const head = store.head(this.#address)
    const view = new CharacterViewBuilder(store).rebuildAt(this.#address, this.#playerId, head.headSeq)
    const availability = new CharacterRuntimeAvailabilityService(resolve(this.#dataDirectory, 'world.sqlite'))
    try {
      const scene = new SceneDecisionService(store, availability, this.#sceneVersion)
        .decideFromEvents(this.#address, this.#playerId, store.readEvents(this.#address, head.headSeq), head.headSeq)
      this.#transcript = playerTranscript(await presetDisplay(view, this.#effectivePresets), this.#names, this.#playerId)
      this.#currentScene = {
        locationName: view.locationId === null ? '未知地点' : this.#locationNames.get(view.locationId) ?? view.locationId,
        recipients: scene.observerIds.filter(id => id !== this.#playerId).map(id => ({ id, name: this.#names.get(id) ?? id })),
        presentNpcNames: scene.observerIds.filter(id => id !== this.#playerId).map(id => this.#names.get(id) ?? id),
      }
      this.#debug = { ...this.#debug, headSeq: head.headSeq, tick: head.tick, worldVersion: this.#worldVersion,
        visibleSceneIds: view.scenes.map(scene => scene.sceneId) }
    } finally { availability.close() }
  }

  async #refresh(): Promise<void> {
    const [view, head] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
    ])
    this.#transcript = playerTranscript(await presetDisplay(view, this.#effectivePresets), this.#names, this.#playerId)
    this.#availableActions = await this.#application.playerAffordancesForPrincipal(
      this.#address, this.#principalId, this.#playerId, view.asOfWorldSeq)

    const worldPath = resolve(this.#dataDirectory, 'world.sqlite')
    const world = new WorldStore(worldPath)
    try {
      const availability = new CharacterRuntimeAvailabilityService(worldPath)
      try {
        const scene = new SceneDecisionService(world, availability, this.#sceneVersion)
          .decideFromEvents(this.#address, this.#playerId,
            world.readEvents(this.#address, view.asOfWorldSeq), view.asOfWorldSeq)
        this.#currentScene = {
          locationName: view.locationId === null ? '未知地点'
            : this.#locationNames.get(view.locationId) ?? view.locationId,
          recipients: scene.observerIds.filter(id => id !== this.#playerId).map(id => ({ id, name: this.#names.get(id) ?? id })),
        presentNpcNames: scene.observerIds.filter(id => id !== this.#playerId)
            .map(id => this.#names.get(id) ?? id),
        }
      } finally {
        availability.close()
      }
    } finally {
      world.close()
    }
    // Like transcript and affordances, serve the last refreshed committed projection.
    // Polling must not open a migrating writer while tail snapshots copy the database.
    this.#activityView = this.#activity?.view(this.#playerId)
    this.#activityViews = this.#activity?.views(this.#playerId)
    const activityState = this.#activity?.current()
    if (activityState?.game.active && activityState.participants.includes(this.#playerId)) {
      this.#availableActions = this.#activity!.filterAffordances(this.#availableActions, activityState, this.#playerId)
    }
    this.#debug = {
      headSeq: head.headSeq, tick: head.tick, worldVersion: this.#worldVersion, manifestVersion: this.#manifestVersion,
      outputProtocol: 'perform/publish(segments)/abstain', memoryMode: this.#memoryCore ? 'core' : 'native',
      activationCycle: this.#activationCycle ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
    }
    this.#shadow?.observe(head.headSeq)
  }
}

/** Public runtime owns one logical storyline and its replaceable tail. */
export class FrozenWorldPlaytestRuntime extends TailRoundRuntime {
  static async create(options: FrozenPlaytestOptions): Promise<FrozenWorldPlaytestRuntime> {
    return TailRoundRuntime.open(options, value => FrozenWorldRuntimeCore.create(value))
  }
}
