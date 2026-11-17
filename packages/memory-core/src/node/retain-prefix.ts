/** Bounded prefix reuse from core_bridge.retain_prefix; no persistence or recovery layer. */
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { checkScope, checkSources, evidenceJson, object, rows, same, segments, validateUnits } from './archive.ts'
import { retain, type MemoryUtility } from './episodes.ts'

export async function retainPrefix(
  doc: WorldJsonObject,
  utility: MemoryUtility,
  maxProseChars = 9000,
): Promise<WorldJsonObject> {
  const sources = checkSources(doc),
    scope = checkScope(doc)
  const previous =
    doc.retainedPrefix === undefined || doc.retainedPrefix === null ? undefined : object(doc.retainedPrefix)
  if (previous) {
    validateUnits(previous)
    const old = checkScope(previous)
    if (
      !same(old.worldAddress!, scope.worldAddress!) ||
      old.characterId !== scope.characterId ||
      (old.asOfWorldSeq as number) > (scope.asOfWorldSeq as number)
    )
      throw new Error('Retained prefix scope mismatch')
    if (!same(sources.slice(0, rows(previous.sources).length), previous.sources!))
      throw new Error('Retained source prefix changed')
  }
  const reuse = previous ? rows(previous.facts) : [],
    pending = sources.slice(previous ? rows(previous.sources).length : 0)
  const batches: WorldJsonObject[][] = []
  let batch: WorldJsonObject[] = [],
    size = 0
  for (const source of pending) {
    const parts = segments(source)
      .filter(p => p.channel !== 'action')
      .map(p => ({ ...p, sourceId: source.sourceId!, epistemicKind: source.epistemicKind! }))
    // JSON field order does not affect Python's code-point length, including its separator spaces.
    const chars = [...evidenceJson(parts)].length
    if (batch.length && size + chars > maxProseChars) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(source)
    size += chars
  }
  if (batch.length) batches.push(batch)
  const concurrency = doc.retainConcurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 4)
    throw new Error('Invalid retain concurrency')
  const entries = batches.length ? batches : [[]],
    retained: WorldJsonObject[] = Array(entries.length)
  let cursor = 0,
    failed = false
  const completed = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency as number, entries.length) }, async () => {
      while (!failed && cursor < entries.length) {
        const index = cursor++
        try {
          retained[index] = await retain({ ...doc, sources: entries[index]! }, utility)
        } catch (error) {
          failed = true
          throw error
        }
      }
    }),
  )
  const failure = completed.find(r => r.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  const stats = Object.fromEntries(
    ['atomCount', 'rejectedSelections', 'wholeSegmentFallbacks'].map(k => [
      k,
      retained.reduce((n, r) => n + (object(r.stats)[k] as number), 0),
    ]),
  )
  const facts = [...structuredClone(reuse), ...retained.flatMap(r => rows(r.facts))]
  const result: WorldJsonObject = {
    scope,
    sources,
    facts,
    representations: [
      ...structuredClone(previous ? rows(previous.representations ?? []) : []),
      ...retained.flatMap(r => rows(r.representations)),
    ],
    stats: {
      ...stats,
      atomCount: facts.length,
      retainBatches: batches.length,
      reusedSources: previous ? rows(previous.sources).length : 0,
      reusedAtoms: reuse.length,
      selectionStatsScope: previous ? 'new sources' : 'all sources',
    },
  }
  validateUnits(result)
  return result
}
