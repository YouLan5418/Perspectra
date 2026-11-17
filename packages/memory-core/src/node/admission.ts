import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import { compareText, list, object, rows, same, text, unionRefs } from './archive.ts'
import { archive } from './projections.ts'
import { record, sorted } from './queries.ts'

export function assertRequest(doc: WorldJsonObject, request: WorldJsonObject): void {
  const scope = object(doc.scope),
    context = object(request.context),
    cognition = record(context.cognition)
  if (
    record(context.character).characterId !== scope.characterId ||
    !same('address' in cognition ? cognition.address! : scope.worldAddress!, scope.worldAddress!)
  )
    throw new Error('Memory request crosses character or world')
}
export function seedsFor(request: WorldJsonObject, query: WorldJsonObject, owner: string): WorldJsonObject {
  const context = object(request.context),
    entries = rows(query.entitySeeds),
    mentioned = entries
      .filter(e => list(e.roles).some(r => r === 'mentioned' || text(r).startsWith('object:')))
      .map(e => text(e.id))
  let objects = sorted([
    ...mentioned.filter(i => i.startsWith('entity:')),
    ...list(query.requiredEntityIds ?? []).map(text),
  ])
  const people = entries
      .filter(
        e =>
          e.id !== owner &&
          text(e.id).startsWith('character:') &&
          list(e.roles).some(r => r === 'actor' || r === 'mentioned'),
      )
      .map(e => text(e.id)),
    location = record(context.scene).locationId
  let places = mentioned.filter(i => i.startsWith('location:'))
  const explicit = objects.length > 0
  if (!explicit) {
    if (typeof location === 'string') places.push(location)
    objects = rows(Array.isArray(context.items) ? context.items : (record(context.items).current ?? []))
      .filter(v => typeof v.entityId === 'string' && v.locationId === location)
      .map(v => text(v.entityId))
  }
  const activities: string[] = text(query.originalText).match(/activity:[a-z0-9_-]+/g) ?? [],
    active = record(context.activity).id
  if (typeof active === 'string') activities.push(active)
  return {
    mode: explicit ? 'explicit-object' : 'current-authorized-scene',
    entityIds: sorted([...objects, ...places, ...people].filter(i => i !== owner)),
    activityIds: sorted(activities),
    observerIsNotASeed: true,
  }
}
export function admit(
  doc: WorldJsonObject,
  index: WorldJsonObject,
  retrieval: WorldJsonObject,
  request: WorldJsonObject,
  query: WorldJsonObject,
): { candidates: WorldJsonObject[]; trace: WorldJsonObject } {
  const { byId, sources } = archive(doc)
  assertRequest(doc, request)
  if (!same(index.scope!, doc.scope!) || !same(retrieval.scope!, doc.scope!))
    throw new Error('Candidate input crosses world or prefix')
  const views = rows(index.units)
  for (const view of views) {
    const unit = byId.get(text(view.memoryId))
    if (!unit) throw new Error('Foreign projection memory')
    const allowed =
        unit.memoryLevel === 'event_atom'
          ? [text(unit.id)]
          : list(unit.eventAtomIds ?? unit.sourceFactIds ?? []).map(text),
      ids = list(view.atomIds).map(text)
    if (!ids.length || ids.some(i => !allowed.includes(i) || !byId.has(i))) throw new Error('Foreign projection atoms')
    if (!same(view.sourceRefs!, unionRefs(ids.map(i => byId.get(i)!))))
      throw new Error('Projection evidence identity changed')
    if (rows(view.sourceRefs).some(r => !sources.has(text(r.sourceId))))
      throw new Error('Unauthorized projection Source')
  }
  const seeds = seedsFor(request, query, text(object(doc.scope).characterId)),
    raw = new Map(rows(retrieval.rawScores ?? []).map(r => [text(r.id), r])),
    before = new Map(rows(retrieval.results).map(c => [text(c.id), structuredClone(c)])),
    candidates = new Map(before),
    details: Record<string, WorldJsonValue>[] = []
  const overlap = (v: WorldJsonValue | undefined, s: WorldJsonValue | undefined) =>
    sorted(
      list(v ?? [])
        .map(text)
        .filter(i => list(s ?? []).includes(i)),
    )
  const values = (r: WorldJsonObject) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'memoryId', 'graphScore'].includes(k)))
  for (const unit of byId.values()) {
    const matched: WorldJsonObject[] = [],
      matches: WorldJsonObject[] = []
    for (const view of views.filter(v => v.memoryId === unit.id)) {
      const entities = overlap(view.entities, seeds.entityIds),
        activities = overlap(view.activityIds, seeds.activityIds)
      if ((!entities.length && !activities.length) || query.mode === 'skip') continue
      const signal = raw.get(text(view.id))
      if (!signal) throw new Error('ID admission requires score diagnostics')
      const atomScores: WorldJsonObject[] = []
      for (const id of list(view.atomIds).map(text)) {
        const atomViews = views.filter(v => v.memoryId === id),
          signals = atomViews
            .map(v => raw.get(text(v.id)))
            .filter((s): s is Record<string, WorldJsonValue> => s !== undefined)
            .sort((a, b) => Number(b.relevance) - Number(a.relevance)),
          best = signals[0]
        if (best) {
          const match = atomViews.some(
            v => overlap(v.entities, seeds.entityIds).length || overlap(v.activityIds, seeds.activityIds).length,
          )
          atomScores.push({
            ...values(best),
            atomId: id,
            originalAccepted: best.accepted!,
            accepted: Boolean(best.accepted || match),
            admissionReason: 'original gate or explicit ID',
          })
        }
      }
      matches.push({
        representationId: view.id!,
        atomIds: structuredClone(view.atomIds!),
        sourceRefs: structuredClone(view.sourceRefs!),
        ...values(signal),
        originalAccepted: signal.accepted!,
        accepted: true,
        admissionReason: 'explicit authorized ID',
        atomScores,
      })
      matched.push({ representationId: view.id!, entityIds: entities, activityIds: activities })
    }
    const id = text(unit.id)
    if (!before.has(id) && matches.length)
      candidates.set(id, {
        id,
        score: 0,
        sourceRanks: {},
        fusionRank: null,
        relevance: Math.max(...matches.map(m => Number(m.relevance))),
        matches,
      })
    details.push({
      memoryId: id,
      memoryLevel: unit.memoryLevel!,
      originalCandidate: before.has(id),
      explicitMatches: matched,
      admitted: candidates.has(id),
      reason: before.has(id)
        ? 'original gate'
        : matches.length
          ? 'explicit ID'
          : query.mode === 'skip'
            ? 'low-information query'
            : 'no explicit association',
    })
  }
  const selected: WorldJsonObject[] = [...candidates.values()]
    .sort(
      (a, b) =>
        Number(b.relevance) - Number(a.relevance) ||
        Number(b.score) - Number(a.score) ||
        compareText(text(a.id), text(b.id)),
    )
    .slice(0, 32)
    .map((r, i) => ({ ...r, rank: i + 1 }))
  const ids = selected.map(c => text(c.id))
  for (const detail of details) {
    detail.selected = ids.includes(text(detail.memoryId))
    if (detail.admitted && !detail.selected) detail.reason = 'candidate budget'
  }
  return {
    candidates: selected,
    trace: {
      seeds,
      units: details,
      candidateLimit: 32,
      originalIds: [...before.keys()],
      selectedIds: ids,
      newSemanticModels: 0,
      familyExpansion: false,
      ordering: 'unchanged relevance then existing fusion score then ID; no new scoring',
      limits: [
        'scene association is candidacy, not topic applicability or truth',
        'rank fusion is not recomputed for newly admitted rows',
      ],
    },
  }
}
