import {
  ACTION_GROUP_CUES,
  type ActionGroupCue,
  type CharacterId,
  type InteractionRoundId,
  type ManifestationCueProposal,
  type ManifestationProposal,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { worldJsonObject, type RulebookEvent } from './rulebook.ts'

/**
 * A step's closed-vocabulary cues, read as the proposal the manifestation resolver takes. It lives here
 * rather than beside the action-group code because a frozen interaction step produces the same fact: one
 * mapping, so the two paths cannot end up describing the same expression differently.
 *
 * `cueId` is positional: a step states codes, and the fact records the order they were stated in.
 */
export function stepManifestation(
  value: { readonly independent: readonly ActionGroupCue[]; readonly onSuccess: readonly ActionGroupCue[] } | null,
  accepted: boolean,
): ManifestationProposal | undefined {
  if (value === null) return undefined
  const codes = [...value.independent, ...(accepted ? value.onSuccess : [])]
  if (codes.length === 0) return undefined
  return { cues: codes.map((code, index) => ({
    cueId: `cue:${index}`, channel: ACTION_GROUP_CUES[code].channel,
    description: ACTION_GROUP_CUES[code].description, persistence: 'event_only',
  })) }
}

export interface ManifestationCueResolution extends WorldJsonObject {
  readonly cueId: string
  readonly status: 'accepted' | 'rejected'
  readonly reason: 'accepted' | 'visible_state_absent'
}

export interface ManifestationResolution extends WorldJsonObject {
  readonly status: 'accepted' | 'partially_accepted' | 'rejected'
  readonly cueResolutions: readonly ManifestationCueResolution[]
  readonly events: readonly WorldEventDraft[]
}

export interface ResolveManifestationRequest {
  readonly roundId: InteractionRoundId
  readonly actionId: string
  readonly actorId: CharacterId
  readonly manifestation: ManifestationProposal
  readonly events: readonly RulebookEvent[]
}

function text(value: WorldJsonValue | undefined, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function activeVisibleStates(events: readonly RulebookEvent[], actorId: CharacterId): Set<string> {
  const states = new Set<string>()
  for (const event of events) {
    if (event.eventType !== 'character.visible-state-upserted' && event.eventType !== 'character.visible-state-removed') continue
    const data = worldJsonObject(event.data)
    if (data?.characterId !== actorId) continue
    const stateKey = text(data.stateKey, `${event.eventType}.stateKey`)
    if (event.eventType === 'character.visible-state-upserted') {
      const value = data.value === undefined ? undefined : worldJsonObject(data.value)
      if (value === undefined || (value.channel !== 'posture' && value.channel !== 'appearance')
        || typeof value.description !== 'string' || value.description.length === 0) {
        throw new TypeError('character.visible-state-upserted.value is malformed')
      }
      states.add(stateKey)
    } else {
      states.delete(stateKey)
    }
  }
  return states
}

function stateEvent(actorId: CharacterId, actionId: string, cue: ManifestationCueProposal): WorldEventDraft | undefined {
  if (cue.persistence === 'event_only') return undefined
  return cue.operation === 'set'
    ? {
        eventType: 'character.visible-state-upserted', eventVersion: 1,
        data: {
          characterId: actorId, stateKey: cue.stateKey,
          value: { channel: cue.channel, description: cue.description, sourceActionId: actionId },
        },
      }
    : {
        eventType: 'character.visible-state-removed', eventVersion: 1,
        data: { characterId: actorId, stateKey: cue.stateKey, sourceActionId: actionId },
      }
}

/** Deterministically adjudicate one validated outward-performance proposal. */
export function resolveManifestation(request: ResolveManifestationRequest): ManifestationResolution {
  const states = activeVisibleStates(request.events, request.actorId)
  const accepted: ManifestationCueProposal[] = []
  const cueResolutions: ManifestationCueResolution[] = []
  const stateEvents: WorldEventDraft[] = []
  for (const cue of request.manifestation.cues) {
    if (cue.persistence === 'until_changed' && cue.operation === 'clear' && !states.has(cue.stateKey)) {
      cueResolutions.push({ cueId: cue.cueId, status: 'rejected', reason: 'visible_state_absent' })
      continue
    }
    accepted.push(cue)
    cueResolutions.push({ cueId: cue.cueId, status: 'accepted', reason: 'accepted' })
    const event = stateEvent(request.actorId, request.actionId, cue)
    if (event !== undefined) stateEvents.push(event)
    if (cue.persistence === 'until_changed') {
      if (cue.operation === 'set') states.add(cue.stateKey)
      else states.delete(cue.stateKey)
    }
  }
  const status = accepted.length === 0
    ? 'rejected'
    : accepted.length === request.manifestation.cues.length ? 'accepted' : 'partially_accepted'
  const events: WorldEventDraft[] = accepted.length === 0 ? [] : [
    {
      eventType: 'character.manifested', eventVersion: 1,
      data: {
        roundId: request.roundId,
        actionId: request.actionId,
        characterId: request.actorId,
        description: status === 'accepted' ? request.manifestation.description ?? null : null,
        cues: accepted,
      },
    },
    ...stateEvents,
  ]
  return { status, cueResolutions, events }
}
