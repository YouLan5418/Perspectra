import {
  brandId,
  type ActivityGame,
  type ActivityState,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { actionObservations } from './action-observations.ts'

/** A request is live only against the committed state it was offered from, and only for a participant. */
export function checkActivityRequest(
  state: ActivityState | undefined,
  id: unknown,
  revision: unknown,
  actorId: string,
): asserts state is ActivityState {
  if (!state?.game.active || state.id !== id || state.revision !== revision || !state.participants.includes(actorId))
    throw new TypeError('活动请求已失效，请刷新；这次没有执行')
}

export function startedActivity(input: {
  readonly id: string
  readonly participants: string[]
  readonly game: ActivityGame
}): ActivityState {
  return { id: input.id, revision: 1, participants: input.participants, game: input.game }
}

/** Pausing frees the foreground and keeps all progress, including whose turn it was. */
export function suspendedActivity(state: ActivityState): ActivityState {
  return {
    ...state,
    revision: state.revision + 1,
    suspendedTurn: state.game.turn!,
    game: { ...state.game, active: false, turn: null },
  }
}

export function resumedActivity(state: ActivityState): ActivityState {
  if (state.suspendedTurn === undefined) throw new TypeError('只能恢复暂停中的活动')
  const { suspendedTurn, ...saved } = state
  return { ...saved, revision: state.revision + 1, game: { ...state.game, active: true, turn: suspendedTurn } }
}

/** Giving up paused progress keeps what was already committed. */
export function abandonedActivity(state: ActivityState): ActivityState {
  if (state.suspendedTurn === undefined) throw new TypeError('只能放弃暂停中的活动')
  const { suspendedTurn: _turn, ...saved } = state
  return {
    ...saved,
    revision: state.revision + 1,
    game: { ...state.game, active: false, phase: 'host-aborted', turn: null },
  }
}

/** The player's way out. Takes no script input, so no author rule can keep the player inside an activity. */
export function escapedActivity(state: ActivityState): ActivityState {
  return {
    ...state,
    revision: state.revision + 1,
    game: { ...state.game, active: false, phase: 'host-aborted', turn: null },
  }
}

export function activityUpdatedEvent(input: {
  readonly key: string
  readonly state: ActivityState
  readonly description: string
  readonly actorId: string
  readonly actionId: string
  readonly operation: string
}): WorldEventDraft {
  const { key, state, description, actorId, actionId, operation } = input
  return {
    eventType: 'activity.updated',
    eventVersion: 1,
    data: { activityKey: key, state, description, actorId, actionId, operation } as unknown as WorldJsonObject,
  }
}

function lifecycle(state: ActivityState, operation: string): string {
  if (operation === 'suspend') return 'suspended'
  if (operation === 'resume') return 'resumed'
  if (operation === 'start') return 'started'
  return state.game.active ? 'updated' : 'ended'
}

/** What a character learns about the activity from a result: never its internal or private state. */
export function activityResultMetadata(state: ActivityState, operation: string): WorldJsonObject {
  return {
    activity: {
      id: state.id,
      revision: state.revision,
      phase: state.game.phase,
      round: state.game.round,
      active: state.game.active,
      lifecycle: lifecycle(state, operation),
    },
  }
}

/** Activity results reach the named participants wherever they are, so this does not consult the scene. */
export function activityOutcomeObservations(input: {
  readonly state: ActivityState
  readonly description: string
  readonly actorId: string
  readonly actionId: string
  readonly observerIds: readonly string[]
  readonly operation: string
}): readonly WorldEventDraft[] {
  const { actionId } = input
  return actionObservations({
    roundId: brandId(actionId, 'InteractionRoundId'),
    actionId,
    actorId: brandId(input.actorId, 'CharacterId'),
    actionType: 'interact',
    status: 'accepted',
    audience: {
      fullContentCharacterIds: input.observerIds.map(id => brandId(id, 'CharacterId')),
      occurrenceOnlyCharacterIds: [],
    },
    shared: {
      resultDescription: input.description,
      resultMetadata: activityResultMetadata(input.state, input.operation),
    },
    playerBindings: [],
    observationId: observerId => `${actionId}:${observerId}`,
  }).events
}

/** Something that happened around those present. No actor: nobody here did it, and it reads as what they noticed. */
export function sceneEventObservations(input: {
  readonly actionId: string
  readonly observerIds: readonly string[]
  readonly text: string
}): readonly WorldEventDraft[] {
  return input.observerIds.map(observerId => ({
    eventType: 'observation.upsert',
    eventVersion: 1,
    data: {
      id: `${input.actionId}:scene:${observerId}`,
      value: { observerId, actionId: input.actionId, content: { eventNotice: input.text } },
    },
  }))
}
