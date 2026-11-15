import type { CharacterId } from '@harness-world/contracts'
import type { OpportunityScheduleLimits, SchedulerRound } from '@harness-world/plugin-sdk'

/** Private official policy accounting; this never chooses another character executor. */
export interface OpportunityRound extends SchedulerRound {
  readonly autonomy?: OpportunityScheduleLimits & {
    readonly roles: readonly { readonly characterId: CharacterId; readonly opportunities: number }[]
    readonly stimuli: ReadonlyMap<CharacterId, readonly number[]>
  }
}
