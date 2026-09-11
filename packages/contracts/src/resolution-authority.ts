import type { WorldJsonObject } from './world-json.ts'

export type RulebookSourceRole = 'player' | 'agent' | 'director'
export type RulebookAdjudicationMode = 'standard' | 'manual_player_immediate'

/** Host-derived adjudication context. Untrusted Action parameters never populate this object. */
export interface RulebookResolutionAuthorityV1 extends WorldJsonObject {
  readonly version: 'resolution-authority/v1'
  readonly sourceRole: RulebookSourceRole
  readonly adjudicationMode: RulebookAdjudicationMode
}

export function resolutionAuthority(
  sourceRole: RulebookSourceRole,
  adjudicationMode: RulebookAdjudicationMode,
): RulebookResolutionAuthorityV1 {
  if (adjudicationMode === 'manual_player_immediate' && sourceRole !== 'player') {
    throw new TypeError('manual_player_immediate requires player sourceRole')
  }
  return { version: 'resolution-authority/v1', sourceRole, adjudicationMode }
}

export function validateResolutionAuthority(value: RulebookResolutionAuthorityV1): RulebookResolutionAuthorityV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'adjudicationMode,sourceRole,version'
    || value.version !== 'resolution-authority/v1'
    || (value.sourceRole !== 'player' && value.sourceRole !== 'agent' && value.sourceRole !== 'director')
    || (value.adjudicationMode !== 'standard' && value.adjudicationMode !== 'manual_player_immediate')) {
    throw new TypeError('resolution authority is invalid')
  }
  return resolutionAuthority(value.sourceRole, value.adjudicationMode)
}
