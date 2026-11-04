import type { CharacterId, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import { brandId } from '@harness-world/contracts'
import { createSchedulerRound, type ActivationTurn } from '@harness-world/application'
import type { SchedulerRound, WorldReader } from '@harness-world/plugin-sdk'
import type { WorldStore } from '@harness-world/store-sqlite'
import type { PlaySettings } from '../play-settings.ts'
import type { PackActivities } from './pack-activities.ts'

/** Bind activity opportunities to the current legal participant. Scheduling policy lives in the provider. */
export function createActivityRound(input: {
  readonly activity: PackActivities | undefined
  readonly settings: PlaySettings
  readonly address: WorldAddress
  readonly signal: AbortSignal
  readonly store: WorldStore
  readonly turn: ActivationTurn
  readonly world: WorldReader
  readonly resultUnknown: () => boolean
}): SchedulerRound | undefined {
  const { activity, settings, address, signal, store, turn, world, resultUnknown } = input
  let selected = activity?.schedule()
  if (selected === undefined) return undefined
  let running = false
  return createSchedulerRound({
    phase: 'activity',
    address,
    store,
    world,
    signal,
    afterSeq: 0,
    characterIds: [],
    allowConcurrent: false,
    limits: {
      maximumWaves: settings.activityOpportunities,
      maximumNpcCalls: settings.maximumNpcCalls,
      maximumCallsPerCharacter: settings.maximumCallsPerCharacter,
    },
    activity: {
      opportunities: settings.activityOpportunities,
      deadlineSeconds: settings.activityDeadlineSeconds,
      next: () => (selected === undefined ? undefined : brandId(selected, 'CharacterId')),
      resultUnknown,
    },
    turn: {
      run: async (id: CharacterId, options) => {
        signal.throwIfAborted()
        if (running || selected === undefined || id !== selected || activity?.schedule() !== id)
          throw new TypeError('activity turn requires its current legal participant')
        running = true
        try {
          const result = await turn.run(id, options)
          selected =
            signal.aborted || options?.signal?.aborted || resultUnknown()
              ? undefined
              : activity.outcome(result as unknown as WorldJsonObject)
          return result
        } finally {
          running = false
        }
      },
    },
  })
}
