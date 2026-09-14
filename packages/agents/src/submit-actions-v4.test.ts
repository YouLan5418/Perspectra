import { describe, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { SubmitActionsValidator } from './submit-actions.ts'

const actorId = brandId('character:a', 'CharacterId')
const auth = { participantId: 'a', actorId, allowedActionTypes: ['speak', 'move', 'take', 'other'], maxActions: 2, maxReflectionOperations: 0, correlationId: 'test' }
const speak = { actionId: 'a', actorId, actionType: 'speak', actionVersion: 1, parameters: { text: 'hi' } }
const move = { ...speak, actionId: 'z', actionType: 'move', parameters: { locationId: 'room' } }
const payload = (actions: unknown[] = [move, speak]) => ({ schemaVersion: 4, decision: 'act', actions })
const validator = new SubmitActionsValidator()

describe('submit_actions/v4', () => {
  it('preserves original step order, binds closed cues, and supports abstention and reflection', () => {
    const result = validator.validateV4(payload([{ ...move, manifestation: { independent: ['frown'], onSuccess: ['slow_walk'] } }, speak]), auth)
    expect(result.proposal.actions).toEqual([move, speak])
    expect(result.proposal.actionGroup?.manifestations).toEqual([{ independent: ['frown'], onSuccess: ['slow_walk'] }, null])
    expect(validator.validateV4({ schemaVersion: 4, decision: 'abstain', actions: [] }, auth).proposal.actions).toEqual([])
    expect(validator.validateV4({ ...payload([speak]), reflection: { operations: [] } }, auth).reflectionOperations).toEqual([])
    expect(validator.validateV4(payload([{ ...speak, manifestation: { independent: [], onSuccess: ['smile', 'quiet_voice'] } }]), auth).proposal.actions).toEqual([speak])
    expect(validator.validateV4(payload([speak, move]), auth).proposal.actions).toEqual([speak, move])
    expect(validator.validateV4(payload([{ ...move, actionType: 'take' }]), auth).proposal.actions).toHaveLength(1)
  })

  it('collapses a cue repeated across both lists and an empty pair instead of failing the step', () => {
    const group = (manifestation: Record<string, unknown>): unknown =>
      validator.validateV4(payload([{ ...speak, manifestation }]), auth).proposal.actionGroup?.manifestations
    // `independent` already declares the cue plays whatever the outcome, so the repeat never carried a
    // second cue: the collapsed binding is identical to the one a model produces when it gets it right.
    expect(group({ independent: ['smile'], onSuccess: ['smile'] }))
      .toEqual(group({ independent: ['smile'], onSuccess: [] }))
    expect(group({ independent: ['smile', 'nod'], onSuccess: ['smile', 'quiet_voice'] }))
      .toEqual([{ independent: ['smile', 'nod'], onSuccess: ['quiet_voice'] }])
    // An empty pair is no manifestation at all, which is exactly how every consumer reads it.
    expect(group({ independent: [], onSuccess: [] })).toEqual([null])
    // Only a repeat across the two lists is collapsed; a repeat inside one list stays a violation.
    expect(() => group({ independent: ['smile', 'smile'], onSuccess: [] })).toThrow()
    expect(() => group({ independent: [], onSuccess: ['smile', 'smile'] })).toThrow()
  })

  it('rejects invalid shapes, unsupported combinations and narration masquerading as a cue', () => {
    const invalid = [null, { ...payload(), schemaVersion: 3 }, { ...payload(), decision: 'other' },
      { ...payload(), actions: null }, payload([move, speak, move]), payload([]),
      payload([move, { ...move, actionId: 'other' }]), payload([speak, { ...speak, actionId: 'other' }]),
      payload([{ ...speak, actionType: 'other' }]), { ...payload(), manifestation: {} },
      { ...payload(), reflection: { operations: [{}] } },
      ...[null, {},
        { independent: null, onSuccess: [] }, { independent: Array(9).fill('smile'), onSuccess: [] },
        { independent: [1], onSuccess: [] }, { independent: ['走进厨房'], onSuccess: [] },
        { independent: ['quiet_voice'], onSuccess: [] }, { independent: [], onSuccess: ['slow_walk'] },
      ].map(manifestation => payload([{ ...speak, manifestation }])),
    ]
    for (const value of invalid) expect(() => validator.validateV4(value, auth)).toThrow()
    expect(() => validator.validateV4(payload(), { ...auth, maxActions: 1 })).toThrow()
  })
})

it('gates object interactions to v5 and retains the one-world-operation bound', () => {
  const authorization = { ...auth, allowedActionTypes: [...auth.allowedActionTypes, 'interact'] }
  const interact = { ...move, actionType: 'interact', parameters: { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} } }
  const v5 = { schemaVersion: 5, decision: 'act', actions: [interact, speak] }
  expect(validator.validateV5(v5, authorization).proposal.actions).toEqual([interact, speak])
  expect(() => validator.validateV4({ ...v5, schemaVersion: 4 }, authorization)).toThrow('unsupported group action')
  expect(() => validator.validateV5({ ...v5, actions: [{ ...interact, actionType: 'take' }] }, authorization)).toThrow('unsupported group action')
  expect(() => validator.validateV5({ ...v5, actions: [interact, { ...move, actionId: 'other' }] }, authorization)).toThrow('exactly one speech')
  expect(() => validator.validateV5({ ...v5, schemaVersion: 4 }, authorization)).toThrow('must be 5')
})

