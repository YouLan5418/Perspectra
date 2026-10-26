import type { PlaySettings, ReadingPreferences, AudioPreferences } from '../../../desktop/play-settings.ts'
import type { HostPluginSettings } from '../../../desktop/host-plugin-settings.ts'
import type { PluginManifest } from '@harness-world/plugin-sdk'
export type { PluginManifest }
/** What the launcher knows about a plugin file: its manifest, that it has none, or why it is unreadable. */
export type PluginManifestInfo = { manifest: PluginManifest } | { missing: true } | { error: string }
import type { PackRolePresets, RolePreset, RolePresetMapping } from '@harness-world/provider-chat/preset'
export type { PackRolePresets, RolePreset, RolePresetMapping }
export interface PresetChoice extends RolePresetMapping {
  mode: 'auto' | 'global' | 'custom'
  override: RolePreset
}
export type {
  ModelConnection,
  ModelTarget,
  DecisionTarget,
  CharacterModels,
  InstanceModels,
} from '../../../desktop/model-connections.ts'
import type { ModelConnection, InstanceModels } from '../../../desktop/model-connections.ts'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export interface CoreSnapshot {
  packs: { id: string; version: string; title: string; path: string; hash: string }[]
  instances: {
    storyError?: string
    currentStorylineId?: string
    storylines?: import('./types.ts').Storyline[]
    nodes?: import('./types.ts').StoryNode[]
    id: string
    packageId: string
    packageVersion: string
    packHash: string
    name: string
    lastPlayedAt: string | null
    models?: InstanceModels
    needsModel: boolean
    brokenConnection: boolean
  }[]
  connections: ModelConnection[]
  lastModels?: InstanceModels
  packDetails?: Record<string, { description: string; hasCover: boolean; error?: string }>
  frontends: Record<
    string,
    { kind: 'default' | 'custom'; mode: 'sandbox' | 'trusted'; digest: string; capabilities: string[] }
  >
  presets: {
    library: import('@harness-world/provider-chat/preset-library').LibraryPreset[]
    characters: Record<string, { id: string; name: string }[]>
    global: RolePreset
    instances: Record<string, PresetChoice>
    recommended: Record<string, RolePreset>
    /** Packages that ship role-presets.json, keyed by package ID. */
    bundled?: Record<string, PackRolePresets>
  }
  preferences?: {
    largeText: boolean
    theme?: 'system' | 'light' | 'dark'
    reading?: ReadingPreferences
    audio?: AudioPreferences
    hostPlugins?: HostPluginSettings[]
  }
  playSettings?: Record<string, PlaySettings>
  dataDirectory: string
  /** Plugins that failed to load in the most recent game launch and were skipped. */
  skippedPlugins?: { id: string; reason: 'manifest' | 'config' | 'import' | 'version' | 'apply'; detail?: string }[]
  /** Per saved plugin ID. */
  pluginManifests?: Record<string, PluginManifestInfo>
  core: {
    state: 'idle' | 'running' | 'error'
    mode: 'real'
    instanceId?: string
    message?: string
    frontendMode?: 'sandbox' | 'trusted'
  }
}
