import {
  AFFECT_DURATIONS,
  AFFECT_EXPRESSION_MODES,
  AFFECT_STATUSES,
  AFFECT_TYPES,
  AWARENESS_LEVELS,
  CLAIM_STANCES,
  COGNITION_PROJECTION_KINDS,
  COMMITMENT_ORIGINS,
  COMMITMENT_STATUSES,
  GOAL_OBJECTIVE_KINDS,
  GOAL_STATUSES,
  OPEN_LOOP_KINDS,
  OPEN_LOOP_STATUSES,
  PHASE8_CONTEXT_PROFILES,
  PHASE8_REFLECTION_PROFILE,
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_TYPES,
  TENSION_POLE_TENDENCIES,
  TENSION_RESOLUTION_KINDS,
  TENSION_STATUSES,
  canonicalizeWorldJson,
  failWorld,
  hashCognitionRecordState,
  hashContextReceipt,
  hashWorldJson,
  worldAddressKey,
  type CharacterCognitionView,
  type CharacterId,
  type CognitivePolicyReceipt,
  type CognitionProjectionKind,
  type CognitionProjectionRecord,
  type ContextProfileId,
  type ContextReceipt,
  type ContextSourceRef,
  type ReflectionOperation,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'

export interface ReflectionPolicyRequest {
  readonly participantId: string
  readonly actorId: CharacterId
  readonly contextReceipt: ContextReceipt
  readonly cognition: CharacterCognitionView
  readonly contextProfileId: ContextProfileId
  readonly operations: readonly WorldJsonValue[]
  readonly correlationId: string
}

export interface ReflectionPolicyResult {
  readonly status: 'accepted' | 'rejected'
  readonly receipt: CognitivePolicyReceipt
  readonly event?: WorldEventDraft
}

type ReasonCode = CognitivePolicyReceipt['reasonCode']

class ReflectionRejection extends Error {
  constructor(readonly reasonCode: Exclude<ReasonCode, 'accepted'>, message: string) {
    super(message)
  }
}

function object(value: unknown, path: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReflectionRejection('model_schema_invalid', `${path} must be an object`)
  return value as WorldJsonObject
}

function exact(value: WorldJsonObject, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new ReflectionRejection('model_schema_invalid', `${path} contains missing or unknown fields`)
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ReflectionRejection('model_schema_invalid', `${path} must be a non-empty, unpadded string`)
  }
  return value
}

function literal(value: unknown, values: readonly string[], path: string): string {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ReflectionRejection('model_schema_invalid', `${path} uses an unsupported vocabulary value`)
  }
  return value
}

function permille(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 1000) {
    throw new ReflectionRejection('model_schema_invalid', `${path} must be a safe integer from ${minimum} through 1000`)
  }
  return value as number
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path)
}

function textArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new ReflectionRejection('model_schema_invalid', `${path} must be an array`)
  const result = value.map((entry, index) => text(entry, `${path}[${index}]`))
  if (new Set(result).size !== result.length) throw new ReflectionRejection('model_schema_invalid', `${path} must be unique`)
  return result
}

function source(value: unknown, path: string): ContextSourceRef {
  const result = object(value, path)
  exact(result, ['sourceKind', 'sourceId', 'sourceSeq', 'sourceHash'], [], path)
  const sourceSeq = result.sourceSeq
  const sourceHash = result.sourceHash
  if (!Number.isSafeInteger(sourceSeq) || (sourceSeq as number) < 0
    || typeof sourceHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(sourceHash)) {
    throw new ReflectionRejection('model_schema_invalid', `${path} has an invalid sequence or hash`)
  }
  return {
    sourceKind: text(result.sourceKind, `${path}.sourceKind`),
    sourceId: text(result.sourceId, `${path}.sourceId`),
    sourceSeq: sourceSeq as number,
    sourceHash: sourceHash as WorldHash,
  }
}