describe('submit_actions/v6', () => {
  // The frozen protocol: the interaction step names a binding and a definition lock, which is why its
  // action version is above one and why the group it produces declares the v2 policy.
  const authorization = { ...auth, allowedActionTypes: ['speak', 'move', 'interact'] }
  const interact = { actionId: 'i', actorId, actionType: 'interact', actionVersion: 2,
    parameters: { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:cup-take',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {} } }
  const payload6 = (actions: unknown[] = [interact, speak]) => ({ schemaVersion: 6, decision: 'act', actions })

  it('accepts the frozen step and declares the policy it was validated under', () => {
    const result = validator.validateV6(payload6(), authorization)
    expect(result.proposal.actions).toEqual([interact, speak])
    expect(result.proposal.actionGroup?.version).toBe('bounded-action-group/v2')
    expect(validator.validateV6({ schemaVersion: 6, decision: 'abstain', actions: [] }, authorization).proposal.actions).toEqual([])
  })

  it('requires each frozen action at its exact version and refuses the neighbouring schema version', () => {
    expect(() => validator.validateV6(payload6([{ ...interact, actionVersion: 3 }, speak]), authorization))
      .toThrow('interact actionVersion must be 2')
    expect(() => validator.validateV6(payload6([{ ...interact, actionVersion: 1 }, speak]), authorization))
      .toThrow('interact actionVersion must be 2')
    expect(() => validator.validateV6(payload6([{ ...interact, actionType: 'move', actionVersion: 2 }, speak]), authorization))
      .toThrow('move actionVersion must be 1')
    // `take` is authorized here on purpose, so the refusal comes from the protocol rather than from
    // the participant's own allowance.
    expect(() => validator.validateV6(payload6([{ ...interact, actionType: 'take', actionVersion: 1 }, speak]),
      { ...authorization, allowedActionTypes: ['speak', 'move', 'interact', 'take'] }))
      .toThrow('unsupported group action')
    expect(() => validator.validateV6({ ...payload6(), schemaVersion: 5 }, authorization)).toThrow('must be 6')
    // V5 still refuses version 2, so the two protocols cannot borrow each other's steps.
    expect(() => validator.validateV5({ ...payload6(), schemaVersion: 5 }, authorization))
      .toThrow('interact actionVersion must be 1')
  })

  it('refuses legacy manifestation on a frozen interaction step', () => {
    expect(() => validator.validateV6(payload6([{ ...interact,
      manifestation: { independent: ['smile'], onSuccess: [] } }, speak]), authorization))
      .toThrow('submit_actions/v6 interaction manifestation is not supported')
    expect(() => validator.validateV6(payload6([{ ...interact,
      manifestation: { independent: [], onSuccess: [] } }, speak]), authorization))
      .toThrow('submit_actions/v6 interaction manifestation is not supported')
  })
})
