import type { WorldEventDraft } from '@harness-world/contracts'
import {
  currentEntityState,
  currentLocation,
  type CompiledWorldManifest,
  type RulebookEvent,
} from '@harness-world/kernel'

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(what + '必须是对象')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const keys = Object.keys(value)
  if (required.some(k => !Object.hasOwn(value, k)) || keys.some(k => !required.includes(k) && !optional.includes(k)))
    throw new TypeError('状态定义字段不合法：' + keys.join(','))
}
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new TypeError(what + '无效')
  return value
}

/** Reach uses committed custody and the actor's authoritative scene. */
export function itemIsReachable(
  events: readonly RulebookEvent[],
  actorId: string,
  entityId: string,
  present: readonly string[],
): boolean {
  const item = currentEntityState(events, entityId)
  if (item === undefined) return false
  if (item.holderId !== null) return item.holderId === actorId || present.includes(item.holderId)
  return item.locationId !== null && item.locationId === currentLocation(events, actorId)
}

/** The physical facts a candidate may state, checked in order against the prefix it would extend. A contradicting
 * custody event in the log would make every later fold of that entity throw, so it must never get there. */
export function assertPhysicalEffects(input: {
  readonly manifest: Pick<CompiledWorldManifest, 'characters' | 'locations' | 'entities'>
  readonly events: readonly RulebookEvent[]
  readonly drafts: readonly WorldEventDraft[]
  /** The bound actor of an immediate round; only they can walk. Omitted for a rule layer's own proposal. */
  readonly actorId?: string | undefined
}): void {
  const applied: RulebookEvent[] = [...input.events]
  const character = (id: unknown): void => {
    if (!input.manifest.characters.some(row => row.characterId === id))
      throw new TypeError('physical effect names an undeclared character: ' + String(id))
  }
  const location = (id: unknown): void => {
    if (!input.manifest.locations.some(row => row.locationId === id))
      throw new TypeError('physical effect names an undeclared location: ' + String(id))
  }
  const custody = (entityId: string, why: string): TypeError =>
    new TypeError(`effect on ${entityId} contradicts committed custody: ${why}`)
  for (const draft of input.drafts) {
    const data = (draft.data ?? {}) as Record<string, unknown>
    const entityId = String(data.entityId)
    if (draft.eventType === 'character.moved') {
      character(data.characterId)
      location(data.toLocationId)
      if (input.actorId !== undefined && data.characterId !== input.actorId)
        throw new TypeError('an immediate round moves only its bound player')
      if ((currentLocation(applied, String(data.characterId)) ?? null) !== data.fromLocationId)
        throw new TypeError('character.moved does not start from the current location')
    } else if (draft.eventType === 'entity.transferred' || draft.eventType === 'entity.taken') {
      const before = currentEntityState(applied, entityId)
      if (before === undefined) throw custody(entityId, 'it does not exist')
      character(data.characterId)
      if (typeof data.toHolderId === 'string') character(data.toHolderId)
      if (typeof data.toLocationId === 'string') location(data.toLocationId)
      try {
        currentEntityState([...applied, draft as RulebookEvent], entityId)
      } catch {
        throw custody(entityId, `it is at ${before.holderId ?? before.locationId}`)
      }
    } else if (draft.eventType === 'entity.upsert') {
      const before = currentEntityState(applied, entityId)
      if (before === undefined && !input.manifest.entities.some(row => row.entityId === entityId))
        throw custody(entityId, 'it is not declared')
      const after = currentEntityState([...applied, draft as RulebookEvent], entityId)!
      // Changing how an item looks never moves it; moves are recorded as transfers, with their witnesses.
      if (before && (before.holderId !== after.holderId || before.locationId !== after.locationId))
        throw custody(entityId, 'an upsert cannot move it')
      if (after.holderId !== null) character(after.holderId)
      else location(after.locationId)
    }
    applied.push(draft as RulebookEvent)
  }
}

/** Validate all requested item effects before returning any facts to commit. */
export function adjudicateItemChanges(input: {
  readonly events: readonly RulebookEvent[]
  readonly actorId: string
  readonly interactionId: string
  readonly sceneIds: readonly string[]
  readonly entityIds: readonly string[]
  readonly value: unknown
}): WorldEventDraft[] {
  const { events, actorId, interactionId, sceneIds, entityIds, value } = input
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('物品变化必须是至多 8 项的列表')
  const drafts: WorldEventDraft[] = []
  let moved = false
  for (const entry of value) {
    const change = object(entry, '物品变化')
    exact(change, ['entityId'], ['kind', 'to'])
    const entityId = text(change.entityId, '物品')
    if (!entityIds.includes(entityId)) throw new TypeError('物品不存在：' + entityId)
    if (!itemIsReachable([...events, ...drafts] as RulebookEvent[], actorId, entityId, sceneIds))
      throw new TypeError('物品不在行动者够得着的地方：' + entityId)
    const before = currentEntityState([...events, ...drafts] as RulebookEvent[], entityId)!
    if (Object.hasOwn(change, 'kind')) {
      if (typeof change.kind !== 'string' || change.kind.trim() === '' || change.kind.length > 500)
        throw new TypeError('物品外观必须是 1–500 字')
      drafts.push({
        eventType: 'entity.upsert',
        eventVersion: 1,
        data:
          before.holderId === null
            ? { entityId, locationId: before.locationId, kind: change.kind }
            : { entityId, locationId: null, holderId: before.holderId, kind: change.kind },
      })
    }
    if (Object.hasOwn(change, 'to')) {
      if (moved) throw new TypeError('一次结果至多移动一件物品')
      moved = true
      const to = object(change.to, '物品去向')
      let destination: { holderId: string | null; locationId: string | null }
      if (Object.hasOwn(to, 'holderId')) {
        exact(to, ['holderId'])
        if (typeof to.holderId !== 'string' || !sceneIds.includes(to.holderId))
          throw new TypeError('物品只能交给行动者或同场角色')
        destination = { holderId: to.holderId, locationId: null }
      } else {
        exact(to, ['locationId'])
        if (to.locationId !== currentLocation(events, actorId)) throw new TypeError('物品只能放在行动者所在的位置')
        destination = { holderId: null, locationId: to.locationId as string }
      }
      if (destination.holderId === before.holderId && destination.locationId === before.locationId)
        throw new TypeError('物品已经在那里')
      drafts.push({
        eventType: 'entity.transferred',
        eventVersion: 1,
        data: {
          entityId,
          characterId: actorId,
          interactionId: interactionId,
          fromHolderId: before.holderId,
          fromLocationId: before.locationId,
          toHolderId: destination.holderId,
          toLocationId: destination.locationId,
        },
      })
    }
  }
  return drafts
}
