import { describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, type RulebookResolutionAuthorityV1 } from '@harness-world/contracts'
import {
  FrozenInteractionRulebook,
  createCoreRulebookRegistry,
  interactionHostSnapshot,
  runtimeManifestFromStored,
  type CompiledWorldManifestV10,
  type RulebookEvent,
} from '@harness-world/kernel'
import {
  basicInteractionPackage,
  frozenGenesisEvents,
  frozenInteractionWorld,
  relationStarted,
} from './fixtures/frozen-interaction-world.ts'

const world = frozenInteractionWorld()
const address = world.manifest.address
const authority: RulebookResolutionAuthorityV1 = {
  version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'manual_player_immediate',
}
const origin = frozenGenesisEvents()

function rulebook(): FrozenInteractionRulebook {
  return new FrozenInteractionRulebook([basicInteractionPackage])
}

function context(actionId: string, events: readonly RulebookEvent[] = origin, over: Record<string, unknown> = {}) {
  return {
    manifest: world.manifest, events, characterId: 'character:player',
    actionId, manifestHash: world.manifestHash, asOfWorldSeq: 4, resolutionAuthority: authority, ...over,
  }
}

describe('the frozen interaction path', () => {
  it('is the v10 stored view the Host rebuilds, not a hand-written object', () => {
    expect(world.manifest.schemaVersion).toBe(10)
    expect(runtimeManifestFromStored(world.manifest).schemaVersion).toBe(10)
  })

  it('closes relations through the world fold, and only the classes its handlers declare', () => {
    const path = rulebook()
    const held = [...origin, relationStarted('base:hold-hand')]
    const moved = path.resolve(context('action:move', held), { actionType: 'move', parameters: { locationId: 'location:next' } })
    expect(moved.status).toBe('accepted')
    expect(moved.events.map(event => event.eventType)).toEqual(['character.moved', 'character.relation-ended'])
    expect(moved.events[1]!.data).toEqual({
      relationId: 'relation:held', endedByCharacterId: 'character:player', reason: 'participant_moved',
    })
    // A relation of a class no handler consumes is left alone: the fold is scoped by declaration, not by
    // "scan everything active and see what is out of reach".
    const foreign = [...origin, relationStarted('base:other')]
    const stillMoved = path.resolve(context('action:move:2', foreign), { actionType: 'move', parameters: { locationId: 'location:next' } })
    expect(stillMoved.events.map(event => event.eventType)).toEqual(['character.moved'])
    // A move that changes nothing produces no ending either.
    const stayed = path.resolve(context('action:stay', held), { actionType: 'speak', parameters: { text: '还是待着' } })
    expect(stayed.events.map(event => event.eventType)).toEqual(['character.speak'])
  })

  it('resolves every first-batch definition through the world selection', () => {
    const path = rulebook()
    const take = path.resolve(context('action:take'), {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {},
      },
    })
    expect(take.status).toBe('accepted')
    expect(take.events[0]!.data).toMatchObject({ entityId: 'entity:cup', characterId: 'character:player', toHolderId: 'character:player' })
    const held = [...origin, ...take.events]
    const drop = path.resolve(context('action:drop', held), {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:drop',
        definitionRef: { id: 'base:drop', version: 1 }, arguments: {},
      },
    })
    expect(drop.status).toBe('accepted')
    const hold = path.resolve(context('action:hold'), {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'character', id: 'character:npc' }, bindingId: 'binding:character:npc:base:hold-hand',
        definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {},
      },
    })
    expect(hold.status).toBe('accepted')
    expect(hold.events[0]!.eventType).toBe('character.relation-started')
    // The release addresses the instance through the class the author bound, and the identity is the one
    // the establishing action minted rather than a second relation.
    const relationId = (hold.events[0]!.data as { relationId: string }).relationId
    const released = path.resolve(context('action:release', [...origin, ...hold.events]), {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'relation', id: relationId }, bindingId: 'binding:release',
        definitionRef: { id: 'base:end-contact', version: 1 }, arguments: {},
      },
    })
    expect(released.status).toBe('accepted')
    expect(released.events[0]!.data).toEqual({
      relationId, endedByCharacterId: 'character:player', reason: 'released',
    })
  })

  it('answers an unroutable proposal with a rejection instead of throwing the round', () => {
    const path = rulebook()
    const reject = (parameters: unknown): string => {
      const resolution = path.resolve(context('action:bad'), { actionType: 'interact', parameters: parameters as never })
      expect(resolution.status).toBe('rejected')
      return resolution.reason!
    }
    expect(reject({ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:missing',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {} })).toBe('INTERACTION_NOT_BOUND')
    expect(reject({ targetRef: { kind: 'entity', id: 'entity:other' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {} })).toBe('INVALID_INTERACTION_PARAMETERS')
    expect(reject({ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:drop', version: 1 }, arguments: {} })).toBe('INVALID_INTERACTION_PARAMETERS')
    expect(reject({ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {}, performance: { independent: [], onSuccess: [] } }))
      .toBe('INTERACTION_PERFORMANCE_NOT_SUPPORTED')
    expect(reject({ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 } })).toBe('INVALID_INTERACTION_PARAMETERS')
    expect(reject(null)).toBe('INVALID_INTERACTION_PARAMETERS')
    for (const broken of [
      { targetRef: { kind: 'entity' }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'entity', id: 'entity:cup', extra: 1 }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'entity', id: 42 }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'room', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 42, definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take' }, arguments: {} },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take', definitionRef: null, arguments: {} },
      { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: null },
      { targetRef: null, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'entity', id: '' }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
    ]) expect(reject(broken)).toBe('INVALID_INTERACTION_PARAMETERS')
    // A character named through the release binding is not a relation, so there is no instance to read
    // a class from and no binding it could have addressed.
    expect(reject({ targetRef: { kind: 'character', id: 'character:npc' }, bindingId: 'binding:release',
      definitionRef: { id: 'base:end-contact', version: 1 }, arguments: {} })).toBe('INTERACTION_NOT_BOUND')
    // A relation of another class is not addressable through the release binding; it is refused rather
    // than silently ending somebody else's relation.
    expect(reject({ targetRef: { kind: 'relation', id: 'relation:other' }, bindingId: 'binding:release',
      definitionRef: { id: 'base:end-contact', version: 1 }, arguments: {} })).toBe('INTERACTION_NOT_BOUND')
    // A rejection that is about this proposal rather than about routing keeps its own reason, so a
    // caller can tell "that is not a binding" from "that binding does not authorize you here".
    const elsewhere = path.resolve(context('action:gone', []), {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {},
      },
    })
    expect(elsewhere.status).toBe('rejected')
    expect(elsewhere.reason).toBe('PARTICIPANT_NOT_AUTHORIZED')
  })

  it('refuses to resolve without the Host facts the frozen trace binds', () => {
    const path = rulebook()
    const action = { actionType: 'move', parameters: { locationId: 'location:next' } }
    expect(() => path.resolve(context('action:x', origin, { manifestHash: undefined }), action))
      .toThrow(/manifest hash and world sequence/u)
    expect(() => path.resolve(context('action:x', origin, { asOfWorldSeq: undefined }), action))
      .toThrow(/manifest hash and world sequence/u)
    expect(() => path.resolve(context('action:x', origin, { actionId: undefined }), action))
      .toThrow(/requires an actionId/u)
    expect(() => path.resolve(context('action:x', origin, { resolutionAuthority: undefined }), action))
      .toThrow(/requires Host authority/u)
    const v9 = frozenInteractionWorld().manifest
    expect(() => path.resolve(context('action:x', origin, { manifest: { ...v9, schemaVersion: 9 } }), action))
      .toThrow(/only serves Manifest v10/u)
  })

  it('enumerates the options the world accepts, from the same selection it adjudicates', () => {
    const path = rulebook()
    const optionIds = (events: readonly RulebookEvent[], actionId: string): readonly string[] =>
      path.affordances(context(actionId, events)).find(entry => entry.actionType === 'interact')!.interactions!
        .map(option => `${(option.definitionRef as { id: string }).id}:${(option.targetRef as { id: string }).id}`)
    const offered = path.affordances(context('action:affordance'))
    expect(offered.map(entry => `${entry.actionType}@${entry.actionVersion}`)).toEqual(['speak@1', 'move@1', 'interact@2'])
    // With nothing held and no relation yet, only taking and holding are attemptable: drop and give
    // have nothing to act on, and releasing has no instance of the class to address.
    expect(optionIds(origin, 'action:affordance')).toEqual([
      'base:hold-hand:character:npc', 'base:take:entity:cup', 'base:take:entity:other',
    ])
    // Once the pair is holding, the release appears and the second hold is no longer attemptable.
    const paired = [...origin, relationStarted('base:hold-hand')]
    expect(optionIds(paired, 'action:affordance:2')).toContain('base:end-contact:relation:held')
    expect(optionIds(paired, 'action:affordance:2')).not.toContain('base:hold-hand:character:npc')
    // An inactive relation is not something either side can release, so it is not offered.
    const ended = [...paired, { eventType: 'character.relation-ended', eventVersion: 1,
      data: { relationId: 'relation:held', endedByCharacterId: 'character:npc', reason: 'released' } }]
    expect(optionIds(ended, 'action:affordance:3')).not.toContain('base:end-contact:relation:held')
  })

  it('authorizes what the actor can reach and nothing else', () => {
    const snapshot = interactionHostSnapshot(world.manifest, origin, 'character:player')
    const keys = snapshot.authorizedTargets.map(ref => `${ref.kind}:${ref.id}`)
    expect(keys).toEqual(['character:character:npc', 'entity:entity:cup', 'entity:entity:other'])
    // An entity somebody else is holding is not the actor's to address.
    const held = [...origin, { eventType: 'entity.transferred', eventVersion: 1, data: {
      entityId: 'entity:cup', characterId: 'character:npc', interactionId: 'base:take',
      fromLocationId: 'location:room', fromHolderId: null, toLocationId: null, toHolderId: 'character:bob',
    } }]
    expect(interactionHostSnapshot(world.manifest, held, 'character:player').authorizedTargets.map(ref => ref.id))
      .toEqual(['character:npc', 'entity:other'])
    // Out of the Scene as well as out of the Location: no co-location and no shared Scene, so there is
    // nothing left that makes the pair reachable.
    const gone = [...origin,
      { eventType: 'character.moved', eventVersion: 1,
        data: { characterId: 'character:npc', fromLocationId: 'location:room', toLocationId: 'location:next' } },
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:room', characterId: 'character:npc' } }]
    expect(interactionHostSnapshot(world.manifest, gone, 'character:player').authorizedTargets.map(ref => ref.id))
      .toEqual(['entity:cup', 'entity:other'])
    // Moving away while the Scene still holds them is enough for the rules to refuse, but the reach
    // projection is about reach, not about a particular rule: the Scene alone keeps them addressable.
    const stillInScene = [...origin, { eventType: 'character.moved', eventVersion: 1,
      data: { characterId: 'character:npc', fromLocationId: 'location:room', toLocationId: 'location:next' } }]
    expect(interactionHostSnapshot(world.manifest, stillInScene, 'character:player').authorizedTargets.map(ref => ref.id))
      .toEqual(['character:npc', 'entity:cup', 'entity:other'])
    // Only a participant may address a relation.
    const paired = [...origin, relationStarted('base:hold-hand')]
    expect(interactionHostSnapshot(world.manifest, paired, 'character:npc').authorizedTargets.map(ref => `${ref.kind}:${ref.id}`))
      .toContain('relation:relation:held')
    expect(interactionHostSnapshot(world.manifest, paired, 'character:bob').authorizedTargets.map(ref => ref.kind))
      .not.toContain('relation')
  })

  it('identifies a candidate prefix by its contents, including events that name no version', () => {
    const path = rulebook()
    const take = {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {},
      },
    }
    const trace = (events: readonly RulebookEvent[]): unknown =>
      path.resolve(context('action:prefix', events), take).interactionTrace
    const versionless = [...origin, { eventType: 'world.tick-advanced', data: { tick: 2 } } as unknown as RulebookEvent]
    expect(trace(versionless)).toEqual(trace(versionless))
    // A prefix differing by one event is a different prefix, which is what keeps a bound trace from
    // claiming a state the world never had. The trace is the only place a resolution exposes it.
    expect(trace(origin)).not.toEqual(trace(versionless))
    expect((trace(origin) as { ruleTraceHash: string }).ruleTraceHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('counts every active Scene a character belongs to, not just the first', () => {
    const twoScenes = [...origin,
      { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:second',
        value: { lifecycle: 'active', locationId: 'location:room', participantIds: ['character:player', 'character:npc'] } } },
      { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:third',
        value: { lifecycle: 'closed', locationId: 'location:room', participantIds: ['character:player', 'character:npc'] } } }]
    const state = interactionHostSnapshot(world.manifest, twoScenes, 'character:player')
      .targets.find(entry => entry.ref.kind === 'character' && entry.ref.id === 'character:player')!.state
    // Both active Scenes are recorded and the closed one is not, so a rule reading sceneIds sees the
    // whole membership rather than whichever Scene happened to be read last.
    expect(state.sceneIds).toEqual(['scene:room', 'scene:second'])
  })

  it('fails closed on a prefix it cannot read rather than guessing at reach', () => {
    const broken = [...origin, { eventType: 'character.relation-started', eventVersion: 1, data: {
      relationId: 'relation:held', relationKind: 'hand_hold', initiatorId: 42, targetId: 'character:npc',
      interactionId: 'base:hold-hand', sourceActionId: 'action:hold',
    } }]
    expect(() => interactionHostSnapshot(world.manifest, broken, 'character:player'))
      .toThrow(/prefix is malformed/u)
  })
})

describe('the Rulebook registry on the frozen path', () => {
  it('serves v10 through the generic resolver the Host already uses', () => {
    const registry = createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] })
    const resolver = registry.resolve('builtin:speak-move', 2, 'correlation:i4b', address)
    const held = [...origin, relationStarted('base:hold-hand')]
    const moved = resolver.resolve({
      manifest: world.manifest, events: held, characterId: 'character:player',
      actionId: 'action:move:registry', manifestHash: world.manifestHash, asOfWorldSeq: 4,
      resolutionAuthority: authority, action: { actionType: 'move', parameters: { locationId: 'location:next' } },
    })
    expect(moved.events.map(event => event.eventType)).toEqual(['character.moved', 'character.relation-ended'])
    expect(resolver.affordances({
      manifest: world.manifest, events: held, characterId: 'character:player',
      manifestHash: world.manifestHash, asOfWorldSeq: 4, resolutionAuthority: authority,
    }).map(entry => entry.actionType)).toEqual(['speak', 'move', 'interact'])
  })

  it('fails closed when the Host installed no interaction package', () => {
    const registry = createCoreRulebookRegistry()
    const resolver = registry.resolve('builtin:speak-move', 2, 'correlation:i4b', address)
    expect(() => resolver.resolve({
      manifest: world.manifest, events: origin, characterId: 'character:player',
      actionId: 'action:x', manifestHash: world.manifestHash, asOfWorldSeq: 4,
      resolutionAuthority: authority, action: { actionType: 'move', parameters: { locationId: 'location:next' } },
    })).toThrow(/package missing or lock drift/u)
    // speak is still the shared Rulebook's, so a world nobody can resolve interactions in still speaks.
    const spoke = resolver.resolve({
      manifest: world.manifest, events: origin, characterId: 'character:player',
      actionId: 'action:y', manifestHash: world.manifestHash, asOfWorldSeq: 4,
      resolutionAuthority: authority, action: { actionType: 'speak', parameters: { text: '走吧' } },
    })
    expect(spoke.status).toBe('accepted')
  })
})

describe('the fixture itself', () => {
  it('names a relation class that the catalog actually enables', () => {
    const selection = (world.manifest as CompiledWorldManifestV10).interactionCatalog
    const classes = selection.bindings.filter(entry => entry.targetRef.kind === 'relation').map(entry => entry.targetRef.id)
    expect(classes).toEqual(['base:hold-hand'])
    for (const id of classes) {
      expect(selection.definitions.some(entry => entry.ref.id === id)).toBe(true)
    }
    expect(hashWorldJson('compiled-world-manifest', world.manifest)).toBe(world.manifestHash)
    expect(address.branchId).toBe(brandId('branch:main', 'BranchId'))
  })
})
