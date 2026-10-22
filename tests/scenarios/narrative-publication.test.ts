import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SpeakMoveRulebook, currentLocation, currentEntityState } from '../../packages/kernel/src/rulebook.ts'
import { brandId, interactionPackageDescription, parseExpressionSegments } from '@harness-world/contracts'
import { createItemCustodyTestPackage } from '../fixtures/item-custody-package.ts'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'
import type { WorldEventDraft } from '@harness-world/contracts'

it.each(['direct', 'private'])('rejects every recipient of %s speech when any target is unreachable', scope => {
  const world = frozenInteractionWorld(),
    rules = new SpeakMoveRulebook()
  const speak = (events: readonly WorldEventDraft[], addresseeIds = ['character:npc']) =>
    rules.resolve(world.manifest, events, 'character:player', {
      actionType: 'speak',
      parameters: { text: '未送达的秘密', scope, addresseeIds },
    })
  expect(speak(world.genesisEvents).status).toBe('accepted')
  const unavailable: WorldEventDraft[][] = [
    [
      {
        eventType: 'character.moved',
        eventVersion: 1,
        data: { characterId: 'character:npc', toLocationId: 'location:next' },
      },
    ],
    [
      {
        eventType: 'scene.member_left',
        eventVersion: 1,
        data: { sceneId: 'scene:room', characterId: 'character:npc' },
      },
    ],
    [
      {
        eventType: 'character.lifecycle-changed',
        eventVersion: 1,
        data: { characterId: 'character:npc', lifecycleState: 'departed' },
      },
    ],
    [
      {
        eventType: 'visibility.upsert',
        eventVersion: 1,
        data: { id: 'hidden-npc', value: { sceneId: 'scene:room', observerId: 'character:npc', visible: false } },
      },
    ],
  ]
  for (const extra of unavailable) {
    const prefix = [...world.genesisEvents, ...extra]
    for (const recipients of [['character:npc'], ['character:bob', 'character:npc']]) {
      const result = speak(prefix, recipients)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: 'SPEECH_RECIPIENT_UNREACHABLE',
        observationScope: { scope: 'self' },
      })
      expect(result.events.map(event => event.eventType)).toEqual(['action.rejected'])
      expect(JSON.stringify(result)).not.toContain('未送达的秘密')
    }
  }
})

it('publishes silent expression without granting movement, possession, or a new observation scope', async () => {
  const pack = await compileWorldPackSource(resolve('examples/world-packs/prototype-g1'), [
    interactionPackageDescription(createItemCustodyTestPackage()),
  ])
  const world = adaptCompiledWorldPack(pack, {
    address: {
      tenantId: brandId('tenant:narrative-test', 'TenantId'),
      worldId: brandId('world:narrative-test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
    principalId: 'principal:player',
    sessionId: brandId('session:narrative-test', 'SessionId'),
  })
  const rules = new SpeakMoveRulebook()
  const actor = 'character:companion'
  const before = world.genesisEvents
  const narration = '我已经走进下一间房，把杯子收进了口袋。'
  const result = rules.resolve(world.manifest, before, actor, {
    actionType: 'speak',
    parameters: {
      text: '',
      narration,
      scope: 'private',
      addresseeIds: ['character:player'],
      narrationNote: '',
      statePatch: { holderId: actor, locationId: 'elsewhere' },
    },
  })
  expect(result.status).toBe('accepted')
  expect(result.events).toHaveLength(1)
  expect(JSON.stringify(result.events)).not.toMatch(/statePatch|narrationNote|elsewhere/)
  expect(result.events[0]).toMatchObject({ eventType: 'character.speak', data: { text: '', narration } })
  expect(result.observationScope).toEqual({ scope: 'private', recipientIds: ['character:player'] })
  const after = [...before, ...result.events]
  expect(currentLocation(after, actor)).toBe(currentLocation(before, actor))
  expect(currentEntityState(after, 'entity:brass-key')).toEqual(currentEntityState(before, 'entity:brass-key'))
  expect(
    rules.resolve(world.manifest, after, actor, {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:brass-key' },
        bindingId: 'binding:key-give',
        definitionRef: { id: 'base:give', version: 1 },
        arguments: { recipientId: 'character:player' },
      },
    }).status,
  ).toBe('rejected')
  expect(
    rules.resolve(world.manifest, before, actor, { actionType: 'speak', parameters: { text: '', narration: '' } })
      .status,
  ).toBe('rejected')
  expect(
    rules.resolve(world.manifest, before, actor, {
      actionType: 'speak',
      parameters: { text: '', narration: { locationId: 'elsewhere' } },
    }).status,
  ).toBe('rejected')
})

it('accepts two expressions without requiring a world operation', () => {
  const segments = ['抿住唇角。', '又忍不住笑出声。'].map(text => ({ type: 'narration', text }))
  expect(parseExpressionSegments(segments)).toEqual(segments)
  expect(() => parseExpressionSegments([{ type: 'move', text: '走到后室。' }])).toThrow()
})
