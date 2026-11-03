import {
  characterPreset,
  createChatProvider,
  rolePresetMapping,
  type ChatCallObservation,
  type ChatProvider,
  type ChatProviderOptions,
  type PresetBaseSource,
  type ProviderProtocol,
  type RequestInspector,
  type RolePreset,
  type RolePresetMapping,
  type ThinkingLevel,
} from '@harness-world/provider-chat'
import type { CharacterId } from '@harness-world/contracts'

/** One resolved call target. The key is the only credential, and it stays inside this package's providers. */
export interface LlmModel {
  readonly protocol: ProviderProtocol
  readonly endpoint: string
  readonly model: string
  readonly thinkingLevel?: ThinkingLevel
  readonly apiKey?: string
}
interface LlmRoles {
  readonly default: { readonly decision: LlmModel }
  readonly characters: Readonly<Record<string, { readonly decision: LlmModel }>>
}
/** The play settings model calls read. */
export interface LlmSettings {
  readonly modelTimeoutSeconds: number
  readonly publicationCharacters: number
}
/** How the host learns about calls for its debug state and failure notices. */
export interface ChatObservers {
  readonly onCall: (observation: ChatCallObservation) => void
  readonly onRoleCall: (characterId: string, observation: ChatCallObservation) => void
}

/** How the Host reaches its models: resolved call targets, one default and optional per-character overrides. */
export interface ModelOptions {
  readonly models: LlmRoles
  readonly preset?: RolePreset
  readonly presetBaseSource?: PresetBaseSource
  readonly presetMapping?: RolePresetMapping
  readonly timeoutMs?: number
  readonly playSettings?: object
}

export interface RoleProviders {
  readonly model: string
  readonly intentModel: string
  readonly timeoutMs: number
  readonly protocol: ProviderProtocol
  readonly endpoint: URL
  /** The default target; the player-intent interpreter dispatches through it. */
  readonly shared: ChatProvider
  readonly byCharacter: ReadonlyMap<string, ChatProvider>
  readonly protocols: ReadonlyMap<string, ProviderProtocol>
  readonly presets: ReadonlyMap<string, RolePreset>
}

export function llmTimeoutMs(options: ModelOptions, settings: Pick<LlmSettings, 'modelTimeoutSeconds'>): number {
  return options.timeoutMs ?? (options.playSettings ? settings.modelTimeoutSeconds * 1000 : 60_000)
}

export function createRoleProviders(
  options: ModelOptions,
  settings: Pick<LlmSettings, 'modelTimeoutSeconds'>,
  characters: readonly { readonly actorId: CharacterId }[],
  inspector: RequestInspector,
  onCall: (observation: ChatCallObservation) => void,
  onRoleCall: (characterId: string, observation: ChatCallObservation) => void,
): RoleProviders {
  const timeoutMs = llmTimeoutMs(options, settings)
  const base = options.models.default.decision
  const target = (own: LlmModel) => ({
    protocol: own.protocol,
    endpoint: new URL(own.endpoint),
    model: own.model,
    ...(own.thinkingLevel === undefined ? {} : { thinkingLevel: own.thinkingLevel }),
    ...(own.apiKey === undefined ? {} : { apiKey: own.apiKey }),
  })
  const providerOptions: ChatProviderOptions = {
    ...target(base),
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    inspector,
    timeoutMs,
    onCall,
  }
  const shared = createChatProvider(providerOptions)
  const mapping = rolePresetMapping(options.presetMapping ?? {})
  if (
    [...Object.keys(mapping.characters ?? {}), ...Object.keys(mapping.memberships ?? {})].some(
      id => !characters.some(c => c.actorId === id),
    )
  )
    throw new TypeError('预设引用了此包之外或不可调用的角色。')
  const roleModels = options.models.characters
  if (Object.keys(roleModels).some(id => !characters.some(c => c.actorId === id)))
    throw new TypeError('模型配置引用了此包之外或不可调用的角色。')
  // An override replaces the whole target, so the default key and thinking level never reach another provider.
  const decisionTarget = (id: string) => target(roleModels[id]?.decision ?? base)
  const protocols = new Map(characters.map(c => [String(c.actorId), decisionTarget(String(c.actorId)).protocol]))
  const presets = new Map(
    characters.map(c => [String(c.actorId), characterPreset(options.preset ?? {}, mapping, c.actorId)]),
  )
  const byCharacter = new Map(
    characters.map(c => [
      String(c.actorId),
      createChatProvider({
        ...decisionTarget(String(c.actorId)),
        inspector,
        timeoutMs,
        preset: presets.get(c.actorId)!,
        presetOrigin: Object.hasOwn(mapping.characters ?? {}, c.actorId)
          ? { scope: 'character', characterId: String(c.actorId), name: '角色专属预设' }
          : mapping.memberships?.[c.actorId]
            ? {
                scope: 'group',
                characterId: String(c.actorId),
                groupId: mapping.memberships[c.actorId]!,
                name: mapping.groups![mapping.memberships[c.actorId]!]!.name,
              }
            : {
                scope: 'base',
                characterId: String(c.actorId),
                name: '默认预设',
                base: options.presetBaseSource ?? {
                  mode: 'explicit',
                  layers: [{ name: '运行配置', value: presets.get(c.actorId)! }],
                },
              },
        onCall: observation => {
          onCall(observation)
          onRoleCall(String(c.actorId), observation)
        },
      }),
    ]),
  )
  return {
    model: base.model,
    intentModel: base.model,
    timeoutMs,
    protocol: base.protocol,
    endpoint: new URL(base.endpoint),
    shared,
    byCharacter,
    protocols,
    presets,
  }
}
