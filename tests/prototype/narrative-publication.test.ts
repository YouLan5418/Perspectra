import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SpeakMoveRulebook, currentLocation, currentEntityState } from '../../packages/kernel/src/rulebook.ts'
import { SubmitActionsValidator } from '../../packages/agents/src/submit-actions.ts'
import { brandId, interactionPackageDescription } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'

it('publishes silent expression without granting movement, possession, or a new observation scope', async () => {
  const pack = await compileWorldPackSource(resolve('examples/world-packs/prototype-g1'), [
    interactionPackageDescription(createBasicInteractionPackage()),
  ])
  const world = adaptCompiledWorldPack(pack, {
    address: { tenantId: brandId('tenant:narrative-test', 'TenantId'),
      worldId: brandId('world:narrative-test', 'WorldId'), branchId: brandId('branch:main', 'BranchId') },
    principalId: 'principal:player', sessionId: brandId('session:narrative-test', 'SessionId'),
  })
  const rules = new SpeakMoveRulebook()
  const actor = 'character:companion'
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
  expect(currentEntityState(after, 'entity:brass-key')).toEqual(currentEntityState(before, 'entity:brass-key'))
  expect(rules.resolve(world.manifest, after, actor, {
    actionType: 'interact', parameters: {
      targetRef: { kind: 'entity', id: 'entity:brass-key' }, bindingId: 'binding:key-give',
      definitionRef: { id: 'base:give', version: 1 }, arguments: { recipientId: 'character:player' },
    },
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
