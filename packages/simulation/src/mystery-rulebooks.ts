import { compareWorldText, deterministicId, type WorldEventDraft, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import {
  RulebookRegistry,
  SpeakMoveRulebook,
  createCoreRulebookRegistry,
  currentEntityState,
  currentLocation,
  rejectRulebookResolution,
  worldJsonObject,
  type ActionAffordance,
  type RulebookEvent,
  type RulebookResolution,
  type RulebookResolutionContext,
  type RulebookResolver,
} from '@harness-world/kernel'

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
    const data = worldJsonObject(event.data)
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
    evidence: [...evidence.entries()].sort(([left], [right]) => compareWorldText(left, right)).map(([evidenceId, value]) => ({
      evidenceId,
      discoveredBy: [...value.discoveredBy].sort(compareWorldText),
      presentedBy: [...value.presentedBy].sort(compareWorldText),
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

function sameLocation(events: readonly RulebookEvent[], left: string, right: string): boolean {
  const location = currentLocation(events, left)
  return location !== undefined && location === currentLocation(events, right)
}

function culpritClaims(events: readonly RulebookEvent[]): Set<string> {
  const claims = new Map<string, WorldJsonObject>()
  for (const event of events) {
    const data = worldJsonObject(event.data)
    if ((event.eventType === 'claim.upsert' || event.eventType === 'claim.remove') && typeof data?.id !== 'string') {
      throw new TypeError(`${event.eventType} is malformed`)
    }
    if (event.eventType === 'claim.remove') claims.delete(data!.id as string)
    if (event.eventType === 'claim.upsert') {
      const value = worldJsonObject(data!.value as WorldJsonValue)
      const seed = worldJsonObject(value?.seed as WorldJsonValue)
      const proposition = worldJsonObject(seed?.proposition as WorldJsonValue)
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
    const data = worldJsonObject(event.data)
    if (typeof data?.culpritId !== 'string' || typeof data.sourceClaimId !== 'string') {
      throw new TypeError('investigation.culprit-seeded is malformed')
    }
    culprits.add(data.culpritId)
  }
  return culprits
}

/** Demo-owned compatibility Resolver. Its output is frozen by the pre-extraction Golden. */
export class MysteryRulebookResolver implements RulebookResolver {
  readonly #core = new SpeakMoveRulebook()

  resolve(context: RulebookResolutionContext): RulebookResolution {
    const { manifest, events, characterId, action } = context
    const core = this.#core.resolveSupported(manifest, events, characterId, action)
    if (core !== undefined) return core
    const parameters = worldJsonObject(action.parameters)
    const investigationAction = action.actionType === 'inspect' || action.actionType === 'ask'
      || action.actionType === 'present_evidence' || action.actionType === 'accuse'
    if (manifest.rulebook.version >= 4 && investigationAction
      && currentInvestigationState(events).status === 'solved') {
      return rejectRulebookResolution(characterId, action.actionType, 'CASE_ALREADY_CLOSED')
    }
    if (manifest.rulebook.version >= 3 && action.actionType === 'inspect') {
      const entityId = parameters?.entityId
      if (typeof entityId !== 'string' || !manifest.entities.some(entity => entity.entityId === entityId)) {
        return rejectRulebookResolution(characterId, action.actionType, 'inspect requires a manifest entityId')
      }
      const entity = currentEntityState(events, entityId)
      const characterLocation = currentLocation(events, characterId)
      if (entity === undefined || (entity.locationId !== characterLocation && entity.holderId !== characterId)) {
        return rejectRulebookResolution(characterId, action.actionType, 'INSPECTION_TARGET_NOT_AVAILABLE')
      }
      const evidenceId = manifest.rulebook.version >= 4 ? inspectionEvidenceId(entityId) : `evidence:${entity.kind}`
      const investigation = currentInvestigationState(events)
      if (investigation.evidence.some(value => value.evidenceId === evidenceId && value.discoveredBy.includes(characterId))) {
        return rejectRulebookResolution(characterId, action.actionType, 'ALREADY_INSPECTED')
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
      if (typeof targetCharacterId !== 'string' || targetCharacterId === characterId
        || !manifest.characters.some(character => character.characterId === targetCharacterId)) {
        return rejectRulebookResolution(characterId, action.actionType, 'ask requires another manifest character')
      }
      if (typeof topicId !== 'string' || topicId.length === 0) return rejectRulebookResolution(characterId, action.actionType, 'ask requires topicId')
      if (!sameLocation(events, characterId, targetCharacterId)) return rejectRulebookResolution(characterId, action.actionType, 'ASK_TARGET_NOT_PRESENT')
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
      if (typeof evidenceId !== 'string') return rejectRulebookResolution(characterId, action.actionType, 'present_evidence requires evidenceId')
      if (typeof targetCharacterId !== 'string' || targetCharacterId === characterId
        || !manifest.characters.some(character => character.characterId === targetCharacterId)) {
        return rejectRulebookResolution(characterId, action.actionType, 'present_evidence requires another manifest character')
      }
      const evidence = currentInvestigationState(events).evidence.find(value => value.evidenceId === evidenceId)
      if (evidence === undefined || !evidence.discoveredBy.includes(characterId)) {
        return rejectRulebookResolution(characterId, action.actionType, 'EVIDENCE_NOT_KNOWN')
      }
      if (!sameLocation(events, characterId, targetCharacterId)) return rejectRulebookResolution(characterId, action.actionType, 'EVIDENCE_TARGET_NOT_PRESENT')
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
      if (typeof suspectId !== 'string' || suspectId === characterId
        || !manifest.characters.some(character => character.characterId === suspectId)) {
        return rejectRulebookResolution(characterId, action.actionType, 'accuse requires another manifest character')
      }
      if (!Array.isArray(evidenceIds) || evidenceIds.length === 0
        || evidenceIds.some(value => typeof value !== 'string') || new Set(evidenceIds).size !== evidenceIds.length) {
        return rejectRulebookResolution(characterId, action.actionType, 'accuse requires unique evidenceIds')
      }
      if (!sameLocation(events, characterId, suspectId)) return rejectRulebookResolution(characterId, action.actionType, 'ACCUSE_TARGET_NOT_PRESENT')
      const investigation = currentInvestigationState(events)
      if (investigation.status === 'solved') return rejectRulebookResolution(characterId, action.actionType, 'CASE_ALREADY_CLOSED')
      const presented = new Set(investigation.evidence.filter(value => value.presentedBy.includes(characterId)).map(value => value.evidenceId))
      if (!(evidenceIds as string[]).every(evidenceId => presented.has(evidenceId))) {
        return rejectRulebookResolution(characterId, action.actionType, 'EVIDENCE_NOT_PRESENTED')
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
    return rejectRulebookResolution(characterId, action.actionType, 'action type is not afforded by the V0 Rulebook')
  }

  affordances(_context: Omit<RulebookResolutionContext, 'action'>): readonly ActionAffordance[] {
    return [
      { actionType: 'speak', actionVersion: 1 },
      { actionType: 'move', actionVersion: 1 },
      { actionType: 'take', actionVersion: 1 },
      { actionType: 'inspect', actionVersion: 1 },
      { actionType: 'ask', actionVersion: 1 },
      { actionType: 'present_evidence', actionVersion: 1 },
      { actionType: 'accuse', actionVersion: 1 },
    ]
  }
}

/** Explicit Demo composition hook for historical v3 and current v4 mystery worlds. */
export function registerMysteryRulebooks(registry: RulebookRegistry): RulebookRegistry {
  registry.register('builtin:speak-move', 3, new MysteryRulebookResolver())
  registry.register('builtin:speak-move', 4, new MysteryRulebookResolver())
  return registry
}

export function createMysteryRulebookRegistry(): RulebookRegistry {
  return registerMysteryRulebooks(createCoreRulebookRegistry())
}
