import { coreMemoryProvider, type CoreProviderOptions } from '@perspectra/memory-core'
import type { SeamProvider, MemoryInstance } from '@perspectra/sdk'
import type { RuntimeRoleModels } from './model-connections.ts'
import { playSettings, type PlaySettings } from './play-settings.ts'

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
