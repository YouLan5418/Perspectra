export const hostApi = '2.1'

// Replace only knowledge expansion. All other default steps remain in their default positions.
export default function (ctx, config) {
  const maximumEntries = Number(config.maximumEntries ?? 1)
  ctx.effect(() => ctx.decisions.register({
    id: 'official-context-knowledge', version: '1.1.0', identity: { maximumEntries },
    open: async world => ({
      context: async (request, signal) => {
        const projected = await world.contextSources.knowledge(request, signal)
        const knowledge = projected.context.knowledge
        return { ...projected, context: { ...projected.context,
          ...(knowledge ? { knowledge: { ...knowledge, entries: knowledge.entries.slice(0, maximumEntries) } } : {}),
        } }
      },
    }),
  }))
}
