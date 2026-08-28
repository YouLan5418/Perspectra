import { describe, expect, it } from 'vitest'
import {
  brandId,
  hashCognitionRecordState,
  hashWorldJson,
  type CharacterCognitionView,
  type CognitionProjectionKind,
  type CognitionProjectionRecord,
  type ContextSourceRef,
  type ReflectionOperation,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { createContextReceipt } from './context-receipt.ts'
import { ReflectionPolicyValidator, type ReflectionPolicyRequest } from './reflection.ts'

const actorId = brandId('character:alice', 'CharacterId')
const address: WorldAddress = {
  tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'), branchId: brandId('branch:main', 'BranchId'),
}
const basis: ContextSourceRef = {
  sourceKind: 'world_event', sourceId: 'event:4', sourceSeq: 4, sourceHash: hashWorldJson('event', { seq: 4 }),
}

function view(entries: readonly { kind: CognitionProjectionKind; id: string; value: WorldJsonObject }[] = []): CharacterCognitionView {
  const selected = (kind: CognitionProjectionKind): CognitionProjectionRecord[] => entries.filter(entry => entry.kind === kind).map((entry): CognitionProjectionRecord => ({
    ...entry, characterId: actorId, validFromSeq: 1, validToSeq: null, sourceRef: basis,
  }))
  const grouped = {
    claims: selected('subjective-claim'), goals: selected('character-goal'), relationships: selected('relationship-attitude'),
    affects: selected('affect-episode'), innerTensions: selected('inner-tension'), commitments: selected('commitment'),
    openLoops: selected('open-loop'),
  }
  const input = { address, characterId: actorId, asOfWorldSeq: 4, ...grouped }
  return { ...input, bundleHash: hashWorldJson('world-character-cognition-view/v1', input) }
}

function contextReceipt(overrides: Record<string, unknown> = {}) {
  return createContextReceipt({
    address, roundId: brandId('round:1', 'InteractionRoundId'), participantKind: 'character', participantId: 'agent:alice',
    subjectCharacterId: actorId, controllerId: 'scripted', controllerEpoch: 1, baseHeadSeq: 4, asOfWorldSeq: 4, tick: 1,
    manifestHash: hashWorldJson('manifest', { v: 4 }), contextProfileId: 'standard',
    contextProfileHash: hashWorldJson('profile', { id: 'standard' }),
    versionLocks: {
      contextSchema: 'character-controller/v2', contextReceiptSchema: 'context-receipt/v1', sceneDecisionSchema: 'scene-decision/v2',
      memorySchema: 'cognitive-memory/v2', checkpointSchema: 'continuity-checkpoint/v1', rendererSchema: 'structured-prompt-renderer/v1',
    },
    componentHashes: {
      characterViewHash: hashWorldJson('view', {}), sceneDecisionHash: hashWorldJson('scene', {}), checkpointHash: null,
      tailHash: hashWorldJson('tail', {}), recallHash: hashWorldJson('recall', {}), affordanceHash: hashWorldJson('affordance', {}),
    },
    includedSourceRefs: [basis], exclusions: [], contextHash: hashWorldJson('context', {}),
    providerRequestHash: hashWorldJson('provider', {}), ...overrides,
  })
}

const values: Record<CognitionProjectionKind, WorldJsonObject> = {
  'subjective-claim': { proposition: 'The road is unsafe', stance: 'suspected', confidencePermille: 500, saliencePermille: 500, awareness: 'conscious', status: 'active' },
  'character-goal': { objective: { kind: 'narrative', value: 'Reach the station' }, priorityPermille: 100, awareness: 'conscious', status: 'active', parentGoalKey: null, targetKeys: [], blockerKeys: [] },
  'relationship-attitude': { target: 'character:bob', type: 'trust', facet: 'competence', intensityPermille: 100, confidencePermille: 500, awareness: 'conscious', status: 'active' },
  'affect-episode': { type: 'anxiety', intensityPermille: 100, cause: 'The storm', targetKey: null, awareness: 'conscious', expressionMode: 'restrained', duration: 'short_lived', status: 'active' },
  'inner-tension': { title: 'Wait or leave', pressurePermille: 300, awareness: 'conscious', status: 'active', poles: [
    { key: 'wait', tendency: 'preserve', impulseText: 'Wait for Bob', strengthPermille: 500, awareness: 'conscious' },
    { key: 'leave', tendency: 'pursue', impulseText: 'Catch the train', strengthPermille: 500, awareness: 'conscious' },
  ] },
  commitment: { content: 'Wait ten minutes', origin: 'agreement', saliencePermille: 500, awareness: 'conscious', status: 'active' },
  'open-loop': { kind: 'question', summary: 'Where is Bob?', saliencePermille: 500, status: 'open' },
}

function operation(kind: CognitionProjectionKind, overrides: Partial<ReflectionOperation> = {}): ReflectionOperation {
  return {
    operationId: `operation:${kind}`, kind, recordId: `record:${kind}`, expectedStateHash: null,
    basisRefs: [basis], value: values[kind]!, ...overrides,
  }
}

function request(overrides: Partial<ReflectionPolicyRequest> = {}): ReflectionPolicyRequest {
  return {
    participantId: 'agent:alice', actorId, contextReceipt: contextReceipt(), cognition: view(), contextProfileId: 'standard',
    operations: [operation('subjective-claim')], correlationId: 'reflection:test', ...overrides,
  }
}

describe('ReflectionPolicyValidator', () => {
  it('accepts every Basic v1 state kind and derives host-owned source plus deterministic receipts', () => {
    const validator = new ReflectionPolicyValidator()
    for (const kind of Object.keys(values) as CognitionProjectionKind[]) {
      const result = validator.evaluate(request({ operations: [operation(kind)] }))
      expect(result).toMatchObject({ status: 'accepted', receipt: { status: 'accepted', reasonCode: 'accepted' }, event: { eventType: 'character.reflect' } })
      const stored = ((result.event!.data as WorldJsonObject).operations as readonly WorldJsonObject[])[0]!.value as WorldJsonObject
      expect(stored).toMatchObject({ basisRefs: [basis], source: { sourceKind: 'context_receipt', sourceSeq: 4 } })
      if (kind === 'inner-tension') expect((stored.poles as readonly WorldJsonObject[])[0]).toMatchObject({ basisRefs: [basis] })
      expect(validator.evaluate(request({ operations: [operation(kind)] })).receipt.receiptHash).toBe(result.receipt.receiptHash)
    }
  })

  it('checks optimistic state, terminal records, magnitude, awareness, and final capacity atomically', () => {
    const validator = new ReflectionPolicyValidator()
    const existingValue = { ...values['relationship-attitude'], intensityPermille: 400 }
    const existing = { kind: 'relationship-attitude' as const, id: 'relationship:1', value: existingValue }
    const expectedStateHash = hashCognitionRecordState(existing.kind, existing.id, actorId, existing.value)
    expect(validator.evaluate(request({
      cognition: view([existing]), operations: [operation(existing.kind, {
        recordId: existing.id, expectedStateHash, value: { ...existingValue, intensityPermille: 600 },
      })],
    })).status).toBe('accepted')
    const claimValue = values['subjective-claim']!
    const claim = { kind: 'subjective-claim' as const, id: 'claim:existing', value: claimValue }
    expect(validator.evaluate(request({ cognition: view([claim]), operations: [operation('subjective-claim', {
      recordId: claim.id, expectedStateHash: hashCognitionRecordState(claim.kind, claim.id, actorId, claimValue),
      value: { ...claimValue, stance: 'doubted' },
    })] })).status).toBe('accepted')
    expect(validator.evaluate(request({
      cognition: view([{ kind: 'character-goal', id: 'goal:blocked', value: { ...values['character-goal']!, status: 'blocked' } }]),
      operations: [],
    })).status).toBe('accepted')
    const rejected = [
      request({ cognition: view([existing]), operations: [operation(existing.kind, { recordId: existing.id })] }),
      request({ operations: [operation('relationship-attitude', { value: { ...values['relationship-attitude'], intensityPermille: 201 } })] }),
      request({ operations: [operation('character-goal', { value: { ...values['character-goal'], awareness: 'unrecognized' } })] }),
      request({ operations: [operation('inner-tension', { value: { ...values['inner-tension'], poles: [
        { ...(values['inner-tension']!.poles as readonly WorldJsonObject[])[0], awareness: 'unrecognized' },
        (values['inner-tension']!.poles as readonly WorldJsonObject[])[1]!,
      ] } })] }),
      request({ operations: Array.from({ length: 5 }, (_, index) => operation('subjective-claim', { operationId: `operation:${index}`, recordId: `claim:${index}` })) }),
      request({ operations: Array.from({ length: 3 }, (_, index) => operation('subjective-claim', { operationId: `operation:${index}`, recordId: `claim:${index}` })) }),
      request({ operations: [operation('subjective-claim'), operation('subjective-claim', { operationId: 'other' })] }),
      request({ operations: [operation('subjective-claim'), operation('character-goal', { operationId: 'operation:subjective-claim' })] }),
    ]
    expect(rejected.map(value => validator.evaluate(value).receipt.reasonCode)).toEqual([
      'source_forbidden', 'state_limit', 'source_forbidden', 'source_forbidden',
      'state_limit', 'state_limit', 'model_schema_invalid', 'model_schema_invalid',
    ])

    const terminalValue = { ...values.commitment, status: 'fulfilled' }
    const terminalRecord = { kind: 'commitment' as const, id: 'commitment:done', value: terminalValue }
    expect(validator.evaluate(request({ cognition: view([terminalRecord]), operations: [operation('commitment', {
      recordId: terminalRecord.id,
      expectedStateHash: hashCognitionRecordState(terminalRecord.kind, terminalRecord.id, actorId, terminalValue),
      value: { ...terminalValue, status: 'active' },
    })] })).receipt.reasonCode).toBe('source_forbidden')

    for (const terminalRecord of [
      { kind: 'character-goal' as const, id: 'goal:done', value: { ...values['character-goal']!, status: 'completed' } },
      { kind: 'open-loop' as const, id: 'loop:done', value: { ...values['open-loop']!, status: 'resolved' } },
    ]) {
      expect(validator.evaluate(request({ cognition: view([terminalRecord]), operations: [operation(terminalRecord.kind, {
        recordId: terminalRecord.id,
        expectedStateHash: hashCognitionRecordState(terminalRecord.kind, terminalRecord.id, actorId, terminalRecord.value),
        value: terminalRecord.value,
      })] })).receipt.reasonCode).toBe('source_forbidden')
    }

    const unawareGoal = { kind: 'character-goal' as const, id: 'goal:hidden', value: { ...values['character-goal']!, awareness: 'unrecognized' } }
    expect(validator.evaluate(request({ cognition: view([unawareGoal]), operations: [operation('character-goal', {
      recordId: unawareGoal.id,
      expectedStateHash: hashCognitionRecordState(unawareGoal.kind, unawareGoal.id, actorId, unawareGoal.value),
      value: { ...unawareGoal.value, awareness: 'conscious' },
    })] })).receipt.reasonCode).toBe('state_limit')

    const existingTension = {
      kind: 'inner-tension' as const, id: 'tension:existing', value: {
        ...values['inner-tension']!, poles: (values['inner-tension']!.poles as readonly WorldJsonObject[]).map((pole, index) => (
          index === 0 ? { ...pole, awareness: 'unrecognized', basisRefs: [basis] } : { ...pole, basisRefs: [basis] }
        )), basisRefs: [basis], source: basis,
      },
    }
    const tensionExpected = hashCognitionRecordState(existingTension.kind, existingTension.id, actorId, existingTension.value)
    const tensionCandidate = {
      ...values['inner-tension']!, resolutionKind: 'choice_made',
      poles: (values['inner-tension']!.poles as readonly WorldJsonObject[]).map((pole, index) => (
        index === 0 ? { ...pole, awareness: 'conscious' } : pole
      )),
    }
    expect(validator.evaluate(request({ cognition: view([existingTension]), operations: [operation('inner-tension', {
      recordId: existingTension.id, expectedStateHash: tensionExpected, value: tensionCandidate,
    })] })).receipt.reasonCode).toBe('state_limit')
    const oneStep = {
      ...tensionCandidate,
      poles: (tensionCandidate.poles as readonly WorldJsonObject[]).map((pole, index) => (
        index === 0 ? { ...pole, awareness: 'partially_conscious' } : pole
      )),
    }
    expect(validator.evaluate(request({ cognition: view([existingTension]), operations: [operation('inner-tension', {
      recordId: existingTension.id, expectedStateHash: tensionExpected, value: oneStep,
    })] })).status).toBe('accepted')

    const claims = Array.from({ length: 8 }, (_, index) => ({ kind: 'subjective-claim' as const, id: `claim:${index}`, value: values['subjective-claim']! }))
    expect(validator.evaluate(request({ cognition: view(claims), contextProfileId: 'compact', operations: [operation('subjective-claim')] })).receipt.reasonCode).toBe('state_limit')
  })

  it('rejects untrusted sources, host-owned fields, and narrative byte overflow without emitting an event', () => {
    const validator = new ReflectionPolicyValidator()
    const future = { ...basis, sourceSeq: 5 }
    const unknown = { ...basis, sourceId: 'event:unknown' }
    const cases = [
      operation('subjective-claim', { basisRefs: [] }),
      operation('subjective-claim', { basisRefs: [basis, basis] }),
      operation('subjective-claim', { basisRefs: [future] }),
      operation('subjective-claim', { basisRefs: [unknown] }),
      operation('subjective-claim', { value: { ...values['subjective-claim'], source: basis } }),
      operation('subjective-claim', { value: { ...values['subjective-claim'], basisRefs: [basis] } }),
      operation('subjective-claim', { value: { ...values['subjective-claim'], characterId: actorId } }),
      operation('subjective-claim', { value: { ...values['subjective-claim'], proposition: 'x'.repeat(5000) } }),
    ]
    for (const candidate of cases) {
      const result = validator.evaluate(request({ operations: [candidate] }))
      expect(result.status).toBe('rejected')
      expect(result.event).toBeUndefined()
      expect(result.receipt.baseStateHash).toBe(result.receipt.candidateStateHash)
    }
    const large = 'x'.repeat(4090)
    const batch = Array.from({ length: 4 }, (_, index) => operation('subjective-claim', {
      operationId: `operation:${index}`, recordId: `claim:${index}`, value: { ...values['subjective-claim'], proposition: large },
    }))
    expect(validator.evaluate(request({ operations: batch })).receipt.reasonCode).toBe('state_limit')
  })

  it('rejects malformed operation and state vocabulary shapes as model schema failures', () => {
    const validator = new ReflectionPolicyValidator()
    const malformed: unknown[] = [
      null,
      { ...operation('subjective-claim'), extra: true },
      { ...operation('subjective-claim'), operationId: '' },
      { ...operation('subjective-claim'), kind: 'world-fact' },
      { ...operation('subjective-claim'), expectedStateHash: 'bad' },
      { ...operation('subjective-claim'), basisRefs: {} },
      { ...operation('subjective-claim'), basisRefs: [{ ...basis, sourceSeq: -1 }] },
      { ...operation('subjective-claim'), basisRefs: [{ ...basis, sourceHash: 'bad' }] },
      { ...operation('subjective-claim'), value: null },
      operation('subjective-claim', { value: { ...values['subjective-claim'], stance: 'certain' } }),
      operation('character-goal', { value: { ...values['character-goal'], targetKeys: ['x', 'x'] } }),
      operation('character-goal', { value: { ...values['character-goal'], targetKeys: null } }),
      operation('relationship-attitude', { value: { ...values['relationship-attitude'], intensityPermille: 0 } }),
      operation('affect-episode', { value: { ...values['affect-episode'], duration: 'forever' } }),
      operation('inner-tension', { value: { ...values['inner-tension'], poles: [] } }),
      operation('inner-tension', { value: { ...values['inner-tension'], poles: [
        (values['inner-tension']!.poles as readonly WorldJsonObject[])[0]!,
        (values['inner-tension']!.poles as readonly WorldJsonObject[])[0]!,
      ] } }),
      operation('commitment', { value: { ...values.commitment, origin: 'wish' } }),
      operation('open-loop', { value: { ...values['open-loop'], kind: 'mystery' } }),
    ]
    for (const candidate of malformed) {
      expect(validator.evaluate(request({ operations: [candidate as never] })).receipt.reasonCode).toBe('model_schema_invalid')
    }
    expect(validator.evaluate(request({ contextProfileId: 'unknown' as never })).receipt.reasonCode).toBe('model_schema_invalid')
    expect(validator.evaluate(request({ operations: [operation('character-goal', {
      value: { ...values['character-goal']!, parentGoalKey: 'goal:parent' },
    })] })).status).toBe('accepted')
    const circular: unknown[] = []
    circular.push(circular)
    expect(() => validator.evaluate(request({ operations: circular as never }))).toThrow('cycle')
  })

  it('fails closed when the trusted Context receipt or cognition view binding diverges', () => {
    const validator = new ReflectionPolicyValidator()
    const receipt = contextReceipt()
    const badReceipt = { ...receipt, receiptHash: hashWorldJson('forged', {}) }
    expect(() => validator.evaluate(request({ contextReceipt: badReceipt }))).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }) }))
    const cognition = view()
    expect(() => validator.evaluate(request({ cognition: { ...cognition, bundleHash: hashWorldJson('forged', {}) } }))).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_REBUILD_DIVERGED' }) }))
    const bindingVariants = [
      contextReceipt({ participantKind: 'director', subjectCharacterId: null }),
      contextReceipt({ participantId: 'agent:other' }),
      contextReceipt({ subjectCharacterId: brandId('character:bob', 'CharacterId') }),
      contextReceipt({ baseHeadSeq: 5, asOfWorldSeq: 5 }),
      contextReceipt({ address: { ...address, branchId: brandId('branch:other', 'BranchId') } }),
    ]
    for (const candidate of bindingVariants) {
      expect(() => validator.evaluate(request({ contextReceipt: candidate }))).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }) }))
    }
    expect(() => validator.evaluate(request({ actorId: brandId('character:bob', 'CharacterId') }))).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ errorCode: 'CONTEXT_SOURCE_UNVERIFIED' }) }))
  })
})
