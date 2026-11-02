import type { SchedulerInstance, SeamProvider } from '@harness-world/plugin-sdk'

/** The implementation in force for each replaceable seam. */
export interface HostSeams {
  readonly scheduler: SeamProvider<SchedulerInstance>
}

/** The default bundle, and the only production file allowed to import `packages/official-*`. */
export function officialSeams(): HostSeams {
  return {
    scheduler: {
      id: 'official-scheduler',
      version: '1.0.0',
      open: async () => {
        throw new Error('official scheduler is not wired yet')
      },
    },
  }
}
