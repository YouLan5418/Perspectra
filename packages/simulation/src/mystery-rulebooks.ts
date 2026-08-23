import {
  RulebookRegistry,
  SpeakMoveRulebook,
  createCoreRulebookRegistry,
  type ActionAffordance,
  type RulebookResolutionContext,
  type RulebookResolver,
} from '@harness-world/kernel'

class MysteryCompatibilityResolver implements RulebookResolver {
  readonly #legacy = new SpeakMoveRulebook()

  resolve(context: RulebookResolutionContext) {
    return this.#legacy.resolve(context.manifest, context.events, context.characterId, context.action)
  }

  affordances(_context: Omit<RulebookResolutionContext, 'action'>): readonly ActionAffordance[] {
    return [
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1 },
      { actionType: 'take', actionVersion: 1 },
      { actionType: 'inspect', actionVersion: 1 },
      { actionType: 'ask', actionVersion: 1 },
      { actionType: 'present_evidence', actionVersion: 1 },
      { actionType: 'accuse', actionVersion: 1 },
    ]
  }
}

/** Explicit Demo composition hook for historical v3 and current v4 mystery worlds. */
export function registerMysteryRulebooks(registry: RulebookRegistry): RulebookRegistry {
  registry.register('builtin:speak-move', 3, new MysteryCompatibilityResolver())
  registry.register('builtin:speak-move', 4, new MysteryCompatibilityResolver())
  return registry
}

export function createMysteryRulebookRegistry(): RulebookRegistry {
  return registerMysteryRulebooks(createCoreRulebookRegistry())
}
