import type { CharacterId, InteractionRoundId } from './ids.ts'
import type { InteractionPerformanceAcceptance } from './interaction-definition.ts'
import type { RulebookResolutionAuthorityV1 } from './resolution-authority.ts'
import type { PlayerActionInput, RulebookEvent } from './rulebook.ts'
import type { CompiledWorldManifest } from './world-spec.ts'
import type { WorldHash, WorldJsonObject } from './world-json.ts'

export interface RulebookResolutionContext {
  /** Host-owned publication limit, never supplied by action parameters. */
  readonly publicationCharacters?: number
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly characterId: CharacterId | string
  readonly actionId?: string
  readonly resolutionAuthority?: RulebookResolutionAuthorityV1
  /** The Host's own identity of the locked Manifest. A frozen resolution binds it into its trace. */
  readonly manifestHash?: WorldHash
  /** The world sequence the candidate prefix sits at. A frozen resolution binds it into its trace. */
  readonly asOfWorldSeq?: number
  /**
   * The Round the action belongs to. A step that states cues needs it, because a manifestation is a
   * Round-scoped fact; a resolution that produces none never reads it.
   */
  readonly roundId?: InteractionRoundId
  readonly action: PlayerActionInput
}

export interface ActionAffordance {
  readonly actionType: string
  readonly actionVersion: number
  readonly interactions?: readonly WorldJsonObject[]
  /**
   * What the definitions behind those options accept as a step, one entry per definition. It rides here
   * rather than on each option for the reason the frozen affordance states: it is the definition's own
   * answer, and an option is what a caller turns into request parameters. A rulebook that never saw a
   * locked policy leaves it absent, which is the same answer as "nothing here accepts a step".
   */
  readonly performances?: readonly InteractionPerformanceAcceptance[]
  /** Where a `move` may go, from the world's own locations. Absent means the rulebook offers no list. */
  readonly destinations?: readonly { readonly locationId: string; readonly name: string }[]
}
