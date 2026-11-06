import type { Context } from '@deepseek-ai/cordis'
import type { FrontendServicesApi } from './frontend.ts'
import type { CapabilitiesApi } from './capabilities.ts'
import type { PlayerFeedApi } from './player-feed.ts'
import type { KnowledgeSlotApi } from './knowledge.ts'
import type { StatusSlotApi } from './status.ts'
import type { ActivitiesSlotApi } from './activities.ts'
import type { CommunicationSlotApi } from './communication.ts'
import type { AutonomySlotApi } from './autonomy.ts'
import type { PacingSlotApi } from './pacing.ts'
import type { SchedulerSlotApi } from './scheduler.ts'
import type { CharacterLoopSlotApi } from './character-loop.ts'
import type { MemorySlotApi } from './memory.ts'
import type { LlmSlotApi } from './llm.ts'
import type { DecisionsApi } from './decisions.ts'
import type { RulesApi } from './rules.ts'

export interface HostServices {
  frontendServices: FrontendServicesApi
  capabilities: CapabilitiesApi
  playerFeed: PlayerFeedApi
  knowledge: KnowledgeSlotApi
  status: StatusSlotApi
  activities: ActivitiesSlotApi
  communication: CommunicationSlotApi
  autonomy: AutonomySlotApi
  pacing: PacingSlotApi
  scheduler: SchedulerSlotApi
  characterLoop: CharacterLoopSlotApi
  memory: MemorySlotApi
  llm: LlmSlotApi
  decisions: DecisionsApi
  rules: RulesApi
}

declare module '@deepseek-ai/cordis' {
  interface Context extends HostServices {}
}

/** A plugin module default-exports this (or a class / `{ apply }`) and exports `hostApi`. `config` holds
 * the values the player entered for the fields its manifest declares, defaults filled in. */
export type HostPlugin = (ctx: Context, config: PluginConfig) => void | Promise<void>
export type PluginConfig = Readonly<Record<string, string | number | boolean>>

/** One field the launcher renders in the plugin's settings. `secret` strings are kept in the system
 * credential store, never in launcher settings, and reach the plugin only at launch. */
export type PluginConfigField = {
  readonly title: string
  readonly description?: string
  readonly required?: boolean
} & (
  | {
      readonly type: 'string'
      readonly default?: string
      readonly enum?: readonly string[]
      readonly maxLength?: number
      readonly secret?: boolean
    }
  | {
      readonly type: 'number' | 'integer'
      readonly default?: number
      readonly minimum?: number
      readonly maximum?: number
    }
  | { readonly type: 'boolean'; readonly default?: boolean }
)

/** Contents of `<entry>.plugin.json` beside the plugin file. The launcher reads it without running the
 * plugin. `services` is the author's statement shown to players; the host does not enforce it. */
export interface PluginManifest {
  /** Stable across versions; what a world pack names when it needs this plugin. */
  readonly id?: string
  readonly name: string
  readonly version: string
  readonly author?: string
  readonly description?: string
  readonly llmMode?: 'transport'
  readonly services: readonly (keyof HostServices)[]
  readonly config?: Readonly<Record<string, PluginConfigField>>
}
