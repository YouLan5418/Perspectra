import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorldApplication, type ReactionParticipantBinding, type RoundParticipant } from '@harness-world/application'
import {
  brandId,
  compareWorldText,
  hashWorldJson,
  type CharacterId,
  type CharacterView,
  type ProposalContext,
  type ReactionProposalContext,
  type RecallTokenizerId,
  type SubmitActionsV2,
  type SubmitActionsV3,
  type SubmitActionsV4,
  type SubmitActionsV5,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  manifestationManifestRegistries,
  manifestationPolicyFromManifest,
  manifestUsesActionGroups,
  manifestUsesInteractions,
  type CompiledWorldManifest,
  type CompiledWorldManifestV6,
  type CompiledWorldSpec,
} from '@harness-world/kernel'
import { adaptRainyRoadPack, compileRainyRoadPack } from '@harness-world/simulation'
import { adaptCompiledWorldPack, readCompiledPack, readStrictJson } from '@harness-world/world-pack'
import {
  byteHash,
  availableExperimentActionReferences,
  createExperimentActionReferences,
  externalActionProposal,
  externalActionSchemaFor,
  renderExperiment,
  speechProposal,
  speechSchema,
  type ExperimentMessage,
} from './compact-context.ts'
import { groupedPlaytestRequest, groupedPlaytestProposal, groupedPlayerCommand } from './grouped-playtest.ts'
import { renderLeanContext } from './lean-context.ts'
import { comparisonMessages, comparisonResponse } from './provider-comparison.ts'
import { PlaytestBusyError, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'
import {
  hasExplicitPlayerPerformance,
  isDefinitelyPlayerSpeech,
  OllamaUtilityIntentInterpreter,
  type UtilityIntentResult,
} from './utility-intent.ts'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434'
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const OLLAMA_MODEL = 'qwen3.5:4b'
const DEEPSEEK_MODEL = 'deepseek-v4-flash'

export type PlaytestProviderKind = 'ollama' | 'deepseek'

function object(value: WorldJsonValue | unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function localEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.username !== '' || url.password !== '') {
    throw new TypeError('playtest accepts only an unauthenticated local Ollama endpoint')
  }
  return url
}

function responsive(compiled: CompiledWorldSpec): CompiledWorldSpec {
  const manifest = { ...compiled.manifest, schemaVersion: 6,
    registries: manifestationManifestRegistries(),
    reactionPolicy: { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' },
    manifestationPolicy: { version: 'manifestation-policy/v1', mode: 'enabled' },
  } as CompiledWorldManifestV6
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = compiled.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...(event.data as WorldJsonObject), manifestHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

const manifestationSchema = {
  type: 'object', additionalProperties: false, required: ['cues'],
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 500 },
    cues: { type: 'array', minItems: 1, maxItems: 4, items: {
      oneOf: [
        { type: 'object', additionalProperties: false,
          required: ['cueId', 'channel', 'description', 'persistence'],
          properties: {
            cueId: { type: 'string', minLength: 1, maxLength: 80 },
            channel: { type: 'string', enum: ['facial', 'gaze', 'gesture', 'voice'] },
            description: { type: 'string', minLength: 1, maxLength: 160 },
            persistence: { type: 'string', const: 'event_only' },
          } },
        { type: 'object', additionalProperties: false,
          required: ['cueId', 'channel', 'description', 'persistence', 'stateKey', 'operation'],
          properties: {
            cueId: { type: 'string', minLength: 1, maxLength: 80 },
            channel: { type: 'string', enum: ['posture', 'appearance'] },
            description: { type: 'string', minLength: 1, maxLength: 160 },
            persistence: { type: 'string', const: 'until_changed' },
            stateKey: { type: 'string', minLength: 1, maxLength: 80 },
            operation: { type: 'string', enum: ['set', 'clear'] },
          } },
      ],
    } },
  },
} as const

function expressiveSchema(base: Record<string, unknown>): Record<string, unknown> {
  const properties = object(base.properties) ?? {}
  const actions = object(properties.actions)
  return {
    ...base,
    properties: {
      ...properties,
      ...(actions === undefined ? {} : { actions: { ...actions, maxItems: 1 } }),
      manifestation: manifestationSchema,
    },
  }
}

