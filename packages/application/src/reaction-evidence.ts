import {
  strongestReactionRoleClass,
  type CharacterId,
  type ReactionEvidenceV1,
  type ReactionPolicyV1,
  type ReactionRoleClass,
} from '@harness-world/contracts'
import type { RulebookResolution } from '@harness-world/kernel'

/** The addressees a speech named. Any other action names nobody, so its observers are never addressees. */
export function speechAddressees(resolution: RulebookResolution): readonly string[] {
  const event = resolution.events.find(entry => entry.eventType === 'character.speak')
  return (event?.data as { addresseeIds?: readonly string[] } | undefined)?.addresseeIds ?? []
}

/**
 * The class one observer holds for one action, from facts that already exist: who acted, what the
 * definition's own policy says the effect landed on, and who the action named. It reads no event field
 * looking for something that resembles a character id.
 *
 * Both writers of a reaction stimulus call this - the Root Round for the Cycle it opens, and the
 * Reaction Round for the next wave's candidates - so a wave-two stimulus is classified by the same rule
 * as a wave-one one rather than being a special case.
 */
export function reactionRoleClass(input: {
  readonly actorId: string
  readonly observerId: string
  /** Absent for an action no frozen definition adjudicated, which lands on nobody. */
  readonly affectedCharacterIds: readonly string[] | undefined
  readonly addresseeIds: readonly string[]
}): ReactionRoleClass {
  if (input.observerId === input.actorId) return 'self'
  if ((input.affectedCharacterIds ?? []).includes(input.observerId)) return 'direct'
  if (input.addresseeIds.includes(input.observerId)) return 'addressee'
  return 'witness'
}

/**
 * Why one observer is being weighed. The entry names the definition lock when a definition adjudicated
 * the action and the action itself otherwise, because speech and movement are not resolved by one.
 */
export function reactionEvidence(input: {
  readonly actionId: string
  readonly actionType: string
  readonly actionVersion: number
  readonly actorId: string
  readonly observerId: CharacterId
  readonly resolution: RulebookResolution
  readonly roleClass: ReactionRoleClass
  readonly sourceEventOrdinal: number
  readonly observationId: string
}): ReactionEvidenceV1 {
  return {
    version: 'reaction-evidence/v1',
    sourceEventOrdinal: input.sourceEventOrdinal,
    observationId: input.observationId,
    observerCharacterId: input.observerId,
    actionId: input.actionId,
    entry: input.resolution.definitionRef === undefined
      ? { kind: 'action', actionType: input.actionType, actionVersion: input.actionVersion }
      : { kind: 'definition', definitionRef: input.resolution.definitionRef },
    roleClass: input.roleClass,
  }
}

/**
 * Whether this world's profile records why an observer was weighed. It is one predicate rather than a
 * conjunction at each call site, so the disabled case is answered here instead of being a branch a
 * running wave could never take.
 */
export function recordsReactionEvidence(policy: ReactionPolicyV1): boolean {
  return policy.mode === 'responsive' && policy.profile === 'responsive/v2'
}

/**
 * The strongest class among a candidate's observations, which is the one it is weighed by. Callers hand
 * this to the budget planner, which owns the ordering; a caller does not sort with it, because a plan
 * that re-sorted later would silently override whatever order a draft happened to be in. The rank itself
 * lives with the contract, so the persistence boundary can check a candidate the same way.
 */
export function strongestClass(stimuli: readonly { readonly roleClass?: ReactionRoleClass }[]): ReactionRoleClass {
  return strongestReactionRoleClass(stimuli.map(stimulus => stimulus.roleClass!))
}
