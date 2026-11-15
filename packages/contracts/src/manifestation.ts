import type { WorldEventDraft } from './protocol.ts'
import type { WorldJsonObject } from './world-json.ts'

export interface ManifestationCueResolution extends WorldJsonObject {
  readonly cueId: string
  readonly status: 'accepted' | 'rejected'
  readonly reason: 'accepted' | 'visible_state_absent'
}

export interface ManifestationResolution extends WorldJsonObject {
  readonly status: 'accepted' | 'partially_accepted' | 'rejected'
  readonly cueResolutions: readonly ManifestationCueResolution[]
  readonly events: readonly WorldEventDraft[]
}
