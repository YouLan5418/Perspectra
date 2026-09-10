import { expect, it } from 'vitest'
import { availableInteractions, parseInteractionCatalog, resolveInteraction } from './interactions.ts'
import { currentEntityState, SpeakMoveRulebook, type RulebookEvent } from './rulebook.ts'
import { runtimeManifestFromStored } from './world-spec.ts'
import { createCoreRulebookRegistry } from './rulebook-registry.ts'
import { interactionWorld } from '../../../tests/fixtures/interaction-world.ts'
import type { WorldJsonValue } from '@harness-world/contracts'

const actor = 'character:npc'
const world = interactionWorld(true)
const initial = world.genesisEvents
const manifest = world.manifest
const params = (operation: string, args: WorldJsonValue = {}) => ({ targetId: 'entity:cup', interactionId: `core:${operation}`, arguments: args })
const catalog = { version: 'object-interactions/v1', definitions: [{ interactionId: 'core:take', label: '拿取', operation: 'take' }], bindings: [{ entityId: 'entity:cup', interactionIds: ['core:take'] }] }

it('strictly validates and normalizes creator catalogs and version gates', () => {
  expect(parseInteractionCatalog(catalog, ['entity:cup'])).toEqual(catalog)
  expect(runtimeManifestFromStored(manifest)).toEqual(manifest)
  expect(() => runtimeManifestFromStored({ ...manifest, schemaVersion: 7 })).toThrow('requires Manifest v8')
  expect(parseInteractionCatalog({ ...catalog, definitions: [{ ...catalog.definitions[0]!, interactionId: 'pack:collect' }], bindings: [] }, [])).toMatchObject({ definitions: [{ interactionId: 'pack:collect' }] })
  const invalid: WorldJsonValue[] = [null, [], {}, { ...catalog, extra: true }, { ...catalog, version: 'v2' }, { ...catalog, definitions: null }, { ...catalog, bindings: null },
    { ...catalog, definitions: Array(129).fill(catalog.definitions[0]) }, { ...catalog, bindings: Array(4097).fill(catalog.bindings[0]) },
    ...[null, {}, { ...catalog.definitions[0], interactionId: '' }, { ...catalog.definitions[0], label: 1 }, { ...catalog.definitions[0], label: '' }, { ...catalog.definitions[0], label: ' x' }, { ...catalog.definitions[0], label: 'x'.repeat(129) }, { ...catalog.definitions[0], operation: 'kill' }, { ...catalog.definitions[0], interactionId: 'core:give' }].map(value => ({ ...catalog, definitions: [value] })),
    { ...catalog, definitions: [...catalog.definitions, ...catalog.definitions] }, { ...catalog, bindings: [...catalog.bindings, ...catalog.bindings] },
    ...[null, {}, { entityId: '', interactionIds: [] }, { entityId: 'missing', interactionIds: [] }, { entityId: 'entity:cup', interactionIds: null }, { entityId: 'entity:cup', interactionIds: [1] }, { entityId: 'entity:cup', interactionIds: ['missing'] }, { entityId: 'entity:cup', interactionIds: ['core:take', 'core:take'] }].map(value => ({ ...catalog, bindings: [value] })),
  ]
  for (const value of invalid) expect(() => parseInteractionCatalog(value, ['entity:cup'])).toThrow()
})

