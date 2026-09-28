import { expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { characterVisibleItems } from '../../packages/application/src/character-visible-items.ts'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

const fixture = frozenInteractionWorld()
const world = { ...fixture, manifest: { ...fixture.manifest, entities: fixture.manifest.entities.filter(entity => entity.entityId === 'entity:cup') } }
const actor = brandId('character:npc', 'CharacterId'), player = brandId('character:player', 'CharacterId')
const transfer = { eventType: 'entity.transferred', eventVersion: 1, data: {
  characterId: player, entityId: 'entity:cup', interactionId: 'base:take', fromHolderId: null,
  fromLocationId: 'location:room', toHolderId: player, toLocationId: null,
} }
const observation = { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'seen', value: {
  observerId: actor, content: { status: 'accepted', interaction: transfer.data,
    resultDescription: '我看见玩家拿起杯子。' },
} } }
const events = [...world.genesisEvents, transfer, observation]
it('shows witnessed possession only while the holder remains visible in the same place', () => {
  expect(characterVisibleItems(world.manifest, events, actor, [actor, player]).current)
    .toContainEqual({ entityId: 'entity:cup', holderId: player, locationId: null })
  const away = [...events, { eventType: 'character.moved', eventVersion: 1,
    data: { characterId: player, fromLocationId: 'location:room', toLocationId: 'location:elsewhere' } }]
  const result = characterVisibleItems(world.manifest, away, actor, [actor, player])
  expect(result.current).toEqual([])
  expect(result.lastObserved).toMatchObject([{ entityId: 'entity:cup', holderId: player,
    lastObservedDescription: '我看见玩家拿起杯子。' }])
  expect(characterVisibleItems(world.manifest, events, actor, [actor]).current).toEqual([])
})
it('does not reveal an unseen transfer, even when its holder is present', () => {
  expect(characterVisibleItems(world.manifest, [...world.genesisEvents, transfer], actor, [actor, player]))
    .toEqual({ current: [], lastObserved: [] })
  const hiddenTransfer = { eventType: 'entity.transferred', eventVersion: 1, data: {
    ...transfer.data, fromHolderId: player, fromLocationId: null, toHolderId: 'character:hidden',
  } }
  const result = characterVisibleItems(world.manifest, [...events, hiddenTransfer], actor, [actor, player])
  expect(result.current).toEqual([])
  expect(result.lastObserved).toMatchObject([{ holderId: player }])
  expect(JSON.stringify(result)).not.toContain('character:hidden')
})
it('does not turn dialogue into a possession fact', () => {
  const speech = { ...observation, data: { id: 'claim', value: { observerId: actor,
    content: { status: 'accepted', speech: { text: '杯子一直在我手里。' } } } } }
  expect(characterVisibleItems(world.manifest, [...events, speech], actor, [actor, player]).current)
    .toContainEqual({ entityId: 'entity:cup', holderId: player, locationId: null })
})
