import type { PlaySettings, ReadingPreferences, AudioPreferences, Palette } from '../../../desktop/play-settings.ts'
import type { HostPluginSettings } from '../../../desktop/host-plugin-settings.ts'
import type { RolePreset, RolePresetMapping } from '../../../packages/provider-chat/src/preset.ts'
export type { RolePreset, RolePresetMapping }
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
    library: import('../../../packages/provider-chat/src/preset-library.ts').LibraryPreset[]
    characters: Record<string, { id: string; name: string }[]>
    global: RolePreset
    instances: Record<string, PresetChoice>
    recommended: Record<string, RolePreset>
  }
  preferences?: {
    largeText: boolean
    theme?: 'system' | 'light' | 'dark'
    palette?: Palette
    reading?: ReadingPreferences
    audio?: AudioPreferences
    hostPlugins?: HostPluginSettings[]
  }
  playSettings?: Record<string, PlaySettings>
  dataDirectory: string
  core: {
    state: 'idle' | 'running' | 'error'
    mode: 'real'
    instanceId?: string
    message?: string
    frontendMode?: 'sandbox' | 'trusted'
  }
}
