import {
  failWorld,
  hashWorldJson,
  type CharacterId,
  type WorldAddress,
  type WorldHash,
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

export type SceneDecisionVersion = 1 | 2
export type SceneObservationScope = 'scene_public' | 'direct' | 'private' | 'self'

export interface SceneObservationPolicy extends WorldJsonObject {
  readonly scope: SceneObservationScope
  readonly recipientIds?: readonly CharacterId[]
}

export interface SceneActionAudience extends WorldJsonObject {
  readonly fullContentCharacterIds: readonly CharacterId[]
  readonly occurrenceOnlyCharacterIds: readonly CharacterId[]
}

export interface SceneDecision extends WorldJsonObject {
  readonly sceneId: string | null
  readonly observerIds: readonly CharacterId[]
  readonly schedulableCharacterIds: readonly CharacterId[]
  readonly visibleResultCharacterIds: readonly CharacterId[]
  readonly asOfSeq: number
  readonly schemaVersion?: 'scene-decision/v2'
  readonly memberIds?: readonly CharacterId[]
  readonly directorEligible?: boolean
  readonly decisionHash?: WorldHash
}

type SceneLifecycle = 'created' | 'active' | 'closed'

interface SceneState {
  readonly sceneId: string
  readonly participantIds: readonly CharacterId[]
  readonly lifecycle: SceneLifecycle
  readonly locationId: string | null
}

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

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

function legacySceneState(events: readonly RulebookEvent[]): readonly SceneState[] {
  const scenes = new Map<string, SceneState>()
  for (const event of events) {
    if (event.eventType !== 'scene.upsert' && event.eventType !== 'scene.remove') continue
    const { sceneId } = sceneIdOf(event)
    if (event.eventType === 'scene.remove') {
      scenes.delete(sceneId)
      continue
    }
    const data = worldJsonObject(event.data)!
    const value = worldJsonObject(data.value as WorldJsonValue)
    scenes.set(sceneId, { sceneId, participantIds: participantsOf(value), lifecycle: 'active', locationId: null })
  }
  return [...scenes.values()].sort((left, right) => left.sceneId.localeCompare(right.sceneId))
}

function phase8SceneState(events: readonly RulebookEvent[]): readonly SceneState[] {
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

function sortedUnique(values: readonly CharacterId[]): readonly CharacterId[] {
  return [...new Set(values)].sort(compareText)
}

/** Authoritative scene selection derived only from an exact durable Event prefix plus runtime availability. */
export class SceneDecisionService {
  constructor(
    private readonly store: WorldStore,
    private readonly availability: CharacterRuntimeAvailabilityService,
    readonly version: SceneDecisionVersion = 1,
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
    if (this.version === 1) return this.#legacyDecision(address, player, events, asOfSeq)
    try {
      return this.#phase8Decision(address, player, events, asOfSeq)
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        failWorld({
          errorCode: 'PROJECTION_INVARIANT_FAILED', category: 'integrity',
          message: `Scene projection is malformed: ${error.message}`, retryable: false,
          correlationId: `scene-decision:${player}:${asOfSeq}`, address,
          details: { player, asOfSeq },
        })
      }
      throw error
    }
  }

  audienceForAction(
    address: WorldAddress,
    actorId: CharacterId,
    events: readonly RulebookEvent[],
    asOfSeq: number,
    policy: SceneObservationPolicy = { scope: 'scene_public' },
  ): SceneActionAudience {
    if (this.version !== 2) throw new TypeError('action-scoped Scene audiences require Scene Decision v2')
    const recipients = policy.recipientIds ?? []
    if (!Array.isArray(recipients) || recipients.some(value => typeof value !== 'string')
      || new Set(recipients).size !== recipients.length
      || ((policy.scope === 'direct' || policy.scope === 'private') && recipients.length === 0)
      || ((policy.scope === 'scene_public' || policy.scope === 'self') && recipients.length !== 0)) {
      throw new TypeError('Scene observation policy is malformed')
    }
    const decision = this.decideFromEvents(address, actorId, events, asOfSeq)
    const present = new Set(decision.observerIds)
    const direct = recipients.filter(characterId => present.has(characterId))
    const full = policy.scope === 'scene_public'
      ? sortedUnique([...decision.observerIds, actorId])
      : policy.scope === 'self'
      ? [actorId]
      : sortedUnique([actorId, ...direct])
    const occurrence = policy.scope === 'private'
      ? decision.observerIds.filter(characterId => !full.includes(characterId))
      : []
    return { fullContentCharacterIds: full, occurrenceOnlyCharacterIds: occurrence }
  }

  #legacyDecision(address: WorldAddress, player: CharacterId, events: readonly RulebookEvent[], asOfSeq: number): SceneDecision {
    const active = legacySceneState(events).filter(scene => scene.participantIds.includes(player))
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
      characterId !== player && ['ready', 'provider_output_invalid']
        .includes(this.availability.get(address, characterId)?.state ?? ''))
    return {
      sceneId: scene.sceneId,
      observerIds,
      schedulableCharacterIds,
      visibleResultCharacterIds: observerIds,
      asOfSeq,
    }
  }

  #phase8Decision(address: WorldAddress, player: CharacterId, events: readonly RulebookEvent[], asOfSeq: number): SceneDecision {
    const scenes = phase8SceneState(events)
    const membership = new Map<CharacterId, string[]>()
    for (const scene of scenes.filter(value => value.lifecycle === 'active')) {
      for (const characterId of scene.participantIds) {
        const current = membership.get(characterId) ?? []
        current.push(scene.sceneId)
        membership.set(characterId, current)
      }
    }
    const overlap = [...membership].find(([, sceneIds]) => sceneIds.length > 1)
    if (overlap !== undefined) {
      failWorld({
        errorCode: 'SCENE_MEMBERSHIP_INVARIANT', category: 'integrity',
        message: `character ${overlap[0]} belongs to multiple active Scenes`, retryable: false,
        correlationId: `scene-membership:${overlap[0]}:${asOfSeq}`, address,
        details: { characterId: overlap[0], asOfSeq, sceneIds: overlap[1].sort(compareText) },
      })
    }
    const sceneId = membership.get(player)?.[0]
    const scene = sceneId === undefined ? undefined : scenes.find(value => value.sceneId === sceneId)!
    const hidden = scene === undefined ? new Set<string>() : hiddenObservers(events, scene.sceneId)
    const observerIds = scene === undefined ? [] : scene.participantIds.filter(characterId =>
      !hidden.has(characterId)
      && currentCharacterLifecycle(events, characterId) === 'active'
      && (scene.locationId === null || currentLocation(events, characterId) === scene.locationId))
    const schedulableCharacterIds = observerIds.filter(characterId =>
      characterId !== player && ['ready', 'provider_output_invalid']
        .includes(this.availability.get(address, characterId)?.state ?? ''))
    const semantic = {
      schemaVersion: 'scene-decision/v2' as const,
      sceneId: scene?.sceneId ?? null,
      memberIds: scene?.participantIds ?? [],
      observerIds,
      schedulableCharacterIds,
      visibleResultCharacterIds: observerIds,
      directorEligible: scene !== undefined,
      asOfSeq,
    }
    return { ...semantic, decisionHash: hashWorldJson('scene-decision/v2', semantic) }
  }
}