function sourceKey(value: ContextSourceRef): WorldHash {
  return hashWorldJson('context-source-ref/v1', value)
}

function parseOperation(value: WorldJsonValue, index: number): ReflectionOperation {
  const path = `reflection.operations[${index}]`
  const operation = object(value, path)
  exact(operation, ['operationId', 'kind', 'recordId', 'expectedStateHash', 'basisRefs', 'value'], [], path)
  const kind = literal(operation.kind, COGNITION_PROJECTION_KINDS, `${path}.kind`) as CognitionProjectionKind
  const expected = operation.expectedStateHash
  if (expected !== null && (typeof expected !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(expected))) {
    throw new ReflectionRejection('model_schema_invalid', `${path}.expectedStateHash must be null or a WorldHash`)
  }
  if (!Array.isArray(operation.basisRefs)) throw new ReflectionRejection('model_schema_invalid', `${path}.basisRefs must be an array`)
  const basisRefs = operation.basisRefs.map((entry, basisIndex) => source(entry, `${path}.basisRefs[${basisIndex}]`))
  if (basisRefs.length === 0 || new Set(basisRefs.map(sourceKey)).size !== basisRefs.length) {
    throw new ReflectionRejection('source_forbidden', `${path}.basisRefs must be non-empty and unique`)
  }
  return {
    operationId: text(operation.operationId, `${path}.operationId`),
    kind,
    recordId: text(operation.recordId, `${path}.recordId`),
    expectedStateHash: expected as WorldHash | null,
    basisRefs,
    value: object(operation.value, `${path}.value`),
  }
}

function withSource(
  operation: ReflectionOperation,
  receipt: ContextReceipt,
  normalized: WorldJsonObject,
): WorldJsonObject {
  const basisRefs = operation.basisRefs
  const value = operation.kind === 'inner-tension'
    ? {
        ...normalized,
        poles: (normalized.poles as readonly WorldJsonObject[]).map(pole => ({ ...pole, basisRefs })),
        basisRefs,
      }
    : { ...normalized, basisRefs }
  return {
    ...value,
    source: {
      sourceKind: 'context_receipt', sourceId: receipt.receiptId,
      sourceSeq: receipt.asOfWorldSeq, sourceHash: receipt.receiptHash,
    },
  }
}

