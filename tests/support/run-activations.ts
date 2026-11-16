import type { CharacterId, WorldAddress } from '@perspectra/sdk/contracts'
import type { OpportunityScheduleLimits, WakeupSource } from '@perspectra/sdk'
import type { WorldStore } from '@perspectra/core/store'
import { createSchedulerRound, type ActivationTurn } from '../../packages/core/src/application/scheduler-round.ts'
import { runOfficialSchedule } from '../../packages/providers/src/scheduler/index.ts'

/** The official scheduler over a real round, for tests that exercise its behavior directly. */
export function runActivations(input: {
  store: WorldStore
  address: WorldAddress
  turn: ActivationTurn
  afterSeq: number
  characterIds: readonly CharacterId[]
  signal: AbortSignal
  presentCharacterIds?: () => readonly CharacterId[]
  initialCounts?: ReadonlyMap<CharacterId, number>
  strictCallBudget?: boolean
  locationId?: (characterId: CharacterId) => string | null
  maximumConcurrent?: number
  limits?: Parameters<typeof createSchedulerRound>[0]['limits']
  opportunityLimits?: OpportunityScheduleLimits
  wakeupSources?: readonly WakeupSource[]
}) {
  const { maximumConcurrent, strictCallBudget, limits, locationId, ...round } = input
  return runOfficialSchedule(
    createSchedulerRound({
      ...round,
      limits: limits ?? { maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2 },
      allowConcurrent: locationId !== undefined,
      ...(locationId === undefined ? {} : { locationId }),
      world: {} as never,
    }),
    {
      ...(maximumConcurrent === undefined ? {} : { maximumConcurrent }),
      ...(strictCallBudget === undefined ? {} : { strictCallBudget }),
    },
  )
}
