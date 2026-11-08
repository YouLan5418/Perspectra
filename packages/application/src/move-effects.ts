import type {
  CharacterId,
  InteractionRoundId,
  OutboxDraft,
  SessionId,
  WorldAddress,
  WorldEventDraft,
} from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
import { actionObservations, type MovementRoute } from './action-observations.ts'
import type { SceneDecisionService } from './scene-decision.ts'
import { activityObject as object } from './activity-state.ts'

export interface MovedCharacter {
  readonly characterId: CharacterId
  readonly fromLocationId: string | null
  readonly toLocationId: string
}

/** The scene changes of every `character.moved` in one resolution, in order. Each mover's transition reads the ones
 * before it, so a rule that brings a follower along joins the scene the leader just opened instead of opening it
 * again. A resolution that moves only its actor gives exactly that actor's transition. */
export function moveEffects(input: {
  readonly scene: SceneDecisionService
  readonly address: WorldAddress
  readonly events: readonly RulebookEvent[]
  readonly headSeq: number
  readonly drafts: readonly WorldEventDraft[]
}): { transitions: WorldEventDraft[]; moved: MovedCharacter[] } {
  const transitions: WorldEventDraft[] = []
  const moved: MovedCharacter[] = []
  for (const draft of input.drafts) {
    if (draft.eventType !== 'character.moved') continue
    const data = draft.data as Partial<Record<keyof MovedCharacter, unknown>> | null
    if (typeof data?.characterId !== 'string' || typeof data.toLocationId !== 'string')
      throw new TypeError('character.moved needs a characterId and a toLocationId string')
    if (data.fromLocationId !== null && typeof data.fromLocationId !== 'string')
      throw new TypeError('character.moved needs a fromLocationId string or null')
    const characterId = data.characterId as CharacterId
    moved.push({ characterId, fromLocationId: data.fromLocationId, toLocationId: data.toLocationId })
    transitions.push(
      ...input.scene.transitionForMove(
        input.address,
        [...input.events, ...(transitions as RulebookEvent[])],
        characterId,
        data.toLocationId,
        input.headSeq,
      ),
    )
  }
  return { transitions, moved }
}

/** Who a move's result walks along with the mover, such as a party a rules layer brings: every other
 * `character.moved` from where she stood to where she went. Empty when the result does not move her. */
export function movedAlongWith(events: readonly { eventType: string; data: unknown }[], moverId: string): string[] {
  const moves = events.filter(e => e.eventType === 'character.moved').map(e => object(e.data))
  const own = moves.find(m => m.characterId === moverId)
  if (!own) return []
  return moves
    .filter(
      m => m.characterId !== moverId && m.fromLocationId === own.fromLocationId && m.toLocationId === own.toLocationId,
    )
    .map(m => String(m.characterId))
}

/** What witnesses learn of the characters an action moved besides its actor, such as a follower: those she left see
 * her go, those where she arrives see her come, and she knows her whole route. Each record is about her alone, with
 * herself as its subject and `moved` as its kind: those at a far end did not see the action that moved her, and the
 * actor learns of either end only by being there. The actor's own move stays in the action's observation. `before` is
 * the prefix the action started from; `after` already holds every move and its scene changes. */
export function otherMoverObservations(input: {
  readonly scene: SceneDecisionService
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly actionId: string
  /** Undefined when no action record carries anyone's move, as for an activity operation the host commits. */
  readonly actorId: CharacterId | undefined
  readonly moved: readonly MovedCharacter[]
  readonly before: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number }
  readonly after: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number }
  readonly playerBindings: readonly { readonly characterId: CharacterId; readonly sessionId: SessionId }[]
  readonly observationId: (moverId: CharacterId, observerId: CharacterId) => string
}): { observerIds: CharacterId[]; events: WorldEventDraft[]; outbox: OutboxDraft[] } {
  const observerIds: CharacterId[] = [],
    events: WorldEventDraft[] = [],
    outbox: OutboxDraft[] = []
  const observers = (
    characterId: CharacterId,
    at: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number },
  ) => new Set(input.scene.decideFromEvents(input.address, characterId, at.events, at.asOfSeq).observerIds)
  for (const mover of input.moved) {
    if (mover.characterId === input.actorId) continue
    const route: MovementRoute = {
      ...mover,
      departureObservers: observers(mover.characterId, input.before),
      arrivalObservers: observers(mover.characterId, input.after),
    }
    // The mover is the record's subject, so the full-route shortcut is hers, never the actor's.
    const observed = actionObservations({
      roundId: input.roundId,
      actionId: input.actionId,
      actorId: mover.characterId,
      actionType: 'moved',
      status: 'accepted',
      audience: {
        fullContentCharacterIds: [
          ...new Set([...route.departureObservers, ...route.arrivalObservers, mover.characterId]),
        ],
        occurrenceOnlyCharacterIds: [],
      },
      route,
      shared: {},
      playerBindings: input.playerBindings,
      observationId: observerId => input.observationId(mover.characterId, observerId),
    })
    observerIds.push(...observed.observerIds)
    events.push(...observed.events)
    outbox.push(...observed.outbox)
  }
  return { observerIds, events, outbox }
}