function normalizeValue(operation: ReflectionOperation, index: number): WorldJsonObject {
  const path = `reflection.operations[${index}].value`
  const value = operation.value
  if ('source' in value || 'basisRefs' in value || 'characterId' in value) {
    throw new ReflectionRejection('source_forbidden', `${path} contains host-owned fields`)
  }
  if (operation.kind === 'subjective-claim') {
    exact(value, ['proposition', 'stance', 'confidencePermille', 'saliencePermille', 'awareness', 'status'], [], path)
    literal(value.stance, CLAIM_STANCES, `${path}.stance`); permille(value.confidencePermille, `${path}.confidencePermille`)
    permille(value.saliencePermille, `${path}.saliencePermille`); literal(value.awareness, AWARENESS_LEVELS.slice(0, 2), `${path}.awareness`)
    literal(value.status, ['active'], `${path}.status`)
  } else if (operation.kind === 'character-goal') {
    exact(value, ['objective', 'priorityPermille', 'awareness', 'status', 'parentGoalKey', 'targetKeys', 'blockerKeys'], [], path)
    const objective = object(value.objective, `${path}.objective`); exact(objective, ['kind', 'value'], [], `${path}.objective`)
    literal(objective.kind, GOAL_OBJECTIVE_KINDS, `${path}.objective.kind`); permille(value.priorityPermille, `${path}.priorityPermille`)
    literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`); literal(value.status, GOAL_STATUSES, `${path}.status`)
    nullableText(value.parentGoalKey, `${path}.parentGoalKey`); textArray(value.targetKeys, `${path}.targetKeys`); textArray(value.blockerKeys, `${path}.blockerKeys`)
  } else if (operation.kind === 'relationship-attitude') {
    exact(value, ['target', 'type', 'facet', 'intensityPermille', 'confidencePermille', 'awareness', 'status'], [], path)
    text(value.target, `${path}.target`); literal(value.type, RELATIONSHIP_TYPES, `${path}.type`); text(value.facet, `${path}.facet`)
    permille(value.intensityPermille, `${path}.intensityPermille`, 1); permille(value.confidencePermille, `${path}.confidencePermille`)
    literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`); literal(value.status, RELATIONSHIP_STATUSES, `${path}.status`)
  } else if (operation.kind === 'affect-episode') {
    exact(value, ['type', 'intensityPermille', 'cause', 'targetKey', 'awareness', 'expressionMode', 'duration', 'status'], [], path)
    literal(value.type, AFFECT_TYPES, `${path}.type`); permille(value.intensityPermille, `${path}.intensityPermille`, 1)
    nullableText(value.targetKey, `${path}.targetKey`); literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`)
    literal(value.expressionMode, AFFECT_EXPRESSION_MODES, `${path}.expressionMode`); literal(value.duration, AFFECT_DURATIONS, `${path}.duration`)
    literal(value.status, AFFECT_STATUSES, `${path}.status`)
  } else if (operation.kind === 'inner-tension') {
    exact(value, ['title', 'pressurePermille', 'awareness', 'status', 'poles'], ['resolutionKind'], path)
    text(value.title, `${path}.title`); permille(value.pressurePermille, `${path}.pressurePermille`, 1)
    literal(value.awareness, AWARENESS_LEVELS, `${path}.awareness`); literal(value.status, TENSION_STATUSES, `${path}.status`)
    if (value.resolutionKind !== undefined) literal(value.resolutionKind, TENSION_RESOLUTION_KINDS, `${path}.resolutionKind`)
    if (!Array.isArray(value.poles) || value.poles.length < 2 || value.poles.length > 4) {
      throw new ReflectionRejection('model_schema_invalid', `${path}.poles must contain two through four entries`)
    }
    const poleKeys = value.poles.map((entry, poleIndex) => {
      const polePath = `${path}.poles[${poleIndex}]`; const pole = object(entry, polePath)
      exact(pole, ['key', 'tendency', 'impulseText', 'strengthPermille', 'awareness'], [], polePath)
      const key = text(pole.key, `${polePath}.key`); literal(pole.tendency, TENSION_POLE_TENDENCIES, `${polePath}.tendency`)
      text(pole.impulseText, `${polePath}.impulseText`); permille(pole.strengthPermille, `${polePath}.strengthPermille`, 1)
      literal(pole.awareness, AWARENESS_LEVELS, `${polePath}.awareness`); return key
    })
    if (new Set(poleKeys).size !== poleKeys.length) throw new ReflectionRejection('model_schema_invalid', `${path}.poles must have unique keys`)
  } else if (operation.kind === 'commitment') {
    exact(value, ['content', 'origin', 'saliencePermille', 'awareness', 'status'], [], path)
    literal(value.origin, COMMITMENT_ORIGINS, `${path}.origin`); permille(value.saliencePermille, `${path}.saliencePermille`)
    literal(value.awareness, AWARENESS_LEVELS.slice(0, 2), `${path}.awareness`); literal(value.status, COMMITMENT_STATUSES, `${path}.status`)
  } else {
    exact(value, ['kind', 'summary', 'saliencePermille', 'status'], [], path)
    literal(value.kind, OPEN_LOOP_KINDS, `${path}.kind`); text(value.summary, `${path}.summary`)
    permille(value.saliencePermille, `${path}.saliencePermille`); literal(value.status, OPEN_LOOP_STATUSES, `${path}.status`)
  }
  canonicalizeWorldJson(value)
  return value
}

function isActive(kind: CognitionProjectionKind, value: WorldJsonObject): boolean {
  if (kind === 'subjective-claim') return value.status === 'active'
  if (kind === 'character-goal') return value.status === 'active' || value.status === 'blocked'
  if (kind === 'relationship-attitude' || kind === 'affect-episode' || kind === 'inner-tension' || kind === 'commitment') return value.status === 'active'
  return value.status === 'open'
}

function terminal(kind: CognitionProjectionKind, value: WorldJsonObject): boolean {
  if (kind === 'subjective-claim') return false
  if (kind === 'character-goal') return ['completed', 'abandoned', 'failed'].includes(value.status as string)
  if (kind === 'open-loop') return ['resolved', 'dismissed', 'expired'].includes(value.status as string)
  return value.status !== 'active'
}

function awarenessRank(value: unknown): number {
  return AWARENESS_LEVELS.indexOf(value as typeof AWARENESS_LEVELS[number])
}

function narrative(kind: CognitionProjectionKind, value: WorldJsonObject): WorldJsonValue {
  if (kind === 'subjective-claim') return value.proposition!
  if (kind === 'character-goal') return (value.objective as WorldJsonObject).value!
  if (kind === 'relationship-attitude') return value.facet!
  if (kind === 'affect-episode') return value.cause!
  if (kind === 'inner-tension') return [value.title!, ...(value.poles as readonly WorldJsonObject[]).map(pole => pole.impulseText!)]
  if (kind === 'commitment') return value.content!
  return value.summary!
}

function records(view: CharacterCognitionView): CognitionProjectionRecord[] {
  return [...view.claims, ...view.goals, ...view.relationships, ...view.affects, ...view.innerTensions, ...view.commitments, ...view.openLoops]
}

function stateHash(values: readonly { kind: CognitionProjectionKind; id: string; characterId: CharacterId; value: WorldJsonValue }[]): WorldHash {
  const ordered = [...values].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
  return hashWorldJson('character-cognition-policy-state/v1', { records: ordered })
}

function receipt(
  request: ReflectionPolicyRequest,
  status: CognitivePolicyReceipt['status'],
  reasonCode: ReasonCode,
  baseStateHash: WorldHash,
  candidateStateHash: WorldHash,
  operationHashes: readonly WorldHash[],
): CognitivePolicyReceipt {
  const input = {
    schemaVersion: 'cognitive-policy-receipt/v1' as const,
    policyId: 'reflection-policy/standard-v1' as const,
    participantId: request.participantId, characterId: request.actorId,
    contextReceiptId: request.contextReceipt.receiptId, baseStateHash, candidateStateHash,
    status, operationHashes, reasonCode,
  }
  return { ...input, receiptHash: hashWorldJson('cognitive-policy-receipt/v1', input) }
}

/** Validates a Reflection batch against one exact Context receipt and immutable cognition prefix. */
export class ReflectionPolicyValidator {
  evaluate(request: ReflectionPolicyRequest): ReflectionPolicyResult {
    this.#assertTrustedInputs(request)
    const current = records(request.cognition)
    const base = stateHash(current)
    let operationHashes: readonly WorldHash[] = []
    try {
      canonicalizeWorldJson(request.operations)
      operationHashes = request.operations.map(value => hashWorldJson('reflection-operation/v1', value))
      const operations = request.operations.map(parseOperation)
      const candidate = this.#candidate(request, current, operations)
      const candidateHash = stateHash(candidate)
      const policyReceipt = receipt(request, 'accepted', 'accepted', base, candidateHash, operationHashes)
      return {
        status: 'accepted', receipt: policyReceipt,
        event: {
          eventType: 'character.reflect', eventVersion: 1,
          data: {
            actorId: request.actorId, contextReceiptId: request.contextReceipt.receiptId,
            policyReceiptHash: policyReceipt.receiptHash,
            operations: operations.map((operation, index) => ({
              ...operation,
              value: withSource(operation, request.contextReceipt, normalizeValue(operation, index)),
            })),
          },
        },
      }
    } catch (error: unknown) {
      if (!(error instanceof ReflectionRejection)) throw error
      return { status: 'rejected', receipt: receipt(request, 'rejected', error.reasonCode, base, base, operationHashes) }
    }
  }

  #assertTrustedInputs(request: ReflectionPolicyRequest): void {
    const { receiptHash, ...receiptInput } = request.contextReceipt
    if (receiptHash !== hashContextReceipt(receiptInput)
      || request.contextReceipt.participantKind !== 'character'
      || request.contextReceipt.participantId !== request.participantId
      || request.contextReceipt.subjectCharacterId !== request.actorId
      || request.contextReceipt.asOfWorldSeq !== request.cognition.asOfWorldSeq
      || worldAddressKey(request.contextReceipt.address) !== worldAddressKey(request.cognition.address)
      || request.cognition.characterId !== request.actorId) {
      failWorld({
        errorCode: 'CONTEXT_SOURCE_UNVERIFIED', category: 'integrity', message: 'Reflection Context binding is divergent',
        retryable: false, correlationId: request.correlationId, address: request.cognition.address,
      })
    }
    const { bundleHash, ...viewInput } = request.cognition
    if (bundleHash !== hashWorldJson('world-character-cognition-view/v1', viewInput)) {
      failWorld({
        errorCode: 'CONTEXT_REBUILD_DIVERGED', category: 'integrity', message: 'Reflection cognition view hash is divergent',
        retryable: false, correlationId: request.correlationId, address: request.cognition.address,
      })
    }
  }

  #candidate(
    request: ReflectionPolicyRequest,
    current: readonly CognitionProjectionRecord[],
    operations: readonly ReflectionOperation[],
  ): Array<{ kind: CognitionProjectionKind; id: string; characterId: CharacterId; value: WorldJsonValue }> {
    if (operations.length > PHASE8_REFLECTION_PROFILE.maximumOperations) {
      throw new ReflectionRejection('state_limit', 'Reflection exceeds the operation limit')
    }
    const operationKeys = operations.map(value => `${value.kind}\u001f${value.recordId}`)
    if (new Set(operationKeys).size !== operationKeys.length || new Set(operations.map(value => value.operationId)).size !== operations.length) {
      throw new ReflectionRejection('model_schema_invalid', 'Reflection operation and record identities must be unique')
    }
    const authorized = new Set(request.contextReceipt.includedSourceRefs.map(sourceKey))
    const byKey = new Map(current.map(value => [`${value.kind}\u001f${value.id}`, {
      kind: value.kind, id: value.id, characterId: value.characterId, value: value.value,
    }]))
    const newActive = new Map<CognitionProjectionKind, number>()
    const narrativeValues: WorldJsonValue[] = []
    for (const [index, operation] of operations.entries()) {
      if (operation.basisRefs.some(value => value.sourceSeq > request.contextReceipt.asOfWorldSeq || !authorized.has(sourceKey(value)))) {
        throw new ReflectionRejection('source_forbidden', 'Reflection basisRefs are not authorized by this Context receipt')
      }
      const key = `${operation.kind}\u001f${operation.recordId}`
      const previous = byKey.get(key)
      const actualHash = previous === undefined ? null : hashCognitionRecordState(previous.kind, previous.id, previous.characterId, previous.value)
      if (actualHash !== operation.expectedStateHash) throw new ReflectionRejection('source_forbidden', 'Reflection expected state hash is stale or unauthorized')
      const normalized = normalizeValue(operation, index)
      if (previous !== undefined && terminal(operation.kind, previous.value as WorldJsonObject)) {
        throw new ReflectionRejection('source_forbidden', 'Reflection cannot rewrite a terminal cognition record')
      }
      this.#limits(previous?.value as WorldJsonObject | undefined, operation.kind, normalized)
      const itemBytes = canonicalizeWorldJson(narrative(operation.kind, normalized)).byteLength
      if (itemBytes > PHASE8_REFLECTION_PROFILE.maximumNarrativeBytesPerOperation) {
        throw new ReflectionRejection('state_limit', 'Reflection narrative exceeds the per-operation byte limit')
      }
      narrativeValues.push(narrative(operation.kind, normalized))
      if (previous === undefined && isActive(operation.kind, normalized)) {
        newActive.set(operation.kind, (newActive.get(operation.kind) ?? 0) + 1)
      }
      byKey.set(key, {
        kind: operation.kind, id: operation.recordId, characterId: request.actorId,
        value: withSource(operation, request.contextReceipt, normalized),
      })
    }
    if ([...newActive.values()].some(value => value > PHASE8_REFLECTION_PROFILE.maximumNewActivePerKind)
      || canonicalizeWorldJson(narrativeValues).byteLength > PHASE8_REFLECTION_PROFILE.maximumNarrativeBytesPerBatch) {
      throw new ReflectionRejection('state_limit', 'Reflection exceeds the creation or batch narrative limit')
    }
    const selected = PHASE8_CONTEXT_PROFILES.find(value => value.profileId === request.contextProfileId)
    if (selected === undefined) throw new ReflectionRejection('model_schema_invalid', 'Reflection uses an unknown Context Profile')
    const limits = new Map<CognitionProjectionKind, number>([
      ['subjective-claim', selected.activeClaims], ['character-goal', selected.activeGoals],
      ['relationship-attitude', selected.relationshipFacets], ['affect-episode', selected.activeAffects],
      ['inner-tension', selected.activeInnerTensions], ['commitment', selected.activeCommitments], ['open-loop', selected.openLoops],
    ])
    for (const kind of COGNITION_PROJECTION_KINDS) {
      const count = [...byKey.values()].filter(value => value.kind === kind && isActive(kind, value.value as WorldJsonObject)).length
      if (count > limits.get(kind)!) throw new ReflectionRejection('state_limit', `Reflection exceeds ${kind} capacity`)
    }
    return [...byKey.values()]
  }

  #limits(previous: WorldJsonObject | undefined, kind: CognitionProjectionKind, candidate: WorldJsonObject): void {
    const priorAwareness = previous?.awareness
    if (previous === undefined && candidate.awareness === 'unrecognized') {
      throw new ReflectionRejection('source_forbidden', 'Reflection cannot create unrecognized cognition')
    }
    if (priorAwareness !== undefined && Math.abs(awarenessRank(priorAwareness) - awarenessRank(candidate.awareness)) > 1) {
      throw new ReflectionRejection('state_limit', 'Reflection awareness changes by more than one level')
    }
    for (const field of ['intensityPermille', 'priorityPermille'] as const) {
      const next = candidate[field]
      if (typeof next === 'number') {
        const before = typeof previous?.[field] === 'number' ? previous[field] as number : 0
        if (Math.abs(next - before) > PHASE8_REFLECTION_PROFILE.maximumMagnitudeChangePermille) {
          throw new ReflectionRejection('state_limit', `Reflection ${field} changes by more than the profile limit`)
        }
      }
    }
    if (kind === 'inner-tension') {
      const priorPoles = new Map(((previous?.poles as readonly WorldJsonObject[] | undefined) ?? []).map(pole => [pole.key, pole]))
      for (const pole of candidate.poles as readonly WorldJsonObject[]) {
        const before = priorPoles.get(pole.key)
        if (before !== undefined && Math.abs(awarenessRank(before.awareness) - awarenessRank(pole.awareness)) > 1) {
          throw new ReflectionRejection('state_limit', 'Reflection pole awareness changes by more than one level')
        }
        if (before === undefined && pole.awareness === 'unrecognized') {
          throw new ReflectionRejection('source_forbidden', 'Reflection cannot create an unrecognized tension pole')
        }
      }
    }
  }
}
