import {
  brandId,
  type CharacterId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  characterRelationObservations,
  type CompiledWorldManifest,
  type RulebookEvent,
  type RulebookResolution,
} from '@harness-world/kernel'
import { actionObservations, movementRoute } from './action-observations.ts'
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
  readonly result: Pick<RulebookResolution, 'status' | 'events' | 'observationScope'>
  readonly description: string
}): WorldEventDraft[] {
  const { scene, address, events, headSeq, actorId, actionId, action, result } = input
  const accepted = result.status === 'accepted'
  const drafts: WorldEventDraft[] = [...result.events]
  if (accepted && action.actionType === 'move')
    drafts.push(
      ...scene.transitionForMove(
        address,
        events,
        actorId,
        String((action.parameters as WorldJsonObject).locationId),
        headSeq,
      ),
    )
  const scope = result.observationScope
  const audience = scene.audienceForAction(address, actorId, events, headSeq, {
    scope: scope?.scope ?? 'scene_public',
    ...(scope?.recipientIds === undefined
      ? {}
      : { recipientIds: scope.recipientIds.map(id => brandId(id, 'CharacterId')) }),
  })
  const after = { events: [...events, ...(drafts as RulebookEvent[])], asOfSeq: headSeq + drafts.length }
  const moved = accepted ? result.events.find(event => event.eventType === 'character.moved') : undefined
  const route = movementRoute(scene, address, moved, { events, asOfSeq: headSeq }, after)
  const arrived =
    route === undefined
      ? []
      : scene.audienceForAction(address, actorId, after.events, after.asOfSeq).fullContentCharacterIds
  // A line carried by an interaction, such as a scripted player line, has its own observations.
  const speech =
    action.actionType === 'speak' ? result.events.find(event => event.eventType === 'character.speak') : undefined
  const transfer = result.events.find(event => event.eventType === 'entity.transferred')
  const relations = characterRelationObservations(events, result.events)
  const observed = actionObservations({
    roundId: brandId(actionId, 'InteractionRoundId'),
    actionId,
    actorId,
    actionType: action.actionType,
    status: accepted ? 'accepted' : 'rejected',
    audience: {
      fullContentCharacterIds: [...audience.fullContentCharacterIds, ...arrived, actorId],
      occurrenceOnlyCharacterIds: audience.occurrenceOnlyCharacterIds,
    },
    ...(route === undefined ? {} : { route }),
    shared: {
      ...(speech === undefined ? {} : { speech: speech.data }),
      ...(transfer === undefined ? {} : { interaction: transfer.data }),
      ...(relations.length === 0 ? {} : { relations }),
    },
    perObserver: observerId => ({
      resultDescription: input.description.replaceAll('你', observerId === actorId ? '你' : '行动者'),
    }),
    playerBindings: [],
    observationId: observerId => `${actionId}:${observerId}`,
  })
  return [
    ...drafts,
    ...observed.events,
    {
      eventType: 'action.resolved',
      eventVersion: 1,
      data: { actorId, actionId, actionType: action.actionType, accepted, sourceRole: 'player' },
    },
  ]
}
