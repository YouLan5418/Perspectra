import { FrozenInteractionRulebook } from './frozen-interactions.ts'
import {
  assertProtocolString,
  failWorld,
  type InteractionPackageImplementation,
  type ActionAffordance,
  type RulebookResolution,
  type RulebookResolutionContext,
  type WorldAddress,
} from '@harness-world/contracts'

export type { ActionAffordance, RulebookResolutionContext } from '@harness-world/contracts'

/** One exact, versioned deterministic rules implementation. */
export interface RulebookResolver {
  resolve(context: RulebookResolutionContext): RulebookResolution
  affordances(context: Omit<RulebookResolutionContext, 'action' | 'actionId'>): readonly ActionAffordance[]
}

function key(rulebookId: string, version: number): string {
  assertProtocolString(rulebookId, 'rulebookId')
  if (!Number.isSafeInteger(version) || version < 1)
    throw new TypeError('rulebook version must be a positive safe integer')
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

  resolve(rulebookId: string, version: number, correlationId: string, address?: WorldAddress): RulebookResolver {
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
  readonly #frozen: FrozenInteractionRulebook

  constructor(options: CoreRulebookOptions) {
    this.#frozen = options.frozenInteractions ?? new FrozenInteractionRulebook(options.interactionPackages ?? [])
  }

  resolve(context: RulebookResolutionContext): RulebookResolution {
    return this.#frozen.resolve(
      {
        manifest: context.manifest,
        events: context.events,
        characterId: context.characterId,
        actionId: context.actionId,
        manifestHash: context.manifestHash,
        roundId: context.roundId,
        publicationCharacters: context.publicationCharacters,
        asOfWorldSeq: context.asOfWorldSeq,
        resolutionAuthority: context.resolutionAuthority,
      },
      context.action,
    )
  }

  affordances(context: Omit<RulebookResolutionContext, 'action' | 'actionId'>): readonly ActionAffordance[] {
    return this.#frozen.affordances({
      manifest: context.manifest,
      events: context.events,
      characterId: context.characterId,
      actionId: undefined,
      manifestHash: context.manifestHash,
      roundId: context.roundId,
      publicationCharacters: context.publicationCharacters,
      asOfWorldSeq: context.asOfWorldSeq,
      resolutionAuthority: context.resolutionAuthority,
    })
  }
}

export interface CoreRulebookOptions {
  /**
   * The trusted interaction packages the Host installs. A world selects among them and can never add
   * one. An empty list serves worlds with an empty selection; any uninstalled selection fails closed.
   */
  readonly interactionPackages?: readonly InteractionPackageImplementation[]
  /**
   * A frozen path the Host already built, so one instance both resolves actions and proves a
   * selection closes before Genesis is written. Omitted means one is built from `interactionPackages`.
   */
  readonly frozenInteractions?: FrozenInteractionRulebook
}

/** Register the current v10 Rulebook while preserving the generic registry extension point. */
export function createCoreRulebookRegistry(options: CoreRulebookOptions = {}): RulebookRegistry {
  const registry = new RulebookRegistry()
  registry.register('builtin:speak-move', 2, new CoreRulebookResolver(options))
  return registry
}
