import { publicationSourceText } from '@harness-world/contracts'
/** Deterministic authorized Source delivery for the simplification experiment. */
import { canonicalizeWorldJson, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import type { openActionWorld } from './notice-board-action-fixture.ts'
const object = (v: unknown): WorldJsonObject => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as WorldJsonObject : {}
const list = (v: unknown): WorldJsonObject[] => Array.isArray(v) ? v.map(object) : []
const canonical = (v: WorldJsonValue) => Buffer.from(canonicalizeWorldJson(v)).toString('utf8')
export const historyBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')

/** Host reads only owner-verified rows. Metadata comes from the matching immutable observation. */
export function rawHistorySnapshot(f: ReturnType<typeof openActionWorld>) {
  const head = f.store.head(f.address), events = new Map(f.store.readEvents(f.address).map(e => [e.seq, e]))
  const scope: WorldJsonObject = { characterId: 'character:npc', worldAddress: { ...f.address }, asOfWorldSeq: head.headSeq }
  const sources = f.sources().map(row => {
    const event = events.get(Number(row.source_seq)), value = object(object(event?.data).value)
    if (!event || event.eventType !== 'observation.upsert' || value.observerId !== scope.characterId
      || row.source_id !== 'event:' + event.seq || row.source_hash !== event.eventHash
      || row.namespace_key !== [f.address.tenantId, f.address.worldId, f.address.branchId, scope.characterId].join('\x1f'))
      throw new Error('Source is not an owner-authorized immutable event')
    const content = value.content ?? value, c = object(content), speech = object(c.speech)
    if (c.manifestation !== undefined || c.playerInput !== undefined) throw new Error('unsupported raw-history lab source')
    const text = c.speech !== undefined
      ? publicationSourceText(speech)
      : typeof content === 'string' ? content : canonical(content)
    const kind = c.speech !== undefined ? 'reported_speech' : value.epistemicKind ?? (c.actionType === undefined ? 'direct_observation' : 'observed_action')
    if (row.text_value !== text || row.epistemic_kind !== kind) throw new Error('Source text or epistemic kind changed')
    return { sourceId: row.source_id!, sourceHash: row.source_hash!, worldSeq: event.seq,
      characterId: scope.characterId!, worldAddress: { ...f.address }, epistemicKind: kind,
      text, knownTick: event.tick, content } satisfies WorldJsonObject
  }).sort((a, b) => a.worldSeq - b.worldSeq)
  return { scope, tick: head.tick, sources }
}

/** Input is a host snapshot, never another character's archive or a global search result. */
export function deliverRawHistory(snapshot: { scope: WorldJsonObject; tick: number; sources: WorldJsonObject[] },
  request: PrototypeTurnRequest, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new Error('invalid history byte budget')
  const { scope, sources, tick } = snapshot, owner = scope.characterId
  if (object(request.context.character).characterId !== owner) throw new Error('foreign Character request')
  if (!Number.isSafeInteger(scope.asOfWorldSeq) || !Number.isSafeInteger(tick)) throw new Error('invalid snapshot time')
  const scene = object(request.context.scene), people = new Set(list(scene.people).map(p => String(p.characterId)).filter(id => id !== owner))
  const locations = new Set<WorldJsonValue | undefined>([scene.locationId, object(request.context.character).locationId].filter(v => typeof v === 'string'))
  const entities = new Set(list(object(request.context.items).current).filter(e => locations.has(e.locationId)).map(e => String(e.entityId)))
  const activities = new Set<string>()
  function activityIds(v: WorldJsonValue | undefined) {
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) { for (const item of v) activityIds(item); return }
    if (typeof object(v).activityId === 'string') activities.add(String(object(v).activityId))
    for (const item of Object.values(v)) activityIds(item)
  }
  activityIds(request.context.stimulus); activityIds(request.context.activity)
  const recentContent = [...list(request.context.observations), ...list(request.context.selfObservations), ...list(request.context.stimulus)]
  const recentSeqs = new Set(recentContent.map(v => Number(v.sourceSeq)).filter(Number.isSafeInteger))
  const recent = new Set<string>(), seen = new Map<string, string>()
  const candidates: { source: WorldJsonObject; memory: WorldJsonObject; reasons: string[] }[] = []
  const excluded: WorldJsonObject[] = []
  for (const source of sources.toSorted((a, b) => Number(a.worldSeq) - Number(b.worldSeq) || String(a.sourceId).localeCompare(String(b.sourceId)))) {
    if (source.characterId !== owner || canonical(source.worldAddress!) !== canonical(scope.worldAddress!)
      || !Number.isSafeInteger(source.worldSeq) || Number(source.worldSeq) > Number(scope.asOfWorldSeq)
      || !Number.isSafeInteger(source.knownTick) || Number(source.knownTick) > tick
      || typeof source.sourceId !== 'string' || typeof source.sourceHash !== 'string' || typeof source.text !== 'string')
      throw new Error('unauthorized or future raw-history Source')
    const bytes = canonical(source)
    if (seen.has(source.sourceId)) {
      if (seen.get(source.sourceId) !== bytes) throw new Error('Source identity changed')
      continue
    }
    seen.set(source.sourceId, bytes)
    const c = object(source.content), speech = object(c.speech), actor = speech.characterId ?? c.actorId
    const reasons: string[] = []
    if (typeof actor === 'string' && people.has(actor)) reasons.push('current-person')
    if (Array.isArray(speech.addresseeIds) && speech.addresseeIds.some(id => typeof id === 'string' && people.has(id))) reasons.push('explicit-addressee')
    if (typeof c.targetId === 'string' && people.has(c.targetId)) reasons.push('current-person-target')
    if (typeof c.targetId === 'string' && entities.has(c.targetId)) reasons.push('explicit-target-in-current-location')
    if ([c.locationId, c.originLocationId, c.destinationLocationId].some(id => locations.has(id))) reasons.push('explicit-location')
    if (typeof object(c.activity).activityId === 'string' && activities.has(String(object(c.activity).activityId))) reasons.push('explicit-activity')
    if (recentSeqs.has(Number(source.worldSeq)) || recentContent.some(v => canonical((object(v.value).content ?? v.content ?? v) as WorldJsonValue) === canonical(source.content!))) {
      recent.add(source.sourceId)
      excluded.push({ sourceId: source.sourceId, reason: 'already-in-recent-context' }); continue
    }
    if (!reasons.length) { excluded.push({ sourceId: source.sourceId, reason: 'no-explicit-association' }); continue }
    const description = typeof c.description === 'string' ? c.description : typeof c.resultDescription === 'string' ? c.resultDescription : source.text
    const text = source.epistemicKind === 'reported_speech'
      ? '【发言及外显表达；不证明受控结果】' + source.text
      : '【' + source.epistemicKind + '】' + (c.targetId === undefined ? '' : String(c.targetId) + '：') + description
    const memory: WorldJsonObject = { memoryId: 'raw:' + source.sourceId, memoryLevel: 'source',
      text, epistemicKind: source.epistemicKind!, sourceIds: [source.sourceId],
      worldSeq: source.worldSeq!, knownTick: source.knownTick!, sourceAgeTicks: tick - Number(source.knownTick), characterId: owner! }
    candidates.push({ source, memory, reasons })
  }
  const selected: typeof candidates = [], omitted: string[] = []
  for (const candidate of candidates.toReversed()) {
    if (historyBytes([...selected.map(c => c.memory), candidate.memory]) <= maxBytes) selected.push(candidate)
    else omitted.push(String(candidate.source.sourceId))
  }
  selected.reverse()
  return { memories: selected.map(c => c.memory), trace: {
    scope, tick, budgetMetric: 'utf8-json-bytes', maxBytes, materialBytes: historyBytes(selected.map(c => c.memory)),
    materialTokens: null, authorizedCount: seen.size, candidateCount: candidates.length, deliveredCount: selected.length,
    recentSourceIds: [...recent], excluded, omittedSourceIds: omitted,
    providedWorldSeqRange: selected.length ? [selected[0]!.source.worldSeq!, selected.at(-1)!.source.worldSeq!] : [],
    delivered: selected.map(c => ({ reasons: c.reasons, sourceRef: Object.fromEntries(
      ['sourceId', 'sourceHash', 'epistemicKind', 'worldSeq', 'characterId', 'worldAddress'].map(k => [k, c.source[k]!])) })),
    complete: omitted.length === 0, coverageLimit: 'unstructured names and missing location/activity IDs are not inferred',
    semanticCalls: 0, observationBodiesDelivered: false,
  } }
}
