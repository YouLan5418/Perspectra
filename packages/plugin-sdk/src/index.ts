import type { Context } from '@deepseek-ai/cordis'
import type {
  CharacterId,
  ExpressionSegment,
  WorldAddress,
  WorldJsonObject,
  WorldJsonValue,
} from '@harness-world/contracts'
import type {
  FrontendBgmPlugin,
  FrontendBgmTrack,
  FrontendSpeechAudio,
  FrontendSpeechInput,
} from '@harness-world/frontend'

/** What Cordis host plugins may rely on. The host implements these types; it never hands a plugin
 * character Context, memory, the world store or model credentials. */

/** Major.minor. A new service or optional field raises the minor; any change a plugin could trip over
 * raises the major. A plugin exports `hostApi` with the lowest version it needs. */
export const HOST_API_VERSION = '1.3'

/** Same major, and this host's minor at least the one the plugin asks for. */
export function hostApiCompatible(required: unknown, host: string = HOST_API_VERSION): boolean {
  const parse = (value: unknown) => {
    const match = typeof value === 'string' ? /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/u.exec(value) : null
    return match ? [Number(match[1]), Number(match[2])] : undefined
  }
  const wanted = parse(required),
    current = parse(host)
  return !!wanted && !!current && wanted[0] === current[0] && wanted[1]! <= current[1]!
}

export type SpeechInput = FrontendSpeechInput
export type SpeechAudio = FrontendSpeechAudio
export type BgmTrack = FrontendBgmTrack
export type BgmPlugin = FrontendBgmPlugin

/** `ctx.frontendServices`: one speech and one BGM provider at a time. Wrap each call in `ctx.effect()`. */
export interface FrontendServicesApi {
  registerSpeech(synthesize: (input: SpeechInput, signal: AbortSignal) => Promise<SpeechAudio>): () => void
  registerBgm(plugin: BgmPlugin): () => void
}

export interface CapabilityMethod {
  readonly arguments: WorldJsonObject
  readonly result: WorldJsonObject
  /** `external` for anything that can queue, write or change state outside Perspectra. */
  readonly effect: 'read' | 'external'
}
export interface CapabilityOutcome {
  /** Only `completed` reaches the pack's resolve; `queued` never commits the requested effect. */
  readonly completion: 'completed' | 'queued'
  readonly data: WorldJsonValue
}
export interface CapabilityWorld {
  readonly address: WorldAddress
  readonly worldVersion: string
  /** Bound by the host to the pack's declared NPCs; never accepts caller-supplied Context. */
  readonly requestCharacter: (characterId: string, signal?: AbortSignal) => Promise<WorldJsonObject>
}
export interface CapabilityService {
  invoke(method: string, args: WorldJsonObject, actorId: string, signal: AbortSignal): Promise<CapabilityOutcome>
  close(): Promise<void>
}
export interface CapabilityProvider {
  readonly id: string
  readonly version: string
  readonly methods: Readonly<Record<string, CapabilityMethod>>
  /** Called once per opened world with the pack's declared config. */
  readonly open: (world: CapabilityWorld, config: WorldJsonObject) => Promise<CapabilityService>
}
export interface CapabilityListing {
  readonly id: string
  readonly version: string
  readonly methods: Readonly<Record<string, CapabilityMethod>>
}
/** `ctx.capabilities`: asynchronous abilities a pack's rules can call. */
export interface CapabilitiesApi {
  register(provider: CapabilityProvider): () => Promise<void>
  list(): readonly CapabilityListing[]
}

/** One line of what the player can read, exactly as the default stage receives it. */
export interface PlayerFeedLine {
  readonly seq: number
  readonly speaker: string
  readonly speakerId?: CharacterId
  readonly text: string
  readonly player: boolean
  readonly segments?: readonly ExpressionSegment[]
  /** A round the player let pass; the text is empty. */
  readonly pause?: true
}
/** `reset` replaces everything a listener holds: first publish, regeneration, candidate switch or restore. */
export type PlayerFeedEvent =
  | { readonly kind: 'append'; readonly lines: readonly PlayerFeedLine[] }
  | { readonly kind: 'reset'; readonly lines: readonly PlayerFeedLine[] }
