/**
 * Hash-locked Manifest field kept from the retired NPC Reaction Cycle. It is still compiled into and
 * parsed from Manifests so their hashes stay stable, but no runtime path reads it any more: NPCs are
 * scheduled by the application activation cycle regardless of the declared mode.
 */
export type ReactionPolicyV1 =
  | {
      readonly version: 'reaction-policy/v1'
      readonly mode: 'disabled'
    }
  | {
      readonly version: 'reaction-policy/v1'
      readonly mode: 'responsive'
      readonly profile: ReactionProfileId
    }

export type ReactionProfileId = 'responsive/v1' | 'responsive/v2'
