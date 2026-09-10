import { availableInteractions, manifestUsesInteractions } from './interactions.ts'
import { assertProtocolString, failWorld, type CharacterId, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
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
  affordances(context: Omit<RulebookResolutionContext, 'action'>): readonly ActionAffordance[]
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
    return this.#legacy.resolve(context.manifest, context.events, context.characterId, context.action)
  }

  affordances(context: Omit<RulebookResolutionContext, 'action'>): readonly ActionAffordance[] {
    return [
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1 },
      ...(manifestUsesInteractions(context.manifest) ? [{ actionType: 'interact', actionVersion: 1, interactions: availableInteractions(context.manifest, context.events, context.characterId) }] : context.manifest.rulebook.version >= 2 ? [{ actionType: 'take', actionVersion: 1 }] : []),
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
