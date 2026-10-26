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
export const HOST_API_VERSION = '1.0'

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

export interface HostServices {
  frontendServices: FrontendServicesApi
  capabilities: CapabilitiesApi
  playerFeed: PlayerFeedApi
}

declare module '@deepseek-ai/cordis' {
  interface Context extends HostServices {}
}

/** A plugin module default-exports this (or a class / `{ apply }`) and exports `hostApi`. */
export type HostPlugin = (ctx: Context) => void | Promise<void>
