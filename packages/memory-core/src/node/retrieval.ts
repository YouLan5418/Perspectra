/** Current quality retrieval only; legacy experimental graph/temporal recall is not selected. */
import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import { checkSources, compareText, list, object, rows, same, sourceRef, text } from './archive.ts'
import { caseFold, lexicalTerms, normalizeWhitespace, sorted } from './queries.ts'

export type Encode = (texts: readonly string[], query: boolean) => Promise<number[][]>
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    left = 0,
    right = 0
  for (let i = 0; i < a.length; i++) {
    dot += Math.fround(a[i]! * b[i]!)
    left += Math.fround(a[i]! * a[i]!)
    right += Math.fround(b[i]! * b[i]!)
  }
  const denominator = Math.fround(
    Math.fround(Math.sqrt(Math.fround(left))) * Math.fround(Math.sqrt(Math.fround(right))),
  )
  return Math.fround(Math.fround(dot) / Math.max(denominator, 1e-9))
}
export function checkMapping(index: WorldJsonObject): WorldJsonObject[] {
  const sources = new Map(checkSources(index).map(s => [text(s.sourceId), s])),
    units = rows(index.units),
    ids = new Set<string>()
  for (const source of sources.values())
    if (!Number.isSafeInteger(source.knownTick) || Number(source.knownTick) < 0)
      throw new Error('Source lacks knowledge tick')
  for (const unit of units) {
    const id = text(unit.id)
    if (ids.has(id)) throw new Error('Duplicate retrieval ID')
    ids.add(id)
    const refs = rows(unit.sourceRefs)
    if (!refs.length) throw new Error('Missing source mapping')
    for (const ref of refs) {
      const source = sources.get(text(ref.sourceId))
      if (!source || !same(ref, sourceRef(source))) throw new Error('Retrieval source identity changed')
    }
  }
  return units
}
function checkLinks(index: WorldJsonObject, units: WorldJsonObject[]): WorldJsonValue[][] {
  const ids = new Set(units.map(u => text(u.id)))
  return list(index.links).map(value => {
    if (!Array.isArray(value) || value.length !== 5) throw new Error('Invalid or foreign graph edge')
    const [from, to, kind] = value
    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !ids.has(from) ||
      !ids.has(to) ||
      (kind !== 'semantic' && kind !== 'temporal')
    )
      throw new Error('Invalid or foreign graph edge')
    return value
  })
}
export async function buildIndex(projected: WorldJsonObject, encode: Encode): Promise<WorldJsonObject> {
  const sources = new Map(checkSources(projected).map(s => [text(s.sourceId), s]))
  const units: (WorldJsonObject & { knownTickStart: number; knownTickEnd: number })[] = [
    'facts',
    'episodes',
    'observations',
  ]
    .flatMap(k => rows(projected[k] ?? []))
    .map(unit => {
      const ticks = rows(unit.sourceRefs).map(r => ({
        sourceId: r.sourceId!,
        knownTick: sources.get(text(r.sourceId))!.knownTick!,
      }))
      return {
        ...unit,
        entities: sorted(
          list(unit.entities ?? [])
            .map(text)
            .map(e => caseFold(normalizeWhitespace(e))),
        ),
        sourceTicks: ticks,
        knownTickStart: Math.min(...ticks.map(t => Number(t.knownTick))),
        knownTickEnd: Math.max(...ticks.map(t => Number(t.knownTick))),
      }
    })
  checkMapping({ ...projected, units })
  const passageTexts = units.map(u => text(u.retrievalText ?? u.text)),
    uniquePassages = [...new Set(passageTexts)],
    uniqueVectors = uniquePassages.length ? await encode(uniquePassages, false) : [],
    vectorByPassage = new Map(uniquePassages.map((passage, i) => [passage, uniqueVectors[i]!])),
    vectors = passageTexts.map(passage => vectorByPassage.get(passage)!),
    links: WorldJsonValue[][] = []
  for (const kind of ['fact', 'episode', 'observation']) {
    const positions = units.map((u, i) => ({ u, i })).filter(({ u }) => u.kind === kind)
    for (const { u, i } of positions) {
      const candidates = positions
        .filter(p => p.i !== i)
        .map(p => ({ id: p.u.id!, score: cosine(vectors[i]!, vectors[p.i]!) }))
        .filter(p => p.score >= 0.8)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
      for (const c of candidates) links.push([u.id!, c.id, 'semantic', Math.min(1, Math.max(0, c.score)), null])
    }
    const temporal = positions.toSorted((a, b) => a.u.knownTickEnd - b.u.knownTickEnd),
      pending: WorldJsonValue[][] = []
    for (let i = 0; i < temporal.length; i++)
      for (const next of temporal.slice(i + 1, i + 21)) {
        const first = temporal[i]!,
          gap = next.u.knownTickEnd - first.u.knownTickEnd
        if (gap > 8) break
        const weight = Math.max(0.3, 1 - gap / 8)
        pending.push(
          [first.u.id!, next.u.id!, 'temporal', weight, null],
          [next.u.id!, first.u.id!, 'temporal', weight, null],
        )
      }
    const grouped = new Map<string, WorldJsonValue[][]>()
    for (const edge of pending) {
      const key = text(edge[0])
      grouped.set(key, [...(grouped.get(key) ?? []), edge])
    }
    for (const edges of grouped.values()) links.push(...edges.sort((a, b) => Number(b[3]) - Number(a[3])).slice(0, 10))
  }
  return {
    scope: projected.scope!,
    sources: projected.sources!,
    units,
    ...(projected.retrievalAliases ? { retrievalAliases: projected.retrievalAliases } : {}),
    vectors,
    links,
    stats: {
      embeddingModel: 'Xenova/multilingual-e5-small',
      revision: '761b726',
      dimensions: 384,
      semanticEdges: links.filter(e => e[2] === 'semantic').length,
      temporalEdges: links.filter(e => e[2] === 'temporal').length,
      causalEdges: 0,
      ...(projected.retrievalAliases ? { retrievalTextRule: object(projected.retrievalAliases).rule! } : {}),
    },
  }
}
export async function recallQuality(
  index: WorldJsonObject,
  scope: WorldJsonObject,
  query: WorldJsonObject,
  encode: Encode,
): Promise<WorldJsonObject> {
  if (!same(index.scope!, scope)) throw new Error('Index scope differs')
  const units = checkMapping(index),
    links = checkLinks(index, units),
    empty = { semantic: [], bm25: [], graph: [], temporal: [] }
  if (query.mode === 'skip' || !units.length)
    return {
      scope,
      query: query.semanticQuery!,
      queryProjection: query,
      results: [],
      arms: { semantic: 0, bm25: 0, graph: 0, temporal: 0 },
      armResults: empty,
      memoryArmResults: empty,
      graphSeeds: [],
      expansionPaths: [],
      indexStats: index.stats!,
      skipReason: query.skipReason ?? null,
    }
  const vectors = list(index.vectors).map(v => list(v).map(Number))
  if (vectors.length !== units.length || vectors.some(v => v.length !== 384 || !v.every(Number.isFinite)))
    throw new Error('Invalid embedding matrix')
  const required = query.mode === 'entity' ? list(query.requiredEntityIds ?? []).map(text) : []
  const qv = required.length ? [] : (await encode([text(query.semanticQuery)], true))[0]!
  if (!required.length && (qv.length !== 384 || !qv.every(Number.isFinite) || Math.hypot(...qv) === 0))
    throw new Error('Invalid query embedding')
  const scores = units.map((_, i) => (required.length ? 0 : cosine(vectors[i]!, qv))),
    ordered = [...scores].sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2),
    background = ordered.length % 2 ? ordered[middle]! : Math.fround((ordered[middle - 1]! + ordered[middle]!) / 2)
  const bags = units.map(u => {
    const bag = new Map<string, number>()
    for (const term of lexicalTerms(text(u.retrievalText ?? u.text))) bag.set(term, (bag.get(term) ?? 0) + 1)
    for (const term of list(query.keywordTerms).map(text))
      if (/^[\u3400-\u9fff]$/.test(term)) bag.set(term, text(u.retrievalText ?? u.text).split(term).length - 1)
    return bag
  })
  const df = new Map<string, number>()
  for (const bag of bags) for (const term of bag.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  const n = bags.length,
    average = sum(bags.map(b => sum([...b.values()]))) / Math.max(n, 1),
    terms = required.length ? [] : list(query.keywordTerms).map(text),
    idf = new Map(terms.map(t => [t, Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))])),
    total = sum([...idf.values()])
  const signals = units.map((u, i) => {
    const bag = bags[i]!,
      matched = sorted(terms.filter(t => bag.get(t))),
      bm = sum(
        matched.map(
          t =>
            (idf.get(t)! * bag.get(t)! * 2.5) /
            (bag.get(t)! + 1.5 * (0.25 + (0.75 * sum([...bag.values()])) / Math.max(average, 1))),
        ),
      ),
      coverage = total ? sum(matched.map(t => idf.get(t)!)) / total : 0,
      lift = Math.max(0, (scores[i]! - background) / Math.max(1 - background, 1e-9)),
      objectMatch = list(u.entities ?? []).some(e => required.includes(text(e)))
    return {
      semanticSimilarity: required.length ? null : scores[i]!,
      semanticLift: required.length ? null : lift,
      semanticScored: !required.length,
      bm25Score: bm,
      keywordCoverage: coverage,
      matchedTerms: matched,
      relevance: required.length ? Number(objectMatch) : Math.max(coverage, lift),
      accepted:
        (required.length ? objectMatch : (scores[i]! >= 0.3 && lift >= 0.3) || coverage >= 0.15) &&
        !(query.mode === 'entity' && same(u.channels ?? [], ['action'])),
    }
  })
  const good = units.map((_, i) => i).filter(i => signals[i]!.accepted)
  const rank = (ids: number[], score: (i: number) => number) =>
    ids.sort((a, b) => score(b) - score(a) || compareText(text(units[a]!.id), text(units[b]!.id)))
  const cap = (ids: number[], limit = 32) => {
    const seen = new Set<string>()
    return ids
      .filter(i => {
        const id = text(units[i]!.memoryId)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .slice(0, limit)
  }
  const semantic = cap(
      rank(
        good.filter(i => scores[i]! >= 0.3),
        i => scores[i]!,
      ),
    ),
    bm25 = cap(
      rank(
        good.filter(i => signals[i]!.bm25Score > 0),
        i => signals[i]!.bm25Score,
      ),
    ),
    seeds = cap(
      rank(
        good.filter(i => scores[i]! >= 0.3),
        i => scores[i]!,
      ),
      20,
    )
  const wanted = rows(query.entitySeeds).filter(e => !required.length || required.includes(text(e.id))),
    memories = new Set(units.map(u => text(u.memoryId))),
    weights = new Map(
      wanted.map(e => {
        const count = new Set(units.filter(u => list(u.entities ?? []).includes(e.id!)).map(u => text(u.memoryId))).size
        return [text(e.id), Math.log(1 + (memories.size - count + 0.5) / (count + 0.5))]
      }),
    ),
    denominator = sum([...weights.values()]),
    graphScores = new Map<number, number>(),
    paths: WorldJsonObject[] = []
  const seedIds = new Set(seeds.map(i => text(units[i]!.id))),
    goodIds = new Set(good.map(i => text(units[i]!.id)))
  for (const edge of links) {
    if (edge[2] !== 'semantic') continue
    for (const [parent, target] of [
      [text(edge[0]), text(edge[1])],
      [text(edge[1]), text(edge[0])],
    ] as [string, string][])
      if (seedIds.has(parent) && goodIds.has(target))
        paths.push({
          from: parent,
          to: target,
          kind: 'semantic',
          weight: edge[3]!,
          arm: 'semantic',
          use: 'diagnostic neighbor; no extra vote or admission',
        })
  }
  for (const i of good) {
    const shared = sorted(
      list(units[i]!.entities ?? [])
        .map(text)
        .filter(e => weights.has(e)),
    )
    if (!shared.length) continue
    const score = denominator ? sum(shared.map(e => weights.get(e)!)) / denominator : 0
    graphScores.set(i, score)
    if (required.length) signals[i]!.relevance = score
    paths.push({
      from: 'current authorized query',
      to: units[i]!.id!,
      kind: 'entity',
      entities: shared,
      seedRoles: Object.fromEntries(shared.map(e => [e, wanted.find(w => w.id === e)!.roles!])),
      idf: Object.fromEntries(shared.map(e => [e, weights.get(e)!])),
      roles: units[i]!.entityRoles ?? [],
      arm: 'graph',
    })
  }
  const arms: Record<string, number[]> = {
      semantic: query.mode === 'entity' ? [] : semantic,
      bm25: query.mode === 'entity' ? [] : bm25,
      graph: cap(rank([...graphScores.keys()], i => graphScores.get(i)!)),
      temporal: [],
    },
    fused = new Map<string, { id: string; score: number; sourceRanks: Record<string, number> }>()
  for (const [name, ids] of Object.entries(arms))
    ids.forEach((i, r) => {
      const id = text(units[i]!.memoryId),
        entry = fused.get(id) ?? { id, score: 0, sourceRanks: {} }
      entry.score += 1 / (61 + r)
      entry.sourceRanks[name + '_rank'] = r + 1
      fused.set(id, entry)
    })
  const atomSignals = new Map<string, (typeof signals)[number]>()
  units.forEach((u, i) => {
    if (u.projectionLevel === 'event_atom')
      for (const id of list(u.atomIds).map(text))
        if (!atomSignals.has(id) || signals[i]!.relevance > atomSignals.get(id)!.relevance)
          atomSignals.set(id, signals[i]!)
  })
  const candidates = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .flatMap((entry, r) => {
      const views = good
        .filter(i => units[i]!.memoryId === entry.id)
        .sort(
          (a, b) =>
            signals[b]!.relevance - signals[a]!.relevance ||
            scores[b]! - scores[a]! ||
            compareText(text(units[a]!.id), text(units[b]!.id)),
        )
      const matches = views.map(i => ({
        representationId: units[i]!.id!,
        atomIds: units[i]!.atomIds!,
        sourceRefs: units[i]!.sourceRefs!,
        ...signals[i]!,
        atomScores: list(units[i]!.atomIds)
          .map(text)
          .filter(id => atomSignals.has(id))
          .map(id => ({ atomId: id, ...atomSignals.get(id)! })),
      }))
      if (units[views[0]!]!.projectionLevel === 'episode' && !matches.some(m => m.atomScores.some(a => a.accepted)))
        return []
      return [
        {
          ...entry,
          fusionRank: r + 1,
          sourceRanks: entry.sourceRanks,
          relevance: Math.max(...matches.map(m => m.relevance)),
          matches,
        },
      ]
    })
    .sort((a, b) => b.relevance - a.relevance || b.score - a.score || compareText(a.id, b.id))
    .slice(0, 32)
    .map((c, i) => ({ ...c, rank: i + 1 }))
  const raw = units.map((u, i) => ({
    id: u.id!,
    memoryId: u.memoryId!,
    ...signals[i]!,
    graphScore: graphScores.get(i) ?? null,
  }))
  const selected = new Set(
    Object.values(arms)
      .flat()
      .map(i => text(units[i]!.id)),
  )
  return {
    scope,
    query: query.semanticQuery!,
    queryProjection: query,
    tickWindow: null,
    results: candidates,
    arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.length])),
    armResults: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.map(i => raw[i]!)])),
    memoryArmResults: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, v.map(i => units[i]!.memoryId!)])),
    graphSeeds: seeds.map(i => units[i]!.id!),
    expansionPaths: paths.filter(p => selected.has(text(p.to))),
    indexStats: index.stats!,
    rawScores: raw,
    thresholds: {
      semanticMin: 0.3,
      semanticLiftMin: 0.3,
      keywordCoverageMin: 0.15,
      queryBackgroundMedian: background,
      status: 'provisional experimental gate; not calibrated confidence',
    },
    rejectedCount: signals.length - good.length,
  }
}
