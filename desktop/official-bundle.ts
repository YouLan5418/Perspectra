import { officialSchedulerProvider } from '@harness-world/official-scheduler'
import type { SchedulerInstance, SeamProvider } from '@harness-world/plugin-sdk'

export { runOfficialSchedule } from '@harness-world/official-scheduler'

/** The implementation in force for each replaceable seam. */
export interface HostSeams {
  readonly scheduler: SeamProvider<SchedulerInstance>
}

/** The default bundle, and the only production file allowed to import `packages/official-*`. */
export function officialSeams(): HostSeams {
  return { scheduler: officialSchedulerProvider }
}
