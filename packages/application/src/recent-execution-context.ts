import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

const object = (value: WorldJsonValue | undefined): WorldJsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WorldJsonObject) : undefined

export const RECENT_EXECUTION_LIMITS = { maximumItems: 6, maximumJsonCharacters: 1200 } as const
/** A second presentation of already delivered observations, never a new source of world facts.
 * Source links stay in the host context; characterRequestText removes them from model text.
 * Memories, goals and speech are deliberately not mined for objective accomplishments.
 */
export function recentExecutionContext(context: WorldJsonObject): WorldJsonObject {
  const actorId = object(context.character)?.characterId
  const cognition = object(context.cognition),
    prefix = cognition?.asOfWorldSeq
  if (
    typeof actorId !== 'string' ||
    !Number.isSafeInteger(prefix) ||
    (cognition?.characterId !== undefined && cognition.characterId !== actorId)
  )
    return context
  const candidates = new Map<string, WorldJsonObject>()
  for (const raw of Array.isArray(context.observations) ? context.observations : []) {
    const record = object(raw),
      value = object(record?.value),
      content = object(value?.content)
    const seq = record?.sourceSeq
    if (
      !record ||
      !content ||
      value?.observerId !== actorId ||
      typeof value.actionId !== 'string' ||
      typeof record.id !== 'string' ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq > Number(prefix) ||
      typeof content.actorId !== 'string' ||
      !['move', 'interact'].includes(String(content.actionType)) ||
      !['accepted', 'rejected'].includes(String(content.status))
    )
      continue
    // Private occurrence-only observations, character speech and inferred memories are not executions.
    const movement = object(content.movement),
      transfer = object(content.interaction),
      metadata = object(content.resultMetadata)
    const details: Record<string, WorldJsonValue> = {}
    if (content.actionType === 'move' && movement?.characterId === content.actorId) {
      if (typeof movement.toLocationId === 'string') details.toLocationId = movement.toLocationId
      if (typeof movement.fromLocationId === 'string') details.fromLocationId = movement.fromLocationId
    }
    if (
      content.actionType === 'interact' &&
      transfer?.characterId === content.actorId &&
      typeof transfer.entityId === 'string' &&
      typeof transfer.interactionId === 'string'
    ) {
      details.definitionId = transfer.interactionId
      details.entityId = transfer.entityId
      for (const key of ['toHolderId', 'toLocationId'] as const) {
        if (transfer[key] === null || typeof transfer[key] === 'string') details[key] = transfer[key]!
      }
    }
    // Creator feedback is kept verbatim and explicitly scoped; unknown business meaning is not inferred.
    if (metadata !== undefined) details.resultMetadata = metadata
    if (typeof content.resultDescription === 'string' && content.resultDescription.trim())
      details.description = content.resultDescription
    if (Object.keys(details).length === 0) continue
    const entry: WorldJsonObject = {
      actorId: content.actorId,
      actionType: content.actionType!,
      result: content.status!,
      evidenceKind: 'actual_execution',
      ...details,
      sourceSeq: seq,
      observationId: record.id,
      actionId: value.actionId,
    }
    const previous = candidates.get(value.actionId)
    // The same execution can have a creator result plus generic host feedback. Prefer actual domain feedback.
    if (
      !previous ||
      metadata !== undefined ||
      (previous.resultMetadata === undefined && seq > Number(previous.sourceSeq))
    )
      candidates.set(value.actionId, entry)
  }
  const items: WorldJsonObject[] = []
  for (const entry of [...candidates.values()].sort((a, b) => Number(b.sourceSeq) - Number(a.sourceSeq))) {
    if (items.length >= RECENT_EXECUTION_LIMITS.maximumItems) break
    // Skip oversized evidence intact rather than truncating a negation, range or result into a false claim.
    if (JSON.stringify({ items: [entry, ...items] }).length <= RECENT_EXECUTION_LIMITS.maximumJsonCharacters)
      items.unshift(entry)
  }
  return items.length ? { ...context, recentExecutionEvidence: { items } } : context
}
