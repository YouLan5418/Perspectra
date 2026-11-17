import { compareWorldText } from '@perspectra/sdk/contracts'
import { worldJsonObject, type RulebookEvent } from './rulebook.ts'

export interface SceneState {
  readonly sceneId: string
  readonly lifecycle: 'created' | 'active' | 'closed'
  readonly participantIds: readonly string[]
}

/**
 * The frozen Scene facts of one Event prefix, read by the current interaction path.
 */
export function currentSceneStates(events: readonly RulebookEvent[]): readonly SceneState[] {
  return currentScenes(events)
}

function currentScenes(events: readonly RulebookEvent[]): readonly SceneState[] {
  const scenes = new Map<string, SceneState>()
  for (const event of events) {
    if (event.eventType === 'scene.upsert') {
      const data = worldJsonObject(event.data)
      const value = data?.value === undefined ? undefined : worldJsonObject(data.value)
      if (
        typeof data?.sceneId !== 'string' ||
        value === undefined ||
        (value.lifecycle !== 'created' && value.lifecycle !== 'active' && value.lifecycle !== 'closed') ||
        !Array.isArray(value.participantIds) ||
        value.participantIds.some(id => typeof id !== 'string') ||
        new Set(value.participantIds).size !== value.participantIds.length ||
        scenes.has(data.sceneId)
      ) {
        throw new TypeError('scene prefix is malformed')
      }
      scenes.set(data.sceneId, {
        sceneId: data.sceneId,
        lifecycle: value.lifecycle,
        participantIds: value.participantIds as string[],
      })
      continue
    }
    if (!event.eventType.startsWith('scene.')) continue
    if (event.eventType === 'scene.remove') throw new TypeError('scene.remove is not valid in an active Scene prefix')
    const data = worldJsonObject(event.data)
    if (typeof data?.sceneId !== 'string') throw new TypeError('scene prefix is malformed')
    if (event.eventType === 'scene.created') {
      if (scenes.has(data.sceneId)) throw new TypeError('scene prefix is malformed')
      scenes.set(data.sceneId, { sceneId: data.sceneId, lifecycle: 'created', participantIds: [] })
      continue
    }
    const scene = scenes.get(data.sceneId)
    if (scene === undefined) throw new TypeError('scene prefix is malformed')
    if (event.eventType === 'scene.activated') {
      if (scene.lifecycle !== 'created') throw new TypeError('scene prefix is malformed')
      scenes.set(data.sceneId, { ...scene, lifecycle: 'active' })
      continue
    }
    if (event.eventType === 'scene.closed') {
      if (scene.lifecycle !== 'active') throw new TypeError('scene prefix is malformed')
      scenes.set(data.sceneId, { ...scene, lifecycle: 'closed' })
      continue
    }
    if (event.eventType !== 'scene.member_joined' && event.eventType !== 'scene.member_left') continue
    if (scene.lifecycle === 'closed' || typeof data.characterId !== 'string')
      throw new TypeError('scene prefix is malformed')
    const members = new Set(scene.participantIds)
    if (event.eventType === 'scene.member_joined' ? members.has(data.characterId) : !members.has(data.characterId)) {
      throw new TypeError('scene membership prefix is malformed')
    }
    if (event.eventType === 'scene.member_joined') members.add(data.characterId)
    else members.delete(data.characterId)
    scenes.set(data.sceneId, { ...scene, participantIds: [...members].sort(compareWorldText) })
  }
  return [...scenes.values()]
}
