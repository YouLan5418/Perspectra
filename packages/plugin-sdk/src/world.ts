import type { CharacterId, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { MemoryRequest } from './memory.ts'
import type { KnowledgeSource } from './knowledge.ts'
import type { StatusSource } from './status.ts'
import type { ActivitySource } from './activities.ts'
import type { CommunicationSource } from './communication.ts'
import type { AutonomySource } from './autonomy.ts'

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
  /** Opened as a regeneration candidate. Avoid side effects outside the instance. If the player selects it, this
   * instance keeps running as is, and the next time the world opens it is no longer a candidate. */
  readonly candidate: boolean
  /** Who is in this world. Names only; nothing here is private to a character. */
  readonly cast: WorldCast
  readonly world: WorldReader
  /** Trusted author materials, supplied only to the selected knowledge provider; never a model-visible request. */
  readonly knowledgeSource?: KnowledgeSource
  /** Locked status/module texts and resolved availability, supplied only to the selected status provider. */
  readonly statusSource?: StatusSource
  /** Locked activity texts, supplied only to the selected activities provider. */
  readonly activitySource?: ActivitySource
  /** Locked configuration and public identifiers, only for the selected mechanism. */
  readonly communicationSource?: CommunicationSource
  readonly autonomySource?: AutonomySource
  /** Authorized context projections, available equally to official and replacement decisions. */
  readonly contextSources?: DecisionContextSources
}
export interface DecisionContextSources {
  /** Pair with memory() when the selected context step restores this archived prefix. */
  memoryAfterSeq?(characterId: CharacterId): number | undefined
  memory<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  recentExecution<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  status<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  knowledge<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
  expressions<T extends MemoryRequest>(request: T, signal: AbortSignal): Promise<T>
}
export interface WorldCast {
  readonly playerId: string
  readonly playerName: string
  /** The characters that decide through a model. */
  readonly characterIds: readonly CharacterId[]
  readonly characterNames: ReadonlyMap<string, string>
  readonly entityIds: readonly string[]
  readonly locationNames: ReadonlyMap<string, string>
}
/** Registered once per process; `open` runs once per world instance, including regeneration candidates. */
export interface SeamProvider<Instance> {
  readonly id: string
  readonly version: string
  open(world: WorldServices, signal: AbortSignal): Promise<Instance>
  /** Public, non-secret settings that make a regenerated round incomparable once they change.
   * Object key order is ignored; the host never infers this from plugin config or credentials. */
  readonly identity?: WorldJsonObject
}
