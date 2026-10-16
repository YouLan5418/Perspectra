import { compareWorldText, type CharacterId, type WorldJsonValue } from '@harness-world/contracts'
import { currentCharacterLifecycle, currentLocation, worldJsonObject, type RulebookEvent } from './rulebook.ts'

type SceneLifecycle = 'created' | 'active' | 'closed'
interface SceneState {
  readonly sceneId: string
  readonly participantIds: readonly CharacterId[]
  readonly lifecycle: SceneLifecycle
  readonly locationId: string | null
}
const compareText = compareWorldText

function sceneIdOf(event: RulebookEvent): { readonly sceneId: string; readonly data: Record<string, WorldJsonValue> } {
  const data = worldJsonObject(event.data)
  if (typeof data?.sceneId !== 'string') throw new TypeError(`${event.eventType} requires sceneId`)
  return { sceneId: data.sceneId, data }
}

function participantsOf(value: Record<string, WorldJsonValue> | undefined): readonly CharacterId[] {
  if (!Array.isArray(value?.participantIds)
    || value.participantIds.some(participantId => typeof participantId !== 'string')) {
    throw new TypeError('scene.upsert requires string participantIds')
  }
  return value.participantIds as CharacterId[]
}

function phase8ParticipantsOf(value: Record<string, WorldJsonValue>): readonly CharacterId[] {
  const participants = participantsOf(value)
  if (new Set(participants).size !== participants.length) throw new TypeError('scene participantIds must be unique')
  return [...participants].sort(compareText)
}

export function phase8SceneState(events: readonly RulebookEvent[]): readonly SceneState[] {
  const scenes = new Map<string, SceneState>()
  for (const event of events) {
    if (event.eventType === 'scene.upsert') {
      const { sceneId, data } = sceneIdOf(event)
      if (scenes.has(sceneId)) throw new TypeError(`Scene ${sceneId} cannot be redefined in Scene Decision v2`)
      const value = worldJsonObject(data.value as WorldJsonValue)
      if (value === undefined || (value.lifecycle !== 'created' && value.lifecycle !== 'active' && value.lifecycle !== 'closed')
        || (value.locationId !== null && typeof value.locationId !== 'string')) {
        throw new TypeError('Scene Decision v2 scene.upsert requires lifecycle and nullable locationId')
      }
      scenes.set(sceneId, {
        sceneId,
        participantIds: phase8ParticipantsOf(value),
        lifecycle: value.lifecycle,
        locationId: value.locationId,
      })
      continue
    }
    if (!event.eventType.startsWith('scene.')) continue
    const { sceneId, data } = sceneIdOf(event)
    if (event.eventType === 'scene.remove') throw new TypeError('scene.remove is unavailable in Scene Decision v2')
    if (event.eventType === 'scene.created') {
      if (scenes.has(sceneId) || (data.locationId !== null && typeof data.locationId !== 'string')) {
        throw new TypeError(`Scene ${sceneId} cannot be created from this prefix`)
      }
      scenes.set(sceneId, { sceneId, participantIds: [], lifecycle: 'created', locationId: data.locationId })
      continue
    }
    const scene = scenes.get(sceneId)
    if (scene === undefined) throw new TypeError(`Scene ${sceneId} is absent from the event prefix`)
    if (event.eventType === 'scene.activated') {
      if (scene.lifecycle !== 'created') throw new TypeError(`Scene ${sceneId} cannot be activated from ${scene.lifecycle}`)
      scenes.set(sceneId, { ...scene, lifecycle: 'active' })
      continue
    }
    if (event.eventType === 'scene.closed') {
      if (scene.lifecycle !== 'active') throw new TypeError(`Scene ${sceneId} cannot be closed from ${scene.lifecycle}`)
      scenes.set(sceneId, { ...scene, lifecycle: 'closed' })
      continue
    }
    if (event.eventType !== 'scene.member_joined' && event.eventType !== 'scene.member_left') continue
    if (scene.lifecycle === 'closed' || typeof data.characterId !== 'string') {
      throw new TypeError(`${event.eventType} is invalid for Scene ${sceneId}`)
    }
    const characterId = data.characterId as CharacterId
    const members = new Set(scene.participantIds)
    if (event.eventType === 'scene.member_joined') {
      if (members.has(characterId)) throw new TypeError(`${characterId} already belongs to Scene ${sceneId}`)
      members.add(characterId)
    } else {
      if (!members.delete(characterId)) throw new TypeError(`${characterId} does not belong to Scene ${sceneId}`)
    }
    scenes.set(sceneId, { ...scene, participantIds: [...members].sort(compareText) })
  }
  return [...scenes.values()].sort((left, right) => compareText(left.sceneId, right.sceneId))
}

export function hiddenObservers(events: readonly RulebookEvent[], sceneId: string): Set<string> {
  const visibility = new Map<string, boolean>()
  for (const event of events) {
    if (event.eventType !== 'visibility.upsert' && event.eventType !== 'visibility.remove') continue
    const data = worldJsonObject(event.data)
    if (typeof data?.id !== 'string') throw new TypeError(`${event.eventType} requires id`)
    if (event.eventType === 'visibility.remove') {
      visibility.delete(data.id)
      continue
    }
    const value = worldJsonObject(data.value as WorldJsonValue)
    if (typeof value?.observerId !== 'string' || typeof value.sceneId !== 'string' || typeof value.visible !== 'boolean') {
      throw new TypeError('visibility.upsert is malformed')
    }
    if (value.sceneId === sceneId) visibility.set(value.observerId, value.visible)
  }
  return new Set([...visibility].filter(([, visible]) => !visible).map(([observerId]) => observerId))
}

/** The same current audience eligibility serves speech adjudication and observation delivery. */
export function sceneObserverIds(events: readonly RulebookEvent[], scene: SceneState): readonly CharacterId[] {
  const hidden = hiddenObservers(events, scene.sceneId)
  return scene.participantIds.filter(characterId => !hidden.has(characterId)
    && currentCharacterLifecycle(events, characterId) === 'active'
    && (scene.locationId === null || currentLocation(events, characterId) === scene.locationId))
}
