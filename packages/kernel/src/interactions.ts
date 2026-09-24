import { compareWorldText, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { worldJsonObject, type RulebookEvent } from './rulebook.ts'
export interface CharacterRelationState extends WorldJsonObject {
  readonly relationId: string
  readonly relationKind: 'hand_hold'
  readonly initiatorId: string
  readonly targetId: string
  readonly interactionId: string
  readonly sourceActionId: string
  readonly active: boolean
}

function exact(object: WorldJsonObject, keys: readonly string[]): boolean {
  return Object.keys(object).sort(compareWorldText).join(',') === [...keys].sort(compareWorldText).join(',')
}

function text(input: WorldJsonValue | undefined): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 128 && input.trim() === input
}

function relationData(event: RulebookEvent, path: string): WorldJsonObject {
  const data = worldJsonObject(event.data)
  if (data === undefined) throw new TypeError(`${path} data must be an object`)
  return data
}

/** Rebuild current hand-hold state from the exact Event prefix; malformed transitions fail closed. */
export function currentCharacterRelations(events: readonly RulebookEvent[]): readonly CharacterRelationState[] {
  const relations = new Map<string, CharacterRelationState>()
  for (const [index, event] of events.entries()) {
    if (event.eventType === 'character.relation-started') {
      const data = relationData(event, `events[${index}]`)
      if (!exact(data, ['relationId', 'relationKind', 'initiatorId', 'targetId', 'interactionId', 'sourceActionId'])
        || event.eventVersion !== 1 || !text(data.relationId) || !data.relationId.startsWith('relation:')
        || data.relationKind !== 'hand_hold' || !text(data.initiatorId) || !text(data.targetId)
        || data.initiatorId === data.targetId || !text(data.interactionId) || !text(data.sourceActionId)
        || relations.has(data.relationId)) throw new TypeError('character relation start prefix is malformed')
      const duplicatePair = [...relations.values()].some(relation => relation.active
        && ((relation.initiatorId === data.initiatorId && relation.targetId === data.targetId)
          || (relation.initiatorId === data.targetId && relation.targetId === data.initiatorId)))
      if (duplicatePair) throw new TypeError('character relation prefix contains a duplicate active pair')
      relations.set(data.relationId, {
        relationId: data.relationId,
        relationKind: 'hand_hold',
        initiatorId: data.initiatorId,
        targetId: data.targetId,
        interactionId: data.interactionId,
        sourceActionId: data.sourceActionId,
        active: true,
      })
    }
    if (event.eventType === 'character.relation-ended') {
      const data = relationData(event, `events[${index}]`)
      if (!exact(data, ['relationId', 'endedByCharacterId', 'reason']) || event.eventVersion !== 1
        || !text(data.relationId) || !text(data.endedByCharacterId)
        || (data.reason !== 'released' && data.reason !== 'participant_moved' && data.reason !== 'participant_unavailable')) {
        throw new TypeError('character relation end prefix is malformed')
      }
      const relation = relations.get(data.relationId)
      if (relation === undefined || !relation.active
        || (data.endedByCharacterId !== relation.initiatorId && data.endedByCharacterId !== relation.targetId)) {
        throw new TypeError('character relation end violates the relation prefix')
      }
      relations.set(data.relationId, { ...relation, active: false })
    }
  }
  return [...relations.values()].sort((left, right) => compareWorldText(left.relationId, right.relationId))
}

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
      if (typeof data?.sceneId !== 'string' || value === undefined
        || (value.lifecycle !== 'created' && value.lifecycle !== 'active' && value.lifecycle !== 'closed')
        || !Array.isArray(value.participantIds) || value.participantIds.some(id => typeof id !== 'string')
        || new Set(value.participantIds).size !== value.participantIds.length || scenes.has(data.sceneId)) {
        throw new TypeError('scene prefix is malformed')
      }
      scenes.set(data.sceneId, { sceneId: data.sceneId, lifecycle: value.lifecycle, participantIds: value.participantIds as string[] })
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
    if (scene.lifecycle === 'closed' || typeof data.characterId !== 'string') throw new TypeError('scene prefix is malformed')
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

export function characterRelationObservations(
  prefix: readonly RulebookEvent[],
  resolved: readonly RulebookEvent[],
): readonly WorldJsonObject[] {
  const relations = currentCharacterRelations([...prefix, ...resolved])
  return resolved.filter(event => event.eventType === 'character.relation-started' || event.eventType === 'character.relation-ended')
    .map(event => {
      const data = worldJsonObject(event.data)!
      const relation = relations.find(value => value.relationId === data.relationId)!
      return {
        relationKind: relation.relationKind,
        initiatorId: relation.initiatorId,
        targetId: relation.targetId,
        status: event.eventType === 'character.relation-started' ? 'started' : 'ended',
        ...(event.eventType === 'character.relation-ended' ? { reason: data.reason! } : {}),
      }
    })
}
