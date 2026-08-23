import type { WorldEventDraft, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface PlayerActionInput extends WorldJsonObject {
  readonly actionType: string
  readonly parameters: WorldJsonValue
}

/** Revalidate a durable Inbox payload before it reaches any deterministic Rulebook. */
export function parsePlayerActionInput(value: WorldJsonValue): PlayerActionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('claimed player action must be an object')
  const action = value as Record<string, WorldJsonValue>
  const keys = Object.keys(action).sort()
  if (keys.join(',') !== 'actionType,parameters' || typeof action.actionType !== 'string') {
    throw new TypeError('claimed player action has an invalid shape')
  }
  return { actionType: action.actionType, parameters: action.parameters! }
}

export interface RulebookResolution {
  readonly status: 'accepted' | 'rejected'
  readonly events: readonly WorldEventDraft[]
  readonly reason?: string
}

function object(value: WorldJsonValue): Record<string, WorldJsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, WorldJsonValue>
    : undefined
}

export interface RulebookEvent {
  readonly eventType: string
  readonly data: WorldJsonValue
}

function currentLocation(events: readonly RulebookEvent[], characterId: string): string | undefined {
  let locationId: string | undefined
  for (const event of events) {
    const data = object(event.data)
    if (data?.characterId !== characterId) continue
    if ((event.eventType === 'character.upsert' || event.eventType === 'character.created') && typeof data.locationId === 'string') locationId = data.locationId
    if (event.eventType === 'character.moved' && typeof data.toLocationId === 'string') locationId = data.toLocationId
  }
  return locationId
}

export interface EntityState extends WorldJsonObject {
  readonly entityId: string
  readonly locationId: string | null
  readonly holderId: string | null
  readonly kind: string
}

/** Rebuild one entity's authoritative location/holder state from the exact Event prefix. */
export function currentEntityState(events: readonly RulebookEvent[], entityId: string): EntityState | undefined {
  let state: EntityState | undefined
  for (const event of events) {
    const data = object(event.data)
    if (data?.entityId !== entityId) continue
    if (event.eventType === 'entity.upsert') {
      if (typeof data.locationId !== 'string' || typeof data.kind !== 'string') {
        throw new TypeError(`entity.upsert for ${entityId} is malformed`)
      }
      state = { entityId, locationId: data.locationId, holderId: null, kind: data.kind }
    }
    if (event.eventType === 'entity.taken') {
      if (state === undefined || typeof data.characterId !== 'string' || typeof data.fromLocationId !== 'string'
        || state.holderId !== null || state.locationId !== data.fromLocationId) {
        throw new TypeError(`entity.taken for ${entityId} violates the entity event prefix`)
      }
      state = { ...state, locationId: null, holderId: data.characterId }
    }
  }
  return state
}

export function currentCharacterLifecycle(events: readonly RulebookEvent[], characterId: string): 'active' | 'incapacitated' | 'dead' | 'departed' | undefined {
  let state: 'active' | 'incapacitated' | 'dead' | 'departed' | undefined
  for (const event of events) {
    const data = object(event.data)
    if (data?.characterId !== characterId) continue
    if (event.eventType === 'character.upsert' || event.eventType === 'character.created') state ??= 'active'
    if (event.eventType === 'character.lifecycle-changed'
      && (data.lifecycleState === 'active' || data.lifecycleState === 'incapacitated'
        || data.lifecycleState === 'dead' || data.lifecycleState === 'departed')) state = data.lifecycleState
  }
  return state
}

/** Deterministic V0 Rulebook for player speech and movement. */
export class SpeakMoveRulebook {
  resolve(
    manifest: CompiledWorldManifest,
    events: readonly RulebookEvent[],
    characterId: string,
    action: PlayerActionInput,
  ): RulebookResolution {
    const lifecycle = currentCharacterLifecycle(events, characterId)
    if (lifecycle !== 'active') return this.#reject(characterId, action.actionType, `character lifecycle ${lifecycle ?? 'missing'} cannot act`)
    const parameters = object(action.parameters)
    if (action.actionType === 'speak') {
      const text = parameters?.text
      if (typeof text !== 'string' || text.length === 0) return this.#reject(characterId, action.actionType, 'speak requires non-empty text')
      return {
        status: 'accepted',
        events: [{ eventType: 'character.speak', eventVersion: 1, data: { characterId, text } }],
      }
    }
    if (action.actionType === 'move') {
      const target = parameters?.locationId
      if (typeof target !== 'string' || !manifest.locations.some(location => location.locationId === target)) {
        return this.#reject(characterId, action.actionType, 'move target is not a manifest location')
      }
      const from = currentLocation(events, characterId)
      if (from === target) return this.#reject(characterId, action.actionType, 'character is already at the target location')
      return {
        status: 'accepted',
        events: [{
          eventType: 'character.moved',
          eventVersion: 1,
          data: { characterId, fromLocationId: from ?? null, toLocationId: target },
        }],
      }
    }
    if (action.actionType === 'take' && manifest.rulebook.version === 2) {
      const entityId = parameters?.entityId
      if (typeof entityId !== 'string' || !manifest.entities.some(entity => entity.entityId === entityId)) {
        return this.#reject(characterId, action.actionType, 'take requires a manifest entityId')
      }
      const entity = currentEntityState(events, entityId)
      const characterLocation = currentLocation(events, characterId)
      if (entity === undefined || entity.holderId !== null || entity.locationId !== characterLocation) {
        return this.#reject(characterId, action.actionType, 'ITEM_NOT_AVAILABLE')
      }
      return {
        status: 'accepted',
        events: [{
          eventType: 'entity.taken',
          eventVersion: 1,
          data: { entityId, characterId, fromLocationId: entity.locationId },
        }],
      }
    }
    return this.#reject(characterId, action.actionType, 'action type is not afforded by the V0 Rulebook')
  }

  #reject(characterId: string, actionType: string, reason: string): RulebookResolution {
    return {
      status: 'rejected',
      reason,
      events: [{ eventType: 'action.rejected', eventVersion: 1, data: { characterId, actionType, reason } }],
    }
  }
}
