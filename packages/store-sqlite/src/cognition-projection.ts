import {
  AFFECT_DURATIONS,
  AFFECT_EXPRESSION_MODES,
  AFFECT_STATUSES,
  AFFECT_TYPES,
  AWARENESS_LEVELS,
  CLAIM_STANCES,
  COMMITMENT_ORIGINS,
  COMMITMENT_STATUSES,
  GOAL_OBJECTIVE_KINDS,
  GOAL_STATUSES,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_STATUSES,
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_TYPES,
  TENSION_POLE_TENDENCIES,
  TENSION_RESOLUTION_KINDS,
  TENSION_STATUSES,
  COGNITION_PROJECTION_KINDS,
  compareWorldText,
  hashCognitionRecordState,
  hashWorldJson,
  type CharacterCognitionView,
  type CharacterId,
  type CognitionProjectionBundle,
  type CognitionProjectionKind,
  type CognitionProjectionRecord,
  type ContextSourceRef,
  type StoredWorldEvent,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import type { WorldStore } from './world-store.ts'

const EVENT_KIND = new Map<string, CognitionProjectionKind>([
  ['subjective-claim.upsert', 'subjective-claim'],
  ['character-goal.upsert', 'character-goal'],
  ['relationship-attitude.upsert', 'relationship-attitude'],
  ['affect-episode.upsert', 'affect-episode'],
  ['inner-tension.upsert', 'inner-tension'],
  ['commitment.upsert', 'commitment'],
  ['open-loop.upsert', 'open-loop'],
])

type CognitionState = Record<CognitionProjectionKind, Map<string, CognitionProjectionRecord[]>>

function object(value: unknown, path: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as WorldJsonObject
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new Error(`${path} must be a non-empty, unpadded string`)
  return value
}

function literal(value: unknown, allowed: readonly string[], path: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${path} uses an unsupported vocabulary value`)
  return value
}

function permille(value: unknown, path: string, minimum = 0): number {
  // World Event JSON canonicalization has already rejected non-integers, unsafe integers, and negative zero.
  if (typeof value !== 'number' || value < minimum || value > 1000) {
    throw new Error(`${path} must be a safe integer from ${minimum} through 1000`)
  }
  return value as number
}

function stringOrNull(value: unknown, path: string): string | null {
  if (value === null) return null
  return text(value, path)
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  const result = value.map((entry, index) => text(entry, `${path}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${path} contains duplicate values`)
  return result
}

function source(value: unknown, path: string): void {
  const record = object(value, path)
  text(record.sourceKind, `${path}.sourceKind`)
  text(record.sourceId, `${path}.sourceId`)
  const hash = text(record.sourceHash, `${path}.sourceHash`)
  if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) throw new Error(`${path}.sourceHash must be a lowercase SHA-256 WorldHash`)
}

function common(value: WorldJsonObject, path: string): void {
  if (!Array.isArray(value.basisRefs)) throw new Error(`${path}.basisRefs must be an array`)
  value.basisRefs.forEach((entry, index) => source(entry, `${path}.basisRefs[${index}]`))
  source(value.source, `${path}.source`)
}

function validateClaim(value: WorldJsonObject, path: string): void {
  if (value.proposition === undefined) throw new Error(`${path}.proposition is required`)
  literal(value.stance, CLAIM_STANCES, `${path}.stance`)
  permille(value.confidencePermille, `${path}.confidencePermille`)
  permille(value.saliencePermille, `${path}.saliencePermille`)
  literal(value.awareness, AWARENESS_LEVELS.slice(0, 2), `${path}.awareness`)
  if (value.status !== 'active') throw new Error(`${path}.status must be active`)
}

function validateGoal(value: WorldJsonObject, path: string): void {
  const objective = object(value.objective, `${path}.objective`)
  literal(objective.kind, GOAL_OBJECTIVE_KINDS, `${path}.objective.kind`)
  permille(value.priorityPermille, `${path}.priorityPermille`)
  literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`)
  literal(value.status, GOAL_STATUSES, `${path}.status`)
  stringOrNull(value.parentGoalKey, `${path}.parentGoalKey`)
  stringArray(value.targetKeys, `${path}.targetKeys`)
  stringArray(value.blockerKeys, `${path}.blockerKeys`)
}

