import type { InteractionPackageImplementation } from '@harness-world/contracts'
import { createCoreRulebookRegistry, RulebookRegistry, type RulebookResolver } from '@harness-world/kernel'
import type { RulesInstance } from '@harness-world/plugin-sdk'
import type { ReportPluginFailure } from './character-decision.ts'

/** The one source of core rules in a world instance, for players, characters and activities alike. Plugin layers
 * are read on each call, so this can be handed out before they open. */
export function layeredCoreRules(
  layers: () => readonly RulesInstance[],
  interactionPackages: readonly InteractionPackageImplementation[],
): RulebookRegistry {
  const core = createCoreRulebookRegistry({ interactionPackages }).resolve('builtin:speak-move', 2, 'layered-core')
  const resolver: RulebookResolver = {
    resolve: context =>
      layers().reduceRight<RulebookResolver['resolve']>(
        (next, layer) => (layer.resolve ? current => layer.resolve!(current, next) : next),
        current => core.resolve(current),
      )(context),
    affordances: context =>
      layers().reduceRight<RulebookResolver['affordances']>(
        (next, layer) => (layer.affordances ? current => layer.affordances!(current, next) : next),
        current => core.affordances(current),
      )(context),
  }
  const registry = new RulebookRegistry()
  registry.register('builtin:speak-move', 2, resolver)
  return registry
}

/** A plugin's layer. When it fails, the action is refused and the options stand: a rule that cannot answer must not
 * let an action through, and it must not leave a round unfinished. A failure further in is not the plugin's. */
export function guardedRules(instance: RulesInstance, id: string, report: ReportPluginFailure): RulesInstance {
  const guarded = <C extends { readonly characterId: string }, R>(
    context: C,
    next: (context: C) => R,
    work: (next: (context: C) => R) => R,
    fallback: () => R,
  ): R => {
    let passedOn: unknown
    try {
      return work(current => {
        try {
          return next(current)
        } catch (error) {
          passedOn = error
          throw error
        }
      })
    } catch (error) {
      if (error === passedOn) throw error
      report(id, String(context.characterId), error)
      return fallback()
    }
  }
  const { resolve, affordances, close } = instance
  return {
    ...(resolve
      ? {
          resolve: (context, next) =>
            guarded(
              context,
              next,
              onward => resolve.call(instance, context, onward),
              () => ({ status: 'rejected', events: [], reason: `plugin:规则插件 ${id} 出错，这次行动没有执行。` }),
            ),
        }
      : {}),
    ...(affordances
      ? {
          affordances: (context, next) =>
            guarded(
              context,
              next,
              onward => affordances.call(instance, context, onward),
              () => next(context),
            ),
        }
      : {}),
    ...(close ? { close: close.bind(instance) } : {}),
  }
}