it('revalidates possession through take, give, drop and a competing stale proposal', () => {
  const events: RulebookEvent[] = [...initial]
  const take = resolveInteraction(manifest, events, actor, params('take'))
  expect(take.status).toBe('accepted')
  events.push(...take.events)
  expect(resolveInteraction(manifest, events, 'character:bob', params('take')).reason).toBe('ITEM_NOT_AVAILABLE')
  expect(availableInteractions(manifest, events, 'character:bob').some(value => value.targetId === 'entity:cup')).toBe(false)
  expect(availableInteractions(manifest, events, actor)).toContainEqual({ ...params('give', { recipientId: 'character:player' }), label: 'give' })
  const give = resolveInteraction(manifest, events, actor, params('give', { recipientId: 'character:player' }))
  expect(give.status).toBe('accepted'); events.push(...give.events)
  expect(currentEntityState(events, 'entity:cup')?.holderId).toBe('character:player')
  const drop = resolveInteraction(manifest, events, 'character:player', params('drop'))
  expect(drop.status).toBe('accepted'); events.push(...drop.events)
  expect(currentEntityState(events, 'entity:cup')).toMatchObject({ holderId: null, locationId: 'location:room' })
  expect(resolveInteraction(manifest, events, actor, params('take')).status).toBe('accepted')
  const customCatalog = parseInteractionCatalog({ version: 'object-interactions/v1', definitions: [{ interactionId: 'travel:collect', label: '收好', operation: 'take' }], bindings: [{ entityId: 'entity:cup', interactionIds: ['travel:collect'] }] }, ['entity:cup'])
  expect(resolveInteraction({ ...manifest, interactionCatalog: customCatalog }, events, actor, { ...params('take'), interactionId: 'travel:collect' })).toMatchObject({ status: 'accepted', events: [{ data: { interactionId: 'travel:collect', toHolderId: actor } }] })
  const registry = createCoreRulebookRegistry().resolve('builtin:speak-move', 2, 'test')
  expect(registry.affordances({ manifest, events, characterId: actor })).toContainEqual({ actionType: 'interact', actionVersion: 1, interactions: availableInteractions(manifest, events, actor) })
  const rules = new SpeakMoveRulebook()
  expect(rules.resolve(manifest, events, actor, { actionType: 'interact', parameters: params('take') }).status).toBe('accepted')
  expect(rules.resolve(manifest, events, actor, { actionType: 'take', parameters: { entityId: 'entity:cup' } }).status).toBe('rejected')
  expect(rules.resolve(manifest, events, actor, { actionType: 'speak', parameters: { text: 'hi' } }).status).toBe('accepted')
})

it('rejects malformed, unbound, unavailable and invalid recipient attempts without public feedback', () => {
  for (const input of [null, {}, { ...params('take'), targetId: 1 }, { ...params('take'), interactionId: 1 }, { ...params('take'), targetId: 'missing' }, params('unknown'), params('take', null), params('take', { extra: true })]) {
    expect(resolveInteraction(manifest, initial, actor, input)).toMatchObject({ status: 'rejected', observationScope: { scope: 'self' } })
  }
  const noBinding = { ...manifest, interactionCatalog: { ...manifest.interactionCatalog as any, bindings: [{ entityId: 'entity:cup', interactionIds: [] }] } }
  expect(resolveInteraction(noBinding, initial, actor, params('take')).reason).toBe('INTERACTION_NOT_BOUND')
  expect(resolveInteraction(manifest, [], actor, params('take')).reason).toBe('ITEM_NOT_AVAILABLE')
  expect(resolveInteraction(manifest, initial.filter(e => !(e.eventType === 'character.created' && (e.data as any).characterId === actor)), actor, params('take')).reason).toBe('ITEM_NOT_AVAILABLE')
  const distant = [...initial, { eventType: 'character.moved', data: { characterId: actor, toLocationId: 'location:next' } }]
  expect(resolveInteraction(manifest, distant, actor, params('take')).reason).toBe('ITEM_NOT_AVAILABLE')
  expect(availableInteractions(manifest, distant, actor)).toEqual([])
  expect(availableInteractions(manifest, [], actor)).toEqual([])
  expect(availableInteractions(manifest, initial.filter(e => e.eventType !== 'entity.upsert'), actor)).toEqual([])
  const held = [...initial, ...resolveInteraction(manifest, initial, actor, params('take')).events]
  for (const recipientId of [1, actor, 'missing']) expect(resolveInteraction(manifest, held, actor, params('give', { recipientId })).reason).toBe('RECIPIENT_NOT_AVAILABLE')
  for (const event of [{ eventType: 'character.lifecycle-changed', data: { characterId: 'character:bob', lifecycleState: 'dead' } }, { eventType: 'character.moved', data: { characterId: 'character:bob', toLocationId: 'location:next' } }]) {
    expect(resolveInteraction(manifest, [...held, event], actor, params('give', { recipientId: 'character:bob' })).reason).toBe('RECIPIENT_NOT_AVAILABLE')
  }
  expect(resolveInteraction(manifest, initial, actor, params('give', { recipientId: 'character:bob' })).reason).toBe('ITEM_NOT_AVAILABLE')
})

it('fails closed on corrupt transfer prefixes and exclusive destination violations', () => {
  const transfer = resolveInteraction(manifest, initial, actor, params('take')).events[0]!
  expect(() => currentEntityState([transfer], 'entity:cup')).toThrow()
  for (const patch of [{ fromLocationId: 'wrong' }, { fromHolderId: 'wrong' }, { characterId: null }, { interactionId: null }, { toLocationId: 'location:room' }, { toLocationId: 1 }, { toHolderId: null }, { toHolderId: 1 }]) {
    expect(() => currentEntityState([...initial, { ...transfer, data: { ...transfer.data as any, ...patch } }], 'entity:cup')).toThrow()
  }
})