const manifestationOutputContract = '可选增加 manifestation，描述角色执行本次 action 时外界能直接看到或听到的表现，格式为 {"description":"综合舞台动作","cues":[{"cueId":"本次响应内唯一短标识","channel":"facial|gaze|posture|gesture|voice|appearance","description":"可观察表现","persistence":"event_only"}]}。只写可观察线索，不要写真实情绪、秘密、动机或心理数值。posture/appearance 若需持续可用 until_changed，并加 stateKey 与 operation=set|clear。\n硬规则（移动必须真实）：角色要改变位置（移动/离开/前往某处），必须提交 move action（parameters.locationRef），manifestation 只能描写这次移动的姿态。禁止用 speak 口头说"我去某处"来替代移动，也禁止在 manifestation 里把尚未发生的移动写成"已经到某处"。\nmanifestation 不限于移动：原地说话（speak）同样应在 manifestation 里附带可见的表情、目光、语气、手势或姿态；只要不涉及位置变化就不要提交 move，但仍要写出说话时的外显表现。\n示例——① 位置变化（走开/前往）：actions:[{"actionType":"move","parameters":{"locationRef":"L2"}}]，manifestation 描写起身走向目标，如 posture"起身走向电脑桌"、gaze"目光转向工作区"；错误：speak"我去工作区"并配 manifestation"已经坐在电脑前"。② 原地说话（位置不变）：actions:[{"actionType":"speak",...}]，manifestation 附带说话时的表现，如 gaze"看向对方"、voice"语气平静"、gesture"轻轻点头"，不要提交 move。\n一次响应最多一个 action，manifestation 绑定这个 action；确实无任何可见变化时才省略。'

function expressiveProposal<T extends SubmitActionsV2>(
  raw: unknown,
  parse: (withoutManifestation: unknown) => T,
): SubmitActionsV3 {
  const candidate = object(raw)
  if (candidate === undefined) throw new TypeError('invalid expressive model response')
  const { manifestation, ...withoutManifestation } = candidate
  const proposal = parse(withoutManifestation)
  return {
    ...proposal,
    schemaVersion: 3,
    ...(manifestation === undefined ? {} : { manifestation: manifestation as SubmitActionsV3['manifestation'] }),
  }
}

function manifestationText(value: unknown): string | undefined {
  const manifestation = object(value)
  if (typeof manifestation?.description === 'string' && manifestation.description.length > 0) {
    return manifestation.description
  }
  if (!Array.isArray(manifestation?.cues)) return undefined
  const descriptions = manifestation.cues.flatMap(cue => {
    const description = object(cue)?.description
    return typeof description === 'string' && description.length > 0 ? [description] : []
  })
  return descriptions.length === 0 ? undefined : descriptions.join('，')
}

export function playtestModelCharacters(
  manifest: CompiledWorldManifest,
  playerId: CharacterId,
): readonly { readonly actorId: CharacterId; readonly name: string; readonly participantId: string }[] {
  return manifest.characters
    .filter(character => character.characterId !== playerId)
    .filter(character => !('lifecycle' in character) || character.lifecycle === 'active')
    .filter(character => !('controllerClass' in character) || character.controllerClass !== 'manual')
    .sort((left, right) => compareWorldText(left.characterId, right.characterId))
    .map(character => ({
      actorId: character.characterId,
      name: character.name,
      participantId: `agent:${character.characterId.replace(/^character:/u, '')}`,
    }))
}

export function playerTranscript(
  view: CharacterView,
  names: ReadonlyMap<string, string>,
  playerId: CharacterId,
): PlaytestState['transcript'] {
  return view.observations.flatMap(observation => {
    const content = object(object(observation.value)?.content)
    const speech = object(content?.speech)
    const stage = manifestationText(content?.manifestation)
    if (content?.status !== 'accepted') return []
    if (typeof speech?.characterId !== 'string' || typeof speech.text !== 'string') {
      if (content?.actionType === 'interact' && typeof content.actorId === 'string') {
        const transfer = object(content.interaction)
        if (typeof transfer?.entityId !== 'string') return []
        const item = transfer.entityId
        const destination = transfer.toHolderId === null ? '放在当前位置' : `交由${names.get(String(transfer.toHolderId)) ?? transfer.toHolderId}持有`
        return [{ seq: observation.sourceSeq, speaker: names.get(content.actorId) ?? content.actorId, text: `${item} 已${destination}。`, player: content.actorId === playerId }]
      }
      if ((content?.actionType !== 'move' && content?.actionType !== 'take') || typeof content.actorId !== 'string') return []
      const actionText = content.actionType === 'move' ? '移动到了另一个地点。' : '拿取了一个物品。'
      return [{
        seq: observation.sourceSeq,
        speaker: names.get(content.actorId) ?? content.actorId,
        text: stage === undefined ? actionText : `（${stage}）\n${actionText}`,
        player: content.actorId === playerId,
      }]
    }
    return [{
      seq: observation.sourceSeq,
      speaker: names.get(speech.characterId) ?? speech.characterId,
      text: stage === undefined ? speech.text : `（${stage}）\n${speech.text}`,
      player: speech.characterId === playerId,
    }]
  }).sort((left, right) => left.seq - right.seq)
}

