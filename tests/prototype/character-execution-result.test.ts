import { expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

const world = frozenInteractionWorld()
const actorId = brandId('character:npc', 'CharacterId')
const input = { manifest: world.manifest, events: world.genesisEvents, actorId,
  action: { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:cup' } } },
  status: 'rejected', reason: 'PARTICIPANT_NOT_AUTHORIZED' }
const transfer = { eventType: 'entity.transferred', eventVersion: 1, data: {
  characterId: 'character:player', entityId: 'entity:cup', interactionId: 'base:take', fromHolderId: null,
  fromLocationId: 'location:room', toHolderId: 'character:player', toLocationId: null,
} }

it('names the known holder without exposing the diagnostic code', () => {
  const result = characterExecutionResult({ ...input, events: [...input.events, transfer,
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'visible-transfer', value: {
      observerId: actorId, content: { interaction: transfer.data },
    } } },
  ] })
  expect(result.description).toContain('Player')
  expect(result.description).toContain('没有成功取得它的保管')
  expect(JSON.stringify(result)).not.toContain('PARTICIPANT_NOT_AUTHORIZED')
})

it('does not reveal an unobserved holder or invent a refusal of consent', () => {
  const result = characterExecutionResult({ ...input, events: [...input.events, transfer] })
  expect(result.description).not.toMatch(/Player|同意|权限/)
})

it.each([
  ['NOT_CO_LOCATED', '不在同一个地方'], ['ITEM_NOT_HELD', '不由你保管'],
  ['CONSENT_REQUIRED', '尚未获得同意'], ['CONSENT_DENIED', '没有同意'],
])('keeps the concrete meaning of %s', (reason, expected) => {
  expect(characterExecutionResult({ ...input, reason }).description).toContain(expected)
})

it('describes an absent target without claiming omniscient knowledge of hidden locations', () => {
  expect(characterExecutionResult({ ...input, action: { ...input.action,
    parameters: { targetRef: { kind: 'entity', id: 'entity:absent' } } } }).description).toContain('你面前找不到')
})

it('describes the actual completed take and remaining own possession', () => {
  const ownTake = { ...transfer, data: { ...transfer.data, toHolderId: actorId, characterId: actorId } }
  expect(characterExecutionResult({ ...input, events: [...input.events, ownTake], status: 'accepted', reason: null,
    action: { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:cup' },
      definitionRef: { id: 'base:take', version: 1 } } } }).description)
    .toBe('你刚刚成功取得保管（物品：entity:cup）。该物品目前仍由你保管；不要求一直握在手里。')
})
