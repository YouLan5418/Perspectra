/** Current minimal delivery. Observation bodies retain explicit subjective framing. */
import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import { LABELS, compareText, list, object, rows, same, segments, text, unionRefs } from './archive.ts'
import { archive, associations } from './projections.ts'
import { sorted, unique } from './queries.ts'
import { assertRequest } from './admission.ts'
const chars = (value: WorldJsonValue) => [...JSON.stringify(value)].length

function evidenceKey(atom: WorldJsonObject, sources: Map<string, WorldJsonObject>): string {
  const e = object(atom.evidence)
  let channel = e.channel,
    actor = e.actorId
  if (
    channel === 'player_input' &&
    segments(sources.get(text(e.sourceId))!).some(
      s => s.channel === 'speech' && s.actorId === 'character:player' && s.context === e.context,
    )
  ) {
    channel = 'speech'
    actor = 'character:player'
  }
  return JSON.stringify([e.sourceId, channel, actor, e.context])
}
export function deliver(
  doc: WorldJsonObject,
  candidates: WorldJsonObject[],
  request: WorldJsonObject,
  tick: number,
  query: WorldJsonObject,
  maxItems = 3,
  maxChars = 4500,
): WorldJsonObject {
  const { byId, sources } = archive(doc)
  assertRequest(doc, request)
  if (!Number.isSafeInteger(tick) || [...sources.values()].some(s => Number(s.knownTick) > tick))
    throw new Error('Delivery contains future Source')
  if (!Number.isSafeInteger(maxItems) || maxItems < 0 || !Number.isSafeInteger(maxChars) || maxChars < 2)
    throw new Error('Invalid Delivery budget')
  for (const c of candidates) {
    const unit = byId.get(text(c.id))
    if (!unit) throw new Error('Selection outside authorized candidate pool')
    const allowed =
      unit.memoryLevel === 'event_atom'
        ? [text(unit.id)]
        : list(unit.eventAtomIds ?? unit.sourceFactIds ?? []).map(text)
    for (const m of rows(c.matches ?? [])) {
      const ids = list(m.atomIds).map(text)
      if (
        !ids.length ||
        ids.some(id => !allowed.includes(id) || !byId.has(id)) ||
        !same(m.sourceRefs!, unionRefs(ids.map(id => byId.get(id)!)))
      )
        throw new Error('Foreign candidate evidence')
      for (const score of rows(m.atomScores ?? []))
        if (!allowed.includes(text(score.atomId)) || !ids.includes(text(score.atomId)))
          throw new Error('Foreign candidate evidence score')
    }
  }
  const memories: WorldJsonObject[] = [],
    delivered: WorldJsonObject[] = [],
    omitted: WorldJsonObject[] = [],
    selectedIds = candidates.filter(c => byId.get(text(c.id))!.memoryLevel === 'observation').map(c => text(c.id))
  for (const c of candidates) {
    const id = text(c.id)
    if (!selectedIds.includes(id)) continue
    const unit = byId.get(id)!,
      refs = rows(unit.sourceRefs),
      counters = list(unit.contradictingAtomIds).map(text),
      supports = list(unit.supportingAtomIds).map(text),
      all = list(unit.sourceFactIds).map(text)
    const base = {
      memoryId: id,
      memoryLevel: 'observation',
      epistemicKind: unit.epistemicKind!,
      text: '【本角色的可修正认识；不是权威世界事实】\n' + text(unit.text),
      sourceIds: refs.map(r => r.sourceId!),
      sourceAgeTicks: tick - Math.max(...refs.map(r => Number(sources.get(text(r.sourceId))!.knownTick))),
      sourceTypes: sorted(refs.map(r => text(sources.get(text(r.sourceId))!.epistemicKind))),
      hasUnresolvedCounterEvidence: counters.length > 0,
    }
    const itemFor = (evidence: WorldJsonObject[]) => {
      const included = new Set(evidence.map(e => text(e.atomId))),
        complete = all.every(i => included.has(i))
      return {
        ...base,
        keyEvidence: evidence,
        evidenceCoverage: {
          included: included.size,
          total: all.length,
          counterIncluded: counters.filter(i => included.has(i)).length,
          counterTotal: counters.length,
          complete,
          note: complete
            ? '证据已全部展示；来源内容不证明现实真值，也不表示冲突已解决。'
            : '仅证据摘选；未展示的证据和反证仍存在，不能视为已核实或冲突已解决。',
        },
      }
    }
    let item = itemFor([])
    if (memories.length >= maxItems || chars([...memories, item]) > maxChars) {
      omitted.push({ memoryId: id, reason: 'Observation body and mandatory provenance exceed budget' })
      continue
    }
    const evidence: WorldJsonObject[] = [],
      choices = unique([
        ...counters.slice(0, 1),
        ...supports
          .toSorted(
            (a, b) =>
              Math.max(...rows(byId.get(b)!.sourceRefs).map(r => Number(r.worldSeq))) -
              Math.max(...rows(byId.get(a)!.sourceRefs).map(r => Number(r.worldSeq))),
          )
          .slice(0, 1),
      ])
    for (const aid of choices) {
      const atom = byId.get(aid)!,
        ref = rows(atom.sourceRefs)[0]!,
        e = object(atom.evidence),
        selected = {
          atomId: aid,
          sourceId: ref.sourceId!,
          role: counters.includes(aid) ? 'counter' : 'support',
          epistemicKind: sources.get(text(ref.sourceId))!.epistemicKind!,
          text: '【' + LABELS[text(e.channel)] + '】' + text(e.context),
        },
        trial = itemFor([...evidence, selected])
      if (chars([...memories, trial]) <= maxChars) {
        evidence.push(selected)
        item = trial
      }
    }
    memories.push(item)
    delivered.push({
      memoryId: id,
      sourceRefs: structuredClone(refs),
      referencedAtomIds: structuredClone(all),
      coveredAtomIds: evidence.map(e => e.atomId!),
      reason: 'selected authorized subjective Observation body; optional evidence excerpts',
    })
  }
  const raw = candidates.filter(c => byId.get(text(c.id))!.memoryLevel !== 'observation'),
    remaining = maxChars - chars(memories) + (memories.length ? 1 : 2)
  if (raw.length && memories.length < maxItems && remaining >= 2) {
    const result = rawDelivery(doc, raw, request, tick, query, maxItems - memories.length, remaining)
    for (let i = 0; i < result.items.length; i++)
      if (memories.length < maxItems && chars([...memories, result.items[i]!]) <= maxChars) {
        memories.push(result.items[i]!)
        delivered.push(result.traces[i]!)
      }
    omitted.push(...result.omitted)
  }
  return {
    memories,
    trace: {
      delivered,
      omitted,
      jsonChars: chars(memories),
      budget: { maxItems, maxJsonChars: maxChars },
      selectedObservationIds: selectedIds,
      bodyFirst: true,
      truthGate: false,
      completeEvidenceGroupRequired: false,
      evidenceExcerptsPerObservation: 2,
    },
  }
}

