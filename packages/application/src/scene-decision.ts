import {
  compareWorldText,
  failWorld,
  hashWorldJson,
  type CharacterId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  currentSceneDecisionStates,
  sceneObserverIds,
  type RulebookEvent,
} from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'
import { SCHEDULABLE_AVAILABILITY_STATES } from './runtime-availability.ts'

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
  readonly schemaVersion: 'scene-decision/v2'
  readonly memberIds: readonly CharacterId[]
  readonly directorEligible: boolean
  readonly decisionHash: WorldHash
}

function sortedUnique(values: readonly CharacterId[]): readonly CharacterId[] {
  return [...new Set(values)].sort(compareWorldText)
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

  /**
   * Derive the durable Scene membership changes for a generic move. A Location-bound Scene is
   * selected only when the target Location identifies at most one non-closed Scene; Location
   * itself never becomes a second Scene state source.
   */
  transitionForMove(
    address: WorldAddress,
    events: readonly RulebookEvent[],
    characterId: CharacterId,
    targetLocationId: string,
    asOfSeq: number,
  ): readonly WorldEventDraft[] {
    try {
      const scenes = currentSceneDecisionStates(events)
      const sources = scenes.filter(scene => scene.lifecycle === 'active' && scene.participantIds.includes(characterId))
      if (sources.length > 1) throw new TypeError(`${characterId} belongs to multiple active Scenes before move`)
      const destinations = scenes.filter(scene => scene.lifecycle !== 'closed' && scene.locationId === targetLocationId)
      if (destinations.length > 1) throw new TypeError(`Location ${targetLocationId} maps to multiple open Scenes`)
      const source = sources[0]
      const destination = destinations[0]
      if (source?.sceneId === destination?.sceneId) return []
      const transitions: WorldEventDraft[] = []
      if (source !== undefined) {
        transitions.push({
          eventType: 'scene.member_left', eventVersion: 1,
          data: { sceneId: source.sceneId, characterId },
        })
        // Fixed rooms remain available for a later visit, even when empty.
        if (source.participantIds.length === 1 && source.locationId === null) {
          transitions.push({ eventType: 'scene.closed', eventVersion: 1, data: { sceneId: source.sceneId } })
        }
      }
      if (destination !== undefined) {
        if (destination.lifecycle === 'created') {
          transitions.push({ eventType: 'scene.activated', eventVersion: 1, data: { sceneId: destination.sceneId } })
        }
        if (!destination.participantIds.includes(characterId)) {
          transitions.push({
            eventType: 'scene.member_joined', eventVersion: 1,
            data: { sceneId: destination.sceneId, characterId },
          })
        }
      }
      return transitions
    } catch (error: unknown) {
      failWorld({
        errorCode: 'PROJECTION_INVARIANT_FAILED', category: 'integrity',
        message: `Scene move transition is malformed: ${String(error)}`, retryable: false,
        correlationId: `scene-move:${characterId}:${asOfSeq}`, address,
        details: { characterId, targetLocationId, asOfSeq },
      })
    }
  }

  decideFromEvents(
    address: WorldAddress,
    player: CharacterId,
    events: readonly RulebookEvent[],
    asOfSeq: number,
  ): SceneDecision {
    try {
      return this.#decide(address, player, events, asOfSeq)
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

  #decide(address: WorldAddress, player: CharacterId, events: readonly RulebookEvent[], asOfSeq: number): SceneDecision {
    const scenes = currentSceneDecisionStates(events)
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
        details: { characterId: overlap[0], asOfSeq, sceneIds: overlap[1].sort(compareWorldText) },
      })
    }
    const sceneId = membership.get(player)?.[0]
    const scene = sceneId === undefined ? undefined : scenes.find(value => value.sceneId === sceneId)!
    const observerIds = scene === undefined ? [] : sceneObserverIds(events, scene)
    const schedulableCharacterIds = observerIds.filter(characterId => {
      const state = this.availability.get(address, characterId)?.state
      return characterId !== player && state !== undefined && SCHEDULABLE_AVAILABILITY_STATES.includes(state)
    })
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
