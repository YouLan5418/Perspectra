import { expect, it } from 'vitest'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { characterVisibleItems } from '../../packages/application/src/character-visible-items.ts'
import { characterRequestText } from '../../packages/provider-chat/src/character-context-text.ts'
import { frozenInteractionWorld } from '../fixtures/frozen-interaction-world.ts'

const f = frozenInteractionWorld(), actor = brandId('character:npc', 'CharacterId'), player = brandId('character:player', 'CharacterId')
const manifest = { ...f.manifest, entities: f.manifest.entities.map(e => ({ ...e, name: e.entityId === 'entity:cup' ? '黄铜钥匙' : '银色钥匙' })) }
const take = { eventType: 'entity.transferred', data: { characterId: player, entityId: 'entity:cup', interactionId: 'base:take',
  fromHolderId: null, fromLocationId: 'location:room', toHolderId: player, toLocationId: null } }
const seen = { eventType: 'observation.upsert', data: { id: 'seen', value: { observerId: actor,
  content: { status: 'accepted', interaction: take.data } } } }
const render = (events: Parameters<typeof characterVisibleItems>[1], extra: WorldJsonObject = {}) => {
  const items = characterVisibleItems(manifest, events, actor, [actor, player])
  const request = { context: { character: { characterId: actor, locationId: 'location:room' }, items, ...extra }, continuation: false }
  const before = JSON.stringify(request), rendered = JSON.parse(characterRequestText(request))
  expect(JSON.stringify(request)).toBe(before)
  expect(JSON.stringify(items)).not.toContain('narrativeBoundary')
  return rendered
}
const cup = (rows: { entityId: string; narrativeBoundary: string }[]) => rows.find(r => r.entityId === 'entity:cup')!

it('anchors only current authorized possession, preserving names and allowing ordinary contact and subjective speech', () => {
  const known = render([...f.genesisEvents, take, seen]).context.items
  expect(cup(known.current)).toMatchObject({ name: '黄铜钥匙', holderId: player })
  expect(cup(known.current).narrativeBoundary).toContain('当前不由你保管')
  expect(known.narrativeBoundaryNote).toContain('仍可误认、说谎')
  expect(known.narrativeBoundaryNote).toContain('临时托起查看')
  expect(cup(render(f.genesisEvents).context.items.current).narrativeBoundary).toContain('当前不由你保管')
})

it('refreshes the anchor after the character legally receives the item', () => {
  const before = [...f.genesisEvents, take, seen]
  const give = { eventType: 'entity.transferred', data: { ...take.data, interactionId: 'base:give', fromHolderId: player,
    fromLocationId: null, toHolderId: actor, toLocationId: null } }
  expect(cup(render(before).context.items.current).narrativeBoundary).toContain('当前不由你保管')
  expect(cup(render([...before, give]).context.items.current).narrativeBoundary).toContain('当前由你保管')
})

it('does not turn an unseen transfer or a player mention into a negative possession fact', () => {
  const rendered = render([...f.genesisEvents, take], { stimulus: [{ content: { text: '黄铜钥匙在你口袋里。' } }] })
  expect(rendered.context.items.current.some((row: { entityId: string }) => row.entityId === 'entity:cup')).toBe(false)
  expect(rendered.context.items.lastObserved).toEqual([])
  // Only the other, visible item gets a row; there is no keyed negative for the mentioned key.
  expect(JSON.stringify(rendered.context.items)).not.toContain('entity:cup')
  expect(rendered.context.items.narrativeBoundaryNote).toContain('未列出的物品不代表你已知')
})

it('keeps history uncertain and does not disclose an unseen later holder', () => {
  const hidden = { eventType: 'entity.transferred', data: { ...take.data, fromHolderId: player,
    fromLocationId: null, toHolderId: 'character:hidden' } }
  const rendered = render([...f.genesisEvents, take, seen, hidden]).context.items
  expect(cup(rendered.lastObserved).narrativeBoundary).toContain('当前归属与位置未确认')
  expect(cup(rendered.lastObserved).narrativeBoundary).not.toContain('不由你保管')
  expect(JSON.stringify(rendered)).not.toContain('character:hidden')
})

it('does not announce a secret loss as known non-possession or overwrite a mistaken belief', () => {
  const own = { ...take, data: { ...take.data, characterId: actor, toHolderId: actor } }
  const ownSeen = { ...seen, data: { ...seen.data, value: { ...seen.data.value, content: { status: 'accepted', interaction: own.data } } } }
  const stolen = { ...take, data: { ...take.data, fromHolderId: actor, fromLocationId: null, toHolderId: 'character:hidden' } }
  const cognition = { claims: [{ value: { text: '我认为钥匙仍在自己的口袋里。' } }] }
  const rendered = render([...f.genesisEvents, own, ownSeen, stolen], { cognition })
  expect(cup(rendered.context.items.lastObserved).narrativeBoundary).toContain('未确认')
  expect(cup(rendered.context.items.lastObserved).narrativeBoundary).not.toContain('不由你保管')
  expect(JSON.stringify(rendered)).not.toContain('character:hidden')
  expect(JSON.stringify(rendered.context.cognition)).toContain('我认为钥匙仍在自己的口袋里')
})