interface CallTelemetry {
  readonly participantId: string
  readonly phase: 'root' | 'reaction'
  readonly wave: number | null
  readonly startedAt: number
}

class PlaytestModelProvider {
  #ordinal = 0

  constructor(
    readonly participantId: string,
    readonly actorId: CharacterId,
    private readonly provider: PlaytestProviderKind,
    private readonly endpoint: URL,
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly manifestationEnabled: boolean,
    private readonly groupVersion: 4 | 5 | undefined,
    private readonly actionReferences: ReturnType<typeof createExperimentActionReferences>,
    /** How much of the assembled Context reaches the model: the default projection, or the lean one. */
    private readonly promptMode: 'compact' | 'lean',
    private readonly evidenceDirectory: string,
    private readonly onStart: (call: CallTelemetry) => void,
    private readonly onFinish: (call: CallTelemetry, durationMs: number, status: 'act' | 'abstain' | 'invalid' | 'failed') => void,
  ) {}

  async propose(context: ProposalContext | ReactionProposalContext): Promise<SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5> {
    const exact = (context as unknown as { exactProviderRequest?: { messages: ExperimentMessage[] } }).exactProviderRequest
    if (exact === undefined || !Array.isArray(exact.messages)) throw new TypeError('exact Provider request is unavailable')
    const reaction = 'origin' in context && context.origin.kind === 'reaction' ? context.origin : null
    const outputMode = reaction === null ? 'external_actions' : 'speech_only'
    const grouped = this.groupVersion === undefined ? undefined : groupedPlaytestRequest(exact.messages, this.actorId, this.groupVersion, reaction !== null, this.actionReferences)
    const rendered = grouped ?? (this.promptMode === 'lean'
      ? renderLeanContext(exact.messages, this.actionReferences)
      : renderExperiment(exact.messages, 'compact', outputMode, this.actionReferences))
    const messages = grouped?.messages ?? comparisonMessages(rendered.messages, 'turn_taking', outputMode)
    if (this.manifestationEnabled && grouped === undefined) messages.push({ role: 'system', content: manifestationOutputContract })
    const ordinarySchema = outputMode === 'speech_only' ? speechSchema : externalActionSchemaFor(rendered.actionReferences)
    const responseSchema = grouped?.schema ?? (this.manifestationEnabled
      ? expressiveSchema(ordinarySchema as unknown as Record<string, unknown>)
      : ordinarySchema)
    const body = JSON.stringify(this.provider === 'ollama'
      ? { model: this.model, messages, stream: false, think: false,
        format: responseSchema,
        options: { temperature: 0.3, seed: 42, num_predict: grouped === undefined ? 256 : 2048 }, keep_alive: '10m' }
      : { model: this.model, messages, stream: false, thinking: { type: 'disabled' },
        response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: grouped === undefined ? 256 : 2048 })
    if (Buffer.byteLength(body) > 512_000) throw new RangeError('playtest Provider input exceeds 512,000 bytes')
    const call: CallTelemetry = { participantId: this.participantId,
      phase: reaction === null ? 'root' : 'reaction', wave: reaction?.wave ?? null, startedAt: Date.now() }
    const evidenceId = `${String(++this.#ordinal).padStart(4, '0')}-${byteHash(`${this.participantId}:${context.roundId}`).slice(7, 23)}`
    writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.request.json`), JSON.stringify({
      provider: this.provider, participantId: this.participantId, roundId: context.roundId, upstreamMessages: exact.messages,
      ...rendered, messages, wireBodyHash: byteHash(body),
    }, null, 2), { flag: 'wx' })
    this.onStart(call)
    const started = performance.now()
    let raw: unknown
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error', headers: this.provider === 'ollama'
          ? { 'content-type': 'application/json' }
          : { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body, signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) throw new Error(`${this.provider} returned HTTP ${response.status}`)
      raw = await response.json()
    } catch (error: unknown) {
      this.onFinish(call, Math.round(performance.now() - started), 'failed')
      writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.failure.json`), JSON.stringify({
        status: 'failed_or_ambiguous', retryAttempted: false,
      }, null, 2), { flag: 'wx' })
      throw new Error('local model call failed; inspect the terminal and local evidence', { cause: error })
    }
    let parsed: ReturnType<typeof comparisonResponse> | undefined
    try {
      parsed = comparisonResponse(this.provider, raw)
      const decoded = JSON.parse(parsed.content) as unknown
      let reflectionWarning: string | undefined
      let proposal: SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5
      if (this.groupVersion !== undefined) {
        proposal = groupedPlaytestProposal(decoded, this.actorId, this.participantId, this.groupVersion, reaction !== null)
      } else if (outputMode === 'speech_only') {
        const parseSpeech = (value: unknown) => speechProposal(
          value, this.actorId, `action:playtest:${this.actorId}:${context.roundId}`,
        )
        proposal = this.manifestationEnabled ? expressiveProposal(decoded, parseSpeech) : parseSpeech(decoded)
      } else {
        const proposalContext = {
          exactMessages: exact.messages,
          references: rendered.references,
          actionReferences: rendered.actionReferences,
        }
        try {
          const parseAction = (value: unknown) => externalActionProposal(value, this.actorId, context.roundId, proposalContext)
          proposal = this.manifestationEnabled ? expressiveProposal(decoded, parseAction) : parseAction(decoded)
        } catch (error: unknown) {
          const candidate = object(decoded)
          if (candidate === undefined || !('reflection' in candidate)) throw error
          const { reflection: _reflection, ...withoutReflection } = candidate
          const parseAction = (value: unknown) => externalActionProposal(value, this.actorId, context.roundId, proposalContext)
          proposal = this.manifestationEnabled
            ? expressiveProposal(withoutReflection, parseAction)
            : parseAction(withoutReflection)
          reflectionWarning = 'reflection_rejected'
        }
      }
      const durationMs = Math.round(performance.now() - started)
      this.onFinish(call, durationMs, proposal.decision)
      writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.response.json`), JSON.stringify({
        durationMs, model: parsed.model, usage: parsed.usage, proposal,
        ...(reflectionWarning === undefined ? {} : { warning: reflectionWarning }),
      }, null, 2), { flag: 'wx' })
      return proposal
    } catch (error: unknown) {
      const durationMs = Math.round(performance.now() - started)
      this.onFinish(call, durationMs, 'invalid')
      writeFileSync(resolve(this.evidenceDirectory, `${evidenceId}.invalid.json`), JSON.stringify({
        status: 'invalid_model_output', reasonCode: error instanceof SyntaxError
          ? 'invalid_json' : 'proposal_schema_rejected', durationMs,
        ...(parsed === undefined ? {} : { model: parsed.model, usage: parsed.usage }),
        validationError: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
        rawOutput: parsed?.content.slice(0, 65_536) ?? null,
        rawOutputTruncated: parsed !== undefined && parsed.content.length > 65_536,
      }, null, 2), { flag: 'wx' })
      // Deliberately return a canonical but invalid marker so the coordinator's
      // durable Provider quality policy classifies this as schema-invalid rather
      // than confusing it with a transport or API failure.
      return {
        schemaVersion: this.groupVersion ?? (this.manifestationEnabled ? 3 : 2), decision: 'abstain', actions: [], invalidModelOutput: true,
      } as unknown as SubmitActionsV2 | SubmitActionsV3 | SubmitActionsV4 | SubmitActionsV5
    }
  }
}

export interface PlaytestRuntimeOptions {
  readonly dataDirectory: string
  readonly packPath?: string
  readonly interactionsPath?: string
  readonly actionGroups?: boolean
  readonly provider?: PlaytestProviderKind
  readonly endpoint?: string
  readonly model?: string
  readonly apiKey?: string
  readonly utilityEndpoint?: string
  readonly utilityModel?: string
  /** Selects the versioned keyword Recall strategy for this playtest world, or leaves the frozen path. */
  readonly recallTokenizer?: RecallTokenizerId
  readonly recallDictionary?: boolean
  /**
   * How much of the assembled Context reaches the model. `compact` is the default and drops a fixed list
   * of machine keys; `lean` projects each segment instead, keeping only what a character can act on.
   */
  readonly promptMode?: 'compact' | 'lean'
}

export class WorldPlaytestRuntime implements PlaytestRuntime {
  readonly #application: WorldApplication
  readonly #address
  readonly #principalId: string
  readonly #playerId: CharacterId
  readonly #names: ReadonlyMap<string, string>
  readonly #title: string
  readonly #playerName: string
  readonly #npcNames: readonly string[]
  readonly #provider: PlaytestProviderKind
  readonly #model: string
  readonly #dataDirectory: string
  readonly #actionReferences: ReturnType<typeof createExperimentActionReferences>
  readonly #promptMode: 'compact' | 'lean'
  readonly #utilityIntent: OllamaUtilityIntentInterpreter
  readonly #utilityModel: string
  readonly #manifestationEnabled: boolean
  readonly #groupVersion: 4 | 5 | undefined
  readonly #manifestVersion: number
  readonly #activeCalls = new Map<string, CallTelemetry>()
  #providerCalls = 0
  #lastProviderDurationMs: number | null = null
  #busy = false
  #pauseRequested = false
  #paused = false
  #phaseLabel = '可以输入'
  #notice = ''
  #error = false
  #cachedTranscript: PlaytestState['transcript'] = []
  #cachedDebug: Record<string, unknown> = {}
  #playerLocationId: string | null = null
  #lastPlayerIntent: string | null = null
  #pendingClarification: {
    readonly originalText: string
    readonly question: string
    readonly references: ReturnType<typeof availableExperimentActionReferences>
  } | null = null

  private constructor(options: PlaytestRuntimeOptions, compiled: CompiledWorldSpec) {
    this.#address = compiled.manifest.address
    this.#manifestVersion = compiled.manifest.schemaVersion
    this.#groupVersion = manifestUsesInteractions(compiled.manifest) ? 5 : manifestUsesActionGroups(compiled.manifest) ? 4 : undefined
    const binding = compiled.manifest.playerBindings[0]
    if (binding === undefined) throw new TypeError('playtest Pack has no PlayerBinding')
    this.#principalId = binding.principalId
    this.#playerId = binding.characterId
    this.#names = new Map(compiled.manifest.characters.map(character => [character.characterId, character.name]))
    this.#title = compiled.manifest.metadata.title
    this.#playerName = this.#names.get(this.#playerId) ?? this.#playerId
    const controlledCharacters = playtestModelCharacters(compiled.manifest, this.#playerId)
    const manifestationEnabled = manifestationPolicyFromManifest(compiled.manifest).mode === 'enabled'
    this.#manifestationEnabled = manifestationEnabled && this.#groupVersion === undefined
    this.#npcNames = controlledCharacters.map(character => character.name)
    this.#provider = options.provider ?? 'ollama'
    this.#model = options.model ?? (this.#provider === 'ollama' ? OLLAMA_MODEL : DEEPSEEK_MODEL)
    this.#dataDirectory = resolve(options.dataDirectory)
    const evidenceDirectory = resolve(this.#dataDirectory, 'requests')
    mkdirSync(evidenceDirectory, { recursive: true })
    this.#actionReferences = createExperimentActionReferences(compiled.manifest)
    this.#promptMode = options.promptMode ?? 'compact'
    this.#utilityModel = options.utilityModel?.trim() || OLLAMA_MODEL
    this.#utilityIntent = new OllamaUtilityIntentInterpreter(
      new URL('/api/chat', localEndpoint(options.utilityEndpoint ?? DEFAULT_ENDPOINT)),
      this.#utilityModel,
      30_000,
      evidenceDirectory,
      this.#manifestationEnabled,
    )
    const apiKey = options.apiKey?.trim()
    if (this.#provider === 'deepseek' && !apiKey) throw new TypeError('DeepSeek credential unavailable')
    if (this.#provider === 'deepseek' && options.endpoint !== undefined) {
      throw new TypeError('DeepSeek playtest endpoint is fixed')
    }
    const endpoint = this.#provider === 'ollama'
      ? new URL('/api/chat', localEndpoint(options.endpoint ?? DEFAULT_ENDPOINT))
      : new URL(DEEPSEEK_ENDPOINT)
    const timeoutMs = this.#provider === 'ollama' ? 120_000 : 30_000
    const participantNames = new Map(controlledCharacters.map(character => [character.participantId, character.name]))
    const onStart = (call: CallTelemetry) => {
      this.#activeCalls.set(call.participantId, call)
      this.#providerCalls += 1
      this.#phaseLabel = `${participantNames.get(call.participantId) ?? call.participantId} 正在思考`
    }
    const onFinish = (call: CallTelemetry, durationMs: number, status: 'act' | 'abstain' | 'invalid' | 'failed') => {
      this.#activeCalls.delete(call.participantId)
      this.#lastProviderDurationMs = durationMs
      if (status === 'failed') this.#notice = '一个角色的本地模型调用失败；本轮将按既有降级规则收口。'
      if (status === 'invalid') this.#notice = '一个角色返回了无效动作格式；本次输出已忽略，角色可在后续轮次重试。'
    }
    const providers = controlledCharacters.map((character, index) => ({
      ...character,
      priority: controlledCharacters.length - index,
    })).map(item => ({ ...item, provider: new PlaytestModelProvider(
      item.participantId, item.actorId, this.#provider, endpoint, this.#model, apiKey, timeoutMs, manifestationEnabled, this.#groupVersion,
      this.#actionReferences,
      this.#promptMode,
      evidenceDirectory, onStart, onFinish,
    ) }))
    const roundParticipants: RoundParticipant[] = providers.map(item => ({ ...item, role: 'agent',
      allowedActionTypes: ['speak', 'move', this.#groupVersion === 5 ? 'interact' : 'take'], estimatedTokens: 1, timeoutMs: timeoutMs + 5_000 }))
    const reactionParticipants: ReactionParticipantBinding[] = providers.map(item => ({ ...item, role: 'agent',
      allowedActionTypes: this.#groupVersion === undefined ? ['speak'] : ['speak', 'move', this.#groupVersion === 5 ? 'interact' : 'take'], estimatedTokens: 1, timeoutMs: timeoutMs + 5_000 }))
    this.#application = new WorldApplication({
      worldPath: resolve(this.#dataDirectory, 'world.sqlite'),
      sessionPath: resolve(this.#dataDirectory, 'session.sqlite'),
      memoryPath: resolve(this.#dataDirectory, 'memory.sqlite'),
      contextPath: resolve(this.#dataDirectory, 'context.sqlite'),
      modelBudgetTokens: 64, leaseTtlMs: 180_000,
      ...(options.recallTokenizer === undefined ? {} : { recallTokenizer: options.recallTokenizer }),
      ...(options.recallDictionary === undefined ? {} : { recallDictionary: options.recallDictionary }),
      participants: () => roundParticipants, reactionParticipants: () => reactionParticipants,
    })
  }

  static async create(options: PlaytestRuntimeOptions): Promise<WorldPlaytestRuntime> {
    if ((options.actionGroups || options.interactionsPath !== undefined) && options.packPath === undefined) throw new TypeError('new protocols require --pack')
    if (options.actionGroups && options.interactionsPath !== undefined) throw new TypeError('choose action groups or interactions')
    mkdirSync(resolve(options.dataDirectory), { recursive: true })
    let compiled: CompiledWorldSpec
    if (options.packPath === undefined) {
      const address = { tenantId: brandId('tenant:web-playtest', 'TenantId'),
        worldId: brandId('world:rainy-road-web', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
      compiled = responsive(adaptRainyRoadPack(await compileRainyRoadPack(), address))
    } else {
      const pack = await readCompiledPack(resolve(options.packPath))
      const address = { tenantId: brandId('tenant:web-playtest', 'TenantId'),
        worldId: brandId(`world:web-playtest:${pack.packHash.slice(7, 23)}`, 'WorldId'),
        branchId: brandId('branch:main', 'BranchId') }
      compiled = adaptCompiledWorldPack(pack, {
        address,
        principalId: 'principal:web-playtest',
        sessionId: brandId('session:web-playtest', 'SessionId'),
        ...(options.actionGroups ? { actionGroups: 'bounded/v1' as const } : {}),
        ...(options.interactionsPath === undefined ? {} : { interactionCatalog: await readStrictJson(resolve(options.interactionsPath)) }),
      })
    }
    const runtime = new WorldPlaytestRuntime(options, compiled)
    try {
      runtime.#application.activate(compiled)
      await runtime.#refresh()
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  }

  async state(): Promise<PlaytestState> {
    return {
      busy: this.#busy, paused: this.#paused, phaseLabel: this.#phaseLabel,
      notice: this.#notice, error: this.#error, transcript: this.#cachedTranscript,
      world: { title: this.#title, playerName: this.#playerName, npcNames: this.#npcNames },
      debug: { ...this.#cachedDebug, provider: this.#provider, model: this.#model, providerCalls: this.#providerCalls,
        utilityModel: this.#utilityModel, lastPlayerIntent: this.#lastPlayerIntent,
        pendingClarification: this.#pendingClarification === null ? null : {
          originalText: this.#pendingClarification.originalText,
          question: this.#pendingClarification.question,
        },
        activeProviderCalls: [...this.#activeCalls.values()].map(call => ({
          participantId: call.participantId, phase: call.phase, wave: call.wave,
        elapsedMs: Date.now() - call.startedAt,
      })), lastProviderDurationMs: this.#lastProviderDurationMs,
        pauseRequested: this.#pauseRequested },
    }
  }

  async submit(text: string): Promise<PlaytestState> {
    if (this.#busy) throw new PlaytestBusyError('请等待当前行动完成，或请求在当前波次后暂停。')
    this.#busy = true
    this.#paused = false
    this.#pauseRequested = false
    this.#error = false
    this.#notice = ''
    this.#phaseLabel = text.startsWith('/') ? '正在解析命令' : '正在理解玩家输入'
    try {
      const key = `web-playtest:${randomUUID()}`
      let interpretation: UtilityIntentResult | undefined
      let cancelled = false
      if (text === '/cancel' && this.#pendingClarification !== null) {
        this.#pendingClarification = null
        this.#lastPlayerIntent = 'clarification_cancelled'
        this.#notice = '已取消上一条未决输入；没有推进世界时间。'
        cancelled = true
      } else if (this.#groupVersion !== undefined) {
        this.#pendingClarification = null
        const command = groupedPlayerCommand(text, this.#groupVersion)
        if (command !== undefined) interpretation = { status: 'action', action: command }
        else if (!text.startsWith('/')) interpretation = { status: 'action', action: { actionType: 'speak', parameters: { text } } }
      } else if (!text.startsWith('/')) {
        const pending = this.#pendingClarification
        try {
          if (pending !== null) {
            interpretation = /^(?:是\s*)?speak$/iu.test(text.trim())
              || /^(?:是)?(?:说话|对白|发言|当作说话|当作发言|只是问问)$/u.test(text.trim())
              ? { status: 'action', action: { actionType: 'speak', parameters: { text: pending.originalText } } }
              : await this.#utilityIntent.interpretClarification(
                pending.originalText, pending.question, text, pending.references,
              )
          } else {
            const references = availableExperimentActionReferences(this.#actionReferences, this.#playerLocationId)
            interpretation = isDefinitelyPlayerSpeech(text) && !hasExplicitPlayerPerformance(text)
              ? { status: 'action', action: { actionType: 'speak', parameters: { text } } }
              : await this.#utilityIntent.interpret(text, references)
          }
        } catch (error: unknown) {
          if (pending !== null) {
            this.#notice = '未能理解这次澄清；上一条输入仍未提交。你可以换种说法，或输入 /cancel。'
            interpretation = { status: 'clarification', question: pending.question }
          } else if (this.#manifestationEnabled && hasExplicitPlayerPerformance(text)) {
            this.#notice = '未能可靠提取这条外显表现，本条没有提交；请换种说法后重试。'
            interpretation = { status: 'clarification', question: '请明确说明角色要说什么、去哪里或拿什么。' }
          } else {
            this.#notice = '自然语言行动翻译暂不可用，本条已安全地按对白处理。'
            interpretation = { status: 'action', action: { actionType: 'speak', parameters: { text } } }
          }
          console.warn('Utility intent fallback:', error instanceof Error ? error.message : 'unknown error')
        }
      } else {
        this.#pendingClarification = null
      }
      if (cancelled) {
        // A clarification is adapter state, so cancelling it creates no Round.
      } else if (interpretation?.status === 'clarification') {
        if (this.#pendingClarification === null) {
          this.#pendingClarification = {
            originalText: text,
            question: interpretation.question,
            references: availableExperimentActionReferences(this.#actionReferences, this.#playerLocationId),
          }
        } else {
          this.#pendingClarification = { ...this.#pendingClarification, question: interpretation.question }
        }
        this.#lastPlayerIntent = 'clarification'
        this.#notice = interpretation.question
      } else {
        this.#pendingClarification = null
        this.#phaseLabel = '角色正在回应玩家'
        const result = interpretation === undefined
          ? await this.#application.submitText(this.#address, {
            text, idempotencyKey: key, principalId: this.#principalId, correlationId: key,
          })
          : await this.#application.submit(this.#address, {
            action: interpretation.action,
            ...(interpretation.manifestation === undefined ? {} : { manifestation: interpretation.manifestation }),
            idempotencyKey: key,
            principalId: this.#principalId,
            correlationId: key,
          })
        this.#lastPlayerIntent = interpretation?.action.actionType ?? 'command'
        if ('status' in result && result.status === 'clarification_required') {
          this.#notice = result.reason
          this.#lastPlayerIntent = 'clarification'
        } else {
          await this.#refresh()
          await this.#drain()
        }
      }
    } catch (error: unknown) {
      this.#error = true
      this.#notice = '本轮失败，详情仅保留在本机终端。'
      console.error('Playtest turn failed:', error instanceof Error ? error.message : 'unknown error')
      throw error
    } finally {
      this.#busy = false
      this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
      await this.#refresh().catch(() => {})
    }
    return this.state()
  }

  async pause(): Promise<PlaytestState> {
    if (!this.#busy) {
      const cycles = await this.#application.listReactionCycles(this.#address, { limit: 1 })
      if (cycles[0]?.status !== 'active' && cycles[0]?.status !== 'stop_requested') {
        this.#pauseRequested = false
        this.#paused = false
        this.#notice = '当前没有正在进行的 NPC 反应。'
        return this.state()
      }
    }
    this.#pauseRequested = true
    if (!this.#busy) this.#paused = true
    this.#notice = this.#busy ? '将在当前 NPC 波次完成后暂停。' : 'NPC 反应已暂停；你可以直接输入来打断旧话题。'
    return this.state()
  }

  async resume(): Promise<PlaytestState> {
    if (this.#busy) throw new PlaytestBusyError('当前波次尚未完成。')
    this.#pauseRequested = false
    this.#paused = false
    this.#busy = true
    this.#notice = ''
    this.#phaseLabel = 'NPC 正在继续反应'
    try {
      await this.#drain()
    } catch (error: unknown) {
      this.#error = true
      this.#notice = '继续 NPC 反应失败，详情仅保留在本机终端。'
      console.error('Playtest resume failed:', error instanceof Error ? error.message : 'unknown error')
      throw error
    } finally {
      this.#busy = false
      this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
      await this.#refresh().catch(() => {})
    }
    return this.state()
  }

  async close(): Promise<void> {
    await this.#application.close()
  }

  async #drain(): Promise<void> {
    for (let quantum = 0; quantum < 8; quantum += 1) {
      if (this.#pauseRequested) {
        this.#paused = true
        this.#notice = 'NPC 已在波次边界暂停。继续或输入新消息均可。'
        return
      }
      this.#phaseLabel = 'NPC 正在决定是否继续说话'
      const step = await this.#application.processNextReactionWave(this.#address)
      if (step.status !== 'wave') return
      await this.#refresh()
      if (step.terminalReason !== null) return
    }
    this.#paused = true
    this.#pauseRequested = true
    this.#notice = '试玩工具已在八个量子后暂停，请检查运行状态。'
  }

  async #refresh(): Promise<void> {
    const [view, head, cycles] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
      this.#application.listReactionCycles(this.#address, { limit: 10 }),
    ])
    this.#cachedTranscript = playerTranscript(view, this.#names, this.#playerId)
    this.#playerLocationId = view.locationId
    const active = cycles.find(cycle => cycle.status !== 'terminal')
    this.#cachedDebug = {
      headSeq: head.headSeq, tick: head.tick,
      manifestVersion: this.#manifestVersion, outputProtocol: this.#groupVersion === undefined ? 'legacy' : `submit_actions/v${this.#groupVersion}`,
      playerInputMode: this.#groupVersion === undefined ? 'utility' : 'speech-and-explicit-commands',
      cycleStatus: active?.status ?? cycles[0]?.status ?? null,
      currentWave: active?.currentWave ?? cycles[0]?.currentWave ?? null,
      terminalReason: active?.terminalReason ?? cycles[0]?.terminalReason ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
    }
  }
}

export function defaultPlaytestDirectory(): string {
  const configured = process.env.HCW_PLAYTEST_DATA_DIRECTORY?.trim()
  if (configured) return resolve(configured)
  let candidate: string
  do {
    candidate = resolve('.tmp', `web-playtest-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`)
  } while (existsSync(candidate))
  return candidate
}
