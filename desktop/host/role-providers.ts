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
} from '@harness-world/provider-chat'
import type { CharacterId } from '@harness-world/contracts'
import type { PlaySettings } from '../play-settings.ts'
import type { RuntimeModel, RuntimeRoleModels } from '../model-connections.ts'

/** How the Host reaches its models: resolved call targets, one default and optional per-character overrides. */
export interface ModelOptions {
  readonly models: RuntimeRoleModels
  readonly preset?: RolePreset
  readonly presetBaseSource?: PresetBaseSource
  readonly presetMapping?: RolePresetMapping
  readonly timeoutMs?: number
  readonly playSettings?: PlaySettings
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
  const timeoutMs = options.timeoutMs ?? (options.playSettings ? settings.modelTimeoutSeconds * 1000 : 60_000)
  const base = options.models.default.decision
  const target = (own: RuntimeModel) => ({
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
