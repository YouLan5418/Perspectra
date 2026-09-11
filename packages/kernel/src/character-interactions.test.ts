import { expect, it } from 'vitest'
import { resolutionAuthority, type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { characterInteractionWorld } from '../../../tests/fixtures/character-interaction-world.ts'
import { availableInteractions, currentCharacterRelations, endCharacterRelations, parseInteractionCatalog, resolveInteraction } from './interactions.ts'
import { runtimeManifestFromStored } from './world-spec.ts'
import { WorldBootstrap } from './world-bootstrap.ts'
import type { RulebookEvent } from './rulebook.ts'
import { createCoreRulebookRegistry } from './rulebook-registry.ts'

const world = characterInteractionWorld()
const player = 'character:player'
const npc = 'character:npc'
const params = { targetId: npc, interactionId: 'core:hold-hand', arguments: {} }
const authority = resolutionAuthority('player', 'manual_player_immediate')
const context = { actionId: 'action:first', resolutionAuthority: authority }

it('holds deterministically, limits handles to participants, and permits participant release', () => {
  const hold = resolveInteraction(world.manifest, world.genesisEvents, player, params, context)
  expect(hold.status).toBe('accepted')
  expect(resolveInteraction(world.manifest, world.genesisEvents, player, params, context)).toEqual(hold)
  const events = [...world.genesisEvents, ...hold.events]
  const relation = currentCharacterRelations(events)[0]!
  expect(relation.active).toBe(true)
  expect(resolveInteraction(world.manifest, events, player, params, context).reason).toBe('HAND_HOLD_ALREADY_ACTIVE')
  const release = { targetId: relation.relationId, interactionId: 'core:release-hand', arguments: {} }
  expect(availableInteractions(world.manifest, events, npc)).toContainEqual({ ...release, label: '松开对方的手' })
  expect(JSON.stringify(availableInteractions(world.manifest, events, 'character:bob'))).not.toContain(relation.relationId)
  expect(resolveInteraction(world.manifest, events, 'character:bob', release, context).reason).toBe('NOT_RELATION_PARTICIPANT')
  const ended = resolveInteraction(world.manifest, events, npc, release, { actionId: 'action:release', resolutionAuthority: resolutionAuthority('agent', 'standard') })
  expect(ended.status).toBe('accepted')
  expect(currentCharacterRelations([...events, ...ended.events])[0]?.active).toBe(false)
  expect(resolveInteraction(world.manifest, [...events, ...ended.events], npc, release, context).reason).toBe('HAND_HOLD_NOT_ACTIVE')
})

it('requires Host authority and ends a relation in the successful move resolution', () => {
  const resolver = createCoreRulebookRegistry().resolve('builtin:speak-move', 2, 'character-test')
  const base = { manifest: world.manifest, events: world.genesisEvents, characterId: player, action: { actionType: 'interact', parameters: params } }
  expect(() => resolver.resolve(base)).toThrow('requires Host authority')
  expect(() => resolver.affordances(base)).toThrow('require Host authority')
  expect(() => resolver.resolve({ ...base, ...context, resolutionAuthority: { ...authority, sourceRole: 'agent' } })).toThrow('requires player')
  expect(resolver.resolve({ ...base, ...context, resolutionAuthority: resolutionAuthority('agent', 'standard') }).status).toBe('rejected')
  const hold = resolver.resolve({ ...base, ...context })
  const events = [...world.genesisEvents, ...hold.events]
  const moved = resolver.resolve({ ...base, ...context, events, characterId: npc, action: { actionType: 'move', parameters: { locationId: 'location:next' } } })
  expect(moved.events.map(event => event.eventType)).toEqual(['character.moved', 'character.relation-ended'])
  expect(currentCharacterRelations([...events, ...moved.events])[0]?.active).toBe(false)
})

it('rejects invalid v2 definitions, fixed policies, ambiguous targets and bindings', () => {
  const catalog = world.manifest.interactionCatalog as any
  const definition = catalog.definitions[0]
  const binding = catalog.bindings[0]
  const targets = { entityIds: ['entity:cup'], characterIds: [player, npc], manualCharacterIds: [player] }
  const parse = (value: any) => parseInteractionCatalog(value, targets)
  for (const value of [
    { ...catalog, extra: true }, { ...catalog, definitions: null }, { ...catalog, bindings: null },
    { ...catalog, definitions: Array(129).fill(definition) }, { ...catalog, bindings: Array(4097).fill(binding) },
    ...[null, {}, { ...definition, interactionId: '' }, { ...definition, label: '' }, { ...definition, targetKind: 'relation' },
      { ...definition, operation: 'grapple' }, { ...definition, targetKind: 'entity' }, { ...definition, interactionId: 'core:release-hand' },
      { ...definition, initiationPolicy: undefined }, { ...definition, initiationPolicy: null },
      { ...definition, initiationPolicy: { manualPlayer: 'standard', autonomousCharacter: 'forbidden' } },
      { ...definition, initiationPolicy: { manualPlayer: 'commit_then_react', autonomousCharacter: 'standard' } },
    ].map(value => ({ ...catalog, definitions: [value] })),
    { ...catalog, definitions: [definition, definition] }, { ...catalog, bindings: [binding, binding] },
    ...[null, {}, { ...binding, targetId: '' }, { ...binding, targetId: player }, { ...binding, targetId: 'unknown' },
      { ...binding, targetId: 'entity:cup' }, { ...binding, interactionIds: null },
      { ...binding, interactionIds: [1] }, { ...binding, interactionIds: ['unknown'] },
      { ...binding, interactionIds: ['core:hold-hand', 'core:hold-hand'] },
    ].map(value => ({ ...catalog, bindings: [value] })),
  ]) expect(() => parse(value)).toThrow()
  expect(() => parseInteractionCatalog(catalog, { ...targets, entityIds: [npc] })).toThrow('ambiguous')
  expect(() => parseInteractionCatalog(catalog, [])).toThrow()
  const entity = { interactionId: 'core:take', label: '拿取', targetKind: 'entity', operation: 'take',
    initiationPolicy: { manualPlayer: 'standard', autonomousCharacter: 'standard' } }
  for (const policy of [{ manualPlayer: 'commit_then_react', autonomousCharacter: 'standard' },
    { manualPlayer: 'standard', autonomousCharacter: 'forbidden' }]) {
    expect(() => parse({ ...catalog, definitions: [{ ...entity, initiationPolicy: policy }], bindings: [] })).toThrow('policy is fixed')
  }
  const normalized = parse({ version: 'interaction-catalog/v2', definitions: [definition, entity],
    bindings: [binding, { targetId: 'entity:cup', interactionIds: ['core:take'] }] })
  expect(normalized.version).toBe('interaction-catalog/v2')
  const manifest = { ...world.manifest, interactionCatalog: normalized }
  expect(resolveInteraction(manifest, world.genesisEvents, player,
    { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} }, context).status).toBe('accepted')
  expect(availableInteractions(manifest, world.genesisEvents, player, authority).length).toBeGreaterThan(0)
})

