import {
  compareWorldText,
  deterministicId,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'

export interface PrototypeResolution {
  readonly status: 'accepted' | 'rejected'
  readonly events: readonly WorldEventDraft[]
  readonly reason?: string
}

export interface PrototypeHandHold {
  readonly relationId: string
  readonly relationKind: 'hand_hold'
  readonly initiatorId: string
  readonly targetId: string
  readonly interactionId: string
  readonly sourceActionId: string
  readonly active: boolean
}

type RelationEndReason = 'released' | 'participant_moved' | 'participant_unavailable'

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort(compareWorldText)
  const keys = [...expected].sort(compareWorldText)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${path} contains missing or unknown fields`)
  }
}

function textAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be a non-empty, unpadded string`)
  }
  return value
}

/** C0-only pure prototype. Production C1 code must reimplement this behind Kernel types and tests. */
export function replayPrototypeHandHolds(events: readonly WorldEventDraft[]): readonly PrototypeHandHold[] {
  const relations = new Map<string, PrototypeHandHold>()
  for (const [index, event] of events.entries()) {
    if (event.eventType === 'character.relation-started') {
      if (event.eventVersion !== 1) throw new TypeError('unsupported relation-started version')
      const data = objectAt(event.data, `events[${index}].data`)
      exactKeys(data, ['relationId', 'relationKind', 'initiatorId', 'targetId', 'interactionId', 'sourceActionId'], `events[${index}].data`)
      const relationId = textAt(data.relationId, 'relationId')
      const initiatorId = textAt(data.initiatorId, 'initiatorId')
      const targetId = textAt(data.targetId, 'targetId')
      if (!relationId.startsWith('relation:') || data.relationKind !== 'hand_hold' || initiatorId === targetId) {
        throw new TypeError('relation-started identity is malformed')
      }
      if (relations.has(relationId)) throw new TypeError('relation-started duplicates relationId')
      const pairAlreadyActive = [...relations.values()].some(relation => relation.active
        && ((relation.initiatorId === initiatorId && relation.targetId === targetId)
          || (relation.initiatorId === targetId && relation.targetId === initiatorId)))
      if (pairAlreadyActive) throw new TypeError('relation-started duplicates an active hand_hold pair')
      relations.set(relationId, {
        relationId,
        relationKind: 'hand_hold',
        initiatorId,
        targetId,
        interactionId: textAt(data.interactionId, 'interactionId'),
        sourceActionId: textAt(data.sourceActionId, 'sourceActionId'),
        active: true,
      })
    }
    if (event.eventType === 'character.relation-ended') {
      if (event.eventVersion !== 1) throw new TypeError('unsupported relation-ended version')
      const data = objectAt(event.data, `events[${index}].data`)
      exactKeys(data, ['relationId', 'endedByCharacterId', 'reason'], `events[${index}].data`)
      const relationId = textAt(data.relationId, 'relationId')
      const endedByCharacterId = textAt(data.endedByCharacterId, 'endedByCharacterId')
      const relation = relations.get(relationId)
      if (relation === undefined || !relation.active) throw new TypeError('relation-ended has no matching active relation')
      if (endedByCharacterId !== relation.initiatorId && endedByCharacterId !== relation.targetId) {
        throw new TypeError('relation-ended actor is not a participant')
      }
      if (data.reason !== 'released' && data.reason !== 'participant_moved' && data.reason !== 'participant_unavailable') {
        throw new TypeError('relation-ended reason is unsupported')
      }
      relations.set(relationId, { ...relation, active: false })
    }
  }
  return [...relations.values()].sort((left, right) => compareWorldText(left.relationId, right.relationId))
}

function rejected(reason: string): PrototypeResolution {
  return { status: 'rejected', events: [], reason }
}

export function prototypeHoldHand(input: {
  readonly address: WorldAddress
  readonly events: readonly WorldEventDraft[]
  readonly sourceActionId: string
  readonly actorId: string
  readonly targetId: string
  readonly interactionId: string
  readonly sourceRole: 'player' | 'agent' | 'director'
  readonly adjudicationMode: 'standard' | 'manual_player_immediate'
}): PrototypeResolution {
  const relations = replayPrototypeHandHolds(input.events)
  if (input.sourceRole !== 'player' || input.adjudicationMode !== 'manual_player_immediate') {
    return rejected('HOLD_HAND_REQUIRES_MANUAL_PLAYER_IMMEDIATE')
  }
  if (input.actorId === input.targetId) return rejected('SELF_RELATION_NOT_ALLOWED')
  if (relations.some(relation => relation.active
    && ((relation.initiatorId === input.actorId && relation.targetId === input.targetId)
      || (relation.initiatorId === input.targetId && relation.targetId === input.actorId)))) {
    return rejected('HAND_HOLD_ALREADY_ACTIVE')
  }
  const relationKind = 'hand_hold' as const
  const relationId = deterministicId('relation', {
    version: 'character-relation/v1',
    address: input.address,
    sourceActionId: input.sourceActionId,
    relationKind,
    initiatorId: input.actorId,
    targetId: input.targetId,
  })
  return {
    status: 'accepted',
    events: [{
      eventType: 'character.relation-started',
      eventVersion: 1,
      data: {
        relationId,
        relationKind,
        initiatorId: input.actorId,
        targetId: input.targetId,
        interactionId: input.interactionId,
        sourceActionId: input.sourceActionId,
      },
    }],
  }
}

export function prototypeReleaseHand(
  events: readonly WorldEventDraft[],
  actorId: string,
  relationId: string,
): PrototypeResolution {
  const relation = replayPrototypeHandHolds(events).find(value => value.relationId === relationId)
  if (relation === undefined || !relation.active) return rejected('HAND_HOLD_NOT_ACTIVE')
  if (actorId !== relation.initiatorId && actorId !== relation.targetId) return rejected('NOT_RELATION_PARTICIPANT')
  return { status: 'accepted', events: [relationEnded(relationId, actorId, 'released')] }
}

function relationEnded(relationId: string, actorId: string, reason: RelationEndReason): WorldEventDraft {
  return {
    eventType: 'character.relation-ended',
    eventVersion: 1,
    data: { relationId, endedByCharacterId: actorId, reason },
  }
}

export function prototypeParticipantTransition(
  events: readonly WorldEventDraft[],
  actorId: string,
  transition: WorldEventDraft,
  reason: Exclude<RelationEndReason, 'released'>,
): PrototypeResolution {
  const relationEnds = replayPrototypeHandHolds(events)
    .filter(relation => relation.active && (relation.initiatorId === actorId || relation.targetId === actorId))
    .map(relation => relationEnded(relation.relationId, actorId, reason))
  return { status: 'accepted', events: [transition, ...relationEnds] }
}
