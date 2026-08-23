import { deterministicId, type WorldEventDraft, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface PlayerActionInput extends WorldJsonObject {
  readonly actionType: string
  readonly parameters: WorldJsonValue
}

/** Revalidate a durable Inbox payload before it reaches any deterministic Rulebook. */
export function parsePlayerActionInput(value: WorldJsonValue): PlayerActionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('claimed player action must be an object')
  const action = value as Record<string, WorldJsonValue>
  const keys = Object.keys(action).sort()
  if (keys.join(',') !== 'actionType,parameters' || typeof action.actionType !== 'string') {
    throw new TypeError('claimed player action has an invalid shape')
  }
  return { actionType: action.actionType, parameters: action.parameters! }
}

export interface RulebookResolution {
  readonly status: 'accepted' | 'rejected'
  readonly events: readonly WorldEventDraft[]
  readonly reason?: string
}

function object(value: WorldJsonValue): Record<string, WorldJsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, WorldJsonValue>
    : undefined
}

export interface RulebookEvent {
  readonly eventType: string
  readonly data: WorldJsonValue
}

function currentLocation(events: readonly RulebookEvent[], characterId: string): string | undefined {
  let locationId: string | undefined
  for (const event of events) {
    const data = object(event.data)
    if (data?.characterId !== characterId) continue
    if ((event.eventType === 'character.upsert' || event.eventType === 'character.created') && typeof data.locationId === 'string') locationId = data.locationId
    if (event.eventType === 'character.moved' && typeof data.toLocationId === 'string') locationId = data.toLocationId
  }
  return locationId
}

export interface EntityState extends WorldJsonObject {
  readonly entityId: string
  readonly locationId: string | null
  readonly holderId: string | null
  readonly kind: string
}

export interface InvestigationEvidenceState extends WorldJsonObject {
  readonly evidenceId: string
  readonly discoveredBy: readonly string[]
  readonly presentedBy: readonly string[]
}

export interface InvestigationState extends WorldJsonObject {
  readonly status: 'open' | 'solved'
  readonly culpritId: string | null
  readonly evidence: readonly InvestigationEvidenceState[]
}

export interface CharacterInvestigationEvidence extends WorldJsonObject {
  readonly evidenceId: string
  readonly presented: boolean
}

export interface CharacterInvestigationView extends WorldJsonObject {
  readonly status: 'open' | 'solved'
  readonly culpritId: string | null
  readonly evidence: readonly CharacterInvestigationEvidence[]
}

/** Stable v4 evidence identity: entity identity, never the non-unique author-facing kind. */
export function inspectionEvidenceId(entityId: string): string {
  if (entityId.length === 0) throw new TypeError('inspection evidence requires entityId')
  return `evidence:inspection:${entityId}`
}

/** Rebuild investigation knowledge and terminal case state from one exact Event prefix. */
export function currentInvestigationState(events: readonly RulebookEvent[]): InvestigationState {
  const evidence = new Map<string, { discoveredBy: Set<string>; presentedBy: Set<string> }>()
  let status: 'open' | 'solved' = 'open'
  let culpritId: string | null = null
  for (const event of events) {
    const data = object(event.data)
    if (event.eventType === 'entity.inspected') {
      if (typeof data?.evidenceId !== 'string' || typeof data.characterId !== 'string' || typeof data.entityId !== 'string') {
        throw new TypeError('entity.inspected is malformed')
      }
      const state = evidence.get(data.evidenceId) ?? { discoveredBy: new Set<string>(), presentedBy: new Set<string>() }
      state.discoveredBy.add(data.characterId)
      evidence.set(data.evidenceId, state)
    }
    if (event.eventType === 'evidence.presented') {
      if (typeof data?.evidenceId !== 'string' || typeof data.characterId !== 'string' || typeof data.targetCharacterId !== 'string') {
        throw new TypeError('evidence.presented is malformed')
      }
      const state = evidence.get(data.evidenceId)
      if (state === undefined || !state.discoveredBy.has(data.characterId)) throw new TypeError('evidence.presented has no discovery source')
      state.presentedBy.add(data.characterId)
    }
    if (event.eventType === 'investigation.case-closed') {
      if (typeof data?.culpritId !== 'string') throw new TypeError('investigation.case-closed is malformed')
      if (status === 'solved' && culpritId !== data.culpritId) throw new TypeError('investigation.case-closed diverges from the event prefix')
      status = 'solved'
      culpritId = data.culpritId
    }
  }
  return {
    status,
    culpritId,
    evidence: [...evidence.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([evidenceId, value]) => ({
      evidenceId,
      discoveredBy: [...value.discoveredBy].sort(),
      presentedBy: [...value.presentedBy].sort(),
    })),
  }
}