function validateRelationship(value: WorldJsonObject, path: string): void {
  text(value.target, `${path}.target`)
  literal(value.type, RELATIONSHIP_TYPES, `${path}.type`)
  text(value.facet, `${path}.facet`)
  permille(value.intensityPermille, `${path}.intensityPermille`, 1)
  permille(value.confidencePermille, `${path}.confidencePermille`)
  literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`)
  literal(value.status, RELATIONSHIP_STATUSES, `${path}.status`)
}

function validateAffect(value: WorldJsonObject, path: string): void {
  literal(value.type, AFFECT_TYPES, `${path}.type`)
  permille(value.intensityPermille, `${path}.intensityPermille`, 1)
  if (value.cause === undefined) throw new Error(`${path}.cause is required`)
  stringOrNull(value.targetKey, `${path}.targetKey`)
  literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`)
  literal(value.expressionMode, AFFECT_EXPRESSION_MODES, `${path}.expressionMode`)
  literal(value.duration, AFFECT_DURATIONS, `${path}.duration`)
  literal(value.status, AFFECT_STATUSES, `${path}.status`)
}

function validateTension(value: WorldJsonObject, path: string): void {
  text(value.title, `${path}.title`)
  permille(value.pressurePermille, `${path}.pressurePermille`, 1)
  literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`)
  literal(value.status, TENSION_STATUSES, `${path}.status`)
  if (value.resolutionKind !== undefined) literal(value.resolutionKind, TENSION_RESOLUTION_KINDS, `${path}.resolutionKind`)
  if (!Array.isArray(value.poles) || value.poles.length < 2 || value.poles.length > 4) throw new Error(`${path}.poles must contain two through four entries`)
  const keys = value.poles.map((entry, index) => {
    const polePath = `${path}.poles[${index}]`
    const pole = object(entry, polePath)
    const key = text(pole.key, `${polePath}.key`)
    literal(pole.tendency, TENSION_POLE_TENDENCIES, `${polePath}.tendency`)
    text(pole.impulseText, `${polePath}.impulseText`)
    permille(pole.strengthPermille, `${polePath}.strengthPermille`, 1)
    literal(pole.awareness, AWARENESS_LEVELS, `${polePath}.awareness`)
    if (!Array.isArray(pole.basisRefs)) throw new Error(`${polePath}.basisRefs must be an array`)
    pole.basisRefs.forEach((basis, basisIndex) => source(basis, `${polePath}.basisRefs[${basisIndex}]`))
    return key
  })
  if (new Set(keys).size !== keys.length) throw new Error(`${path}.poles contains duplicate keys`)
}

function validateCommitment(value: WorldJsonObject, path: string): void {
  if (value.content === undefined) throw new Error(`${path}.content is required`)
  literal(value.origin, COMMITMENT_ORIGINS, `${path}.origin`)
  permille(value.saliencePermille, `${path}.saliencePermille`)
  literal(value.awareness, AWARENESS_LEVELS.slice(0, 2), `${path}.awareness`)
  literal(value.status, COMMITMENT_STATUSES, `${path}.status`)
}

function validateOpenLoop(value: WorldJsonObject, path: string): void {
  literal(value.kind, OPEN_LOOP_KINDS, `${path}.kind`)
  text(value.summary, `${path}.summary`)
  permille(value.saliencePermille, `${path}.saliencePermille`)
  literal(value.status, OPEN_LOOP_STATUSES, `${path}.status`)
}

function validateValue(kind: CognitionProjectionKind, value: WorldJsonObject, path: string): void {
  common(value, path)
  if (kind === 'subjective-claim') validateClaim(value, path)
  else if (kind === 'character-goal') validateGoal(value, path)
  else if (kind === 'relationship-attitude') validateRelationship(value, path)
  else if (kind === 'affect-episode') validateAffect(value, path)
  else if (kind === 'inner-tension') validateTension(value, path)
  else if (kind === 'commitment') validateCommitment(value, path)
  else validateOpenLoop(value, path)
}

function emptyState(): CognitionState {
  return {
    'subjective-claim': new Map(),
    'character-goal': new Map(),
    'relationship-attitude': new Map(),
    'affect-episode': new Map(),
    'inner-tension': new Map(),
    commitment: new Map(),
    'open-loop': new Map(),
  }
}

function actualSource(event: StoredWorldEvent): ContextSourceRef {
  return {
    sourceKind: 'world_event',
    sourceId: `event:${event.seq}`,
    sourceSeq: event.seq,
    sourceHash: event.eventHash,
  }
}

function applyRecord(
  state: CognitionState,
  event: StoredWorldEvent,
  kind: CognitionProjectionKind,
  id: string,
  characterId: CharacterId,
  value: WorldJsonObject,
  path: string,
): void {
  validateValue(kind, value, `${path}.value`)
  const versions = state[kind].get(id) ?? []
  const previous = versions.at(-1)
  if (previous !== undefined) {
    if (previous.characterId !== characterId) throw new Error(`${path} cannot change cognition ownership`)
    versions[versions.length - 1] = { ...previous, validToSeq: event.seq }
  }
  versions.push({ kind, id, characterId, value, validFromSeq: event.seq, validToSeq: null, sourceRef: actualSource(event) })
  state[kind].set(id, versions)
}

function applyReflection(state: CognitionState, event: StoredWorldEvent): void {
  const path = `character.reflect@${event.seq}`
  const data = object(event.data, path)
  const actorId = text(data.actorId, `${path}.actorId`) as CharacterId
  const contextReceiptId = text(data.contextReceiptId, `${path}.contextReceiptId`)
  const policyReceiptHash = text(data.policyReceiptHash, `${path}.policyReceiptHash`)
  if (!/^sha256:[0-9a-f]{64}$/u.test(policyReceiptHash)) throw new Error(`${path}.policyReceiptHash must be a lowercase SHA-256 WorldHash`)
  if (!Array.isArray(data.operations)) throw new Error(`${path}.operations must be an array`)
  const operationIds = new Set<string>()
  const recordKeys = new Set<string>()
  for (const [index, entry] of data.operations.entries()) {
    const operationPath = `${path}.operations[${index}]`
    const operation = object(entry, operationPath)
    const operationId = text(operation.operationId, `${operationPath}.operationId`)
    const kind = text(operation.kind, `${operationPath}.kind`) as CognitionProjectionKind
    if (!(COGNITION_PROJECTION_KINDS as readonly string[]).includes(kind)) throw new Error(`${operationPath}.kind is unsupported`)
    const id = text(operation.recordId, `${operationPath}.recordId`)
    const recordKey = `${kind}\u001f${id}`
    if (operationIds.has(operationId) || recordKeys.has(recordKey)) throw new Error(`${path}.operations contain duplicate identities`)
    operationIds.add(operationId)
    recordKeys.add(recordKey)
    const expectedStateHash = operation.expectedStateHash
    if (expectedStateHash !== null && (typeof expectedStateHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(expectedStateHash))) {
      throw new Error(`${operationPath}.expectedStateHash must be null or a lowercase SHA-256 WorldHash`)
    }
    if (!Array.isArray(operation.basisRefs)) throw new Error(`${operationPath}.basisRefs must be an array`)
    operation.basisRefs.forEach((basis, basisIndex) => source(basis, `${operationPath}.basisRefs[${basisIndex}]`))
    const value = object(operation.value, `${operationPath}.value`)
    if (hashWorldJson('reflection-basis-refs/v1', operation.basisRefs as WorldJsonValue)
      !== hashWorldJson('reflection-basis-refs/v1', value.basisRefs as WorldJsonValue)) {
      throw new Error(`${operationPath}.basisRefs diverge from value.basisRefs`)
    }
    const reflectionSource = object(value.source, `${operationPath}.value.source`)
    source(reflectionSource, `${operationPath}.value.source`)
    if (reflectionSource.sourceKind !== 'context_receipt' || reflectionSource.sourceId !== contextReceiptId
      || typeof reflectionSource.sourceSeq !== 'number' || reflectionSource.sourceSeq >= event.seq) {
      throw new Error(`${operationPath}.value.source is not bound to the prior Context receipt`)
    }
    const versions = state[kind].get(id) ?? []
    const previous = versions.at(-1)
    const actualStateHash = previous === undefined
      ? null
      : hashCognitionRecordState(kind, id, previous.characterId, previous.value)
    if (actualStateHash !== expectedStateHash) throw new Error(`${operationPath}.expectedStateHash diverges from the event prefix`)
    if (previous !== undefined && previous.characterId !== actorId) throw new Error(`${operationPath} cannot change another character's cognition`)
    applyRecord(state, event, kind, id, actorId, value, operationPath)
  }
}

