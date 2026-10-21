import {
  characterPreset,
  createChatProvider,
  providerProtocol,
  rolePresetMapping,
  type ChatCallObservation,
  type ChatProvider,
  type PresetBaseSource,
  type ProviderProtocol,
  type RequestInspector,
  type RolePreset,
  type RolePresetMapping,
  type ThinkingLevel,
} from '@harness-world/provider-chat'
import type { CharacterId } from '@harness-world/contracts'
import type { PlaySettings } from '../play-settings.ts'
import type { RuntimeRoleModels } from '../model-connections.ts'
import { PROVIDER_DEFAULTS } from '../provider-defaults.ts'

/** How the Host reaches its models: one default target, optionally overridden per character. */
export interface ModelOptions {
  readonly provider: 'local' | 'deepseek' | 'ollama'
  readonly protocol?: ProviderProtocol
  readonly thinkingLevel?: ThinkingLevel
  readonly model?: string
  readonly preset?: RolePreset
  readonly presetBaseSource?: PresetBaseSource
  readonly presetMapping?: RolePresetMapping
  readonly intentModel?: string
  /** The Host's Secret, from the environment. It is never written to the data directory. */
  readonly apiKey?: string
  readonly utilityEndpoint?: string
  readonly timeoutMs?: number
  readonly playSettings?: PlaySettings
  /** Launcher-resolved per-character models; characters absent here use the default model above. */
  readonly roleModels?: RuntimeRoleModels
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

export function createRoleProviders(
  options: ModelOptions,
  settings: PlaySettings,
  characters: readonly { readonly actorId: CharacterId }[],
  inspector: RequestInspector,
  onCall: (observation: ChatCallObservation) => void,
  onRoleCall: (characterId: string, observation: ChatCallObservation) => void,
): RoleProviders {
  const model = options.model ?? PROVIDER_DEFAULTS[options.provider].model
  const timeoutMs =
    options.timeoutMs ??
    (options.playSettings ? settings.modelTimeoutSeconds * 1000 : options.provider === 'ollama' ? 120_000 : 60_000)
  const endpoint = new URL(
    options.provider === 'deepseek'
      ? PROVIDER_DEFAULTS.deepseek.endpoint
      : (options.utilityEndpoint ?? PROVIDER_DEFAULTS[options.provider].endpoint),
  )
  if (options.provider === 'deepseek' && options.apiKey === undefined) {
    throw new TypeError('DeepSeek credential unavailable')
  }
  const protocol = providerProtocol(options.protocol)
  if (protocol !== 'openai' && options.provider !== 'local') throw new TypeError('原生协议须使用 local 配置入口。')
  const providerOptions = {
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    protocol,
    endpoint,
    model,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    inspector,
    style: options.provider === 'ollama' ? ('format' as const) : ('tool' as const),
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
  const roleModels = options.roleModels?.characters ?? {}
  if (options.roleModels !== undefined && options.provider !== 'local')
    throw new TypeError('按角色模型须使用 local 配置入口。')
  if (Object.keys(roleModels).some(id => !characters.some(c => c.actorId === id)))
    throw new TypeError('模型配置引用了此包之外或不可调用的角色。')
  // An override replaces the whole target, so the default key and thinking level never reach another provider.
  const { thinkingLevel: _thinking, apiKey: _key, ...sharedOptions } = providerOptions
  const decisionTarget = (id: string) => {
    const own = roleModels[id]?.decision
    return own === undefined
      ? providerOptions
      : {
          ...sharedOptions,
          protocol: own.protocol,
          endpoint: new URL(own.endpoint),
          model: own.model,
          ...(own.thinkingLevel === undefined ? {} : { thinkingLevel: own.thinkingLevel }),
          ...(own.apiKey === undefined ? {} : { apiKey: own.apiKey }),
        }
  }
  const protocols = new Map(characters.map(c => [String(c.actorId), decisionTarget(String(c.actorId)).protocol]))
  const presets = new Map(
    characters.map(c => [String(c.actorId), characterPreset(options.preset ?? {}, mapping, c.actorId)]),
  )
  const byCharacter = new Map(
    characters.map(c => [
      String(c.actorId),
      createChatProvider({
        ...decisionTarget(String(c.actorId)),
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
    model,
    intentModel: options.intentModel ?? model,
    timeoutMs,
    protocol,
    endpoint,
    shared,
    byCharacter,
    protocols,
    presets,
  }
}
