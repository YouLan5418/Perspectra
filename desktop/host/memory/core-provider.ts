import type { CharacterId, WorldJsonObject } from '@harness-world/contracts'
import type { CharacterTurnRequest } from '@harness-world/application'
import type { MemoryInstance, SeamProvider } from '@harness-world/plugin-sdk'
import type { RuntimeRoleModels } from '../../model-connections.ts'
import { playSettings, type PlaySettings } from '../../play-settings.ts'
import { CoreMemoryAdapter, type MemoryBuildOptions, type MemoryContextBudget } from './core-memory.ts'
import { assertCoreEnvironment, coreRunnerGroups, type CoreRunner, type MemoryRunners } from './python-worker.ts'

export const CORE_MEMORY_ID = 'official-memory-core'

/** Assembled by the entry that holds the model connections, so no plugin ever sees them. */
export interface CoreProviderOptions {
  readonly models: RuntimeRoleModels
  readonly playSettings?: Partial<PlaySettings>
  readonly run?: CoreRunner
  readonly buildRun?: CoreRunner
  /** Starts the Core runners for one memory model; defaults to a lazy Python worker plus one-shot builds. */
  readonly runners?: (environment: NodeJS.ProcessEnv) => MemoryRunners
  readonly buildConcurrency?: Omit<MemoryBuildOptions, 'run'>
  readonly contextBudget?: MemoryContextBudget
}

/** Long-term memory that distills each character's authorized experience through the Python Core. */
export function coreMemoryProvider(options: CoreProviderOptions): SeamProvider<MemoryInstance> {
  // Only the default runners start Python; injected runners (tests, studies) bring their own. Checked while
  // assembling, so a machine without Python is refused before any save directory exists.
  if (options.runners === undefined && (options.run === undefined || options.buildRun === undefined))
    assertCoreEnvironment()
  return {
    id: CORE_MEMORY_ID,
    version: '1.0.0',
    identity: { memoryContextBudget: (options.contextBudget ?? null) as WorldJsonObject | null },
    open: async world => {
      const settings = playSettings(options.playSettings ?? {})
      const groups = coreRunnerGroups(world.instanceDirectory, options.runners)
      const shared =
        options.run === undefined || options.buildRun === undefined
          ? groups.runnersFor(options.models.default.memory)
          : undefined
      const own =
        options.run === undefined
          ? new Map(Object.entries(options.models.characters).map(([id, role]) => [id, groups.runnersFor(role.memory)]))
          : new Map<string, MemoryRunners>()
      let closing = false
      const adapter = new CoreMemoryAdapter(
        world.instanceDirectory,
        world.address,
        options.run ?? shared!.recall,
        options.contextBudget ?? {
          triggerTokens: settings.memoryTriggerTokens,
          compactTokens: settings.memoryCompactTokens,
          minimumRecentTokens: settings.memoryRecentTokens,
        },
        {
          ...options.buildConcurrency,
          run: options.buildRun ?? shared!.build,
          runFor: actor => own.get(actor),
          worldVersion: world.worldVersion,
          versionValid: () => !closing,
        },
        { maxItems: settings.memoryMaxItems, maxJsonChars: settings.memoryMaxJsonChars },
      )
      return {
        project: async (request, signal) =>
          (await adapter.project(request as unknown as CharacterTurnRequest, signal)) as unknown as typeof request,
        observeContext: (request, promptText) =>
          adapter.observeContext(request as unknown as CharacterTurnRequest, promptText),
        recordDecision: (request, response) =>
          adapter.recordDecision(request as unknown as CharacterTurnRequest, response),
        shortTermAfterSeq: (characterId: CharacterId) => adapter.shortTermAfterSeq(characterId),
        startPending: () => adapter.startPending(),
        cancelBackground: () => adapter.cancelBackground(),
        waitForBackground: () => adapter.waitForBackground(),
        backgroundState: () => adapter.backgroundState(),
        startRefresh: characterIds => adapter.startRefresh(characterIds),
        inspect: (characterId, offset, limit) => adapter.inspectArchive(characterId, offset, limit),
        snapshotAliases: characterIds => adapter.snapshotAliases(characterIds),
        snapshotArchives: characterIds => adapter.snapshotArchives(characterIds),
        restoreArchives: (archives, characterIds) => adapter.restoreArchives(archives, characterIds),
        holdInstallation: () => adapter.holdInstallation(),
        releaseInstallation: () => adapter.releaseInstallation(),
        close: async () => {
          closing = true
          await adapter.close()
          await groups.close()
        },
      }
    },
  }
}
