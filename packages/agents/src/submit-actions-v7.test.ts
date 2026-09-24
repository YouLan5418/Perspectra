import { describe, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { SubmitActionsValidator } from './submit-actions.ts'

const actorId = brandId('character:a', 'CharacterId')
const authorization = {
  participantId: 'agent:a', actorId,
  allowedActionTypes: ['speak', 'move', 'interact', 'take'],
  maxActions: 2, maxReflectionOperations: 0, correlationId: 'test:submit-actions-v7',
}
const interact = {
  actionId: 'action:interact', actorId, actionType: 'interact', actionVersion: 2,
  parameters: { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:cup-take',
    definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
}
const speak = { actionId: 'action:speak', actorId, actionType: 'speak', actionVersion: 1,
  parameters: { text: '拿到了' } }
const payload = (actions: unknown[]) => ({ schemaVersion: 7, decision: 'act', actions })
const validator = new SubmitActionsValidator()

describe('current submit_actions/v7', () => {
  it('keeps action order and accepted step manifestations', () => {
    const result = validator.validateV7(payload([
      { ...interact, manifestation: { independent: ['frown'], onSuccess: ['smile'] } }, speak,
    ]), authorization)
    expect(result.proposal.actions).toEqual([interact, speak])
    expect(result.proposal.actionGroup).toEqual({
      version: 'bounded-action-group/v2',
      manifestations: [{ independent: ['frown'], onSuccess: ['smile'] }, null],
    })
  })

  it('permits abstention and an empty reflection result', () => {
    expect(validator.validateV7({ schemaVersion: 7, decision: 'abstain', actions: [] }, authorization)
      .proposal.actions).toEqual([])
    expect(validator.validateV7({ ...payload([speak]), reflection: { operations: [] } }, authorization)
      .reflectionOperations).toEqual([])
  })

  it('rejects retired envelopes, wrong action versions and undeclared world actions', () => {
    expect(() => validator.validateV7({ schemaVersion: 6, decision: 'abstain', actions: [] }, authorization))
      .toThrow('must be 7')
    expect(() => validator.validateV7(payload([{ ...interact, actionVersion: 1 }]), authorization))
      .toThrow('interact actionVersion must be 2')
    expect(() => validator.validateV7(payload([{ ...interact, actionType: 'take', actionVersion: 1 }]), authorization))
      .toThrow('unsupported group action')
  })

  it('rejects interaction performance inside parameters and multiple world operations', () => {
    expect(() => validator.validateV7(payload([{ ...interact,
      parameters: { ...interact.parameters, performance: { independent: ['frown'], onSuccess: [] } },
    }]), authorization)).toThrow('interaction performance belongs in action.manifestation')
    expect(() => validator.validateV7(payload([interact,
      { ...interact, actionId: 'action:other', actionType: 'move', actionVersion: 1 }]), authorization))
      .toThrow('at most one world operation')
  })
})
