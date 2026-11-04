import type { DecisionContextSources, DecisionInstance, SeamProvider } from '@harness-world/plugin-sdk'

const steps = [
  ['official-context-memory', 'memory'],
  ['official-context-recent-execution', 'recentExecution'],
  ['official-context-status', 'status'],
  ['official-context-knowledge', 'knowledge'],
  ['official-context-expressions', 'expressions'],
] as const satisfies readonly (readonly [string, keyof DecisionContextSources])[]

export const officialContextOrder: readonly string[] = steps.map(([id]) => id)

/** These steps consume the same authorized projections a third-party replacement can use. */
export const officialContextProviders: readonly SeamProvider<DecisionInstance>[] = steps.map(([id, source]) => ({
  id,
  version: '1.0.0',
  open: async world => {
    const sources = world.contextSources
    if (!sources) throw new TypeError('decision context sources unavailable')
    return {
      context: (request, signal) => sources[source](request, signal),
      ...(source === 'memory' && sources.memoryAfterSeq
        ? { shortTermAfterSeq: sources.memoryAfterSeq.bind(sources) }
        : {}),
    }
  },
}))

/** Explicit order omits disabled official steps. Unpositioned third-party steps retain registration order. */
export function composeDecisions(
  plugins: readonly SeamProvider<DecisionInstance>[],
  order: readonly string[] = officialContextOrder,
): readonly SeamProvider<DecisionInstance>[] {
  const providers = new Map(officialContextProviders.map(provider => [provider.id, provider]))
  for (const provider of plugins) providers.set(provider.id, provider)
  if (new Set(order).size !== order.length || order.some(id => !providers.has(id)))
    throw new TypeError('decision order must contain unique registered IDs')
  return [
    ...order.map(id => providers.get(id)!),
    ...plugins.filter(provider => !order.includes(provider.id) && !officialContextOrder.includes(provider.id)),
  ]
}
