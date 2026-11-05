import { ActivityScript, ActivitiesScripts } from '@harness-world/official-activities'
import { createCoreRulebookRegistry, type RulebookRegistry } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldAddress } from '@harness-world/contracts'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { ActivityRuntime } from '../../desktop/host/activity-runtime.ts'
import { ActivitiesRuntime } from '../../desktop/host/activities-runtime.ts'
import { loadActivitySource } from '../../desktop/host/activity-source.ts'
import type { StatusRuntime } from '../../desktop/host/status-runtime.ts'
export { ActivityRuntime, ActivitiesRuntime }
export { readActivityWorld } from '@harness-world/application'
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
