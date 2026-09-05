import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorldApplication, type ReactionParticipantBinding, type RoundParticipant } from '@harness-world/application'
import {
  brandId,
  hashWorldJson,
  type CharacterId,
  type CharacterView,
  type ProposalContext,
  type ReactionProposalContext,
  type SubmitActionsV2,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import type { CompiledWorldManifestV5, CompiledWorldSpec } from '@harness-world/kernel'
import { RAINY_ROAD_IDS, adaptRainyRoadPack, compileRainyRoadPack } from '@harness-world/simulation'
import {
  byteHash,
  createExperimentActionReferences,
  externalActionProposal,
  externalActionSchemaFor,
  renderExperiment,
  speechProposal,
  speechSchema,
  type ExperimentMessage,
} from './compact-context.ts'
import { comparisonMessages, comparisonResponse } from './provider-comparison.ts'
import { PlaytestBusyError, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'

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
  const manifest = { ...compiled.manifest, schemaVersion: 5,
    reactionPolicy: { version: 'reaction-policy/v1', mode: 'responsive', profile: 'responsive/v1' },
  } as CompiledWorldManifestV5
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = compiled.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...(event.data as WorldJsonObject), manifestHash } } : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

export function playerTranscript(
  view: CharacterView,
  names: ReadonlyMap<string, string>,
  playerId: CharacterId,
): PlaytestState['transcript'] {
  return view.observations.flatMap(observation => {
    const content = object(object(observation.value)?.content)
    const speech = object(content?.speech)
    if (content?.status !== 'accepted') return []
    if (typeof speech?.characterId !== 'string' || typeof speech.text !== 'string') {
      if ((content?.actionType !== 'move' && content?.actionType !== 'take') || typeof content.actorId !== 'string') return []
      return [{
        seq: observation.sourceSeq,
        speaker: names.get(content.actorId) ?? content.actorId,
        text: content.actionType === 'move' ? '移动到了另一个地点。' : '拿取了一个物品。',
        player: content.actorId === playerId,
      }]
    }
    return [{
      seq: observation.sourceSeq,
      speaker: names.get(speech.characterId) ?? speech.characterId,
      text: speech.text,
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
    private readonly actionReferences: ReturnType<typeof createExperimentActionReferences>,
    private readonly evidenceDirectory: string,
    private readonly onStart: (call: CallTelemetry) => void,
    private readonly onFinish: (call: CallTelemetry, durationMs: number, status: 'act' | 'abstain' | 'invalid' | 'failed') => void,
  ) {}

  async propose(context: ProposalContext | ReactionProposalContext): Promise<SubmitActionsV2> {
    const exact = (context as unknown as { exactProviderRequest?: { messages: ExperimentMessage[] } }).exactProviderRequest
    if (exact === undefined || !Array.isArray(exact.messages)) throw new TypeError('exact Provider request is unavailable')
    const reaction = 'origin' in context && context.origin.kind === 'reaction' ? context.origin : null
    const outputMode = reaction === null ? 'external_actions' : 'speech_only'
    const rendered = renderExperiment(exact.messages, 'compact', outputMode, this.actionReferences)
    const messages = comparisonMessages(rendered.messages, 'turn_taking', outputMode)
    const body = JSON.stringify(this.provider === 'ollama'
      ? { model: this.model, messages, stream: false, think: false,
        format: outputMode === 'speech_only' ? speechSchema : externalActionSchemaFor(rendered.actionReferences),
        options: { temperature: 0.3, seed: 42, num_predict: 256 }, keep_alive: '10m' }
      : { model: this.model, messages, stream: false, thinking: { type: 'disabled' },
        response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: 256 })
    if (Buffer.byteLength(body) > 48_000) throw new RangeError('playtest Provider input exceeds 48,000 bytes')
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
      let proposal: SubmitActionsV2
      if (outputMode === 'speech_only') {
        proposal = speechProposal(decoded, this.actorId, `action:playtest:${this.actorId}:${context.roundId}`)
      } else {
        const proposalContext = {
          exactMessages: exact.messages,
          references: rendered.references,
          actionReferences: rendered.actionReferences,
        }
        try {
          proposal = externalActionProposal(decoded, this.actorId, context.roundId, proposalContext)
        } catch (error: unknown) {
          const candidate = object(decoded)
          if (candidate === undefined || !('reflection' in candidate)) throw error
          const { reflection: _reflection, ...withoutReflection } = candidate
          proposal = externalActionProposal(withoutReflection, this.actorId, context.roundId, proposalContext)
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
      }, null, 2), { flag: 'wx' })
      // Deliberately return a canonical but invalid marker so the coordinator's
      // durable Provider quality policy classifies this as schema-invalid rather
      // than confusing it with a transport or API failure.
      return {
        schemaVersion: 2, decision: 'abstain', actions: [],
        invalidModelOutput: true,
      } as unknown as SubmitActionsV2
    }
  }
}

export interface PlaytestRuntimeOptions {
  readonly dataDirectory: string
  readonly provider?: PlaytestProviderKind
  readonly endpoint?: string
  readonly model?: string
  readonly apiKey?: string
}

export class WorldPlaytestRuntime implements PlaytestRuntime {
  readonly #application: WorldApplication
  readonly #address
  readonly #principalId: string
  readonly #playerId: CharacterId
  readonly #names: ReadonlyMap<string, string>
  readonly #provider: PlaytestProviderKind
  readonly #model: string
  readonly #dataDirectory: string
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

  private constructor(options: PlaytestRuntimeOptions, compiled: CompiledWorldSpec) {
    this.#address = compiled.manifest.address
    const binding = compiled.manifest.playerBindings[0]
    if (binding === undefined) throw new TypeError('playtest Pack has no PlayerBinding')
    this.#principalId = binding.principalId
    this.#playerId = binding.characterId
    this.#names = new Map(compiled.manifest.characters.map(character => [character.characterId, character.name]))
    this.#provider = options.provider ?? 'ollama'
    this.#model = options.model ?? (this.#provider === 'ollama' ? OLLAMA_MODEL : DEEPSEEK_MODEL)
    this.#dataDirectory = resolve(options.dataDirectory)
    const evidenceDirectory = resolve(this.#dataDirectory, 'requests')
    mkdirSync(evidenceDirectory, { recursive: true })
    const apiKey = options.apiKey?.trim()
    if (this.#provider === 'deepseek' && !apiKey) throw new TypeError('DeepSeek credential unavailable')
    if (this.#provider === 'deepseek' && options.endpoint !== undefined) {
      throw new TypeError('DeepSeek playtest endpoint is fixed')
    }
    const endpoint = this.#provider === 'ollama'
      ? new URL('/api/chat', localEndpoint(options.endpoint ?? DEFAULT_ENDPOINT))
      : new URL(DEEPSEEK_ENDPOINT)
    const timeoutMs = this.#provider === 'ollama' ? 120_000 : 30_000
    const onStart = (call: CallTelemetry) => {
      this.#activeCalls.set(call.participantId, call)
      this.#providerCalls += 1
      this.#phaseLabel = `${this.#names.get(call.participantId.replace('agent:', 'character:')) ?? call.participantId} 正在思考`
    }
    const onFinish = (call: CallTelemetry, durationMs: number, status: 'act' | 'abstain' | 'invalid' | 'failed') => {
      this.#activeCalls.delete(call.participantId)
      this.#lastProviderDurationMs = durationMs
      if (status === 'failed') this.#notice = '一个角色的本地模型调用失败；本轮将按既有降级规则收口。'
      if (status === 'invalid') this.#notice = '一个角色返回了无效动作格式；本次输出已忽略，角色可在后续轮次重试。'
    }
    const providers = [
      { participantId: 'agent:alice', actorId: RAINY_ROAD_IDS.alice, priority: 2 },
      { participantId: 'agent:bob', actorId: RAINY_ROAD_IDS.bob, priority: 1 },
    ].map(item => ({ ...item, provider: new PlaytestModelProvider(
      item.participantId, item.actorId, this.#provider, endpoint, this.#model, apiKey, timeoutMs,
      createExperimentActionReferences(compiled.manifest),
      evidenceDirectory, onStart, onFinish,
    ) }))
    const roundParticipants: RoundParticipant[] = providers.map(item => ({ ...item, role: 'agent',
      allowedActionTypes: ['speak', 'move', 'take'], estimatedTokens: 1, timeoutMs: timeoutMs + 5_000 }))
    const reactionParticipants: ReactionParticipantBinding[] = providers.map(item => ({ ...item, role: 'agent',
      allowedActionTypes: ['speak'], estimatedTokens: 1, timeoutMs: timeoutMs + 5_000 }))
    this.#application = new WorldApplication({
      worldPath: resolve(this.#dataDirectory, 'world.sqlite'),
      sessionPath: resolve(this.#dataDirectory, 'session.sqlite'),
      memoryPath: resolve(this.#dataDirectory, 'memory.sqlite'),
      contextPath: resolve(this.#dataDirectory, 'context.sqlite'),
      modelBudgetTokens: 64, leaseTtlMs: 180_000,
      participants: () => roundParticipants, reactionParticipants: () => reactionParticipants,
    })
  }

  static async create(options: PlaytestRuntimeOptions): Promise<WorldPlaytestRuntime> {
    mkdirSync(resolve(options.dataDirectory), { recursive: true })
    const address = { tenantId: brandId('tenant:web-playtest', 'TenantId'),
      worldId: brandId('world:rainy-road-web', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
    const compiled = responsive(adaptRainyRoadPack(await compileRainyRoadPack(), address))
    const runtime = new WorldPlaytestRuntime(options, compiled)
    runtime.#application.activate(compiled)
    await runtime.#refresh()
    return runtime
  }

  async state(): Promise<PlaytestState> {
    return {
      busy: this.#busy, paused: this.#paused, phaseLabel: this.#phaseLabel,
      notice: this.#notice, error: this.#error, transcript: this.#cachedTranscript,
      debug: { ...this.#cachedDebug, provider: this.#provider, model: this.#model, providerCalls: this.#providerCalls,
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
    this.#phaseLabel = '角色正在回应玩家'
    try {
      const key = `web-playtest:${randomUUID()}`
      const result = await this.#application.submitText(this.#address, {
        text, idempotencyKey: key, principalId: this.#principalId, correlationId: key,
      })
      if (result.status === 'clarification_required') {
        this.#notice = result.reason
      } else {
        await this.#refresh()
        await this.#drain()
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
    const active = cycles.find(cycle => cycle.status !== 'terminal')
    this.#cachedDebug = {
      headSeq: head.headSeq, tick: head.tick,
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
