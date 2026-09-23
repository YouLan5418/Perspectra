import { runPrototypeActivations } from '../../packages/application/src/prototype-activation-cycle.ts'
import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { SceneDecisionService, WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription, type ActionRequest, type CharacterId, type SubmitActionsV7, type WorldJsonObject,
  type WorldAddress } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { actionGroupCall, createChatProvider, prototypeTurnCall, type ChatCallObservation, type ExactProviderRequest } from '@harness-world/provider-chat'
import { CharacterRuntimeAvailabilityService, PlayerInputJobs, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { PrototypeCharacterTurn, type PrototypeTurnRequest, type PrototypeTurnResult } from '../../packages/application/src/prototype-character-turn.ts'
import { characterExecutionResult, expressionAfterExecution } from '../../packages/application/src/character-execution-result.ts'
import type { CompiledWorldManifest } from '@harness-world/kernel'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { PlaytestBusyError, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'
import { defaultPlaytestDirectory, playtestModelCharacters, playerTranscript } from './playtest-runtime.ts'

export interface FrozenPlaytestOptions {
  /** false only for historical batch experiments. New playtests use single-character activations. */
  readonly singleCharacterActivations?: boolean
  readonly dataDirectory: string
  /** The v5 Pack directory: the world the author wrote, compiled here with the Host's installed packages. */
  readonly packPath: string
  readonly provider: 'deepseek' | 'ollama'
  readonly model?: string
  readonly intentModel?: string
  /** The Host's Secret, from the environment. It is never written to the data directory. */
  readonly apiKey?: string
  readonly utilityEndpoint?: string
  readonly timeoutMs?: number
  /** One explicitly selected NPC: Root item operation commits normally, then gets one continuation. */
  readonly performNpcId?: string
}

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

/** The prototype web host: player submission commits first, then bounded sequential NPC activations.
 * Historical batch mode remains available only for comparison experiments.
 */
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
  readonly #singleCharacterActivations: boolean
  readonly #characterIds: readonly CharacterId[]
  #activationCycle: Awaited<ReturnType<typeof runPrototypeActivations>> | undefined
  readonly #provider: 'deepseek' | 'ollama'
  readonly #manifestVersion: number
  readonly #intentEnabled: boolean
  readonly #dataDirectory: string
  #transcript: PlaytestState['transcript'] = []
  #currentScene: NonNullable<PlaytestState['world']['currentScene']> | undefined
  #debug: Record<string, unknown> = {}
  #busy = false
  #paused = false
  #notice = ''
  #error = false
  #phaseLabel = '可以输入'
  #providerCalls = 0
  #lastCall: ChatCallObservation | null = null
  #lastPlayerIntent: string | null = null
  #rootInProgress = false
  #pendingPerform: ActionRequest | undefined
  #performContinuation: PrototypeTurnResult | undefined
  #performAfterSeq = 0
  #continuationController: AbortController | undefined
  #performReactionContinuation: { operationId: string; calls: number; stage: string } | undefined
  readonly #decideContinuation: (request: PrototypeTurnRequest, signal: AbortSignal) => Promise<unknown>

  private constructor(options: FrozenPlaytestOptions, compiled: ReturnType<typeof adaptCompiledWorldPack>,
    intentEnabled: boolean) {
    this.#singleCharacterActivations = options.singleCharacterActivations !== false
    this.#address = compiled.manifest.address
    this.#dataDirectory = options.dataDirectory
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
    this.#model = options.model ?? (options.provider === 'ollama' ? OLLAMA_MODEL : DEEPSEEK_MODEL)
    this.#intentModel = options.intentModel ?? this.#model
    const timeoutMs = options.timeoutMs ?? (options.provider === 'ollama' ? 120_000 : 60_000)
    const endpoint = options.provider === 'ollama'
      ? new URL(options.utilityEndpoint ?? OLLAMA_ENDPOINT) : new URL(DEEPSEEK_ENDPOINT)
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
    if (options.performNpcId !== undefined && !characters.some(character => character.actorId === options.performNpcId)) {
      throw new TypeError('performNpcId must identify an NPC in this Pack')
    }
    this.#decideContinuation = (request, signal) => provider.decide(prototypeTurnCall(request), signal)
    this.#npcNames = characters.map(character => character.name)
    // The adapter returns what the model stated, unjudged; the Host's participant type names the frozen
    // protocol's payload, and the world's validator is what decides whether that is what it got.
    const propose = async (context: unknown): Promise<SubmitActionsV7> =>
      await provider.propose(context) as SubmitActionsV7
    const participants = characters.map((character, index) => ({
      participantId: character.participantId, role: 'agent' as const, actorId: character.actorId,
      allowedActionTypes: ['speak', 'move', 'interact'],
      priority: characters.length - index, estimatedTokens: 1, timeoutMs: timeoutMs + 5_000,
      provider: { propose: async (context: unknown): Promise<SubmitActionsV7> => {
        if (!this.#rootInProgress && character.actorId === options.performNpcId && this.#pendingPerform !== undefined) {
          const operation = this.#pendingPerform
          const store = new WorldStore(resolve(this.#dataDirectory, 'world.sqlite'))
          let result
          let diagnosticReason: string | undefined
          try {
            const events = store.readEvents(this.#address)
            const resolved = events.findLast(event => event.eventType === 'action.resolved' && event.seq > this.#performAfterSeq
              && (event.data as Record<string, unknown>).actionId === operation.actionId
              && (event.data as Record<string, unknown>).actorId === character.actorId)?.data as Record<string, unknown> | undefined
            diagnosticReason = typeof resolved?.reason === 'string' ? resolved.reason : undefined
            if (resolved !== undefined) result = characterExecutionResult({
              manifest: store.readManifest(this.#address)!.manifest as CompiledWorldManifest, events,
              actorId: character.actorId, action: operation,
              status: resolved.accepted === true ? 'accepted' : 'rejected', reason: typeof resolved.reason === 'string' ? resolved.reason : null,
            })
          } finally { store.close() }
          if (result !== undefined) {
            this.#pendingPerform = undefined
            const exact = (context as { exactProviderRequest: ExactProviderRequest }).exactProviderRequest
            const messages = exact.messages.map(message => {
              if (diagnosticReason === undefined) return message
              try {
                const content = JSON.parse(message.content, (key, value: unknown) =>
                  key === 'reason' && value === diagnosticReason ? '该次请求未满足执行条件，没有执行成功。' : value)
                return { ...message, content: JSON.stringify(content) }
              } catch { return message }
            })
            const call = actionGroupCall({ ...exact, tools: { ...exact.tools,
              actionGroup: { ...(exact.tools.actionGroup as WorldJsonObject), allowedActionTypes: ['speak'] } },
              messages: [...messages, { role: 'user', content: JSON.stringify({
                executionResult: result, attemptedAction: { actionType: operation.actionType, parameters: operation.parameters },
                instruction: expressionAfterExecution,
              }) }] })
            this.#performReactionContinuation = { operationId: operation.actionId, calls: 1, stage: 'dispatched_in_reaction' }
            const output = await provider.decide(call, AbortSignal.timeout(timeoutMs)) as SubmitActionsV7
            if (output.actions.some(action => action.actionType !== 'speak')) throw new TypeError('continuation only permits expression or abstain')
            this.#performReactionContinuation.stage = 'submitted_to_existing_validator'
            return output
          }
        }
        if (!this.#rootInProgress || character.actorId !== options.performNpcId) return propose(context)
        const exact = (context as { exactProviderRequest: ExactProviderRequest }).exactProviderRequest
        const call = actionGroupCall(exact)
        const output = await provider.decide({ ...call,
          schema: { ...call.schema, anyOf: [
            { properties: { actions: { not: { contains: { properties: {
              actionType: { const: 'interact' }, parameters: { properties: {
                targetRef: { properties: { kind: { const: 'entity' } }, required: ['kind'] } }, required: ['targetRef'] },
            }, required: ['actionType', 'parameters'] } } } } },
            { properties: { actions: { maxItems: 1 } } },
          ] },
          description: call.description + ' 本次若选择物品交互 interact，只提交该交互，不附带成功后的对白或表现。'
            + '世界提交后，你会收到真实结果，并获得一次自由续写或 abstain 的机会。',
        }, AbortSignal.timeout(timeoutMs)) as SubmitActionsV7
        const interaction = output?.actions?.find(action => action.actionType === 'interact')
        if (interaction !== undefined) {
          const parameters = interaction.parameters as { targetRef?: { kind?: string } }
          if (parameters.targetRef?.kind === 'entity') {
            if (output.actions.length !== 1) throw new TypeError('perform must not contain a prewritten expression')
            if ('performance' in parameters) throw new TypeError('perform must not contain a legacy performance')
            this.#pendingPerform = interaction as ActionRequest
          }
        }
        return output
      } },
    }))
    // The Host's interpretation profile is a contract with the world, and its deadline ceiling is part of
    // it: a longer call deadline is the adapter's business, not something to state in the profile.
    const intentProfile = { version: 'player-intent-profile/v1' as const, providerId: 'chat-completions',
      modelId: this.#intentModel, maxOutputTokens: 1_024, timeoutMs: Math.min(timeoutMs, 60_000) }
    this.#application = new WorldApplication({
      externalCharacterActivations: this.#singleCharacterActivations,
      worldPath: resolve(options.dataDirectory, 'world.sqlite'),
      sessionPath: resolve(options.dataDirectory, 'session.sqlite'),
      memoryPath: resolve(options.dataDirectory, 'memory.sqlite'),
      contextPath: resolve(options.dataDirectory, 'context.sqlite'),
      // The world's model budget has to cover the interpreter's own output ceiling, or the Host refuses to
      // dispatch an interpretation at all: the profile states the ceiling, this is what pays for it.
      modelBudgetTokens: 8_192, leaseTtlMs: 180_000,
      participants: () => this.#singleCharacterActivations ? [] : participants,
      reactionParticipants: () => this.#singleCharacterActivations ? [] : participants,
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
      await runtime.#refresh()
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
      world: { title: this.#title, playerName: this.#playerName, npcNames: this.#npcNames,
        ...(this.#currentScene === undefined ? {} : { currentScene: this.#currentScene }) },
      debug: { ...this.#debug, provider: this.#provider, model: this.#model, intentModel: this.#intentModel,
        providerCalls: this.#providerCalls, paused: this.#paused, lastPlayerIntent: this.#lastPlayerIntent,
        playerInputMode: this.#intentEnabled ? 'interpreted-free-text' : 'legacy-speech',
        lastProviderCall: this.#lastCall },
    }
  }

  /**
   * One player turn. A caller that is retrying an input the world already recorded passes that input's own
   * key: the store is idempotent by key, so the retry completes the queued input instead of adding another.
   */
  async submit(text: string, idempotencyKey?: string): Promise<PlaytestState> {
    if (this.#busy) throw new PlaytestBusyError('请等待当前行动完成。')
    if (this.#paused) {
      this.#notice = 'NPC 已暂停：这次输入没有提交。恢复后再试。'
      return this.state()
    }
    this.#busy = true
    this.#error = false
    this.#notice = ''
    this.#phaseLabel = text.startsWith('/') ? '正在执行命令' : '正在理解玩家输入'
    const key = idempotencyKey ?? `web-playtest:${randomUUID()}`
    try {
      this.#pendingPerform = undefined
      this.#performContinuation = undefined
      this.#performReactionContinuation = undefined
      this.#activationCycle = undefined
      this.#rootInProgress = true
      this.#performAfterSeq = (await this.#application.head(this.#address)).headSeq
      this.#lastPlayerIntent = text.startsWith('/') ? 'command' : 'natural-language'
      const result = await this.#application.submitText(this.#address, { text, idempotencyKey: key,
        principalId: this.#principalId, correlationId: key })
      this.#rootInProgress = false
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
        this.#notice = `${result.reason}（这次输入没有提交；换一种说法，或用 /act 显式命令。）`
        this.#lastPlayerIntent = 'clarification'
      } else {
        const playerNotice = this.#playerResolutionNotice(key, result.result.headSeq)
        // submitText completes the player's durable Root. This in-process playtest has no BranchWorkScheduler
        // behind it, so it must also drive the Cycle that Root opened before returning control to the page.
        await this.#drainReactions()
        if (this.#singleCharacterActivations) await this.#activateCharacters()
        else await this.#continuePerformedItem()
        if (playerNotice !== undefined) this.#notice = [playerNotice, this.#notice].filter(Boolean).join(' ')
      }
    } catch (error: unknown) {
      this.#error = true
      this.#notice = await this.#whatBecameOf(key)
      console.error('Frozen playtest turn failed:', error instanceof Error ? error.message : 'unknown error')
      throw error
    } finally {
      this.#rootInProgress = false
      this.#busy = false
      this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
      await this.#refresh().catch(() => {})
    }
    return this.state()
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
    this.#busy = true
    try {
      await this.#drainReactions()
    } finally {
      this.#busy = false
      this.#phaseLabel = '可以输入'
      await this.#refresh().catch(() => {})
    }
    return this.state()
  }

  async close(): Promise<void> {
    this.#continuationController?.abort()
    await this.#application.close()
  }

  async #activateCharacters(): Promise<void> {
    await this.#application.release(this.#address)
    const path = resolve(this.#dataDirectory, 'world.sqlite')
    const store = new WorldStore(path), leases = new WriterLeaseService(path)
    const availability = new CharacterRuntimeAvailabilityService(path)
    this.#continuationController = new AbortController()
    try {
      if (this.#paused) return
      const turn = new PrototypeCharacterTurn({ address: this.#address, store, leases, availability,
        rulebooks: createCoreRulebookRegistry({ interactionPackages: [createBasicInteractionPackage()] }),
        decide: this.#decideContinuation })
      this.#phaseLabel = '角色正在处理场景与行动结果'
      this.#activationCycle = await runPrototypeActivations({ store, address: this.#address, turn,
        afterSeq: this.#performAfterSeq, characterIds: this.#characterIds, signal: this.#continuationController.signal })
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
    } finally { this.#continuationController = undefined; availability.close(); leases.close(); store.close() }
  }

  async #continuePerformedItem(): Promise<void> {
    const action = this.#pendingPerform
    this.#pendingPerform = undefined
    if (action === undefined || this.#paused) return
    // Existing frozen waves must finish before another commit changes their base Head.
    // Release the idle application's writer before the bounded continuation, then remount on refresh.
    await this.#application.release(this.#address)
    const path = resolve(this.#dataDirectory, 'world.sqlite')
    const store = new WorldStore(path)
    const leases = new WriterLeaseService(path)
    const availability = new CharacterRuntimeAvailabilityService(path)
    try {
      this.#continuationController = new AbortController()
      const turn = new PrototypeCharacterTurn({ address: this.#address, store, leases, availability,
        rulebooks: createCoreRulebookRegistry({ interactionPackages: [createBasicInteractionPackage()] }),
        decide: this.#decideContinuation })
      this.#phaseLabel = '角色正在依据执行结果继续表达'
      this.#performContinuation = await turn.run(action.actorId, { signal: this.#continuationController.signal,
        continuationOf: { actionId: action.actionId, afterSeq: this.#performAfterSeq,
        action: { actionType: action.actionType, parameters: action.parameters } } })
    } finally { this.#continuationController = undefined; availability.close(); leases.close(); store.close() }
  }

  /** Drain the bounded Cycle in this Host; production Hosts do the same work one scheduler quantum at a time. */
  async #drainReactions(): Promise<void> {
    for (let quantum = 0; quantum < 8; quantum += 1) {
      if (this.#paused) {
        this.#notice = 'NPC 已在波次边界暂停。'
        return
      }
      this.#phaseLabel = 'NPC 正在继续反应'
      const step = await this.#application.processNextReactionWave(this.#address)
      if (step.status !== 'wave') return
      await this.#refresh()
      if (step.terminalReason !== null) return
    }
    throw new Error('frozen playtest reaction drain exceeded eight quanta')
  }

  async #refresh(): Promise<void> {
    const [view, head, cycles] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
      this.#application.listReactionCycles(this.#address, { limit: 10 }),
    ])
    this.#transcript = playerTranscript(view, this.#names, this.#playerId)
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
    const active = cycles.find(cycle => cycle.status !== 'terminal')
    this.#debug = {
      headSeq: head.headSeq, tick: head.tick, manifestVersion: this.#manifestVersion,
      outputProtocol: this.#singleCharacterActivations ? 'perform/publish/abstain' : 'submit_actions/v7',
      activationCycle: this.#activationCycle ?? null,
      cycleStatus: active?.status ?? cycles[0]?.status ?? null,
      currentWave: active?.currentWave ?? cycles[0]?.currentWave ?? null,
      terminalReason: active?.terminalReason ?? cycles[0]?.terminalReason ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
      performContinuation: this.#performContinuation ?? null,
      performReactionContinuation: this.#performReactionContinuation ?? null,
    }
  }
}

export { defaultPlaytestDirectory }
