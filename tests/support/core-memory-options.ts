import { assembleCoreMemory } from '../../desktop/official-bundle.ts'
import type { CoreProviderOptions } from '../../packages/official-memory-core/src/core-provider.ts'
import { WorldHostRuntime, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'

export interface CoreTestOptions {
  readonly memoryCore?: boolean
  readonly memoryCoreRun?: CoreProviderOptions['run']
  readonly memoryCoreBuildRun?: CoreProviderOptions['buildRun']
  readonly memoryCoreRunners?: CoreProviderOptions['runners']
  readonly memoryBuildConcurrency?: CoreProviderOptions['buildConcurrency']
  readonly memoryContextBudget?: CoreProviderOptions['contextBudget']
}

/** The options tests and studies have always written, as the provider the host now takes. */
export function withCoreMemory(options: WorldHostOptions & CoreTestOptions): WorldHostOptions {
  const {
    memoryCore,
    memoryCoreRun,
    memoryCoreBuildRun,
    memoryCoreRunners,
    memoryBuildConcurrency,
    memoryContextBudget,
    ...rest
  } = options
  if (!memoryCore) return rest
  return {
    ...rest,
    plugins: {
      ...rest.plugins,
      memory: assembleCoreMemory({
        models: rest.models,
        ...(rest.playSettings === undefined ? {} : { playSettings: rest.playSettings }),
        ...(memoryCoreRun === undefined ? {} : { run: memoryCoreRun }),
        ...(memoryCoreBuildRun === undefined ? {} : { buildRun: memoryCoreBuildRun }),
        ...(memoryCoreRunners === undefined ? {} : { runners: memoryCoreRunners }),
        ...(memoryBuildConcurrency === undefined ? {} : { buildConcurrency: memoryBuildConcurrency }),
        ...(memoryContextBudget === undefined ? {} : { contextBudget: memoryContextBudget }),
      }),
    },
  }
}

export const createRuntimeWithCore = async (options: WorldHostOptions & CoreTestOptions) =>
  WorldHostRuntime.create(withCoreMemory(options))
