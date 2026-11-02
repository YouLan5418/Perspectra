import type { CharacterId, WorldAddress } from '@harness-world/contracts'
import type { AutonomyOpportunities } from '@harness-world/plugin-sdk'
import type { WorldStore } from '@harness-world/store-sqlite'
import { createSchedulerRound, type ActivationTurn } from '../../packages/application/src/scheduler-round.ts'
import { runOfficialSchedule } from '../../packages/official-scheduler/src/index.ts'

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
  autonomy?: AutonomyOpportunities & { turn: ActivationTurn }
}) {
  const { maximumConcurrent, strictCallBudget, limits, locationId, ...round } = input
  return runOfficialSchedule(
    createSchedulerRound({
      ...round,
      limits: limits ?? { maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2 },
      allowConcurrent: locationId !== undefined,
      ...(locationId === undefined ? {} : { locationId }),
      world: { readEvents: () => [], characterObservations: () => [] },
    }),
    {
      ...(maximumConcurrent === undefined ? {} : { maximumConcurrent }),
      ...(strictCallBudget === undefined ? {} : { strictCallBudget }),
    },
  )
}