function apply(state: CognitionState, event: StoredWorldEvent): void {
  if (event.eventType === 'character.reflect') {
    applyReflection(state, event)
    return
  }
  const kind = EVENT_KIND.get(event.eventType)
  if (kind === undefined) return
  const path = `${event.eventType}@${event.seq}`
  const data = object(event.data, path)
  const id = text(data.id, `${path}.id`)
  const characterId = text(data.characterId, `${path}.characterId`) as CharacterId
  const value = object(data.value, `${path}.value`)
  applyRecord(state, event, kind, id, characterId, value, path)
}

function orderedHistory(state: CognitionState): CognitionProjectionRecord[] {
  return Object.values(state).flatMap(records => [...records.values()].flat())
    .sort((left, right) => compareWorldText(left.kind, right.kind)
      || compareWorldText(left.characterId, right.characterId)
      || compareWorldText(left.id, right.id)
      || left.validFromSeq - right.validFromSeq)
}

function assertUniqueClaims(records: readonly CognitionProjectionRecord[]): void {
  const propositions = new Set<string>()
  for (const record of records.filter(value => value.kind === 'subjective-claim' && value.validToSeq === null)) {
    const value = record.value as WorldJsonObject
    const key = `${record.characterId}\u001f${hashWorldJson('subjective-claim-proposition/v1', value.proposition as WorldJsonValue)}`
    if (propositions.has(key)) throw new Error(`character ${record.characterId} has multiple active Claims for one proposition`)
    propositions.add(key)
  }
}

