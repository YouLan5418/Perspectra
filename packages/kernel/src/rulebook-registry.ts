import { availableInteractions, manifestUsesCharacterInteractions, manifestUsesInteractions } from './interactions.ts'
import { FrozenInteractionRulebook } from './frozen-interactions.ts'
import {
  assertProtocolString,
  failWorld,
  validateResolutionAuthority,
  type CharacterId,
  type InteractionPackageImplementation,
  type RulebookResolutionAuthorityV1,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  SpeakMoveRulebook,
  type PlayerActionInput,
  type RulebookEvent,
  type RulebookResolution,
} from './rulebook.ts'
import { manifestUsesFrozenInteractions, type CompiledWorldManifest } from './world-spec.ts'

export interface RulebookResolutionContext {
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly characterId: CharacterId | string
  readonly actionId?: string
  readonly resolutionAuthority?: RulebookResolutionAuthorityV1
  /** The Host's own identity of the locked Manifest. A frozen resolution binds it into its trace. */
  readonly manifestHash?: WorldHash
  /** The world sequence the candidate prefix sits at. A frozen resolution binds it into its trace. */
  readonly asOfWorldSeq?: number
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
  readonly #frozen: FrozenInteractionRulebook

  constructor(options: CoreRulebookOptions) {
    this.#frozen = options.frozenInteractions ?? new FrozenInteractionRulebook(options.interactionPackages ?? [])
  }

  resolve(context: RulebookResolutionContext): RulebookResolution {
    // The frozen path owns the whole action, so it is dispatched before any v9 requirement is checked:
    // the two versions share an authority-bearing context but nothing about how an action resolves.
    if (manifestUsesFrozenInteractions(context.manifest)) {
      return this.#frozen.resolve({
        manifest: context.manifest, events: context.events, characterId: context.characterId,
        actionId: context.actionId, manifestHash: context.manifestHash,
        asOfWorldSeq: context.asOfWorldSeq, resolutionAuthority: context.resolutionAuthority,
      }, context.action)
    }
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
    if (manifestUsesFrozenInteractions(context.manifest)) {
      return this.#frozen.affordances({
        manifest: context.manifest, events: context.events, characterId: context.characterId,
        actionId: undefined, manifestHash: context.manifestHash,
        asOfWorldSeq: context.asOfWorldSeq, resolutionAuthority: context.resolutionAuthority,
      })
    }
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

/** Generic application registry: only product-neutral speak/move/take rules. */
export function createCoreRulebookRegistry(options: CoreRulebookOptions = {}): RulebookRegistry {
  const registry = new RulebookRegistry()
  // One resolver backs both versions: the Manifest schemaVersion, not the registry key, decides which
  // path an action takes, and a shared instance installs each package exactly once.
  const resolver = new CoreRulebookResolver(options)
  registry.register('builtin:speak-move', 1, resolver)
  registry.register('builtin:speak-move', 2, resolver)
  return registry
}
