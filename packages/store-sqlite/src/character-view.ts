import {
  hashWorldJson,
  type CharacterId,
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

function object(value: WorldJsonValue): WorldJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as WorldJsonObject : undefined
}

function owned(record: ProjectionRecord, characterId: CharacterId, ownerKey: 'observerId' | 'characterId'): boolean {
  return object(record.value)?.[ownerKey] === characterId
}

function sceneChanges(events: readonly StoredWorldEvent[]): Map<string, CharacterSceneView> {
  const scenes = new Map<string, CharacterSceneView>()
  for (const event of events) {
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

function selfState(events: readonly StoredWorldEvent[], characterId: CharacterId): {
  readonly locationId: string | null
  readonly observations: SelfObservationView[]
} {
  let locationId: string | null = null
  const observations: SelfObservationView[] = []
  for (const event of events) {
    const data = object(event.data)
    if (data?.characterId !== characterId) continue
    if (event.eventType === 'character.upsert' && typeof data.locationId === 'string') locationId = data.locationId
    if (event.eventType === 'character.moved' && typeof data.toLocationId === 'string') {
      locationId = data.toLocationId
      observations.push({ observationId: `self:${event.seq}`, sourceSeq: event.seq, content: { actionType: 'move', locationId } })
    }
    if (event.eventType === 'character.speak' && typeof data.text === 'string') {
      observations.push({ observationId: `self:${event.seq}`, sourceSeq: event.seq, content: { actionType: 'speak', text: data.text } })
    }
    if (event.eventType === 'action.rejected' && typeof data.actionType === 'string') {
      observations.push({ observationId: `self:${event.seq}`, sourceSeq: event.seq, content: { actionType: data.actionType, status: 'rejected' } })
    }
  }
  return { locationId, observations }
}

/** Builds the model-visible, character-scoped view from one exact event prefix. */
export class CharacterViewBuilder {
  constructor(private readonly worldStore: WorldStore) {}

  rebuildAt(address: WorldAddress, characterId: CharacterId, asOfWorldSeq: number): CharacterView {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    const events = this.worldStore.readEvents(address, asOfWorldSeq)
    const projections = new ProjectionRebuilder(this.worldStore).rebuildAt(address, asOfWorldSeq)
    const observations = projections.observations.filter(record => owned(record, characterId, 'observerId'))
    const claims = projections.claims.filter(record => owned(record, characterId, 'characterId'))
    const goals = projections.goals.filter(record => owned(record, characterId, 'characterId'))
    const visibility = projections.visibility.filter(record => owned(record, characterId, 'observerId'))
    const scenes = [...sceneChanges(events).values()]
      .filter(scene => visibleScene(scene, characterId, visibility))
      .sort((left, right) => left.sceneId.localeCompare(right.sceneId))
    const self = selfState(events, characterId)
    const base = {
      address,
      characterId,
      asOfWorldSeq,
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
