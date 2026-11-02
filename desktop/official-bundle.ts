import { officialSchedulerProvider } from '@harness-world/official-scheduler'
import type { MemoryInstance, SchedulerInstance, SeamProvider } from '@harness-world/plugin-sdk'

export { officialMemoryNoneProvider } from '@harness-world/official-memory-none'

/** The implementation in force for each replaceable seam. */
export interface HostSeams {
  readonly scheduler: SeamProvider<SchedulerInstance>
  readonly memory?: SeamProvider<MemoryInstance>
}

/** The default bundle, and the only production file allowed to import `packages/official-*`. */
export function officialSeams(): HostSeams {
  return { scheduler: officialSchedulerProvider }
}
