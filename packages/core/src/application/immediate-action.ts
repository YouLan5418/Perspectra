import {
  brandId,
  type CharacterId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@perspectra/sdk/contracts'
import { type CompiledWorldManifest, type RulebookEvent, type RulebookResolution } from '@perspectra/core/kernel'
import { actionObservations, movementRoute } from './action-observations.ts'
import { actorTransfer } from './item-effects.ts'
import { moveEffects, otherMoverObservations } from './move-effects.ts'
import type { SceneDecisionService } from './scene-decision.ts'

/** One adjudicated immediate action as facts: its effects, the scene change of a move, what each witness learns and
 * the action record. Witnesses learn the same here as on the character path, so an activity or a status operation
 * cannot change what somebody saw. Immediate rounds deliver through the log, not through the outbox. */
export function immediateActionDrafts(input: {
  readonly scene: SceneDecisionService
  readonly address: WorldAddress
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly headSeq: number
  readonly actorId: CharacterId
  readonly actionId: string
  readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
  readonly result: Pick<RulebookResolution, 'status' | 'events' | 'observationScope' | 'sceneReaction'>
  readonly description: string
}): WorldEventDraft[] {
  const { scene, address, events, headSeq, actorId, actionId, action, result } = input
  const accepted = result.status === 'accepted'
  const drafts: WorldEventDraft[] = [...result.events]
  const moves = accepted
    ? moveEffects({ scene, address, events, headSeq, drafts: result.events })
    : { transitions: [], moved: [] }
  drafts.push(...moves.transitions)
  const scope = result.observationScope
  const audience = scene.audienceForAction(address, actorId, events, headSeq, {
    scope: scope?.scope ?? 'scene_public',
    ...(scope?.recipientIds === undefined
      ? {}
      : { recipientIds: scope.recipientIds.map(id => brandId(id, 'CharacterId')) }),
  })
  const after = { events: [...events, ...(drafts as RulebookEvent[])], asOfSeq: headSeq + drafts.length }
  // Only her own move action carries her route: when another action's result moved her, such as a battle button
  // that sends the party home, those she arrives among see her come, never the action, so her move is recorded like
  // any other mover's below.
  const ownMove = action.actionType === 'move'
  const moved =
    accepted && ownMove
      ? result.events.find(
          event => event.eventType === 'character.moved' && (event.data as WorldJsonObject).characterId === actorId,
        )
      : undefined
  const route = movementRoute(scene, address, moved, { events, asOfSeq: headSeq }, after)
  const arrived =
    route === undefined
      ? []
      : scene.audienceForAction(address, actorId, after.events, after.asOfSeq).fullContentCharacterIds
  // A line carried by an interaction, such as a scripted player line, has its own observations.
  const speech =
    action.actionType === 'speak' ? result.events.find(event => event.eventType === 'character.speak') : undefined
  const transfer = actorTransfer(actionId, result.events)

  const observed = actionObservations({
    roundId: brandId(actionId, 'InteractionRoundId'),
    actionId,
    actorId,
    actionType: action.actionType,
    status: accepted ? 'accepted' : 'rejected',
    ...(action.actionType === 'interact' && result.sceneReaction === false ? { sceneReaction: false } : {}),
    audience: {
      fullContentCharacterIds: [...audience.fullContentCharacterIds, ...arrived, actorId],
      occurrenceOnlyCharacterIds: audience.occurrenceOnlyCharacterIds,
    },
    ...(route === undefined ? {} : { route }),
    shared: {
      ...(speech === undefined ? {} : { speech: speech.data }),
      ...(transfer === undefined ? {} : { interaction: transfer.data }),
    },
    perObserver: observerId => ({
      resultDescription: input.description.replaceAll('你', observerId === actorId ? '你' : '行动者'),
    }),
    playerBindings: [],
    observationId: observerId => `${actionId}:${observerId}`,
  })
  const others = otherMoverObservations({
    scene,
    address,
    roundId: brandId(actionId, 'InteractionRoundId'),
    actionId,
    actorId: ownMove ? actorId : undefined,
    moved: moves.moved,
    before: { events, asOfSeq: headSeq },
    after,
    playerBindings: [],
    observationId: (moverId, observerId) => `${actionId}:moved:${moverId}:${observerId}`,
  })
  return [
    ...drafts,
    ...observed.events,
    ...others.events,
    {
      eventType: 'action.resolved',
      eventVersion: 1,
      data: { actorId, actionId, actionType: action.actionType, accepted, sourceRole: 'player' },
    },
  ]
}