it('fails closed on malformed relation transitions and ends zero, one and multiple relations', () => {
  const start = resolveInteraction(world.manifest, world.genesisEvents, player, params, context).events[0]!
  const data = start.data as any
  for (const patch of [null, {}, { ...data, relationId: '' }, { ...data, relationId: 'bad' },
    { ...data, relationKind: 'grapple' }, { ...data, initiatorId: '' }, { ...data, targetId: '' },
    { ...data, targetId: player }, { ...data, interactionId: '' }, { ...data, sourceActionId: '' }]) {
    expect(() => currentCharacterRelations([{ ...start, data: patch }])).toThrow()
  }
  expect(() => currentCharacterRelations([{ ...start, eventVersion: 2 }])).toThrow()
  expect(() => currentCharacterRelations([start, start])).toThrow()
  expect(() => currentCharacterRelations([start, { ...start, data: { ...data, relationId: 'relation:other', initiatorId: npc, targetId: player } }])).toThrow('duplicate active pair')
  const end = { eventType: 'character.relation-ended', eventVersion: 1,
    data: { relationId: data.relationId, endedByCharacterId: player, reason: 'released' } }
  for (const patch of [{}, { ...end.data, relationId: '' }, { ...end.data, endedByCharacterId: '' },
    { ...end.data, reason: 'unknown' }, { ...end.data, relationId: 'relation:missing' }, { ...end.data, endedByCharacterId: 'character:bob' }]) {
    expect(() => currentCharacterRelations([start, { ...end, data: patch }])).toThrow()
  }
  expect(() => currentCharacterRelations([start, { ...end, eventVersion: 2 }])).toThrow()
  expect(() => currentCharacterRelations([end])).toThrow()
  expect(() => currentCharacterRelations([start, end, end])).toThrow()
  expect(endCharacterRelations([], player, 'participant_unavailable')).toEqual([])
  const second = { ...start, data: { ...data, relationId: 'relation:second', targetId: 'character:bob' } }
  const endings = endCharacterRelations([start, second], player, 'participant_unavailable')
  expect(endings).toHaveLength(2)
  expect(currentCharacterRelations([start, second, ...endings]).every(value => !value.active)).toBe(true)
  expect(endCharacterRelations([start], 'character:bob', 'participant_moved')).toEqual([])
})

