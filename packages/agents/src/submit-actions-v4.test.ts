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

  it('rejects invalid shapes, unsupported combinations and narration masquerading as a cue', () => {
    const invalid = [null, { ...payload(), schemaVersion: 3 }, { ...payload(), decision: 'other' },
      { ...payload(), actions: null }, payload([move, speak, move]), payload([]),
      payload([move, { ...move, actionId: 'other' }]), payload([speak, { ...speak, actionId: 'other' }]),
      payload([{ ...speak, actionType: 'other' }]), { ...payload(), manifestation: {} },
      { ...payload(), reflection: { operations: [{}] } },
      ...[null, {}, { independent: [], onSuccess: [] },
        { independent: null, onSuccess: [] }, { independent: Array(9).fill('smile'), onSuccess: [] },
        { independent: [1], onSuccess: [] }, { independent: ['走进厨房'], onSuccess: [] },
        { independent: ['quiet_voice'], onSuccess: [] }, { independent: [], onSuccess: ['slow_walk'] },
        { independent: ['smile'], onSuccess: ['smile'] },
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
