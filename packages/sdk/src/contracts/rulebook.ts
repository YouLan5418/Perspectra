import type { ManifestationProposal } from './cognition-projection.ts'
import type { ManifestationResolution } from './manifestation.ts'
import type { WorldEventDraft } from './protocol.ts'
import type { WorldJsonObject, WorldJsonValue } from './world-json.ts'

export interface PlayerActionInput extends WorldJsonObject {
  readonly actionType: string
  readonly parameters: WorldJsonValue
}

/** An expected business refusal, preserved through adjudication and durable results. */
export interface BusinessRejection extends WorldJsonObject {
  readonly code: string
  readonly message: string
  readonly details?: WorldJsonObject
}

export interface RulebookResolution {
  readonly status: 'accepted' | 'rejected'
  readonly events: readonly WorldEventDraft[]
  readonly reason?: string
  readonly rejection?: BusinessRejection
  /** A performance adjudicated inside a frozen definition, returned so the Host records its Authority. */
  readonly manifestation?: {
    readonly proposal: ManifestationProposal
    readonly resolution: ManifestationResolution
  }
  /**
   * The frozen path's rule trace: the definition set, the resolved role bindings and the trace hash
   * that binds them to the World, the Manifest, the candidate prefix and the authority. It is absent on
   * every path that has no frozen rule plan, which is every Manifest before v10, and it is what a Host
   * binds into durable Round Authority.
   */
  readonly interactionTrace?: WorldJsonObject
  /**
   * The definition that adjudicated this action, when one did. Speech and movement are not resolved by
   * a registered definition, so a reaction evidence entry falls back to the action's own identity.
   */
  readonly definitionRef?: { readonly id: string; readonly version: number }
  /**
   * The characters the frozen plan's declared affected slots resolved to, empty when the action did not
   * happen. A reaction role class reads `direct` from this rather than from scanning an event.
   */
  readonly affectedCharacterIds?: readonly string[]
  /**
   * The frozen plan's resolved role bindings by role name, when the action has a frozen plan. A Host
   * needs the names - not only their hash - to state which character an effect landed on, which is what
   * a reaction role class is read from.
   */
  readonly resolvedRoles?: { readonly [name: string]: { readonly kind: string; readonly id: string } }
  /** This player status result is observable but does not itself nominate a scene response. */
  readonly sceneReaction?: false
  /** Maximum audience granted by the Rulebook; Scene policy may only narrow it. */
  readonly observationScope?: {
    readonly scope: 'scene_public' | 'direct' | 'private' | 'self'
    readonly recipientIds?: readonly string[]
  }
}

export interface RulebookEvent {
  readonly eventType: string
  readonly eventVersion?: number
  readonly data: WorldJsonValue
}
