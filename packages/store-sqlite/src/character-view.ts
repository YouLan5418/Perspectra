import { parseExpressionSegments } from '@harness-world/contracts'
import {
  compareWorldText,
  hashWorldJson,
  type CharacterId,
  type CharacterLifecycleState,
  type CharacterSceneView,
  type CharacterView,
  type ProjectionRecord,
  type SelfObservationView,
  type StoredWorldEvent,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { ProjectionRebuilder } from './projection.ts'
import type { WorldStore } from './world-store.ts'

const CHARACTER_VIEW_EVENT_TYPES = [
  'action.rejected',
  'character.created',
  'character.lifecycle-changed',
  'character.moved',
  'character.speak',
  'character.upsert',
  'claim.upsert',
  'goal.upsert',
  'observation.upsert',
  'scene.remove',
  'scene.upsert',
  'visibility.upsert',
] as const

function object(value: WorldJsonValue): WorldJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as WorldJsonObject : undefined
}

function owned(record: ProjectionRecord, characterId: CharacterId, ownerKey: 'observerId' | 'characterId'): boolean {
  return object(record.value)?.[ownerKey] === characterId
}

function sceneChanges(events: readonly StoredWorldEvent[], heartbeat?: () => void): Map<string, CharacterSceneView> {
  const scenes = new Map<string, CharacterSceneView>()
  for (const [index, event] of events.entries()) {
    if (index % 128 === 0) heartbeat?.()
    if (event.eventType !== 'scene.upsert' && event.eventType !== 'scene.remove') continue
    const data = object(event.data)
    if (data === undefined || typeof data.sceneId !== 'string') throw new Error(`${event.eventType} requires sceneId`)
    const sceneId = data.sceneId
    if (event.eventType === 'scene.remove') {
      scenes.delete(sceneId)
      continue
    }
    if (data.value === undefined) throw new Error('scene.upsert requires value')
    scenes.set(sceneId, { sceneId, value: data.value, sourceSeq: event.seq })
  }
  return scenes
}

function visibleScene(scene: CharacterSceneView, characterId: CharacterId, visibility: readonly ProjectionRecord[]): boolean {
  const participants = object(scene.value)?.participantIds
  if (!Array.isArray(participants) || !participants.includes(characterId)) return false
  const explicit = visibility.find((record) => {
    const value = object(record.value)
    return value?.observerId === characterId && value.sceneId === scene.sceneId
  })
  return explicit === undefined || object(explicit.value)?.visible === true
}

function selfState(events: readonly StoredWorldEvent[], characterId: CharacterId, heartbeat?: () => void): {
  readonly locationId: string | null
  readonly lifecycleState: CharacterLifecycleState
  readonly observations: SelfObservationView[]
} {
  let locationId: string | null = null
  let lifecycleState: CharacterLifecycleState | undefined
  const observations: SelfObservationView[] = []
  for (const [index, event] of events.entries()) {
    if (index % 128 === 0) heartbeat?.()
    const data = object(event.data)
    const projected = data?.value === undefined ? undefined : object(data.value)
    const projectedOwner = projected?.characterId ?? projected?.observerId
    // Pre-lifecycle V0 fixtures are upcast as active without rewriting their stored event bytes.
    if (data?.characterId === characterId || projectedOwner === characterId) lifecycleState ??= 'active'
    if (data?.characterId !== characterId) continue
    if ((event.eventType === 'character.upsert' || event.eventType === 'character.created') && typeof data.locationId === 'string') locationId = data.locationId
    if (event.eventType === 'character.lifecycle-changed'
      && (data.lifecycleState === 'active' || data.lifecycleState === 'incapacitated'
        || data.lifecycleState === 'dead' || data.lifecycleState === 'departed')) lifecycleState = data.lifecycleState
    if (event.eventType === 'character.moved' && typeof data.toLocationId === 'string') {
      locationId = data.toLocationId
      observations.push({ observationId: `self:${event.seq}`, sourceSeq: event.seq, content: { actionType: 'move', locationId } })
    }
    if (event.eventType === 'character.speak' && (typeof data.text === 'string' || data.segments !== undefined)) {
      observations.push({ observationId: `self:${event.seq}`, sourceSeq: event.seq, content: { actionType: 'speak', ...(typeof data.medium === 'string' ? { medium: data.medium, addresseeIds: data.addresseeIds ?? [] } : {}), ...(typeof data.text === 'string' ? { text: data.text } : {}),
        ...(typeof data.narration === 'string' ? { narration: data.narration } : {}),
        ...(data.segments === undefined ? {} : { segments: parseExpressionSegments(data.segments) }) } })
    }
    if (event.eventType === 'action.rejected' && typeof data.actionType === 'string') {
      observations.push({ observationId: `self:${event.seq}`, sourceSeq: event.seq, content: { actionType: data.actionType, status: 'rejected' } })
    }
  }
  if (lifecycleState === undefined) throw new Error(`character ${characterId} has no creation event at the requested prefix`)
  return { locationId, lifecycleState, observations }
}

/** Builds the model-visible, character-scoped view from one exact event prefix. */
export class CharacterViewBuilder {
  constructor(private readonly worldStore: WorldStore) {}

  rebuildAt(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number, heartbeat?: () => void): CharacterView {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    const head = this.worldStore.head(address)
    if (asOfWorldSeq > head.headSeq) throw new RangeError('asOfWorldSeq cannot be later than the branch head')
    const events = this.worldStore.readEventsRange(address, 0, asOfWorldSeq, CHARACTER_VIEW_EVENT_TYPES)
    heartbeat?.()
    const projections = new ProjectionRebuilder(this.worldStore).rebuildAt(address, asOfWorldSeq, heartbeat)
    const observations = projections.observations.filter(record => owned(record, characterId, 'observerId'))
    const claims = projections.claims.filter(record => owned(record, characterId, 'characterId'))
    const goals = projections.goals.filter(record => owned(record, characterId, 'characterId'))
    const visibility = projections.visibility.filter(record => owned(record, characterId, 'observerId'))
    const scenes = [...sceneChanges(events, heartbeat).values()]
      .filter(scene => visibleScene(scene, characterId, visibility))
      .sort((left, right) => compareWorldText(left.sceneId, right.sceneId))
    const self = selfState(events, characterId, heartbeat)
    const base = {
      address,
      characterId,
      asOfWorldSeq,
      lifecycleState: self.lifecycleState,
      locationId: self.locationId,
      scenes,
      observations,
      selfObservations: self.observations,
      claims,
      goals,
      visibility,
    }
    return { ...base, bundleHash: hashWorldJson('world-character-view', base) }
  }
}