function arrays(records: readonly CognitionProjectionRecord[]) {
  const current = (kind: CognitionProjectionKind) => records.filter(value => value.kind === kind && value.validToSeq === null)
  return {
    claims: current('subjective-claim'),
    goals: current('character-goal'),
    relationships: current('relationship-attitude'),
    affects: current('affect-episode'),
    innerTensions: current('inner-tension'),
    commitments: current('commitment'),
    openLoops: current('open-loop'),
  }
}

/** Rebuilds private temporal cognition only from the verified effective World Event prefix. */
export class CognitionProjectionRebuilder {
  constructor(private readonly worldStore: WorldStore) {}

  historyAt(address: WorldAddress, asOfWorldSeq: number, heartbeat?: () => void): readonly CognitionProjectionRecord[] {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    if (asOfWorldSeq > this.worldStore.head(address).headSeq) throw new RangeError('asOfWorldSeq cannot be later than the branch head')
    const state = emptyState()
    for (const [index, event] of this.worldStore.readEvents(address, asOfWorldSeq).entries()) {
      if (index % 128 === 0) heartbeat?.()
      apply(state, event)
    }
    heartbeat?.()
    const history = orderedHistory(state)
    assertUniqueClaims(history)
    return history
  }

  rebuildAt(address: WorldAddress, asOfWorldSeq: number, heartbeat?: () => void): CognitionProjectionBundle {
    const values = arrays(this.historyAt(address, asOfWorldSeq, heartbeat))
    const base = { address, asOfWorldSeq, ...values }
    return { ...base, bundleHash: hashWorldJson('world-cognition-projection-bundle/v1', base) }
  }

  rebuildCharacterAt(
    address: WorldAddress,
    characterId: CharacterId,
    asOfWorldSeq: number,
    heartbeat?: () => void,
  ): CharacterCognitionView {
    const values = arrays(this.historyAt(address, asOfWorldSeq, heartbeat).filter(value => value.characterId === characterId))
    const base = { address, characterId, asOfWorldSeq, ...values }
    return { ...base, bundleHash: hashWorldJson('world-character-cognition-view/v1', base) }
  }
}
