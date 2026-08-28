import { describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, type ReflectionOperation } from '@harness-world/contracts'
import { SubmitActionsValidator, type SubmitActionsV2Authorization } from './submit-actions.ts'

const actorId = brandId('character:alice', 'CharacterId')
const authorization: SubmitActionsV2Authorization = {
  participantId: 'agent:alice', actorId, allowedActionTypes: ['speak', 'move'], maxActions: 2,
  maxReflectionOperations: 4, correlationId: 'submit-actions:v2',
}
const action = { actionId: 'action:1', actorId, actionType: 'speak', actionVersion: 1, parameters: { text: 'Hello' } }
const reflection: ReflectionOperation = {
  operationId: 'reflection:1', kind: 'subjective-claim', recordId: 'claim:1', expectedStateHash: null,
  basisRefs: [{ sourceKind: 'world_event', sourceId: 'event:1', sourceSeq: 1, sourceHash: hashWorldJson('event', { seq: 1 }) }],
  value: { proposition: 'Bob arrived', stance: 'believed', confidencePermille: 500, saliencePermille: 500, awareness: 'conscious', status: 'active' },
}

function payload(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 2, decision: 'act', actions: [action], reflection: { operations: [reflection] }, ...overrides }
}

describe('SubmitActionsValidator v2', () => {
  it('binds a v2 tool result to the call participant without trusting a model participantId', () => {
    const validator = new SubmitActionsValidator()
    expect(validator.validateV2(payload(), authorization)).toEqual({
      decision: 'act', proposal: { participantId: 'agent:alice', actions: [action] }, reflectionOperations: [reflection],
    })
    expect(validator.validateV2({ schemaVersion: 2, decision: 'abstain', actions: [] }, authorization)).toEqual({
      decision: 'abstain', proposal: { participantId: 'agent:alice', actions: [] },
    })
    expect(validator.validateV2({ schemaVersion: 2, decision: 'abstain', actions: [], reflection: { operations: [] } }, authorization))
      .toMatchObject({ reflectionOperations: [] })
  })

  it('rejects envelope, decision, reflection, and registered-limit divergence', () => {
    const validator = new SubmitActionsValidator()
    const invalid = [
      null,
      { ...payload(), extra: true },
      { ...payload(), schemaVersion: 1 },
      { ...payload(), decision: 'wait' },
      { ...payload(), decision: 'abstain' },
      { ...payload(), actions: [], decision: 'act' },
      { ...payload(), reflection: null },
      { ...payload(), reflection: { operations: [reflection], extra: true } },
      { ...payload(), reflection: { operations: {} } },
      { ...payload(), reflection: { operations: Array.from({ length: 5 }, () => reflection) } },
    ]
    for (const candidate of invalid) {
      expect(() => validator.validateV2(candidate, authorization)).toThrowError(expect.objectContaining({
        envelope: expect.objectContaining({ errorCode: 'MODEL_SCHEMA_INVALID' }),
      }))
    }
    for (const maxReflectionOperations of [-1, 1.5]) {
      expect(() => validator.validateV2(payload(), { ...authorization, maxReflectionOperations })).toThrow('maxReflectionOperations')
    }
    const hostile = new Proxy({}, { ownKeys() { throw 'non-error v2 failure' } })
    expect(() => validator.validateV2(hostile, authorization)).toThrow('unknown submit_actions')
  })
})