/** `ctx.playerFeed`: read-only; nothing a listener returns reaches the world. */
export interface PlayerFeedApi {
  subscribe(listener: (event: PlayerFeedEvent) => unknown): () => void
}

/** Read access the host grants a trusted plugin. It spans every character, so using it to feed one
 * character another's observations is the plugin's own doing. */
export interface WorldReader {
  readEvents(afterSeq: number, throughSeq: number, types?: readonly string[]): readonly WorldJsonObject[]
  characterObservations(characterId: CharacterId, throughSeq: number): readonly WorldJsonObject[]
  head(): { readonly headSeq: number; readonly tick: number }
  eventTicks(throughSeq: number): readonly { readonly seq: number; readonly tick: number }[]
  /** What this character was allowed to experience, in order. `catchUp: false` reads what is already captured. */
  authorizedSources(
    characterId: CharacterId,
    throughSeq: number,
    options?: { readonly catchUp?: boolean },
  ): readonly AuthorizedSource[]
}
/** One piece of a character's authorized experience, the material long-term memory is built from. */
export interface AuthorizedSource {
  readonly sourceId: string
  readonly sourceHash: string
  readonly epistemicKind: string
  readonly sourceSeq: number
  readonly text: string
}
export interface WorldServices {
  readonly address: WorldAddress
  readonly worldVersion: string
  /** This plugin's own directory inside the instance's data. */
  readonly dataDirectory: string
  /** The world instance's own directory, for implementations that keep files beside its databases. */
  readonly instanceDirectory: string
  /** Who is in this world. Names only; nothing here is private to a character. */
  readonly cast: WorldCast
  readonly world: WorldReader
}
export interface WorldCast {
  readonly playerId: string
  readonly playerName: string
  /** The characters that decide through a model. */
  readonly characterIds: readonly CharacterId[]
  readonly characterNames: ReadonlyMap<string, string>
  readonly locationNames: ReadonlyMap<string, string>
}
/** Registered once per process; `open` runs once per world instance, including regeneration candidates. */
export interface SeamProvider<Instance> {
  readonly id: string
  readonly version: string
  open(world: WorldServices, signal: AbortSignal): Promise<Instance>
  /** Settings that make a regenerated round incomparable once they change. */
  readonly identity?: WorldJsonObject
}

