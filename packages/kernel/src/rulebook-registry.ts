import { FrozenInteractionRulebook } from './frozen-interactions.ts'
import {
  assertProtocolString,
  failWorld,
  type CharacterId,
  type InteractionPackageImplementation,
  type InteractionPerformanceAcceptance,
  type RulebookResolutionAuthorityV1,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type InteractionRoundId,
} from '@harness-world/contracts'
import {
  type PlayerActionInput,
  type RulebookEvent,
  type RulebookResolution,
} from './rulebook.ts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface RulebookResolutionContext {
  /** Host-owned publication limit, never supplied by action parameters. */
  readonly publicationCharacters?: number
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly characterId: CharacterId | string
  readonly actionId?: string
  readonly resolutionAuthority?: RulebookResolutionAuthorityV1
  /** The Host's own identity of the locked Manifest. A frozen resolution binds it into its trace. */
  readonly manifestHash?: WorldHash
  /** The world sequence the candidate prefix sits at. A frozen resolution binds it into its trace. */
  readonly asOfWorldSeq?: number
  /**
   * The Round the action belongs to. A step that states cues needs it, because a manifestation is a
   * Round-scoped fact; a resolution that produces none never reads it.
   */
  readonly roundId?: InteractionRoundId
  readonly action: PlayerActionInput
}

export interface ActionAffordance {
  readonly actionType: string
  readonly actionVersion: number
  readonly interactions?: readonly WorldJsonObject[]
  /**
   * What the definitions behind those options accept as a step, one entry per definition. It rides here
   * rather than on each option for the reason the frozen affordance states: it is the definition's own
   * answer, and an option is what a caller turns into request parameters. A rulebook that never saw a
   * locked policy leaves it absent, which is the same answer as "nothing here accepts a step".
   */
  readonly performances?: readonly InteractionPerformanceAcceptance[]
  /** Where a `move` may go, from the world's own locations. Absent means the rulebook offers no list. */
  readonly destinations?: readonly { readonly locationId: string; readonly name: string }[]
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
  readonly #frozen: FrozenInteractionRulebook

  constructor(options: CoreRulebookOptions) {
    this.#frozen = options.frozenInteractions ?? new FrozenInteractionRulebook(options.interactionPackages ?? [])
  }

  resolve(context: RulebookResolutionContext): RulebookResolution {
    return this.#frozen.resolve({
      manifest: context.manifest, events: context.events, characterId: context.characterId,
      actionId: context.actionId, manifestHash: context.manifestHash, roundId: context.roundId,
      publicationCharacters:context.publicationCharacters, asOfWorldSeq: context.asOfWorldSeq, resolutionAuthority: context.resolutionAuthority,
    }, context.action)
  }

  affordances(context: Omit<RulebookResolutionContext, 'action' | 'actionId'>): readonly ActionAffordance[] {
    return this.#frozen.affordances({
      manifest: context.manifest, events: context.events, characterId: context.characterId,
      actionId: undefined, manifestHash: context.manifestHash, roundId: context.roundId,
      publicationCharacters:context.publicationCharacters, asOfWorldSeq: context.asOfWorldSeq, resolutionAuthority: context.resolutionAuthority,
    })
  }
}

export interface CoreRulebookOptions {
  /**
   * The trusted interaction packages the Host installs. A world selects among them and can never add
   * one, so an empty list is a valid Host: every v10 world then fails closed at activation.
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
