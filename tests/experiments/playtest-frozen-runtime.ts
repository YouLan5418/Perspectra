import { PlaytestMemoryCore, type MemoryContextBudget, type MemoryBuildOptions } from './playtest-memory-core.ts'
import { createCoreWorker, coreRunner, type CoreRunner } from './hindsight-python.ts'
import { PackActivity, type ActivityRequest } from './pack-activity.ts'
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
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
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
  readonly provider: 'local' | 'deepseek' | 'ollama'
  readonly model?: string
  readonly intentModel?: string
  /** The Host's Secret, from the environment. It is never written to the data directory. */
  readonly apiKey?: string
  readonly utilityEndpoint?: string
  readonly timeoutMs?: number
  readonly tuning?: PlaytestTuning
  readonly shadowAudit?: ShadowOptions
  readonly memoryShadow?: boolean
  readonly memoryCore?: boolean
  readonly memoryCoreRun?: CoreRunner
  readonly memoryCoreBuildRun?: CoreRunner
  readonly memoryBuildConcurrency?: Omit<MemoryBuildOptions, 'run'>
  readonly memoryContextBudget?: MemoryContextBudget
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
export class FrozenWorldPlaytestRuntime implements PlaytestRuntime {
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
  #memoryCore: PlaytestMemoryCore | undefined
  #closeCore: (() => Promise<void>) | undefined
  #activity: PackActivity | undefined
  #workDone: Promise<void> = Promise.resolve()
  #finishWork: (() => void) | undefined
  #escaping: Promise<PlaytestState> | undefined
  #variables: PackVariables | undefined
  #activationCycle: Awaited<ReturnType<typeof runPrototypeActivations>> | undefined
  readonly #provider: 'local' | 'deepseek' | 'ollama'
  readonly #manifestVersion: number
  readonly #intentEnabled: boolean
  readonly #dataDirectory: string
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
    this.#address = compiled.manifest.address
    this.#dataDirectory = options.dataDirectory
    this.#tuning = options.tuning ?? DEFAULT_PLAYTEST_TUNING
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
    const timeoutMs = options.timeoutMs ?? (options.provider === 'ollama' ? 120_000 : 60_000)
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
    const provider = createChatProvider({ endpoint, model: this.#model,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      style: options.provider === 'ollama' ? 'format' : 'tool', timeoutMs, onCall })
    const characters = playtestModelCharacters(compiled.manifest, this.#playerId)
    this.#characterIds = characters.map(character => character.actorId)
    if (options.memoryCore) {
      if (options.provider !== 'local') throw new TypeError('实验 Core 网页目前只支持本机 OpenAI 兼容接口。')
      const coreEnvironment = {
        HCW_LOCAL_MODEL: this.#model, HCW_LOCAL_ENDPOINT: endpoint.href,
        ...(options.apiKey === undefined ? {} : { HCW_LOCAL_API_KEY: options.apiKey }),
        HCW_HINDSIGHT_UTILITY_ATTEMPTS: resolve(options.dataDirectory, 'memory-core', 'utility-attempts.jsonl'),
      }
      const worker = options.memoryCoreRun === undefined ? createCoreWorker(coreEnvironment) : undefined
      this.#closeCore = worker?.close
      this.#memoryCore = new PlaytestMemoryCore(options.dataDirectory, this.#address, options.memoryCoreRun ?? worker!.run, options.memoryContextBudget,
        { ...options.memoryBuildConcurrency, run: options.memoryCoreBuildRun ?? coreRunner(coreEnvironment) })
    }
    this.#decideContinuation = async (request, signal) => {
      if (this.#memoryCore) request = await this.#memoryCore.project(request, signal)
      const character = request.context.character as WorldJsonObject
      const variables = this.#variables?.getVariables(String(character.characterId))
      if (variables) request = { ...request, context: { ...request.context,
        packVariables: { public: variables.public, private: variables.private } } }
      const prepared = options.provider === 'local' ? localPrototypeTurnCall(request) : prototypeTurnCall(request)
      this.#memoryCore?.observeContext(request, prepared.messages.map(message => message.content).join('\n')
        + JSON.stringify(prepared.schema))
      const raw = await provider.decide(prepared, signal)
      this.#memoryCore?.recordDecision(request, raw)
      if (options.publicationAudit === undefined) return raw
      const store = new WorldStore(resolve(options.dataDirectory, 'world.sqlite'))
      let history
      try { history = store.readEvents(this.#address) } finally { store.close() }
      return auditBeforePublication({ request, raw, history, options: options.publicationAudit, signal,
        decide: async revised => provider.decide(options.provider === 'local'
          ? localPrototypeTurnCall(revised) : prototypeTurnCall(revised), signal) })
    }
    this.#npcNames = characters.map(character => character.name)
    // The Host's interpretation profile is a contract with the world, and its deadline ceiling is part of
    // it: a longer call deadline is the adapter's business, not something to state in the profile.
    const intentProfile = { version: 'player-intent-profile/v1' as const, providerId: 'chat-completions',
      modelId: this.#intentModel, maxOutputTokens: 1_024, timeoutMs: Math.min(timeoutMs, 60_000) }
    this.#application = new WorldApplication({
      externalCharacterActivations: true,
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

  static async create(options: FrozenPlaytestOptions): Promise<FrozenWorldPlaytestRuntime> {
    mkdirSync(resolve(options.dataDirectory), { recursive: true })
    const pack = await compileWorldPackSource(resolve(options.packPath), [
      interactionPackageDescription(createBasicInteractionPackage()),
    ]) as CompiledWorldPackV5
    const compiled = adaptCompiledWorldPack(pack, {
      address: { tenantId: brandId('tenant:web-playtest', 'TenantId'),
        worldId: brandId(`world:web-playtest:${pack.packHash.slice(7, 23)}`, 'WorldId'),
        branchId: brandId('branch:main', 'BranchId') },
      principalId: 'principal:web-playtest',
      sessionId: brandId('session:web-playtest', 'SessionId'),
    })
    const intentEnabled = (compiled.manifest as { readonly playerInputPolicy?: { readonly version: string } })
      .playerInputPolicy?.version === 'player-intent/v1'
    const runtime = new FrozenWorldPlaytestRuntime(options, compiled, intentEnabled)
    try {
      runtime.#application.activate(compiled)
      runtime.#variables = PackVariables.load(options.packPath, options.dataDirectory, pack)
      runtime.#activity = PackActivity.load(options.packPath, pack, resolve(options.dataDirectory, 'world.sqlite'), runtime.#address, runtime.#playerId)
      await runtime.#refresh()
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
  get address(): WorldAddress {
    return this.#address
  }

  async state(): Promise<PlaytestState> {
    return {
      busy: this.#busy, paused: this.#paused, phaseLabel: this.#phaseLabel,
      notice: this.#notice, error: this.#error, transcript: this.#transcript,
      availableActions: this.#availableActions,
      ...(this.#memoryCore ? { memoryMaintenance: this.#memoryCore.backgroundState() } : {}),
      ...(this.#activity ? { activity: this.#activity.view(this.#playerId) } : {}),
      ...(this.#variables ? { packVariables: this.#variables.getVariables(this.#playerId) } : {}),
      world: { title: this.#title, playerName: this.#playerName, npcNames: this.#npcNames,
        ...(this.#currentScene === undefined ? {} : { currentScene: this.#currentScene }) },
      debug: { ...this.#debug, provider: this.#provider, model: this.#model, intentModel: this.#intentModel,
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
    if (this.#busy || this.#escaping) throw new PlaytestBusyError('请等待当前行动完成。')
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
    this.#busy = true
    this.#workDone = new Promise<void>(done => { this.#finishWork = done })
  }
  #endWork(): void {
    this.#busy = false
    this.#finishWork?.(); this.#finishWork = undefined
  }
  async activityAction(request: ActivityRequest): Promise<PlaytestState> {
    if (this.#busy || this.#escaping) throw new PlaytestBusyError('请等待当前处理完成，或使用逃生按钮。')
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
  async refreshMemory(): Promise<PlaytestState> {
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
    if (this.#escaping) return
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
      const turn = new PrototypeCharacterTurn({ address: this.#address, store, leases, availability,
        ...(this.#memoryCore === undefined ? { memory } : {}),
        rulebooks: this.#activity?.rulebooks() ?? createCoreRulebookRegistry({ interactionPackages: [createBasicInteractionPackage()] }),
        decide: this.#decideContinuation,
        onCommitted: async () => { this.#projectCommitted(store) },
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
      const activitySignal = AbortSignal.any([this.#continuationController.signal, AbortSignal.timeout(90_000)])
      for (let opportunity = 0; opportunity < 4 && selected !== undefined && !activitySignal.aborted && !this.#paused; opportunity++) {
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
          : '角色模型未完成有效操作，当前轮次没有冒充主动让出；可重试或逃生。'
        selected = activitySignal.aborted ? undefined : this.#activity!.outcome(result as unknown as WorldJsonObject)
        if (opportunity === 3 && selected !== undefined) this.#notice = '本次活动处理达到宿主预算上限；已提交结果保留，可再次请求处理或逃生。'
      }
      if (activitySignal.aborted) {
        this.#notice = '活动处理已取消或超时；已提交结果保留，未完成操作没有换手。'
        this.#error = true
      }
      if (activityOnly) return
      this.#activationCycle = await runPrototypeActivations({ store, address: this.#address, turn,
        afterSeq: this.#rootBeforeSeq, characterIds: this.#characterIds.filter(id => !active?.game.active || !active.participants.includes(id)), signal: this.#continuationController.signal,
        limits: this.#tuning })
      const terminal = this.#activationCycle.terminalReason
      if (terminal === 'failed' || terminal === 'interrupted') {
        const last = this.#activationCycle.activations.at(-1)?.result
        const committed = last?.performResult !== undefined
        const cause = terminal === 'interrupted' ? '角色处理被打断或超时'
          : last?.failure === 'invalid_output' ? '角色返回格式无效'
            : last?.failure === 'provider_failed' ? '角色模型服务未完成请求' : '角色处理失败'
        this.#error = true
        this.#notice = `玩家输入已提交；${cause}。${committed
          ? '交互结果已提交，后续表达未完成；请看转录中的实际结果。'
          : '本次未完成的角色行动或表达没有提交。'}`
      } else if (terminal === 'call_limit' || terminal === 'wave_limit' || terminal === 'character_limit') {
        this.#notice = '玩家输入已提交；本轮角色反应达到预算上限，剩余反应没有继续执行。'
      }
    } finally {
      memory?.close(); availability.close(); leases.close(); store.close()
      this.#continuationController = undefined
      if (!this.#paused && !this.#escaping) this.#memoryCore?.startPending()
    }
  }

  /** The active NPC owns the writer lease. Project its committed prefix without remounting the app. */
  #projectCommitted(store: WorldStore): void {
    const head = store.head(this.#address)
    const view = new CharacterViewBuilder(store).rebuildAt(this.#address, this.#playerId, head.headSeq)
    const availability = new CharacterRuntimeAvailabilityService(resolve(this.#dataDirectory, 'world.sqlite'))
    try {
      const scene = new SceneDecisionService(store, availability, this.#sceneVersion)
        .decideFromEvents(this.#address, this.#playerId, store.readEvents(this.#address, head.headSeq), head.headSeq)
      this.#transcript = playerTranscript(view, this.#names, this.#playerId)
      this.#currentScene = {
        locationName: view.locationId === null ? '未知地点' : this.#locationNames.get(view.locationId) ?? view.locationId,
        presentNpcNames: scene.observerIds.filter(id => id !== this.#playerId).map(id => this.#names.get(id) ?? id),
      }
      this.#debug = { ...this.#debug, headSeq: head.headSeq, tick: head.tick,
        visibleSceneIds: view.scenes.map(scene => scene.sceneId) }
    } finally { availability.close() }
  }

  async #refresh(): Promise<void> {
    const [view, head] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
    ])
    this.#transcript = playerTranscript(view, this.#names, this.#playerId)
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
          presentNpcNames: scene.observerIds.filter(id => id !== this.#playerId)
            .map(id => this.#names.get(id) ?? id),
        }
      } finally {
        availability.close()
      }
    } finally {
      world.close()
    }
    const activityState = this.#activity?.current()
    if (activityState?.game.active && activityState.participants.includes(this.#playerId)) {
      this.#availableActions = this.#activity!.filterAffordances(this.#availableActions, activityState, this.#playerId)
    }
    this.#debug = {
      headSeq: head.headSeq, tick: head.tick, manifestVersion: this.#manifestVersion,
      outputProtocol: 'perform/publish/abstain', memoryMode: this.#memoryCore ? 'core' : 'native',
      activationCycle: this.#activationCycle ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
    }
    this.#shadow?.observe(head.headSeq)
  }
}
