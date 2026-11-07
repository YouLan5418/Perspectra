import type {
  CharacterId,
  InteractionRoundId,
  OutboxDraft,
  SessionId,
  WorldAddress,
  WorldEventDraft,
} from '@harness-world/contracts'
import type { RulebookEvent } from '@harness-world/kernel'
import { actionObservations, movementRoute } from './action-observations.ts'
import type { SceneDecisionService } from './scene-decision.ts'

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
    const data = draft.data as unknown as MovedCharacter
    moved.push({ characterId: data.characterId, fromLocationId: data.fromLocationId, toLocationId: data.toLocationId })
    transitions.push(
      ...input.scene.transitionForMove(
        input.address,
        [...input.events, ...(transitions as RulebookEvent[])],
        data.characterId,
        data.toLocationId,
        input.headSeq,
      ),
    )
  }
  return { transitions, moved }
}

/** What witnesses learn of the characters an action moved besides its actor, such as a follower: those she left see
 * her go, those where she arrives see her come, and she knows her whole route. The actor's own move stays in the
 * action's observation. `before` is the prefix the action started from; `after` already holds every move and its
 * scene changes. */
export function otherMoverObservations(input: {
  readonly scene: SceneDecisionService
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly actionId: string
  readonly actorId: CharacterId
  readonly actionType: string
  readonly moved: readonly MovedCharacter[]
  readonly before: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number }
  readonly after: { readonly events: readonly RulebookEvent[]; readonly asOfSeq: number }
  readonly playerBindings: readonly { readonly characterId: CharacterId; readonly sessionId: SessionId }[]
  readonly observationId: (moverId: CharacterId, observerId: CharacterId) => string
}): { observerIds: CharacterId[]; events: WorldEventDraft[]; outbox: OutboxDraft[] } {
  const observerIds: CharacterId[] = [],
    events: WorldEventDraft[] = [],
    outbox: OutboxDraft[] = []
  for (const mover of input.moved) {
    if (mover.characterId === input.actorId) continue
    const seen = movementRoute(
      input.scene,
      input.address,
      { eventType: 'character.moved', eventVersion: 1, data: { ...mover } },
      input.before,
      input.after,
    )!
    // Like an actor, the one moved knows both ends even where no scene is open.
    const route = {
      ...seen,
      departureObservers: new Set([...seen.departureObservers, mover.characterId]),
      arrivalObservers: new Set([...seen.arrivalObservers, mover.characterId]),
    }
    const observed = actionObservations({
      roundId: input.roundId,
      actionId: input.actionId,
      actorId: input.actorId,
      actionType: input.actionType,
      status: 'accepted',
      audience: {
        fullContentCharacterIds: [...new Set([...route.departureObservers, ...route.arrivalObservers])],
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
