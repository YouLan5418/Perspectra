import type { CharacterId } from '@perspectra/sdk/contracts'
import type { OpportunityScheduleLimits, SchedulerRound } from '@perspectra/sdk'

/** Private official policy accounting; this never chooses another character executor. */
export interface OpportunityRound extends SchedulerRound {
  readonly autonomy?: OpportunityScheduleLimits & {
    readonly roles: readonly { readonly characterId: CharacterId; readonly opportunities: number }[]
    readonly stimuli: ReadonlyMap<CharacterId, readonly number[]>
  }
}