/** Remove every other character's discovery/presentation ledger from a character-facing query. */
export function investigationViewForCharacter(
  state: InvestigationState,
  characterId: string,
): CharacterInvestigationView {
  return {
    status: state.status,
    culpritId: state.culpritId,
    evidence: state.evidence
      .filter(value => value.discoveredBy.includes(characterId))
      .map(value => ({ evidenceId: value.evidenceId, presented: value.presentedBy.includes(characterId) })),
  }
}

/** Rebuild one entity's authoritative location/holder state from the exact Event prefix. */
export function currentEntityState(events: readonly RulebookEvent[], entityId: string): EntityState | undefined {
  let state: EntityState | undefined
  for (const event of events) {
    const data = object(event.data)
    if (data?.entityId !== entityId) continue
    if (event.eventType === 'entity.upsert') {
      if (typeof data.locationId !== 'string' || typeof data.kind !== 'string') {
        throw new TypeError(`entity.upsert for ${entityId} is malformed`)
      }
      state = { entityId, locationId: data.locationId, holderId: null, kind: data.kind }
    }
    if (event.eventType === 'entity.taken') {
      if (state === undefined || typeof data.characterId !== 'string' || typeof data.fromLocationId !== 'string'
        || state.holderId !== null || state.locationId !== data.fromLocationId) {
        throw new TypeError(`entity.taken for ${entityId} violates the entity event prefix`)
      }
      state = { ...state, locationId: null, holderId: data.characterId }
    }
  }
  return state
}

export function currentCharacterLifecycle(events: readonly RulebookEvent[], characterId: string): 'active' | 'incapacitated' | 'dead' | 'departed' | undefined {
  let state: 'active' | 'incapacitated' | 'dead' | 'departed' | undefined
  for (const event of events) {
    const data = object(event.data)
    if (data?.characterId !== characterId) continue
    if (event.eventType === 'character.upsert' || event.eventType === 'character.created') state ??= 'active'
    if (event.eventType === 'character.lifecycle-changed'
      && (data.lifecycleState === 'active' || data.lifecycleState === 'incapacitated'
        || data.lifecycleState === 'dead' || data.lifecycleState === 'departed')) state = data.lifecycleState
  }
  return state
}

function observation(characterId: string, actionType: string, content: WorldJsonObject, rulebookVersion: number): WorldEventDraft {
  return {
    eventType: 'observation.upsert',
    eventVersion: 1,
    data: {
      id: deterministicId('observation:investigation-rule', { characterId, actionType, content }),
      value: { observerId: characterId, source: `rulebook:investigation/v${rulebookVersion}`, content },
    },
  }
}

function characterExists(manifest: CompiledWorldManifest, characterId: string): boolean {
  return manifest.characters.some(character => character.characterId === characterId)
}

function sameLocation(events: readonly RulebookEvent[], left: string, right: string): boolean {
  const location = currentLocation(events, left)
  return location !== undefined && location === currentLocation(events, right)
}

function culpritClaims(events: readonly RulebookEvent[]): Set<string> {
  const claims = new Map<string, WorldJsonObject>()
  for (const event of events) {
    const data = object(event.data)
    if ((event.eventType === 'claim.upsert' || event.eventType === 'claim.remove') && typeof data?.id !== 'string') {
      throw new TypeError(`${event.eventType} is malformed`)
    }
    if (event.eventType === 'claim.remove') claims.delete(data!.id as string)
    if (event.eventType === 'claim.upsert') {
      const value = object(data!.value as WorldJsonValue)
      const seed = object(value?.seed as WorldJsonValue)
      const proposition = object(seed?.proposition as WorldJsonValue)
      if (proposition === undefined) continue
      claims.set(data!.id as string, proposition)
    }
  }
  return new Set([...claims.values()]
    .filter(value => value.predicate === 'is_culprit' && value.object === true && typeof value.subject === 'string')
    .map(value => value.subject as string))
}

function seededCulprits(events: readonly RulebookEvent[]): Set<string> {
  const culprits = new Set<string>()
  for (const event of events) {
    if (event.eventType !== 'investigation.culprit-seeded') continue
    const data = object(event.data)
    if (typeof data?.culpritId !== 'string' || typeof data.sourceClaimId !== 'string') {
      throw new TypeError('investigation.culprit-seeded is malformed')
    }
    culprits.add(data.culpritId)
  }
  return culprits
}

