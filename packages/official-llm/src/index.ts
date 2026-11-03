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
import type { WorldJsonObject } from '@harness-world/contracts'
import type { LlmInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { gatewayTurnCall } from './gateway-turn-call.ts'
import { createRoleProviders, type ChatObservers, type LlmSettings, type ModelOptions } from './role-providers.ts'

export { llmTimeoutMs, type ModelOptions } from './role-providers.ts'

type TurnRequest = Parameters<typeof characterTurnCall>[0]

/** Model calls with the player's presets and per-character connections. Assembled by the host, which holds both. */
export function officialLlmProvider(
  options: ModelOptions & ChatObservers & { readonly settings: LlmSettings; readonly inspector: RequestInspector },
): SeamProvider<LlmInstance> {
  return {
    id: 'official-llm',
    version: '1.0.0',
    open: async world => {
      const { cast } = world
      const models = createRoleProviders(
        options,
        options.settings,
        cast.characterIds.map(actorId => ({ actorId })),
        options.inspector,
        options.onCall,
        options.onRoleCall,
      )
      const providerFor = (characterId: string): ChatProvider => {
        const provider = models.byCharacter.get(characterId)
        if (!provider) throw new TypeError('当前角色没有可调用的预设配置。')
        return provider
      }
      const instance: LlmInstance = {
        prepare: async (characterId, request, signal) => {
          providerFor(characterId)
          const preset = models.presets.get(characterId)!
          const projected = await presetContext(request as TurnRequest, preset, cast.playerId, signal)
          const locationId = (projected.context.scene as WorldJsonObject | undefined)?.locationId
          return presetCall(
            models.protocols.get(characterId) !== 'google' ? gatewayTurnCall(projected) : characterTurnCall(projected),
            preset,
            projected,
            cast.playerName,
            {
              character: cast.characterNames.get(characterId) ?? characterId,
              scene: cast.locationNames.get(String(locationId)) ?? String(locationId ?? ''),
            },
          )
        },
        send: async (characterId, call, request, signal) =>
          presetOutput(
            await providerFor(characterId).decide(call as ChatCall, signal),
            models.presets.get(characterId)!,
            signal,
            request.context.expressionPolicy as WorldJsonObject | undefined,
            options.settings.publicationCharacters,
          ),
        promptText: characterId => models.presets.get(characterId)?.prompt ?? '',
        display: async view => (await presetDisplay(view as never, models.presets)) as typeof view,
        dispatch: (request, profile, signal) => models.shared.dispatch(request, profile as never, signal),
      }
      return instance
    },
  }
}
