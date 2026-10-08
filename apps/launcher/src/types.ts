/** Launcher metadata only. World facts and actor-private context remain in Core. */
export type ValidationStatus = 'ready' | 'degraded' | 'blocked'
export interface PackageValidation { status: ValidationStatus; issues: readonly string[]; simulated: boolean }
export interface ModelRecommendation { capability: 'fast' | 'balanced' | 'high'; contextTokens: number; toolCalling: boolean }
export interface GamePackage {
  readonly id: string; readonly version: string; readonly title: string; readonly subtitle: string
  readonly description: string; readonly genre: string; readonly artwork: 'inn' | 'town' | 'sea'
  readonly recommendation: ModelRecommendation; readonly validation: PackageValidation
}
export interface ModelProfile {
  id: string; label: string; providerId: string; model: string
  capability: ModelRecommendation['capability']; contextTokens: number; toolCalling: boolean
}
/** No secrets or private endpoint addresses in portable configuration. */
export interface CharacterModelMapping { groups: Record<string, string>; characters: Record<string, string> }
export interface ModelConfiguration extends CharacterModelMapping { defaultModelId: string | null; overridesEnabled: boolean }
export interface ProviderSettings { protocol?: 'openai' | 'anthropic' | 'google'; id: string; label: string; endpoint: string; apiKey: string }
export interface StorylineSource {
  kind: 'original' | 'local' | 'shared'; label: string
  storylineId: string | null; nodeId: string | null; turn: number
}
export interface StoryNode {
  readonly id: string; readonly parentNodeId: string | null; readonly turn: number
  readonly title: string; readonly summary: string; readonly createdAt: string
}
export interface Storyline {
  id: string; name: string; parentStorylineId: string | null; parentNodeId: string | null
  currentNodeId: string; source: StorylineSource
}
export interface GameInstance {
  storyError?: string
  id: string; packageId: string; packageVersion: string; name: string; currentStorylineId: string
  model: ModelConfiguration; storylines: Storyline[]; nodes: StoryNode[]; lastPlayedAt: string | null
  localSettings: { textSize: 'standard' | 'large' }
}
export type CoreStatus = import('./core-types.ts').CoreSnapshot['core']
  | { state: 'idle'; mode: 'mock' }
  | { state: 'running'; mode: 'mock'; instanceId: string; storylineId: string }
  | { state: 'error'; mode: 'mock'; message: string }
export type ExportScope = 'current-node' | 'storyline' | 'branch' | 'tree'
/** Design placeholder, not an agreed Core save-file format. No runtime state is serialized yet. */
export interface StorylineShare {
  prototype: true; packageId: string; packageVersion: string; scope: ExportScope
  storylineId: string; currentNodeId: string; storylines: Storyline[]; nodes: StoryNode[]
  modelReference: ModelRecommendation
}