/** Deterministic V0 Rulebook for movement, speech, and versioned investigation actions. */
export class SpeakMoveRulebook {
  resolve(
    manifest: CompiledWorldManifest,
    events: readonly RulebookEvent[],
    characterId: string,
    action: PlayerActionInput,
  ): RulebookResolution {
    const lifecycle = currentCharacterLifecycle(events, characterId)
    if (lifecycle !== 'active') return this.#reject(characterId, action.actionType, `character lifecycle ${lifecycle ?? 'missing'} cannot act`)
    const parameters = object(action.parameters)
    const investigationAction = action.actionType === 'inspect' || action.actionType === 'ask'
      || action.actionType === 'present_evidence' || action.actionType === 'accuse'
    if (manifest.rulebook.version >= 4 && investigationAction
      && currentInvestigationState(events).status === 'solved') {
      return this.#reject(characterId, action.actionType, 'CASE_ALREADY_CLOSED')
    }
    if (action.actionType === 'speak') {
      const text = parameters?.text
      if (typeof text !== 'string' || text.length === 0) return this.#reject(characterId, action.actionType, 'speak requires non-empty text')
      return {
        status: 'accepted',
        events: [{ eventType: 'character.speak', eventVersion: 1, data: { characterId, text } }],
      }
    }
    if (action.actionType === 'move') {
      const target = parameters?.locationId
      if (typeof target !== 'string' || !manifest.locations.some(location => location.locationId === target)) {
        return this.#reject(characterId, action.actionType, 'move target is not a manifest location')
      }
      const from = currentLocation(events, characterId)
      if (from === target) return this.#reject(characterId, action.actionType, 'character is already at the target location')
      return {
        status: 'accepted',
        events: [{
          eventType: 'character.moved',
          eventVersion: 1,
          data: { characterId, fromLocationId: from ?? null, toLocationId: target },
        }],
      }
    }
    if (action.actionType === 'take' && manifest.rulebook.version >= 2) {
      const entityId = parameters?.entityId
      if (typeof entityId !== 'string' || !manifest.entities.some(entity => entity.entityId === entityId)) {
        return this.#reject(characterId, action.actionType, 'take requires a manifest entityId')
      }
      const entity = currentEntityState(events, entityId)
      const characterLocation = currentLocation(events, characterId)
      if (entity === undefined || entity.holderId !== null || entity.locationId !== characterLocation) {
        return this.#reject(characterId, action.actionType, 'ITEM_NOT_AVAILABLE')
      }
      return {
        status: 'accepted',
        events: [{
          eventType: 'entity.taken',
          eventVersion: 1,
          data: { entityId, characterId, fromLocationId: entity.locationId },
        }],
      }
    }
    if (manifest.rulebook.version >= 3 && action.actionType === 'inspect') {
      const entityId = parameters?.entityId
      if (typeof entityId !== 'string' || !manifest.entities.some(entity => entity.entityId === entityId)) {
        return this.#reject(characterId, action.actionType, 'inspect requires a manifest entityId')
      }
      const entity = currentEntityState(events, entityId)
      const characterLocation = currentLocation(events, characterId)
      if (entity === undefined || (entity.locationId !== characterLocation && entity.holderId !== characterId)) {
        return this.#reject(characterId, action.actionType, 'INSPECTION_TARGET_NOT_AVAILABLE')
      }
      const evidenceId = manifest.rulebook.version >= 4
        ? inspectionEvidenceId(entityId)
        : `evidence:${entity.kind}`
      const investigation = currentInvestigationState(events)
      if (investigation.evidence.some(value => value.evidenceId === evidenceId && value.discoveredBy.includes(characterId))) {
        return this.#reject(characterId, action.actionType, 'ALREADY_INSPECTED')
      }
      const content = { actionType: 'inspect', entityId, evidenceId }
      return {
        status: 'accepted',
        events: [
          { eventType: 'entity.inspected', eventVersion: 1, data: { entityId, characterId, evidenceId } },
          observation(characterId, action.actionType, content, manifest.rulebook.version),
        ],
      }
    }
    if (manifest.rulebook.version >= 3 && action.actionType === 'ask') {
      const targetCharacterId = parameters?.targetCharacterId
      const topicId = parameters?.topicId
      if (typeof targetCharacterId !== 'string' || targetCharacterId === characterId || !characterExists(manifest, targetCharacterId)) {
        return this.#reject(characterId, action.actionType, 'ask requires another manifest character')
      }
      if (typeof topicId !== 'string' || topicId.length === 0) return this.#reject(characterId, action.actionType, 'ask requires topicId')
      if (!sameLocation(events, characterId, targetCharacterId)) return this.#reject(characterId, action.actionType, 'ASK_TARGET_NOT_PRESENT')
      const content = { actionType: 'ask', targetCharacterId, topicId }
      return {
        status: 'accepted',
        events: [
          { eventType: 'character.asked', eventVersion: 1, data: { characterId, targetCharacterId, topicId } },
          observation(characterId, action.actionType, content, manifest.rulebook.version),
        ],
      }
    }
    if (manifest.rulebook.version >= 3 && action.actionType === 'present_evidence') {
      const evidenceId = parameters?.evidenceId
      const targetCharacterId = parameters?.targetCharacterId
      if (typeof evidenceId !== 'string') return this.#reject(characterId, action.actionType, 'present_evidence requires evidenceId')
      if (typeof targetCharacterId !== 'string' || targetCharacterId === characterId || !characterExists(manifest, targetCharacterId)) {
        return this.#reject(characterId, action.actionType, 'present_evidence requires another manifest character')
      }
      const evidence = currentInvestigationState(events).evidence.find(value => value.evidenceId === evidenceId)
      if (evidence === undefined || !evidence.discoveredBy.includes(characterId)) {
        return this.#reject(characterId, action.actionType, 'EVIDENCE_NOT_KNOWN')
      }
      if (!sameLocation(events, characterId, targetCharacterId)) return this.#reject(characterId, action.actionType, 'EVIDENCE_TARGET_NOT_PRESENT')
      const content = { actionType: 'present_evidence', evidenceId, targetCharacterId }
      return {
        status: 'accepted',
        events: [
          { eventType: 'evidence.presented', eventVersion: 1, data: { characterId, evidenceId, targetCharacterId } },
          observation(characterId, action.actionType, content, manifest.rulebook.version),
        ],
      }
    }
    if (manifest.rulebook.version >= 3 && action.actionType === 'accuse') {
      const suspectId = parameters?.suspectId
      const evidenceIds = parameters?.evidenceIds
      if (typeof suspectId !== 'string' || suspectId === characterId || !characterExists(manifest, suspectId)) {
        return this.#reject(characterId, action.actionType, 'accuse requires another manifest character')
      }
      if (!Array.isArray(evidenceIds) || evidenceIds.length === 0
        || evidenceIds.some(value => typeof value !== 'string') || new Set(evidenceIds).size !== evidenceIds.length) {
        return this.#reject(characterId, action.actionType, 'accuse requires unique evidenceIds')
      }
      if (!sameLocation(events, characterId, suspectId)) return this.#reject(characterId, action.actionType, 'ACCUSE_TARGET_NOT_PRESENT')
      const investigation = currentInvestigationState(events)
      if (investigation.status === 'solved') return this.#reject(characterId, action.actionType, 'CASE_ALREADY_CLOSED')
      const presented = new Set(investigation.evidence.filter(value => value.presentedBy.includes(characterId)).map(value => value.evidenceId))
      if (!(evidenceIds as string[]).every(evidenceId => presented.has(evidenceId))) {
        return this.#reject(characterId, action.actionType, 'EVIDENCE_NOT_PRESENTED')
      }
      const outcome = (manifest.rulebook.version >= 4 ? seededCulprits(events) : culpritClaims(events)).has(suspectId)
        ? 'correct'
        : 'incorrect'
      const content = { actionType: 'accuse', suspectId, evidenceIds: evidenceIds as string[], outcome }
      return {
        status: 'accepted',
        events: [
          { eventType: 'investigation.accusation-resolved', eventVersion: 1, data: { characterId, suspectId, evidenceIds, outcome } },
          ...(outcome === 'correct'
            ? [{ eventType: 'investigation.case-closed', eventVersion: 1, data: { culpritId: suspectId, resolvedBy: characterId } }]
            : []),
          observation(characterId, action.actionType, content, manifest.rulebook.version),
        ],
      }
    }
    return this.#reject(characterId, action.actionType, 'action type is not afforded by the V0 Rulebook')
  }

  #reject(characterId: string, actionType: string, reason: string): RulebookResolution {
    return {
      status: 'rejected',
      reason,
      events: [{ eventType: 'action.rejected', eventVersion: 1, data: { characterId, actionType, reason } }],
    }
  }
}
