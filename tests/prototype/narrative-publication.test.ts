import { expect, it } from 'vitest'
import { SpeakMoveRulebook, currentLocation, currentEntityState } from '../../packages/kernel/src/rulebook.ts'
import { SubmitActionsValidator } from '../../packages/agents/src/submit-actions.ts'
import { brandId } from '@harness-world/contracts'
import { interactionWorld } from '../fixtures/interaction-world.ts'

it('publishes silent expression without granting movement, possession, or a new observation scope', () => {
  const world = interactionWorld(true)
  const rules = new SpeakMoveRulebook()
  const actor = 'character:npc'
  const before = world.genesisEvents
  const narration = '我已经走进下一间房，把杯子收进了口袋。'
  const result = rules.resolve(world.manifest, before, actor, {
    actionType: 'speak', parameters: { text: '', narration, scope: 'private', addresseeIds: ['character:player'],
      narrationNote: '', statePatch: { holderId: actor, locationId: 'elsewhere' } },
  })
  expect(result.status).toBe('accepted')
  expect(result.events).toHaveLength(1)
  expect(JSON.stringify(result.events)).not.toMatch(/statePatch|narrationNote|elsewhere/)
  expect(result.events[0]).toMatchObject({ eventType: 'character.speak', data: { text: '', narration } })
  expect(result.observationScope).toEqual({ scope: 'private', recipientIds: ['character:player'] })
  const after = [...before, ...result.events]
  expect(currentLocation(after, actor)).toBe(currentLocation(before, actor))
  expect(currentEntityState(after, 'entity:cup')).toEqual(currentEntityState(before, 'entity:cup'))
  expect(rules.resolve(world.manifest, after, actor, {
    actionType: 'interact', parameters: { targetId: 'entity:cup', interactionId: 'core:give', arguments: { recipientId: 'character:player' } },
  }).status).toBe('rejected')
  expect(rules.resolve(world.manifest, before, actor, { actionType: 'speak', parameters: { text: '', narration: '' } }).status).toBe('rejected')
  expect(rules.resolve(world.manifest, before, actor, { actionType: 'speak', parameters: { text: '', narration: { locationId: 'elsewhere' } } }).status).toBe('rejected')
})

it('accepts two expressions without requiring a world operation', () => {
  const actor = brandId('character:npc', 'CharacterId')
  const actions = ['抿住唇角。', '又忍不住笑出声。'].map((narration, index) => ({
    actionId: `expression:${index}`, actorId: actor, actionType: 'speak', actionVersion: 1,
    parameters: { text: '', narration },
  }))
  const auth = { actorId: actor, participantId: 'agent:npc', allowedActionTypes: ['speak', 'move', 'interact'],
    maxActions: 2, maxReflectionOperations: 0, correlationId: 'two-expressions' }
  const validate = (steps: unknown[]) => new SubmitActionsValidator().validateV7({ schemaVersion: 7, decision: 'act', actions: steps }, auth)
  expect(validate(actions).proposal.actions).toEqual(actions)
  expect(() => validate([...actions, { ...actions[0], actionId: 'third' }])).toThrow()
  expect(() => validate(actions.map(action => ({ ...action, actionType: 'move', parameters: { locationId: 'elsewhere' } })))).toThrow('at most one world operation')
})
