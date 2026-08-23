import {
  failWorld,
  type CharacterId,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  currentCharacterLifecycle,
  currentLocation,
  worldJsonObject,
  type RulebookEvent,
} from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'

export interface SceneDecision extends WorldJsonObject {
  readonly sceneId: string
  readonly observerIds: readonly CharacterId[]
  readonly schedulableCharacterIds: readonly CharacterId[]
  readonly visibleResultCharacterIds: readonly CharacterId[]
  readonly asOfSeq: number
}

interface SceneState {
  readonly sceneId: string
  readonly participantIds: readonly CharacterId[]
}

function sceneState(events: readonly RulebookEvent[]): readonly SceneState[] {
  const scenes = new Map<string, SceneState>()
  for (const event of events) {
    if (event.eventType !== 'scene.upsert' && event.eventType !== 'scene.remove') continue
    const data = worldJsonObject(event.data)
    if (typeof data?.sceneId !== 'string') throw new TypeError(`${event.eventType} requires sceneId`)
    if (event.eventType === 'scene.remove') {
      scenes.delete(data.sceneId)
      continue
    }
    const value = worldJsonObject(data.value as WorldJsonValue)
    if (!Array.isArray(value?.participantIds)
      || value.participantIds.some(participantId => typeof participantId !== 'string')) {
      throw new TypeError('scene.upsert requires string participantIds')
    }
    scenes.set(data.sceneId, { sceneId: data.sceneId, participantIds: value.participantIds as CharacterId[] })
  }
  return [...scenes.values()].sort((left, right) => left.sceneId.localeCompare(right.sceneId))
}

function hiddenObservers(events: readonly RulebookEvent[], sceneId: string): Set<string> {
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

/** Authoritative scene selection derived only from an exact durable Event prefix plus runtime availability. */
export class SceneDecisionService {
  constructor(
    private readonly store: WorldStore,
    private readonly availability: CharacterRuntimeAvailabilityService,
  ) {}

  decide(address: WorldAddress, player: CharacterId, asOfSeq: number): SceneDecision {
    return this.decideFromEvents(address, player, this.store.readEvents(address, asOfSeq), asOfSeq)
  }

  decideFromEvents(
    address: WorldAddress,
    player: CharacterId,
    events: readonly RulebookEvent[],
    asOfSeq: number,
  ): SceneDecision {
    const active = sceneState(events).filter(scene => scene.participantIds.includes(player))
    if (active.length !== 1) {
      failWorld({
        errorCode: 'PROJECTION_INVARIANT_FAILED', category: 'integrity',
        message: `player must belong to exactly one active Scene; found ${active.length}`,
        retryable: false, correlationId: `scene-decision:${player}:${asOfSeq}`, address,
        details: { player, asOfSeq, sceneIds: active.map(scene => scene.sceneId) },
      })
    }
    const scene = active[0]!
    const hidden = hiddenObservers(events, scene.sceneId)
    const playerLocation = currentLocation(events, player)
    const observerIds = scene.participantIds.filter(characterId =>
      !hidden.has(characterId)
      && currentCharacterLifecycle(events, characterId) === 'active'
      && currentLocation(events, characterId) === playerLocation)
    const schedulableCharacterIds = observerIds.filter(characterId =>
      characterId !== player && this.availability.get(address, characterId)?.state === 'ready')
    return {
      sceneId: scene.sceneId,
      observerIds,
      schedulableCharacterIds,
      visibleResultCharacterIds: observerIds,
      asOfSeq,
    }
  }
}
