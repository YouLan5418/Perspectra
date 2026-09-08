import { describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, type ReflectionOperation } from '@harness-world/contracts'
import { SubmitActionsValidator, type SubmitActionsV2Authorization } from './submit-actions.ts'

const actorId = brandId('character:claude', 'CharacterId')
const authorization: SubmitActionsV2Authorization = {
  participantId: 'agent:claude', actorId, allowedActionTypes: ['speak', 'move'], maxActions: 2,
  maxReflectionOperations: 1, correlationId: 'submit-actions:v3',
}
const action = { actionId: 'action:1', actorId, actionType: 'speak', actionVersion: 1, parameters: { text: '随你。' } }
const secondAction = { actionId: 'action:2', actorId, actionType: 'move', actionVersion: 1, parameters: { locationId: 'location:station' } }
const reflection: ReflectionOperation = {
  operationId: 'reflection:1', kind: 'affect-episode', recordId: 'affect:1', expectedStateHash: null,
  basisRefs: [{ sourceKind: 'world_event', sourceId: 'event:1', sourceSeq: 1, sourceHash: hashWorldJson('event', { seq: 1 }) }],
  value: { type: 'tension', intensityPermille: 500, targetKey: null, awareness: 'conscious', status: 'active' },
}
const manifestation = {
  description: 'Claude皱起眉，双臂抱在胸前。',
  cues: [
    { cueId: 'cue:facial', channel: 'facial', description: '皱眉', persistence: 'event_only' },
    { cueId: 'cue:posture', channel: 'posture', description: '双臂抱胸', persistence: 'until_changed', stateKey: 'posture:arms-crossed', operation: 'set' },
    { cueId: 'cue:appearance', channel: 'appearance', description: '袖口恢复干燥', persistence: 'until_changed', stateKey: 'appearance:sleeve-wet', operation: 'clear' },
  ],
} as const

function payload(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 3, decision: 'act', actions: [action], manifestation, ...overrides }
}

function expectInvalid(value: unknown, auth = authorization): void {
  expect(() => new SubmitActionsValidator().validateV3(value, auth)).toThrowError(expect.objectContaining({
    envelope: expect.objectContaining({ errorCode: 'MODEL_SCHEMA_INVALID' }),
  }))
}

describe('SubmitActionsValidator v3 manifestation', () => {
  it('binds a strictly validated manifestation and optional reflection to the host participant', () => {
    expect(new SubmitActionsValidator().validateV3({ ...payload(), reflection: { operations: [reflection] } }, authorization)).toEqual({
      decision: 'act',
      proposal: { participantId: 'agent:claude', actions: [action], manifestation },
      reflectionOperations: [reflection],
    })
    expect(new SubmitActionsValidator().validateV3({ schemaVersion: 3, decision: 'abstain', actions: [] }, authorization)).toEqual({
      decision: 'abstain', proposal: { participantId: 'agent:claude', actions: [] },
    })
    expect(new SubmitActionsValidator().validateV3({ ...payload(), manifestation: { cues: [manifestation.cues[0]] } }, authorization))
      .toMatchObject({ proposal: { manifestation: { cues: [manifestation.cues[0]] } } })
  })

  it('rejects envelope, decision, action-binding, reflection, and manifestation-shape divergence', () => {
    const invalid = [
      null,
      { ...payload(), extra: true },
      { ...payload(), schemaVersion: 2 },
      { ...payload(), decision: 'wait' },
      { ...payload(), decision: 'abstain' },
      { ...payload(), actions: [], decision: 'act' },
      { ...payload(), actions: [action, secondAction] },
      { ...payload(), manifestation: null },
      { ...payload(), manifestation: { cues: [], description: 'empty' } },
      { ...payload(), manifestation: { cues: Array.from({ length: 9 }, (_, index) => ({ ...manifestation.cues[0], cueId: `cue:${index}` })) } },
      { ...payload(), manifestation: { cues: [manifestation.cues[0]], extra: true } },
      { ...payload(), manifestation: { cues: [manifestation.cues[0]], description: 'x'.repeat(2049) } },
      { ...payload(), reflection: null },
      { ...payload(), reflection: { operations: [reflection], extra: true } },
      { ...payload(), reflection: { operations: {} } },
      { ...payload(), reflection: { operations: [reflection, reflection] } },
    ]
    for (const candidate of invalid) expectInvalid(candidate)
    expectInvalid(payload(), { ...authorization, maxReflectionOperations: -1 })
    expectInvalid(payload(), { ...authorization, maxReflectionOperations: 1.5 })
    expectInvalid(new Proxy({}, { ownKeys() { throw 'non-error v3 failure' } }))
  })

  it('rejects malformed, oversized, duplicate, and unsupported cues', () => {
    const event = manifestation.cues[0]
    const persistent = manifestation.cues[1]
    const invalidCues = [
      null,
      { ...event, extra: true },
      { ...persistent, operation: 'hold' },
      { ...event, persistence: 'forever' },
      { ...event, cueId: '' },
      { ...event, cueId: 'x'.repeat(129) },
      { ...event, channel: 'emotion' },
      { ...event, description: '' },
      { ...event, description: '界'.repeat(171) },
      { ...persistent, channel: 'voice' },
      { ...persistent, stateKey: '' },
      { ...persistent, stateKey: 'x'.repeat(129) },
    ]
    for (const cue of invalidCues) expectInvalid({ ...payload(), manifestation: { cues: [cue] } })
    expectInvalid({ ...payload(), manifestation: { cues: [event, { ...event }] } })
  })
})