/** The player's settings. Advisory for a plugin: the host does not cap what it spends. */
export interface ActivationLimits {
  readonly maximumWaves: number
  readonly maximumNpcCalls: number
  readonly maximumCallsPerCharacter: number
  readonly reactionDeadlineSeconds?: number
}
export interface AutonomyOpportunities {
  readonly roles: readonly { readonly characterId: CharacterId; readonly opportunities: number }[]
  readonly maximumNpcCalls: number
  readonly deadlineSeconds: number
  readonly reactionLimits: ActivationLimits
}
export interface SchedulerObservation {
  readonly seq: number
  readonly characterId: CharacterId
  /** False when this observer only saw a silent performance not addressed to them. */
  readonly substantive: boolean
}
export interface SchedulerTurnOptions {
  readonly kind?: 'reaction' | 'autonomous'
  readonly signal: AbortSignal
  /** Must belong to this character; the host fetches their content. */
  readonly stimulusSeqs: readonly number[]
  readonly maxCalls: 1 | 2 | 3
  readonly maxModelCalls?: number
  readonly onCommitted?: (asOfWorldSeq: number, headSeq: number) => void
  /** After a stale result: continue an action that already committed instead of repeating it. */
  readonly continuationOf?: {
    readonly actionId: string
    readonly afterSeq?: number
    readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
  }
}
export interface SchedulerTurnResult {
  readonly status: 'published' | 'abstained' | 'budget_exhausted' | 'interrupted' | 'inactive' | 'stale' | 'failed'
  readonly calls: number
  readonly asOfWorldSeq?: number
  readonly performResult?: WorldJsonObject
  readonly failure?: 'provider_failed' | 'invalid_output' | 'preset_failed'
}
export interface SchedulerRound {
  readonly characterIds: readonly CharacterId[]
  readonly afterSeq: number
  readonly signal: AbortSignal
  readonly limits: ActivationLimits
  /** False while the current play requires characters to be handled one at a time. */
  readonly allowConcurrent: boolean
  readonly initialCounts?: ReadonlyMap<CharacterId, number>
  readonly autonomy?: AutonomyOpportunities
  readonly world: WorldReader
  headSeq(): number
  /** Accepted observations of someone else's action, in commit order. */
  observationsSince(afterSeq: number, throughSeq: number): readonly SchedulerObservation[]
  presentCharacterIds(): readonly CharacterId[]
  locationOf(id: CharacterId): string | null
  /** Give one character an opportunity. Facts still commit through the host's normal checks. */
  turn(id: CharacterId, options: SchedulerTurnOptions): Promise<SchedulerTurnResult>
}
export interface SchedulerActivation {
  readonly characterId: CharacterId
  readonly result: SchedulerTurnResult
}
export interface SchedulerCycle {
  readonly calls: number
  readonly wave: number
  /** `failed`, `interrupted`, `call_limit`, `wave_limit` and `character_limit` have their own player notices. */
  readonly terminalReason: string
  readonly activations: readonly SchedulerActivation[]
}
export interface SchedulerResult extends SchedulerCycle {
  readonly autonomy?: {
    readonly activations: readonly SchedulerActivation[]
    readonly autonomousCalls: number
    readonly reactionCalls: number
    readonly reactions: SchedulerCycle
    readonly terminalReason: string
  }
}
export interface SchedulerInstance {
  run(round: SchedulerRound): Promise<SchedulerResult>
  close?(): void | Promise<void>
}
/** `ctx.scheduler`: decides who gets an opportunity and when. Wrap `register` in `ctx.effect()`. */
export interface SchedulerSlotApi {
  /** Throws when another plugin already holds the seam. */
  register(provider: SeamProvider<SchedulerInstance>): () => void
  readonly current: SeamProvider<SchedulerInstance> | undefined
}

/** What a memory implementation is handed of one character decision. */
export interface MemoryRequest {
  readonly context: WorldJsonObject
  readonly decisionId?: string
}
/** Long-term memory for characters. Only `project` is required: it returns the request a character decides on,
 * and what it adds is that character's to know. Everything else is optional; the host treats a missing method
 * as nothing to do, and a save restored without archives simply starts from the recent window. */
export interface MemoryInstance {
  project<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  observeContext?(request: MemoryRequest, promptText: string): void
  recordDecision?(request: MemoryRequest, response: unknown): void
  /** The sequence up to which this memory has taken over; the recent window starts after it. */
  shortTermAfterSeq?(characterId: CharacterId): number
  startPending?(): void
  cancelBackground?(): void
  waitForBackground?(): Promise<void>
  backgroundState?(): WorldJsonObject
  startRefresh?(characterIds: readonly CharacterId[]): void
  inspect?(characterId: string, offset: number, limit: number): WorldJsonObject | undefined
  snapshotAliases?(characterIds: readonly CharacterId[]): WorldJsonObject
  snapshotArchives?(characterIds: readonly CharacterId[]): WorldJsonObject
  restoreArchives?(archives: WorldJsonObject, characterIds: readonly CharacterId[]): void
  holdInstallation?(): void
  releaseInstallation?(): void
  close?(): void | Promise<void>
}
/** `ctx.memory`: replaces the characters' long-term memory. Wrap `register` in `ctx.effect()`. */
export interface MemorySlotApi {
  /** Throws when another plugin already holds the seam. */
  register(provider: SeamProvider<MemoryInstance>): () => void
  readonly current: SeamProvider<MemoryInstance> | undefined
}

