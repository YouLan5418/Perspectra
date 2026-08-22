import type { WorldEventDraft, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface PlayerActionInput extends WorldJsonObject {
  readonly actionType: string
  readonly parameters: WorldJsonValue
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
    if (event.eventType === 'character.upsert' && typeof data.locationId === 'string') locationId = data.locationId
    if (event.eventType === 'character.moved' && typeof data.toLocationId === 'string') locationId = data.toLocationId
  }
  return locationId
}

/** Deterministic V0 Rulebook for player speech and movement. */
export class SpeakMoveRulebook {
  resolve(
    manifest: CompiledWorldManifest,
    events: readonly RulebookEvent[],
    characterId: string,
    action: PlayerActionInput,
  ): RulebookResolution {
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
