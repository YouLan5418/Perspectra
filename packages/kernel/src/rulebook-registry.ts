import { availableInteractions, manifestUsesCharacterInteractions, manifestUsesInteractions } from './interactions.ts'
import {
  assertProtocolString,
  failWorld,
  validateResolutionAuthority,
  type CharacterId,
  type RulebookResolutionAuthorityV1,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  SpeakMoveRulebook,
  type PlayerActionInput,
  type RulebookEvent,
  type RulebookResolution,
} from './rulebook.ts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface RulebookResolutionContext {
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly characterId: CharacterId | string
  readonly actionId?: string
  readonly resolutionAuthority?: RulebookResolutionAuthorityV1
  readonly action: PlayerActionInput
}

export interface ActionAffordance {
  readonly actionType: string
  readonly actionVersion: number
  readonly interactions?: readonly WorldJsonObject[]
}

/** One exact, versioned deterministic rules implementation. */
export interface RulebookResolver {
  resolve(context: RulebookResolutionContext): RulebookResolution
  affordances(context: Omit<RulebookResolutionContext, 'action' | 'actionId'>): readonly ActionAffordance[]
}

function key(rulebookId: string, version: number): string {
  assertProtocolString(rulebookId, 'rulebookId')
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('rulebook version must be a positive safe integer')
  return `${rulebookId}\u001f${version}`
}

/** Exact-match executable Rulebook registry. It deliberately has no version fallback. */
export class RulebookRegistry {
  readonly #resolvers = new Map<string, RulebookResolver>()

  register(rulebookId: string, version: number, resolver: RulebookResolver): void {
    const entry = key(rulebookId, version)
    if (this.#resolvers.has(entry)) throw new Error(`duplicate Rulebook resolver ${rulebookId}@${version}`)
    this.#resolvers.set(entry, resolver)
  }

  resolve(
    rulebookId: string,
    version: number,
    correlationId: string,
    address?: WorldAddress,
  ): RulebookResolver {
    const resolver = this.#resolvers.get(key(rulebookId, version))
    if (resolver !== undefined) return resolver
    failWorld({
      errorCode: 'RULEBOOK_NOT_REGISTERED',
      category: 'runtime',
      message: `Rulebook resolver ${rulebookId}@${version} is not registered in this application`,
      retryable: false,
      correlationId,
      ...(address === undefined ? {} : { address }),
      details: { rulebookId, version },
    })
  }
}

class CoreRulebookResolver implements RulebookResolver {
  readonly #legacy = new SpeakMoveRulebook()

  resolve(context: RulebookResolutionContext): RulebookResolution {
    if (manifestUsesCharacterInteractions(context.manifest)
      && (context.actionId === undefined || context.resolutionAuthority === undefined)) {
      throw new TypeError('Manifest v9 Rulebook resolution requires Host authority and actionId')
    }
    const authority = context.resolutionAuthority === undefined
      ? undefined
      : validateResolutionAuthority(context.resolutionAuthority)
    return this.#legacy.resolve(context.manifest, context.events, context.characterId, context.action, {
      actionId: context.actionId!,
      resolutionAuthority: authority!,
    })
  }

  affordances(context: Omit<RulebookResolutionContext, 'action' | 'actionId'>): readonly ActionAffordance[] {
    if (manifestUsesCharacterInteractions(context.manifest) && context.resolutionAuthority === undefined) {
      throw new TypeError('Manifest v9 affordances require Host authority')
    }
    const authority = context.resolutionAuthority === undefined
      ? undefined
      : validateResolutionAuthority(context.resolutionAuthority)
    return [
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1 },
      ...(manifestUsesInteractions(context.manifest) ? [{
        actionType: 'interact', actionVersion: 1,
        interactions: authority === undefined
          ? availableInteractions(context.manifest, context.events, context.characterId)
          : availableInteractions(context.manifest, context.events, context.characterId, authority),
      }] : context.manifest.rulebook.version >= 2 ? [{ actionType: 'take', actionVersion: 1 }] : []),
    ]
  }
}

/** Generic application registry: only product-neutral speak/move/take rules. */
export function createCoreRulebookRegistry(): RulebookRegistry {
  const registry = new RulebookRegistry()
  registry.register('builtin:speak-move', 1, new CoreRulebookResolver())
  registry.register('builtin:speak-move', 2, new CoreRulebookResolver())
  return registry
}
