import {
  brandId,
  deterministicId,
  type CharacterId,
  type InteractionRoundId,
  type OutboxDraft,
  type SessionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
import type { SceneDecisionService } from './scene-decision.ts'

/** Who may see an action in full, and who only learns that something private happened. */
export interface ActionAudience {
  readonly fullContentCharacterIds: readonly CharacterId[]
  readonly occurrenceOnlyCharacterIds: readonly CharacterId[]
}

/** A committed move as each witness may know it: the origin scene sees where from, the destination where to. */
export interface MovementRoute {
  readonly characterId: CharacterId
  readonly fromLocationId: string | null
  readonly toLocationId: string
  readonly departureObservers: ReadonlySet<CharacterId>
  readonly arrivalObservers: ReadonlySet<CharacterId>
}

export interface ActionObservationInput {
  readonly roundId: InteractionRoundId
  readonly actionId: string
  readonly actorId: CharacterId
  readonly actionType: string
  readonly status: 'accepted' | 'rejected'
  /** A skipped group step still reports `skipped` to full-content observers. */
  readonly skipped?: boolean
  readonly audience: ActionAudience
  readonly route?: MovementRoute
  /** Clauses every full-content observer receives, such as speech, interaction or relations. */
  readonly shared: WorldJsonObject
  /** Clauses whose wording or presence depends on who is observing. */
  readonly perObserver?: (observerId: CharacterId) => WorldJsonObject
  readonly playerBindings: readonly { readonly characterId: CharacterId; readonly sessionId: SessionId }[]
}

/**
 * Read the route each witness may learn from a committed move. `before` is the prefix the actor left from;
 * `after` already contains the move, so its scene is the one the actor arrived in.
 */
export function movementRoute(
  scene: SceneDecisionService,
  address: WorldAddress,
  moved: WorldEventDraft | undefined,
  before: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number },
  after: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number },
): MovementRoute | undefined {
  if (moved === undefined) return undefined
  const data = moved.data as {
    readonly characterId: CharacterId
    readonly fromLocationId: string | null
    readonly toLocationId: string
  }
  return {
    characterId: data.characterId,
    fromLocationId: data.fromLocationId,
    toLocationId: data.toLocationId,
    departureObservers: new Set(
      scene.decideFromEvents(address, data.characterId, before.events, before.asOfSeq).observerIds,
    ),
    arrivalObservers: new Set(
      scene.decideFromEvents(address, data.characterId, after.events, after.asOfSeq).observerIds,
    ),
  }
}

/**
 * Turn one adjudicated action and its audience into observation events and player deliveries. Both the
 * player and the character commit paths go through here, so what a witness learns cannot drift between them.
 */
export function actionObservations(input: ActionObservationInput): {
  readonly observerIds: readonly CharacterId[]
  readonly events: readonly WorldEventDraft[]
  readonly outbox: readonly OutboxDraft[]
} {
  const occurrenceOnly = new Set(input.audience.occurrenceOnlyCharacterIds)
  const events: WorldEventDraft[] = []
  const outbox: OutboxDraft[] = []
  const observerIds = [...new Set([...input.audience.fullContentCharacterIds, ...occurrenceOnly])]
  for (const observerId of observerIds) {
    const content: WorldJsonObject = occurrenceOnly.has(observerId)
      ? {
          actorId: input.actorId,
          actionType: 'private_interaction',
          status: input.status,
          contentVisibility: 'occurrence_only',
        }
      : {
          actorId: input.actorId,
          actionType: input.actionType,
          status: input.skipped === true ? 'skipped' : input.status,
          ...input.perObserver?.(observerId),
          ...input.shared,
          ...routeClause(input.route, observerId, input.actorId),
        }
    const observationId = deterministicId('observation:scene-result', {
      roundId: input.roundId,
      actionId: input.actionId,
      observerId,
    })
    const value = { observerId, actionId: input.actionId, content }
    events.push({ eventType: 'observation.upsert', eventVersion: 1, data: { id: observationId, value } })
    for (const binding of input.playerBindings.filter(entry => entry.characterId === observerId)) {
      outbox.push({
        deliveryId: brandId(
          deterministicId('delivery:scene-result', {
            roundId: input.roundId,
            observationId,
            sessionId: binding.sessionId,
          }),
          'DeliveryId',
        ),
        sessionId: binding.sessionId,
        payload: { observationId, value },
        critical: true,
      })
    }
  }
  return { observerIds, events, outbox }
}

function routeClause(route: MovementRoute | undefined, observerId: CharacterId, actorId: CharacterId): WorldJsonObject {
  if (route === undefined) return {}
  const seesDeparture = observerId === actorId || route.departureObservers.has(observerId)
  const seesArrival = observerId === actorId || route.arrivalObservers.has(observerId)
  if (!seesDeparture && !seesArrival) return {}
  return {
    movement: {
      characterId: route.characterId,
      ...(seesDeparture ? { fromLocationId: route.fromLocationId } : {}),
      ...(seesArrival ? { toLocationId: route.toLocationId } : {}),
    },
  }
}
