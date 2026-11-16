import { ActivityScript, ActivitiesScripts } from '@perspectra/providers/activities'
import { createCoreRulebookRegistry, type RulebookRegistry } from '@perspectra/core/kernel'
import { WorldStore } from '@perspectra/core/store'
import type { WorldAddress } from '@perspectra/sdk/contracts'
import type { CompiledWorldPackV5 } from '@perspectra/world-pack'
import { ActivityRuntime } from '../../apps/host/src/runtime/activity-runtime.ts'
import { ActivitiesRuntime } from '../../apps/host/src/runtime/activities-runtime.ts'
import { loadActivitySource } from '../../apps/host/src/runtime/activity-source.ts'
import type { StatusRuntime } from '../../apps/host/src/runtime/status-runtime.ts'
export { ActivityRuntime, ActivitiesRuntime }
export { readActivityWorld } from '@perspectra/core'
export function activityFromSource(
  source: string,
  worldPath: string,
  address: WorldAddress,
  playerId: string,
  key = 'default',
  status?: StatusRuntime,
  coreRules?: RulebookRegistry,
): ActivityRuntime {
  const activity: ActivityRuntime = new ActivityRuntime(
    new ActivityScript({ key, entry: 'scripts/activity.js', source }),
    worldPath,
    address,
    playerId,
    key,
    status,
    coreRules ?? createCoreRulebookRegistry(),
    {
      randomSource: () => Math.random(),
      readCurrent: () => {
        const store = new WorldStore(worldPath)
        try {
          return activity.state(store.readEventsRange(address, 0, store.head(address).headSeq, ['activity.updated']))
        } finally {
          store.close()
        }
      },
    },
  )
  activity.current()
  return activity
}
export function loadActivities(
  packPath: string,
  pack: CompiledWorldPackV5,
  worldPath: string,
  address: WorldAddress,
  playerId: string,
  status?: StatusRuntime,
  coreRules?: RulebookRegistry,
) {
  return ActivitiesRuntime.open(
    new ActivitiesScripts(loadActivitySource(packPath, pack)),
    worldPath,
    address,
    playerId,
    status,
    coreRules ?? createCoreRulebookRegistry(),
  )
}
