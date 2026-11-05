import { officialActivitiesProvider } from '@harness-world/official-activities'
import { StatusScripts, officialStatusProvider } from '@harness-world/official-status'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
export { composeDecisions, officialContextOrder } from '@harness-world/official-contexts'
import { composeDecisions } from '@harness-world/official-contexts'
import { officialLlmProvider } from '@harness-world/official-llm'
import { officialMemoryNoneProvider } from '@harness-world/official-memory-none'
import type { Context } from '@deepseek-ai/cordis'
import { officialSchedulerProvider } from '@harness-world/official-scheduler'
import { officialCharacterLoopProvider } from '@harness-world/official-character-loop'
import { officialKnowledgeProvider } from '@harness-world/official-knowledge'
import type {
  DecisionInstance,
  CharacterLoopInstance,
  KnowledgeInstance,
  StatusInstance,
  ActivitiesInstance,
  LlmInstance,
  LlmTransportInstance,
  MemoryInstance,
  RulesInstance,
  SchedulerInstance,
  SeamProvider,
} from '@harness-world/plugin-sdk'

import { coreMemoryProvider, type CoreProviderOptions } from '@harness-world/official-memory-core'
import type { RuntimeRoleModels } from './model-connections.ts'
import { playSettings, type PlaySettings } from './play-settings.ts'

export { officialMemoryNoneProvider } from '@harness-world/official-memory-none'
export {
  createClaimClassifier,
  jevPublicationAudit,
  jevShadowAudit,
  parseAuditItems,
  takeClaimKey,
  type ShadowOptions,
} from '@harness-world/official-jev-audit'
export { officialLlmProvider, llmTimeoutMs, type ModelOptions } from '@harness-world/official-llm'
export {
  CORE_MEMORY_ID,
  corePythonExecutable,
  corePythonRoot,
  importCoreArchives,
} from '@harness-world/official-memory-core'

/** The default gameplay install, explicitly supplied by desktop entry composition. */
export const defaultInteractionPackages = createInstalledInteractionPackages

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
  readonly knowledge?: SeamProvider<KnowledgeInstance>
  readonly status?: SeamProvider<StatusInstance>
  readonly activities?: SeamProvider<ActivitiesInstance>
  readonly scheduler: SeamProvider<SchedulerInstance>
  readonly characterLoop?: SeamProvider<CharacterLoopInstance>
  readonly memory?: SeamProvider<MemoryInstance>
  readonly llm?: SeamProvider<LlmInstance>
  readonly llmTransport?: SeamProvider<LlmTransportInstance>
  /** Ordered context IDs; omitted official steps stay disabled. Defaults to the official order. */
  readonly decisionOrder?: readonly string[]
  /** Implementations to replace or append; decision wrappers apply with the first outermost. */
  readonly decisions?: readonly SeamProvider<DecisionInstance>[]
  /** Layers around the official rules; the first is outermost. */
  readonly rules?: readonly SeamProvider<RulesInstance>[]
}

/** The default bundle, and the only production file allowed to import `packages/official-*`. */
export function officialSeams(): HostSeams {
  return { scheduler: officialSchedulerProvider, characterLoop: officialCharacterLoopProvider }
}

/** World opening order is composition policy, separate from Cordis inject and pack requirements. */
export const officialWorldOrder = [
  'llm',
  'rules',
  'memory',
  'knowledge',
  'status',
  'activities',
  'decisions',
  'scheduler',
  'characterLoop',
] as const

/** Direct hosts and the plugin loader share the same default choices and decision ordering. */
export function composeWorldSeams(plugins: Partial<HostSeams> = {}) {
  return {
    ...plugins,
    knowledge: plugins.knowledge ?? officialKnowledgeProvider,
    status: plugins.status ?? officialStatusProvider,
    activities: plugins.activities ?? officialActivitiesProvider,
    scheduler: plugins.scheduler ?? officialSchedulerProvider,
    characterLoop: plugins.characterLoop ?? officialCharacterLoopProvider,
    memory: plugins.memory ?? officialMemoryNoneProvider,
    decisions: composeDecisions(plugins.decisions ?? [], plugins.decisionOrder),
    rules: plugins.rules ?? [],
  }
}

/** Called after player plugins settle. Every default uses the same public registration API. */
export function installOfficialBundle(ctx: Context, memory?: () => SeamProvider<MemoryInstance>): void {
  if (!ctx.activities.current) ctx.effect(() => ctx.activities.register(officialActivitiesProvider))
  if (!ctx.status.current) ctx.effect(() => ctx.status.register(officialStatusProvider))
  if (!ctx.knowledge.current) ctx.effect(() => ctx.knowledge.register(officialKnowledgeProvider))
  if (!ctx.scheduler.current) ctx.effect(() => ctx.scheduler.register(officialSchedulerProvider))
  if (!ctx.characterLoop.current) ctx.effect(() => ctx.characterLoop.register(officialCharacterLoopProvider))
  if (!ctx.memory.current && memory) ctx.effect(() => ctx.memory.register(memory()))
  for (const provider of composeDecisions(ctx.decisions.providers)) {
    if (!ctx.decisions.providers.some(current => current.id === provider.id))
      ctx.effect(() => ctx.decisions.register(provider))
  }
}

/** Credentials and observation callbacks are supplied by the entry, not exposed through WorldServices. */
export function composeModelChannel(
  options: Parameters<typeof officialLlmProvider>[0],
  replacement?: SeamProvider<LlmInstance>,
) {
  return replacement ?? officialLlmProvider(options)
}

/** Explicit official interpretation for read-only creator/import preflight; game worlds use the registered service. */
export const createDefaultStatusScripts = (source: import('@harness-world/plugin-sdk').StatusSource | undefined) =>
  new StatusScripts(source)
