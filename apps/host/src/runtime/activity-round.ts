import type { CharacterId, WorldAddress, WorldJsonObject } from '@perspectra/sdk/contracts'
import { brandId } from '@perspectra/sdk/contracts'
import { createSchedulerRound, type ActivationTurn, type ExecutionSchedulerRound } from '@perspectra/core'
import type { WorldReader } from '@perspectra/sdk'
import type { WorldStore } from '@perspectra/core/store'
import type { PlaySettings } from '../play-settings.ts'
import type { ActivitiesRuntime } from './activities-runtime.ts'

/** Bind activity opportunities to the current legal participant. Scheduling policy lives in the provider. */
export function createActivityRound(input: {
  readonly activity: ActivitiesRuntime | undefined
  readonly settings: PlaySettings
  readonly address: WorldAddress
  readonly signal: AbortSignal
  readonly store: WorldStore
  readonly turn: ActivationTurn
  readonly world: WorldReader
  readonly resultUnknown: () => boolean
}): ExecutionSchedulerRound | undefined {
  const { activity, settings, address, signal, store, turn, world, resultUnknown } = input
  let selected = activity?.schedule()
  if (selected === undefined) return undefined
  let running = false
  const validateTurn = (id: CharacterId) => {
    signal.throwIfAborted()
    if (running || selected === undefined || id !== selected || activity?.schedule() !== id)
      throw new TypeError('activity turn requires its current legal participant')
  }
  return createSchedulerRound({
    phase: 'activity',
    validateTurn,
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
        validateTurn(id)
        running = true
        try {
          const result = await turn.run(id, options)
          selected =
            signal.aborted || options?.signal?.aborted || resultUnknown()
              ? undefined
              : activity!.outcome(result as unknown as WorldJsonObject)
          return result
        } finally {
          running = false
        }
      },
    },
  })
}
