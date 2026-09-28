import type { CharacterId, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { currentEntityState, currentLocation, type CompiledWorldManifest, type RulebookEvent } from '@harness-world/kernel'

const object = (value: WorldJsonValue | undefined): WorldJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorldJsonObject : {}

/** A conservative scene view, never a global inventory or an inference from dialogue. */
export function characterVisibleItems(manifest: CompiledWorldManifest, events: readonly RulebookEvent[],
  actorId: CharacterId, observerIds: readonly CharacterId[]): WorldJsonObject {
  const locationId = currentLocation(events, actorId)
  const current: WorldJsonObject[] = [], lastObserved: WorldJsonObject[] = []
  for (const entity of manifest.entities) {
    const state = currentEntityState(events, entity.entityId)
    let lastChange = -1
    let observed: { index: number; transfer: WorldJsonObject; description?: string } | undefined
    events.forEach((event, index) => {
      const data = object(event.data)
      if (['entity.upsert', 'entity.transferred', 'entity.taken'].includes(event.eventType)
        && data.entityId === entity.entityId) lastChange = index
      const value = object(data.value), content = object(value.content), transfer = object(content.interaction)
      if (event.eventType === 'observation.upsert' && value.observerId === actorId
        && content.status === 'accepted' && transfer.entityId === entity.entityId
        && 'toHolderId' in transfer) {
        observed = { index, transfer,
          ...(typeof content.resultDescription === 'string' ? { description: content.resultDescription } : {}) }
      }
    })
    const ownOrGround = state !== undefined && (state.holderId === actorId
      || (locationId !== undefined && state.holderId === null && state.locationId === locationId))
    const witnessedHolder = state?.holderId != null && observed !== undefined && observed.index > lastChange
      && observed.transfer.toHolderId === state.holderId && observerIds.includes(state.holderId as CharacterId)
      && locationId !== undefined && currentLocation(events, state.holderId) === locationId
    if (state !== undefined && (ownOrGround || witnessedHolder)) {
      current.push({ entityId: state.entityId, holderId: state.holderId, locationId: state.locationId })
    } else if (observed !== undefined) {
      lastObserved.push({ entityId: entity.entityId, holderId: observed.transfer.toHolderId ?? null,
        locationId: observed.transfer.toLocationId ?? null,
        ...(observed.description === undefined ? {} : { lastObservedDescription: observed.description }),
        note: '这是你上次观察到的交互结果；目前不能确认该物品的归属或位置。' })
    }
  }
  return { current, lastObserved }
}
