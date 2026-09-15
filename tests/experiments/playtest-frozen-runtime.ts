import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription, type CharacterId, type SubmitActionsV7,
  type WorldAddress } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { createChatProvider, type ChatCallObservation } from '@harness-world/provider-chat'
import { PlayerInputJobs } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { PlaytestBusyError, type PlaytestRuntime, type PlaytestState } from './playtest-server.ts'
import { defaultPlaytestDirectory, playtestModelCharacters, playerTranscript } from './playtest-runtime.ts'

export interface FrozenPlaytestOptions {
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

/**
 * The web playtest for a frozen world: the same page and the same server as the older line, driven by the
 * protocol production offers a v5 Pack - `submit_actions/v7` through the Host's own assembled request, and
 * the durable player interpretation whose schema the Host dispatches. Nothing here re-renders the context
 * or invents a reference scheme: what the model receives is what the world assembled, and what it answers
 * is what the world's validator judges.
 *
 * A player types free text when the world declared `player-intent/v1`, and explicit commands either way:
 * `/act interact {"targetRef":…,"arguments":…}` is the same request a model's step is bound to.
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
  readonly #model: string
  readonly #intentModel: string
  readonly #provider: 'deepseek' | 'ollama'
  readonly #manifestVersion: number
  readonly #intentEnabled: boolean
  readonly #dataDirectory: string
  #transcript: PlaytestState['transcript'] = []
  #debug: Record<string, unknown> = {}
  #busy = false
  #paused = false
  #notice = ''
  #error = false
  #phaseLabel = '可以输入'
  #providerCalls = 0
  #lastCall: ChatCallObservation | null = null
  #lastPlayerIntent: string | null = null

  private constructor(options: FrozenPlaytestOptions, compiled: ReturnType<typeof adaptCompiledWorldPack>,
    intentEnabled: boolean) {
    this.#address = compiled.manifest.address
    this.#dataDirectory = options.dataDirectory
    this.#manifestVersion = compiled.manifest.schemaVersion
    this.#intentEnabled = intentEnabled
    const binding = compiled.manifest.playerBindings[0]
    if (binding === undefined) throw new TypeError('playtest Pack has no PlayerBinding')
    this.#principalId = binding.principalId
    this.#playerId = binding.characterId
    this.#names = new Map(compiled.manifest.characters.map(character => [character.characterId, character.name]))
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
    this.#npcNames = characters.map(character => character.name)
    // The adapter returns what the model stated, unjudged; the Host's participant type names the frozen
    // protocol's payload, and the world's validator is what decides whether that is what it got.
    const propose = async (context: unknown): Promise<SubmitActionsV7> =>
      await provider.propose(context) as SubmitActionsV7
    const participants = characters.map((character, index) => ({
      participantId: character.participantId, role: 'agent' as const, actorId: character.actorId,
      allowedActionTypes: ['speak', 'move', 'interact'],
      priority: characters.length - index, estimatedTokens: 1, timeoutMs: timeoutMs + 5_000,
      provider: { propose },
    }))
    // The Host's interpretation profile is a contract with the world, and its deadline ceiling is part of
    // it: a longer call deadline is the adapter's business, not something to state in the profile.
    const intentProfile = { version: 'player-intent-profile/v1' as const, providerId: 'chat-completions',
      modelId: this.#intentModel, maxOutputTokens: 1_024, timeoutMs: Math.min(timeoutMs, 60_000) }
    this.#application = new WorldApplication({
      worldPath: resolve(options.dataDirectory, 'world.sqlite'),
      sessionPath: resolve(options.dataDirectory, 'session.sqlite'),
      memoryPath: resolve(options.dataDirectory, 'memory.sqlite'),
      contextPath: resolve(options.dataDirectory, 'context.sqlite'),
      // The world's model budget has to cover the interpreter's own output ceiling, or the Host refuses to
      // dispatch an interpretation at all: the profile states the ceiling, this is what pays for it.
      modelBudgetTokens: 8_192, leaseTtlMs: 180_000,
      participants: () => participants, reactionParticipants: () => participants,
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
      world: { title: this.#title, playerName: this.#playerName, npcNames: this.#npcNames },
      debug: { ...this.#debug, provider: this.#provider, model: this.#model, intentModel: this.#intentModel,
        providerCalls: this.#providerCalls, paused: this.#paused, lastPlayerIntent: this.#lastPlayerIntent,
        playerInputMode: this.#intentEnabled ? 'interpreted-free-text' : 'legacy-speech',
        lastProviderCall: this.#lastCall },
    }
  }

  async submit(text: string): Promise<PlaytestState> {
    if (this.#busy) throw new PlaytestBusyError('请等待当前行动完成。')
    if (this.#paused) {
      this.#notice = 'NPC 已暂停：这次输入没有提交。恢复后再试。'
      return this.state()
    }
    this.#busy = true
    this.#error = false
    this.#notice = ''
    this.#phaseLabel = text.startsWith('/') ? '正在执行命令' : '正在理解玩家输入'
    const key = `web-playtest:${randomUUID()}`
    try {
      this.#lastPlayerIntent = text.startsWith('/') ? 'command' : 'natural-language'
      const result = await this.#application.submitText(this.#address, { text, idempotencyKey: key,
        principalId: this.#principalId, correlationId: key })
      // A clarification is a durable answer, not a failure: nothing was spent and the world did not move.
      if (result.status === 'clarification_required') {
        this.#notice = `${result.reason}（这次输入没有提交；换一种说法，或用 /act 显式命令。）`
        this.#lastPlayerIntent = 'clarification'
      }
    } catch (error: unknown) {
      this.#error = true
      this.#notice = await this.#whatBecameOf(key)
      console.error('Frozen playtest turn failed:', error instanceof Error ? error.message : 'unknown error')
      throw error
    } finally {
      this.#busy = false
      this.#phaseLabel = this.#paused ? 'NPC 已暂停' : '可以输入'
      await this.#refresh().catch(() => {})
    }
    return this.state()
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
    this.#notice = 'NPC 已暂停：暂停期间的输入不会推进世界。'
    return this.state()
  }

  async resume(): Promise<PlaytestState> {
    this.#paused = false
    this.#notice = '已恢复。'
    return this.state()
  }

  async close(): Promise<void> {
    await this.#application.close()
  }

  async #refresh(): Promise<void> {
    const [view, head, cycles] = await Promise.all([
      this.#application.characterViewForPrincipal(this.#address, this.#principalId, this.#playerId),
      this.#application.head(this.#address),
      this.#application.listReactionCycles(this.#address, { limit: 10 }),
    ])
    this.#transcript = playerTranscript(view, this.#names, this.#playerId)
    const active = cycles.find(cycle => cycle.status !== 'terminal')
    this.#debug = {
      headSeq: head.headSeq, tick: head.tick, manifestVersion: this.#manifestVersion,
      outputProtocol: 'submit_actions/v7',
      cycleStatus: active?.status ?? cycles[0]?.status ?? null,
      currentWave: active?.currentWave ?? cycles[0]?.currentWave ?? null,
      terminalReason: active?.terminalReason ?? cycles[0]?.terminalReason ?? null,
      visibleSceneIds: view.scenes.map(scene => scene.sceneId),
    }
  }
}

export { defaultPlaytestDirectory }