/** One model call: the messages to send and the JSON Schema the answer must meet. Hand it back unchanged in
 * `send`; the host's calls carry an extra inspection field for the request log. */
export interface LlmCall {
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly schema: WorldJsonObject
}
/** How characters reach a model. Only `send` is required. */
export interface LlmInstance {
  /** Send one call and return the parsed answer. The host validates it and retries once on bad format. */
  send(characterId: string, call: LlmCall, request: MemoryRequest, signal: AbortSignal): Promise<unknown>
  /** Replace the default prompt for this decision. Without it the host's default call is sent as is. */
  prepare?(characterId: string, request: MemoryRequest, signal: AbortSignal): Promise<LlmCall>
  /** Extra text that counts against the character's context budget, such as a preset prompt. */
  promptText?(characterId: string): string
  /** Reshape what the player reads, such as preset display rules. */
  display?<T>(view: T): Promise<T>
  dispatch?(request: WorldJsonValue, profile: WorldJsonObject, signal: AbortSignal): Promise<WorldJsonValue>
  close?(): void | Promise<void>
}
/** `ctx.llm`: replaces how characters reach a model. Wrap `register` in `ctx.effect()`. */
export interface LlmSlotApi {
  /** Throws when another plugin already holds the seam. */
  register(provider: SeamProvider<LlmInstance>): () => void
  readonly current: SeamProvider<LlmInstance> | undefined
}

/** One way of taking part in every character decision. Everything is optional. */
export interface DecisionInstance {
  /** Add to what this character knows before it decides. Runs after the host's own steps. */
  context?<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  /** Wrap the whole decision. May call `next` several times, or not at all. The answer is validated afterwards. */
  decide?<T extends MemoryRequest>(
    request: T,
    next: (request: T) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<unknown>
  /** The host runs one character at a time and turns off follow-up publication while this is true. */
  readonly serial?: boolean
  committed?(headSeq: number): void
  /** Merged into the state's debug section. */
  debug?(): WorldJsonObject
  close?(): void | Promise<void>
}
/** `ctx.decisions`: any number of implementations, applied in load order. Wrap `register` in `ctx.effect()`. */
export interface DecisionsApi {
  register(provider: SeamProvider<DecisionInstance>): () => void
  readonly providers: readonly SeamProvider<DecisionInstance>[]
}

export interface HostServices {
  frontendServices: FrontendServicesApi
  capabilities: CapabilitiesApi
  playerFeed: PlayerFeedApi
  scheduler: SchedulerSlotApi
  memory: MemorySlotApi
  llm: LlmSlotApi
  decisions: DecisionsApi
}

declare module '@deepseek-ai/cordis' {
  interface Context extends HostServices {}
}

/** A plugin module default-exports this (or a class / `{ apply }`) and exports `hostApi`. `config` holds
 * the values the player entered for the fields its manifest declares, defaults filled in. */
export type HostPlugin = (ctx: Context, config: PluginConfig) => void | Promise<void>
export type PluginConfig = Readonly<Record<string, string | number | boolean>>

/** One field the launcher renders in the plugin's settings. `secret` strings are kept in the system
 * credential store, never in launcher settings, and reach the plugin only at launch. */
export type PluginConfigField = {
  readonly title: string
  readonly description?: string
  readonly required?: boolean
} & (
  | {
      readonly type: 'string'
      readonly default?: string
      readonly enum?: readonly string[]
      readonly maxLength?: number
      readonly secret?: boolean
    }
  | {
      readonly type: 'number' | 'integer'
      readonly default?: number
      readonly minimum?: number
      readonly maximum?: number
    }
  | { readonly type: 'boolean'; readonly default?: boolean }
)

/** Contents of `<entry>.plugin.json` beside the plugin file. The launcher reads it without running the
 * plugin. `services` is the author's statement shown to players; the host does not enforce it. */
export interface PluginManifest {
  readonly name: string
  readonly version: string
  readonly author?: string
  readonly description?: string
  readonly services: readonly (keyof HostServices)[]
  readonly config?: Readonly<Record<string, PluginConfigField>>
}
