import { transportSend } from './transport.ts'
import {
  characterTurnCall,
  presetCall,
  presetContext,
  presetDisplay,
  presetOutput,
  type ChatCall,
  type ChatProvider,
  type RequestInspector,
} from '@harness-world/provider-chat'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { LlmInstance, LlmTransportInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { gatewayTurnCall } from './gateway-turn-call.ts'
import {
  createRoleProviders,
  resolveRolePresets,
  llmTimeoutMs,
  type ChatObservers,
  type LlmSettings,
  type ModelOptions,
} from './role-providers.ts'

export { llmTimeoutMs, type ModelOptions } from './role-providers.ts'

type TurnRequest = Parameters<typeof characterTurnCall>[0]

/** Model calls with the player's presets and per-character connections. Assembled by the host, which holds both. */
export function officialLlmProvider(
  options: ModelOptions &
    ChatObservers & {
      readonly settings: LlmSettings
      readonly inspector: RequestInspector
      readonly transport?: {
        readonly id: string
        readonly instance: LlmTransportInstance
        readonly failure: (characterId: string, error: unknown) => void
      }
    },
): SeamProvider<LlmInstance> {
  return {
    id: 'official-llm',
    version: '1.0.0',
    open: async world => {
      const { cast } = world
      const transport = options.transport
      const models = transport
        ? undefined
        : createRoleProviders(
            options,
            options.settings,
            cast.characterIds.map(actorId => ({ actorId })),
            options.inspector,
            options.onCall,
            options.onRoleCall,
          )
      const portrayal =
        models ??
        resolveRolePresets(
          options,
          cast.characterIds.map(actorId => ({ actorId })),
        )
      const sendFor = (characterId: string) =>
        transport
          ? transportSend({
              ...transport,
              inspector: options.inspector,
              timeoutMs: llmTimeoutMs(options, options.settings),
              onCall: observation => {
                options.onCall(observation)
                options.onRoleCall(characterId, observation)
              },
            })
          : undefined
      const providerFor = (characterId: string): ChatProvider => {
        const provider = models?.byCharacter.get(characterId)
        if (!provider) throw new TypeError('当前角色没有可调用的预设配置。')
        return provider
      }
      const instance: LlmInstance = {
        prepare: async (characterId, request, signal) => {
          if (!transport) providerFor(characterId)
          const preset = portrayal.presets.get(characterId)
          if (!preset) throw new TypeError('当前角色没有可调用的预设配置。')
          const projected = await presetContext(request as TurnRequest, preset, cast.playerId, signal)
          const locationId = (projected.context.scene as WorldJsonObject | undefined)?.locationId
          const prepared = presetCall(
            (transport ? transport.instance.schemaMode === 'gateway' : models!.protocols.get(characterId) !== 'google')
              ? gatewayTurnCall(projected)
              : characterTurnCall(projected),
            preset,
            projected,
            cast.playerName,
            {
              character: cast.characterNames.get(characterId) ?? characterId,
              scene: cast.locationNames.get(String(locationId)) ?? String(locationId ?? ''),
            },
          )
          if (transport && prepared.inspection)
            prepared.inspection.preset = {
              origin: (portrayal as ReturnType<typeof resolveRolePresets>).origins.get(characterId)!,
              value: preset,
            }
          return prepared
        },
        send: async (characterId, call, request, signal) => {
          const raw = transport
            ? await sendFor(characterId)!(characterId, call as ChatCall, portrayal.presets.get(characterId)!, signal)
            : await providerFor(characterId).decide(call as ChatCall, signal)
          return presetOutput(
            raw as WorldJsonValue,
            portrayal.presets.get(characterId)!,
            signal,
            request.context.expressionPolicy as WorldJsonObject | undefined,
            options.settings.publicationCharacters,
          )
        },
        promptText: characterId => portrayal.presets.get(characterId)?.prompt ?? '',
        display: async view => (await presetDisplay(view as never, portrayal.presets)) as typeof view,
        ...(transport
          ? { close: async () => transport.instance.close?.() }
          : {
              dispatch: (
                request: Parameters<NonNullable<LlmInstance['dispatch']>>[0],
                profile: WorldJsonObject,
                signal: AbortSignal,
              ) => models!.shared.dispatch(request, profile as never, signal),
            }),
      }
      return instance
    },
  }
}