it('enforces v9 policy activation and exact catalog version', () => {
  expect(runtimeManifestFromStored(world.manifest)).toEqual(world.manifest)
  const { playerInputPolicy: _, ...withoutPolicy } = world.manifest
  expect(runtimeManifestFromStored(withoutPolicy)).toEqual(withoutPolicy)
  for (const policy of [null, {}, { version: 'unknown' }, { version: 'legacy-speech/v1', extra: true }]) {
    expect(() => runtimeManifestFromStored({ ...world.manifest, playerInputPolicy: policy })).toThrow()
  }
  const intent = { ...world.manifest, playerInputPolicy: { version: 'player-intent/v1' } }
  expect(runtimeManifestFromStored(intent)).toEqual(intent)
  expect(() => new WorldBootstrap({} as never).activate({ ...world, manifest: intent })).toThrow('requires the C3')
  expect(() => runtimeManifestFromStored({ ...world.manifest, interactionCatalog: { version: 'object-interactions/v1', definitions: [], bindings: [] } })).toThrow('requires interaction-catalog/v2')
  expect(() => runtimeManifestFromStored({ ...world.manifest, schemaVersion: 8 })).toThrow('playerInputPolicy')
  const { interactionCatalog: _catalog, actionGroupPolicy: _groups, ...legacy } = withoutPolicy as WorldJsonObject
  expect(() => runtimeManifestFromStored({ ...legacy, schemaVersion: 6, playerInputPolicy: {} } as unknown as WorldJsonValue)).toThrow('playerInputPolicy')
})

