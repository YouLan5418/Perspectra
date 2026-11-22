import type { InteractionPackageImplementation, WorldJsonObject } from '@perspectra/sdk/contracts'
import { assertPhysicalEffects } from '@perspectra/core'
import { createCoreRulebookRegistry, RulebookRegistry, type RulebookResolver } from '@perspectra/core/kernel'
import type { ActionAffordance, RulesInstance, RuleResolution } from '@perspectra/sdk'
import type { ReportPluginFailure } from './character-decision.ts'
import {
  callPluginForValue,
  hostCapability,
  invalidPluginResult,
  isPluginFault,
  type PluginCallContext,
} from './plugin-runtime.ts'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function isRuleResolution(value: unknown): value is RuleResolution {
  return isRecord(value) && (value.status === 'accepted' || value.status === 'rejected') && Array.isArray(value.events)
}

function isAffordanceList(value: unknown): value is readonly ActionAffordance[] {
  return Array.isArray(value)
}

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

/** A plugin fault stops adjudication. Business refusals are explicit valid return values. */
export function guardedRules(
  instance: RulesInstance,
  id: string,
  context: PluginCallContext,
  report: ReportPluginFailure,
): RulesInstance {
  const { resolve, affordances } = instance
  if (resolve !== undefined && typeof resolve !== 'function') throw invalidPluginResult(context, id, 'open')
  if (affordances !== undefined && typeof affordances !== 'function') throw invalidPluginResult(context, id, 'open')
  const guarded = <C extends { readonly characterId: string }, R>(
    operation: string,
    input: C,
    next: (context: C) => R,
    work: (next: (context: C) => R) => R,
  ): R => {
    try {
      return callPluginForValue(context, id, operation, () =>
        work(hostCapability(context, current => next(structuredClone(current)))),
      )
    } catch (error) {
      if (isPluginFault(error)) report(id, String(input.characterId), error)
      throw error
    }
  }
  return {
    ...(resolve
      ? {
          resolve: (input, next) => {
            const forwardedMoves: WorldJsonObject[] = []
            return guarded(
              'resolve',
              input,
              current => {
                const result = next(current)
                // A real downstream failure remains a Host callback failure.
                if (result.status === 'accepted') {
                  assertPhysicalEffects({ manifest: current.manifest, events: current.events, drafts: result.events })
                  for (const event of result.events)
                    if (event.eventType === 'character.moved')
                      forwardedMoves.push(structuredClone(event.data as WorldJsonObject))
                }
                return result
              },
              onward => {
                const value = resolve.call(instance, structuredClone(input), onward)
                if (!isRuleResolution(value)) throw invalidPluginResult(context, id, 'resolve')
                // Validation of data returned by this plugin belongs to this plugin's fault boundary.
                if (value.status !== 'accepted') return value
                assertPhysicalEffects({ manifest: input.manifest, events: input.events, drafts: value.events })
                if (!value.events.some(event => event.eventType === 'character.moved')) return value
                return {
                  ...value,
                  events: value.events.map(event => {
                    if (event.eventType !== 'character.moved') return event
                    const data = event.data as WorldJsonObject
                    // Preserve the downstream producer on an unchanged route, including pass-through layers.
                    const forwarded = forwardedMoves.find(
                      move =>
                        move.characterId === data.characterId &&
                        move.fromLocationId === data.fromLocationId &&
                        move.toLocationId === data.toLocationId,
                    )
                    if (forwarded?.movementSource)
                      return { ...event, data: { ...data, movementSource: forwarded.movementSource } }
                    if (isRecord(data.movementSource) && data.movementSource.moduleId === id) return event
                    return {
                      ...event,
                      data: {
                        ...data,
                        movementSource: {
                          kind: 'rule',
                          moduleId: id,
                          actorId: input.characterId,
                          operation: input.action.actionType,
                          ...(input.actionId ? { actionId: input.actionId } : {}),
                        },
                      },
                    }
                  }),
                }
              },
            )
          },
        }
      : {}),
    ...(affordances
      ? {
          affordances: (input, next) =>
            guarded('affordances', input, next, onward => {
              const value = affordances.call(instance, structuredClone(input), onward)
              if (!isAffordanceList(value)) throw invalidPluginResult(context, id, 'affordances')
              return value
            }),
        }
      : {}),
  }
}
