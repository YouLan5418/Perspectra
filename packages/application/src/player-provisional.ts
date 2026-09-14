import {
  failWorld, hashWorldJson, resolutionAuthority,
  type ActionRequest, type WorldAddress, type WorldHash, type WorldJsonObject,
} from '@harness-world/contracts'
import { characterRelationObservations, type RulebookEvent, type RulebookResolution } from '@harness-world/kernel'

export function bindPlayerProvisional(
  address: WorldAddress,
  baseHeadSeq: number,
  baseHeadHash: WorldHash | 'genesis',
  action: ActionRequest,
  resolution: RulebookResolution,
) {
  const authority = resolutionAuthority('player', 'manual_player_immediate')
  const scope = resolution.observationScope ?? { scope: 'scene_public' as const }
  const value = {
    version: 'player-provisional-resolution/v1', address, baseHeadSeq, baseHeadHash,
    action, resolutionAuthority: authority, status: resolution.status, reason: resolution.reason ?? null,
    events: resolution.events.map((event, draftOrdinal) => ({
      actionId: action.actionId, draftOrdinal, event,
      contentHash: hashWorldJson('player-provisional-event/v1', { actionId: action.actionId, draftOrdinal, event }),
    })),
    observationScope: scope,
    // The frozen path's own trace travels with the provisional binding, so the hash below covers the
    // definition set and role bindings the proposal was resolved against and not only its outcome.
    ...(resolution.interactionTrace === undefined ? {} : { interaction: resolution.interactionTrace }),
    ruleTraceHash: hashWorldJson('player-provisional-rule-trace/v1', {
      action, resolutionAuthority: authority, status: resolution.status, reason: resolution.reason ?? null,
      events: resolution.events, observationScope: scope,
      ...(resolution.interactionTrace === undefined ? {} : { interaction: resolution.interactionTrace }),
    }),
  }
  // Detach the frozen authority from all mutable Resolver and Provider object references.
  const binding = JSON.parse(JSON.stringify(value)) as typeof value
  return { binding, hash: hashWorldJson('player-provisional-resolution/v1', binding) }
}

export type PlayerProvisional = ReturnType<typeof bindPlayerProvisional>
export interface ProvisionalReactionInput {
  readonly provisional: PlayerProvisional
  readonly visibility: 'full' | 'occurrence_only' | 'none'
  readonly steps?: readonly ProvisionalReactionInput[]
}

export function provisionalInputHash(input: ProvisionalReactionInput): WorldHash {
  return input.steps === undefined ? input.provisional.hash
    : hashWorldJson('player-provisional-group/v1', input.steps.map(step => step.provisional.hash))
}

export function provisionalInputEvents(input: ProvisionalReactionInput): readonly RulebookEvent[] {
  return input.steps === undefined ? input.visibility === 'full' ? input.provisional.binding.events.map(value => value.event) : []
    : input.steps.flatMap(provisionalInputEvents)
}

export function verifyPlayerProvisional(provisional: PlayerProvisional, action: ActionRequest, resolution: RulebookResolution): void {
  const { address, baseHeadSeq, baseHeadHash } = provisional.binding
  const final = bindPlayerProvisional(address, baseHeadSeq, baseHeadHash, action, resolution)
  if (final.hash !== provisional.hash || hashWorldJson('player-provisional-resolution/v1', provisional.binding) !== provisional.hash) {
    failWorld({ errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false,
      address, correlationId: `player-provisional:${action.actionId}`,
      message: 'player provisional resolution differs from final phase 0 authority',
      details: { expectedHash: provisional.hash, actualHash: final.hash },
    })
  }
}

/** Visibility is selected by Scene policy before Recall; opaque binding Hashes carry no action text. */
export function provisionalReactionView(input: ProvisionalReactionInput, history: readonly RulebookEvent[]): WorldJsonObject {
  if (input.steps !== undefined) return { version: 'provisional-reaction-group/v1', provisionalResolutionHash: provisionalInputHash(input),
    steps: input.steps.map(step => provisionalReactionView(step, history)) }
  const { provisional, visibility } = input
  const binding = provisional.binding
  const identity = { version: 'provisional-reaction-view/v1', provisionalResolutionHash: provisional.hash, visibility }
  if (visibility === 'none') return identity
  if (visibility === 'occurrence_only') return { ...identity, observation: { contentVisibility: 'occurrence_only', actionType: 'private_interaction' } }
  const events = binding.events.map(value => value.event)
  return { ...identity, observation: {
    actionType: binding.action.actionType, actorId: binding.action.actorId,
    status: binding.status, reason: binding.reason,
    relations: characterRelationObservations(history, events),
    effects: events.filter(event => ['character.speak', 'character.moved', 'entity.transferred', 'character.manifested'].includes(event.eventType))
      .map(event => ({ eventType: event.eventType, data: event.data })),
  } }
}