it('reconstructs active scenes and rejects corrupt scene transitions', () => {
  const base = world.genesisEvents.filter(event => !event.eventType.startsWith('scene.'))
  const event = (eventType: string, data: any): RulebookEvent => ({ eventType, eventVersion: 1, data })
  const created = event('scene.created', { sceneId: 'scene:test' })
  const active = event('scene.activated', { sceneId: 'scene:test' })
  const closed = event('scene.closed', { sceneId: 'scene:test' })
  const join = (id: string) => event('scene.member_joined', { sceneId: 'scene:test', characterId: id })
  const leave = event('scene.member_left', { sceneId: 'scene:test', characterId: npc })
  const run = (scenes: readonly RulebookEvent[]) => resolveInteraction(world.manifest, [...base, ...scenes], player, params, context)
  const full = [created, active, join(player), join(npc)]
  expect(run(full).status).toBe('accepted')
  expect(run([...full, leave]).reason).toBe('TARGET_NOT_INTERACTABLE')
  expect(run([...full, closed]).reason).toBe('TARGET_NOT_INTERACTABLE')
  expect(run([...full, event('scene.updated', { sceneId: 'scene:test' })]).status).toBe('accepted')
  for (const scenes of [[created, created], [active], [created, closed], [...full, active], [...full, closed, closed],
    [...full, join(npc)], [created, leave], [...full, closed, leave], [created, event('scene.member_joined', { sceneId: 'scene:test' })],
    [event('scene.remove', {})], [event('scene.created', null)], [event('scene.created', {})]]) {
    expect(() => run(scenes)).toThrow('scene')
  }
  const value = { lifecycle: 'active', participantIds: [player, npc] }
  for (const data of [null, {}, { sceneId: 's' }, { sceneId: 's', value: null },
    { sceneId: 's', value: { ...value, lifecycle: 'unknown' } }, { sceneId: 's', value: { ...value, participantIds: null } },
    { sceneId: 's', value: { ...value, participantIds: [1] } }, { sceneId: 's', value: { ...value, participantIds: [player, player] } }]) {
    expect(() => run([event('scene.upsert', data)])).toThrow('scene')
  }
  const upsert = event('scene.upsert', { sceneId: 's', value })
  expect(() => run([upsert, upsert])).toThrow('scene')
  for (const lifecycle of ['created', 'closed']) expect(run([event('scene.upsert', { sceneId: 's', value: { ...value, lifecycle } })]).status).toBe('rejected')
})

it('rejects unavailable and malformed character actions without changing relations', () => {
  const run = (input: any, events: readonly RulebookEvent[] = world.genesisEvents) => resolveInteraction(world.manifest, events, player, input, context)
  expect(() => resolveInteraction(world.manifest, world.genesisEvents, player, params)).toThrow('requires Host')
  expect(() => resolveInteraction(world.manifest, world.genesisEvents, player, params, { ...context, actionId: '' })).toThrow('actionId')
  for (const input of [{ ...params, arguments: null }, { ...params, arguments: { extra: true } },
    { ...params, interactionId: 'core:release-hand', arguments: { extra: true } }, { ...params, targetId: 'unknown' },
    { ...params, interactionId: 'unknown' }]) expect(run(input).status).toBe('rejected')
  expect(run(params, [...world.genesisEvents, { eventType: 'character.lifecycle-changed', data: { characterId: npc, lifecycleState: 'dead' } }]).reason).toBe('TARGET_NOT_ACTIVE')
  expect(run(params, [...world.genesisEvents, { eventType: 'character.moved', data: { characterId: npc, toLocationId: 'location:next' } }]).reason).toBe('TARGET_NOT_INTERACTABLE')
  expect(run(params, world.genesisEvents.filter(event => !(event.eventType === 'character.created' && (event.data as any).characterId === player))).status).toBe('rejected')
  const manifest = { ...world.manifest, interactionCatalog: { ...world.manifest.interactionCatalog as any,
    bindings: [{ targetId: player, interactionIds: ['core:hold-hand'] }] } }
  expect(resolveInteraction(manifest, world.genesisEvents, player, { ...params, targetId: player }, context).reason).toBe('SELF_RELATION_NOT_ALLOWED')
  expect(resolveInteraction({ ...world.manifest, interactionCatalog: { ...world.manifest.interactionCatalog as any, bindings: [{ targetId: npc, interactionIds: [] }] } },
    world.genesisEvents, player, params, context).reason).toBe('INTERACTION_NOT_BOUND')
  const hold = run(params)
  const data = hold.events[0]!.data as any
  const reversed = { ...hold.events[0]!, data: { ...data, initiatorId: npc, targetId: player } }
  expect(run(params, [...world.genesisEvents, reversed]).reason).toBe('HAND_HOLD_ALREADY_ACTIVE')
  const unrelated = { ...hold.events[0]!, data: { ...data, initiatorId: npc, targetId: 'character:bob' } }
  expect(run(params, [...world.genesisEvents, unrelated]).status).toBe('accepted')
  expect(availableInteractions(world.manifest, world.genesisEvents, player)).toContainEqual({ ...params, label: '牵手' })
})
