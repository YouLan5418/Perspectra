import { officialRpgStageRenderer } from '@perspectra/plugins/rpg'
import type { ActivityStageRenderer } from '@perspectra/sdk/contracts'
import type { InteractionPackageImplementation } from '@perspectra/sdk/contracts'
import { officialCommunicationProvider } from '@perspectra/providers/communication'
import { officialActivitiesProvider } from '@perspectra/providers/activities'
import { officialStatusProvider } from '@perspectra/providers/status'
import { officialPacingProvider } from '@perspectra/plugins/pacing'
import { officialDiceProvider } from '@perspectra/plugins/dice'
import { createInstalledInteractionPackages } from '@perspectra/plugins/basic-interactions'
export { composeDecisions, officialContextOrder } from '@perspectra/providers/contexts'
import { composeDecisions } from '@perspectra/providers/contexts'
import { officialLlmProvider } from '@perspectra/providers/llm'
import { officialMemoryNoneProvider } from '@perspectra/providers/memory-none'
import type { Context } from '@deepseek-ai/cordis'
import { officialSchedulerProvider, officialAutonomyProvider } from '@perspectra/providers/scheduler'
import { officialCharacterLoopProvider } from '@perspectra/providers/character-loop'
import { officialKnowledgeProvider } from '@perspectra/providers/knowledge'
import { officialRpgContent } from '@perspectra/plugins/rpg'
import { officialTrpgContent } from '@perspectra/plugins/trpg'
import type {
  ContentGenerator,
  DecisionInstance,
  CharacterLoopInstance,
  KnowledgeInstance,
  StatusInstance,
  ActivitiesInstance,
  AutonomyInstance,
  PacingInstance,
  DiceInstance,
  CommunicationInstance,
  LlmInstance,
  LlmTransportInstance,
  MemoryInstance,
  RulesInstance,
  SchedulerInstance,
  WakeupInstance,
  SeamProvider,
} from '@perspectra/sdk'

export { officialMemoryNoneProvider } from '@perspectra/providers/memory-none'
export { officialLlmProvider, llmTimeoutMs, type ModelOptions } from '@perspectra/providers/llm'
export { CORE_MEMORY_ID, corePythonExecutable, corePythonRoot } from '@perspectra/memory-core/paths'

/** The default gameplay install, explicitly supplied by desktop entry composition. */
export const defaultInteractionPackages = createInstalledInteractionPackages

/** The implementation in force for each replaceable seam. */
export interface HostSeams {
  /** Installed, permitted native gameplay metadata for explicit pack selection. */
  readonly packPlugins?: readonly import('@perspectra/world-pack').PackPluginDescriptor[]
  readonly knowledge?: SeamProvider<KnowledgeInstance>
  readonly status?: SeamProvider<StatusInstance>
  readonly activities?: SeamProvider<ActivitiesInstance>
  readonly communication?: SeamProvider<CommunicationInstance>
  readonly autonomy?: SeamProvider<AutonomyInstance>
  readonly pacing?: SeamProvider<PacingInstance>
  /** Rolls an activity's dice from the round's recorded draws. */
  readonly dice?: SeamProvider<DiceInstance>
  readonly scheduler: SeamProvider<SchedulerInstance>
  /** Additive pure wakeup sources registered through `ctx.scheduler.registerWakeup`. */
  readonly wakeups?: readonly SeamProvider<WakeupInstance>[]
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
  /** Generators that turn a pack's config file into status modules, activities and a rules layer, such as the
   * official RPG for rpg.json. Only explicitly selected gameplay is generated; missing selected implementations fail closed. */
  readonly content?: readonly ContentGenerator[]
}

/** Installed content generators; the pack selects their IDs in its plugins manifest. */
export { officialRpgContent, officialTrpgContent }

/** Explicit entry composition. An omitted optional mechanism stays absent in this selection. */
export interface WorldComposition {
  readonly interactionPackages: readonly InteractionPackageImplementation[]
  readonly mechanisms: HostSeams
  readonly modelChannel?: typeof composeModelChannel
}

/** The standard RP install chosen by apps/host/src/Lens entry points, never by WorldHostCore. */
export function assembleRoleplay(plugins: Partial<HostSeams> = {}): WorldComposition {
  return {
    interactionPackages: defaultInteractionPackages(),
    mechanisms: composeWorldSeams(plugins),
    modelChannel: composeModelChannel,
  }
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
  'dice',
  'activities',
  'communication',
  'autonomy',
  'pacing',
  'decisions',
  'scheduler',
  'characterLoop',
] as const

/** The official gameplay generators: rpg.json and trpg.json. */
const officialContent: readonly ContentGenerator[] = [officialRpgContent, officialTrpgContent]

/** Direct hosts and the plugin loader share the same default choices and decision ordering. */
export function composeWorldSeams(plugins: Partial<HostSeams> = {}) {
  return {
    ...plugins,
    knowledge: plugins.knowledge ?? officialKnowledgeProvider,
    status: plugins.status ?? officialStatusProvider,
    activities: plugins.activities ?? officialActivitiesProvider,
    communication: plugins.communication ?? officialCommunicationProvider,
    autonomy: plugins.autonomy ?? officialAutonomyProvider,
    pacing: plugins.pacing ?? officialPacingProvider,
    dice: plugins.dice ?? officialDiceProvider,
    scheduler: plugins.scheduler ?? officialSchedulerProvider,
    wakeups: plugins.wakeups ?? [],
    characterLoop: plugins.characterLoop ?? officialCharacterLoopProvider,
    memory: plugins.memory ?? officialMemoryNoneProvider,
    decisions: composeDecisions(plugins.decisions ?? [], plugins.decisionOrder),
    rules: plugins.rules ?? [],
    content: plugins.content ?? officialContent,
  }
}

/** Called after player plugins settle. Every default uses the same public registration API. */
export function installOfficialBundle(ctx: Context, memory?: () => SeamProvider<MemoryInstance>): void {
  if (!ctx.communication.current) ctx.effect(() => ctx.communication.register(officialCommunicationProvider))
  if (!ctx.autonomy.current) ctx.effect(() => ctx.autonomy.register(officialAutonomyProvider))
  if (!ctx.pacing.current) ctx.effect(() => ctx.pacing.register(officialPacingProvider))
  if (!ctx.dice.current) ctx.effect(() => ctx.dice.register(officialDiceProvider))
  if (!ctx.activities.current) ctx.effect(() => ctx.activities.register(officialActivitiesProvider))
  if (!ctx.status.current) ctx.effect(() => ctx.status.register(officialStatusProvider))
  if (!ctx.knowledge.current) ctx.effect(() => ctx.knowledge.register(officialKnowledgeProvider))
  if (!ctx.scheduler.current) ctx.effect(() => ctx.scheduler.register(officialSchedulerProvider))
  if (!ctx.characterLoop.current) ctx.effect(() => ctx.characterLoop.register(officialCharacterLoopProvider))
  if (!ctx.memory.current && memory) ctx.effect(() => ctx.memory.register(memory()))
  // A player generator with the same id or config file replaces the official one, like any other seam a plugin took.
  for (const official of officialContent)
    if (
      !ctx.content.generators.some(
        generator => generator.id === official.id || generator.configFile === official.configFile,
      )
    )
      ctx.effect(() => ctx.content.register(official))
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

export { GameplayScript } from '@perspectra/providers/activities'

/** Explicit trusted builtin display install. World packs cannot supply renderers. */
export const officialStageRenderers: readonly ActivityStageRenderer[] = [officialRpgStageRenderer]
