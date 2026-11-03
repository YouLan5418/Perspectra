import { officialSchedulerProvider } from '@harness-world/official-scheduler'
import type { LlmInstance, MemoryInstance, SchedulerInstance, SeamProvider } from '@harness-world/plugin-sdk'

import { coreMemoryProvider, type CoreProviderOptions } from '@harness-world/official-memory-core'
import type { RuntimeRoleModels } from './model-connections.ts'
import { playSettings, type PlaySettings } from './play-settings.ts'

export { officialMemoryNoneProvider } from '@harness-world/official-memory-none'
export { officialLlmProvider, llmTimeoutMs, type ModelOptions } from '@harness-world/official-llm'
export {
  CORE_MEMORY_ID,
  corePythonExecutable,
  corePythonRoot,
  importCoreArchives,
} from '@harness-world/official-memory-core'

/** Core with the model connections and settings only the entry holds. */
export function assembleCoreMemory(
  options: Omit<CoreProviderOptions, 'models' | 'settings'> & {
    readonly models: RuntimeRoleModels
    readonly playSettings?: Partial<PlaySettings>
  },
): SeamProvider<MemoryInstance> {
  const { playSettings: settings, ...rest } = options
  return coreMemoryProvider({ ...rest, settings: playSettings(settings ?? {}) })
}

/** The implementation in force for each replaceable seam. */
export interface HostSeams {
  readonly scheduler: SeamProvider<SchedulerInstance>
  readonly memory?: SeamProvider<MemoryInstance>
  readonly llm?: SeamProvider<LlmInstance>
}

/** The default bundle, and the only production file allowed to import `packages/official-*`. */
export function officialSeams(): HostSeams {
  return { scheduler: officialSchedulerProvider }
}
