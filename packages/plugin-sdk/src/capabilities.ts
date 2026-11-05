import type { WorldAddress, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

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