function rawDelivery(
  doc: WorldJsonObject,
  candidates: WorldJsonObject[],
  request: WorldJsonObject,
  tick: number,
  query: WorldJsonObject,
  maxItems: number,
  maxChars: number,
) {
  const { byId, sources, activities, atomActivity } = associations(doc),
    context = object(request.context),
    recent = new Set(
      [...rows(context.observations ?? []), ...rows(context.selfObservations ?? [])].map(o => Number(o.sourceSeq)),
    ),
    keys = new Map(
      [...byId.values()].filter(a => a.memoryLevel === 'event_atom').map(a => [text(a.id), evidenceKey(a, sources)]),
    )
  const evidenceItem = (atom: WorldJsonObject, memoryId: string, level: string) => {
    const e = object(atom.evidence),
      key = JSON.parse(keys.get(text(atom.id))!) as [string, string, string | null, string]
    return {
      item: {
        memoryId,
        memoryLevel: level,
        text: '【' + LABELS[key[1]] + '】' + (key[2] ? key[2] + '：' : '') + text(e.context),
        epistemicKind: sources.get(text(e.sourceId))!.epistemicKind!,
        sourceIds: [e.sourceId!],
        sourceAgeTicks: tick - Number(sources.get(text(e.sourceId))!.knownTick),
      },
      ids: [...keys].filter(([, v]) => v === keys.get(text(atom.id))).map(([id]) => id),
    }
  }
  const baseItems: WorldJsonObject[] = [],
    baseTraces: WorldJsonObject[] = [],
    baseOmitted: WorldJsonObject[] = [],
    covered = new Set<string>()
  const queues = candidates.map(c => {
    const unit = byId.get(text(c.id))!
    if (unit.memoryLevel === 'event_atom') return [{ c, ids: [text(unit.id)] }]
    const matches = rows(c.matches ?? [])
    const scored = new Map<string, number>()
    for (const m of matches)
      for (const row of rows(m.atomScores ?? []))
        if (row.accepted)
          scored.set(text(row.atomId), Math.max(scored.get(text(row.atomId)) ?? 0, Number(row.relevance)))
    const ids = matches.some(m => 'atomScores' in m)
      ? [...scored].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([id]) => id)
      : list(matches[0]?.atomIds ?? []).map(text)
    const seen = new Set<string>()
    return ids
      .filter(id => {
        const key = keys.get(id)!
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 2)
      .map(id => ({ c, ids: [id] }))
  })
  for (let depth = 0; depth < 2; depth++)
    for (const queue of queues) {
      const task = queue[depth]
      if (!task) continue
      const unit = byId.get(text(task.c.id))!
      for (const id of task.ids) {
        const atom = byId.get(id)!
        if (recent.has(Number(rows(atom.sourceRefs)[0]!.worldSeq))) {
          baseOmitted.push({ memoryId: unit.id!, atomId: id, reason: 'already in current context' })
          continue
        }
        const key = keys.get(id)!
        if (covered.has(key)) {
          baseOmitted.push({ memoryId: unit.id!, atomId: id, reason: 'same evidence segment already delivered' })
          continue
        }
        const { item, ids } = evidenceItem(atom, text(unit.id), text(unit.memoryLevel))
        if (baseItems.length < maxItems && chars([...baseItems, item]) <= maxChars) {
          baseItems.push(item)
          baseTraces.push({ memoryId: unit.id!, sourceRefs: atom.sourceRefs!, coveredAtomIds: ids, retrieval: task.c })
          covered.add(key)
        } else baseOmitted.push({ memoryId: unit.id!, atomId: id, reason: 'budget; complete context not truncated' })
      }
    }
  const requested = unique(text(query.originalText).match(/activity:[a-z0-9_-]+/g) ?? []),
    touched = new Map<string, string[]>(),
    relation = new Map<string, WorldJsonObject[]>()
  const touch = (id: string, memory: string, atoms: string[]) => {
    if (requested.length && !requested.includes(id)) return
    touched.set(id, [...(touched.get(id) ?? []), memory])
    relation.set(id, [...(relation.get(id) ?? []), ...unionRefs(atoms.map(i => byId.get(i)!))])
  }
  for (const c of candidates) {
    const unit = byId.get(text(c.id))!,
      ids = unique([
        ...(unit.memoryLevel === 'event_atom' ? [text(unit.id)] : []),
        ...rows(c.matches ?? []).flatMap(m =>
          'atomScores' in m
            ? rows(m.atomScores)
                .filter(r => r.accepted)
                .map(r => text(r.atomId))
            : list(m.atomIds).map(text),
        ),
      ])
    for (const id of sorted(ids.map(i => atomActivity.get(i)).filter((s): s is string => s !== undefined)))
      touch(id, text(unit.id), ids)
  }
  for (const id of requested)
    if (activities.has(id)) {
      const row = activities.get(id)!
      touch(
        id,
        id,
        [row.openingAtomId, row.endingAtomId].filter((v): v is string => typeof v === 'string'),
      )
    }
  type Row = { item: WorldJsonObject; trace: WorldJsonObject; activity: string | null }
  const pool: Row[] = []
  for (const [field, reason] of [
    ['endingAtomId', 'same activity ending evidence'],
    ['openingAtomId', 'same activity opening evidence'],
  ] as const)
    for (const [id, matched] of touched) {
      const aid = activities.get(id)![field]
      if (typeof aid !== 'string') continue
      const atom = byId.get(aid)!
      if (recent.has(Number(rows(atom.sourceRefs)[0]!.worldSeq))) continue
      const e = object(atom.evidence)
      pool.push({
        item: {
          memoryId: aid,
          memoryLevel: 'event_atom',
          text: '【' + LABELS[text(e.channel)] + '】' + String(e.actorId ?? '') + '：' + text(e.context),
          epistemicKind: sources.get(text(e.sourceId))!.epistemicKind!,
          sourceIds: [e.sourceId!],
          sourceAgeTicks: tick - Number(sources.get(text(e.sourceId))!.knownTick),
        },
        trace: {
          memoryId: aid,
          sourceRefs: atom.sourceRefs!,
          coveredAtomIds: [aid],
          reason,
          activityId: id,
          matchedMemoryIds: unique(matched),
          relationSourceRefs: [...new Map((relation.get(id) ?? []).map(r => [text(r.sourceId), r])).values()],
        },
        activity: id,
      })
    }
  baseItems.forEach((item, i) => {
    const trace = baseTraces[i]!,
      ids = sorted(
        list(trace.coveredAtomIds)
          .map(text)
          .map(id => atomActivity.get(id))
          .filter((id): id is string => id !== undefined),
      ),
      id = ids.length === 1 ? ids[0]! : null
    if (!requested.length || (id !== null && requested.includes(id))) pool.push({ item, trace, activity: id })
  })
  const annotate = (selected: Row[]) => {
    const included = new Set(selected.flatMap(r => list(r.trace.coveredAtomIds).map(text))),
      noted = new Set<string>()
    return selected.map(r => {
      if (r.activity === null) return r.item
      const row = activities.get(r.activity)!,
        present = (id: WorldJsonValue | undefined) =>
          typeof id === 'string' &&
          (included.has(id) || recent.has(Number(rows(byId.get(id)!.sourceRefs)[0]!.worldSeq))),
        info = {
          activityId: r.activity,
          status: row.status!,
          openingIncluded: present(row.openingAtomId),
          endingIncluded: present(row.endingAtomId),
          processCoverage: 'selected evidence',
        }
      let content = text(r.item.text)
      if (!noted.has(r.activity)) {
        const note = info.endingIncluded
          ? '该活动已结束；当前材料包含结束记录，过程为选取的经历片段。'
          : row.status === 'ended'
            ? '该活动已结束；当前材料未包含结束记录，不能据此推断结束方式或原因。'
            : '当前材料为经历片段；本角色授权档案中尚无结束记录，不能据此确定结局或认定活动仍在进行。'
        content = '【材料完整度】' + note + '\n' + content
        noted.add(r.activity)
      }
      return { ...r.item, text: content, deliveryCoverage: info }
    })
  }
  const selected: Row[] = [],
    finalCovered = new Set<string>(),
    omitted: WorldJsonObject[] = baseOmitted.map(o => ({ ...o, stage: 'retrieved evidence projection' }))
  for (const row of pool) {
    const evidenceKeys = list(row.trace.coveredAtomIds)
      .map(text)
      .map(i => keys.get(i)!)
    if (evidenceKeys.length && evidenceKeys.every(k => finalCovered.has(k))) continue
    const trial = [...selected, row]
    if (trial.length > maxItems || chars(annotate(trial)) > maxChars) {
      omitted.push({ memoryId: row.item.memoryId!, reason: 'budget including completeness annotation' })
      continue
    }
    selected.push(row)
    evidenceKeys.forEach(k => finalCovered.add(k))
  }
  return { items: annotate(selected), traces: selected.map(r => r.trace), omitted }
}
