import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import {
  brandId, hashWorldJson,
  type InteractionPackageImplementation, type RulebookResolutionAuthorityV1,
  type WorldJsonValue,
  type WorldJsonObject,
  type StoredWorldEvent,
} from '@harness-world/contracts'
import {
  FrozenInteractionRulebook,
  createCoreRulebookRegistry,
  SpeakMoveRulebook,
  currentCharacterRelations,
  interactionHostSnapshot,
  runtimeManifestFromStored,
  type CompiledWorldManifestV10,
  type RulebookEvent,
} from '@harness-world/kernel'
import { interactionPackageHash } from '@harness-world/interaction-runtime'
import { WorldStore } from '@harness-world/store-sqlite'
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
    actionId, manifestHash: world.manifestHash, asOfWorldSeq: 4, resolutionAuthority: authority,
    roundId: brandId('round:frozen-interaction', 'InteractionRoundId'), ...over,
  }
}

describe('the frozen interaction path', () => {
  it('is the v10 stored view the Host rebuilds, not a hand-written object', () => {
    expect(world.manifest.schemaVersion).toBe(10)
    expect(runtimeManifestFromStored(world.manifest).schemaVersion).toBe(10)
  })

  it('offers a move only the places the character may actually go', () => {
    // The model used to be given nothing here, so it invented a destination and the world refused a call that
    // had already been paid for. The list is asked of the move rule, not restated: everything offered is a
    // move the world accepts, the place the character is standing in is not a move, and nothing else exists.
    const path = rulebook()
    const current = world.manifest.characters.find(character => character.characterId === 'character:player')!.locationId
    const move = path.affordances(context('action:affordance-view')).find(entry => entry.actionType === 'move')!
    const offered = (move.destinations ?? []).map(place => place.locationId)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered).not.toContain(current)
    expect([...offered].sort()).toEqual(world.manifest.locations
      .map(location => location.locationId).filter(locationId => locationId !== current).sort())
    for (const locationId of offered) {
      const resolved = path.resolve(context('action:affordance-probe'),
        { actionType: 'move', parameters: { locationId } })
      expect(resolved.status, locationId).toBe('accepted')
    }
    // A world with nowhere to go states no list at all: an empty one would be the same answer, and the
    // adapter reads "no list" as "nothing to offer" for the same reason it does for accepted cues.
    const only = world.manifest.characters.find(character => character.characterId === 'character:player')!.locationId!
    const nowhere = path.affordances({ ...context('action:affordance-nowhere'),
      manifest: { ...world.manifest, locations: world.manifest.locations.filter(location => location.locationId === only) } })
    expect(nowhere.find(entry => entry.actionType === 'move')).not.toHaveProperty('destinations')

    // The place it is standing in is refused, so offering it would have been a lie.
    expect(path.resolve(context('action:affordance-here'),
      { actionType: 'move', parameters: { locationId: current } }).status).toBe('rejected')
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

  it('reports the role bindings a frozen resolution used, by name', () => {
    const path = rulebook()
    const resolution = path.resolve(context('action:names'), {
      actionType: 'interact', parameters: {
        targetRef: { kind: 'character', id: 'character:npc' }, bindingId: 'binding:character:npc:base:hold-hand',
        definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {},
      },
    })
    expect(resolution.status).toBe('accepted')
    // Names, not only their hash: a Host stating which role an effect landed on has to be able to ask
    // about a slot, and a hash cannot answer that.
    expect(resolution.resolvedRoles).toEqual({
      actor: { kind: 'character', id: 'character:player' }, target: { kind: 'character', id: 'character:npc' },
    })
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

  it('lets the definition say who may observe a refusal, and records it either way', () => {
    const path = rulebook()
    const take = (events: readonly RulebookEvent[], actionId: string): ReturnType<FrozenInteractionRulebook['resolve']> =>
      path.resolve(context(actionId, events), { actionType: 'interact', parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: {},
      } })
    // A shared cup cannot be taken twice, and being told no is something the Scene can see happen.
    const first = take(origin, 'action:first-take')
    expect(first.status).toBe('accepted')
    expect(first.observationScope).toEqual({ scope: 'scene_public' })
    const refusedTake = take([...origin, ...first.events], 'action:refused-take')
    expect(refusedTake.status).toBe('rejected')
    expect(refusedTake.observationScope).toEqual({ scope: 'scene_public' })
    // The fact is written either way; the policy only decides who is told.
    expect(refusedTake.events.map(event => event.eventType)).toEqual(['action.rejected'])
    // A refused attempt to take someone's hand is not something the Scene is told about - but the pair
    // already holding hands is why it fails, so the attempt is refused for that reason and recorded.
    const paired = [...origin, relationStarted('base:hold-hand')]
    const refusedHold = path.resolve(context('action:refused-hold', paired), { actionType: 'interact', parameters: {
      targetRef: { kind: 'character', id: 'character:npc' }, bindingId: 'binding:character:npc:base:hold-hand',
      definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {},
    } })
    expect(refusedHold.status).toBe('rejected')
    expect(refusedHold.observationScope).toEqual({ scope: 'self' })
    expect(refusedHold.events.map(event => event.eventType)).toEqual(['action.rejected'])
    // A request that never named a definition has no policy to consult, and the reason names the catalog.
    const unbound = path.resolve(context('action:unbound'), { actionType: 'interact', parameters: {
      targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:missing',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {},
    } })
    expect(unbound.reason).toBe('INTERACTION_NOT_BOUND')
    expect(unbound.observationScope).toEqual({ scope: 'self' })
  })

  it('tells the model which cues the offered definition accepts, and only when it accepts any', () => {
    const path = rulebook()
    const take = path.resolve(context('action:view-take'),
      { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} } })
    // Nothing is in anyone's hands yet, so the only option is a take, and a take sanctions no step.
    const before = path.affordances(context('action:view-before'))
      .find(affordance => affordance.actionType === 'interact')!
    expect(before.interactions!.map(option => (option as { readonly bindingId: string }).bindingId))
      .toContain('binding:entity:cup:base:take')
    expect(before.performances).toEqual([])
    // With the cup in hand the hand-over is offered, and its definition is the one that takes cues.
    const after = path.affordances(context('action:view-after', [...origin, ...take.events]))
      .find(affordance => affordance.actionType === 'interact')!
    expect(after.performances).toHaveLength(1)
    expect(after.performances![0]!.definitionRef).toEqual({ id: 'base:give', version: 1 })
    expect(after.performances![0]!.accepted.map(entry => `${entry.cue}:${entry.placement}`))
      .toEqual(['smile:both', 'frown:both', 'nod:both', 'shake_head:both', 'avert_gaze:both'])
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
    // What an interaction step may carry at all is decided here: the closed vocabulary, no cue that names
    // an action of its own, and no cue stated twice inside one list.
    const takeWith = (performance: WorldJsonValue) => ({ targetRef: { kind: 'entity', id: 'entity:cup' },
      bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {}, performance })
    for (const performance of [
      { independent: ['slow_walk'], onSuccess: [] },
      { independent: ['quiet_voice'], onSuccess: [] },
      { independent: ['unknown_cue'], onSuccess: [] },
      { independent: ['frown', 'frown'], onSuccess: [] },
      { independent: ['frown'], onSuccess: ['frown', 'frown'] },
      { independent: 'frown', onSuccess: [] },
      { independent: ['frown'] },
      { independent: ['frown'], onSuccess: [], extra: true },
      { independent: ['frown', 'smile', 'nod', 'shake_head', 'avert_gaze', 'frown', 'smile', 'nod', 'shake_head'], onSuccess: [] },
      { independent: ['frown', 42], onSuccess: [] },
      { independent: ['frown', null], onSuccess: [] },
    ]) expect(reject(takeWith(performance))).toBe('INVALID_INTERACTION_PARAMETERS')
    // A step that states no cue states nothing, exactly as an empty step reads on the action-group path.
    expect(path.resolve(context('action:empty-step'), { actionType: 'interact', parameters: takeWith({ independent: [], onSuccess: [] }) }).status)
      .toBe('accepted')
    // A well-formed step this definition's own locked policy does not accept is a refused proposal, and
    // the caller is told so rather than meeting an exception from inside the trusted runtime.
    expect(path.resolve(context('action:refused-step'), { actionType: 'interact', parameters: takeWith({ independent: ['frown'], onSuccess: [] }) }))
      .toMatchObject({ status: 'rejected', reason: 'PERFORMANCE_NOT_ACCEPTED' })
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
      { targetRef: null, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
      { targetRef: { kind: 'entity', id: '' }, bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} },
    ]) expect(reject(broken)).toBe('INVALID_INTERACTION_PARAMETERS')
    // Arguments are checked against the definition's own frozen schema at this boundary, so a payload
    // that does not fit it is a rejection here rather than an exception from inside the trusted runtime.
    for (const badArguments of [null, { unexpected: true }, { recipientId: 'character:npc' }]) {
      expect(reject({ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 }, arguments: badArguments })).toBe('INVALID_INTERACTION_ARGUMENTS')
    }
    // A definition that does take an argument still accepts a well-formed one through the same check.
    expect(path.resolve(context('action:give'), { actionType: 'interact', parameters: {
      targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {},
    } }).status).toBe('accepted')
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

  it('freezes a selection on demand so activation can prove it closes', () => {
    const path = rulebook()
    // Adopting is what a Host does before it writes Genesis, and it leaves the world cached for the
    // resolution that follows.
    expect(() => path.adopt(world.manifest, world.manifestHash)).not.toThrow()
    expect(path.resolve(context('action:adopted'), { actionType: 'speak', parameters: { text: '好' } }).status).toBe('accepted')
    expect(() => path.adopt({ ...world.manifest, schemaVersion: 9 } as never, world.manifestHash))
      .toThrow(/only serves Manifest v10/u)
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

describe('a v10 world through the production entry point', () => {
  it('shows the Scene a refusal its author made public, and keeps the private one to the actor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-refusal-'))
    const worldPath = join(root, 'world.sqlite')
    const compiled = frozenInteractionWorld()
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20,
    })
    const submit = (key: string, parameters: Record<string, unknown>) => app.submit(compiled.manifest.address, {
      idempotencyKey: key, principalId: 'principal:player', correlationId: `frozen-${key}`,
      action: { actionType: 'interact', parameters: parameters as never },
    })
    const take = { targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 }, arguments: {} }
    const hold = { targetRef: { kind: 'character', id: 'character:npc' }, bindingId: 'binding:character:npc:base:hold-hand',
      definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {} }
    try {
      app.activate(compiled)
      // Two refusals of the same shape, decided by two different declarations: the cup is already taken,
      // and the pair already holds hands.
      await submit('take', take)
      await submit('take-again', take)
      await submit('hold', hold)
      await submit('hold-again', hold)
    } finally { await app.close() }
    try {
      const store = new WorldStore(worldPath)
      const observations = store.readEvents(compiled.manifest.address)
        .filter(event => event.eventType === 'observation.upsert')
        .map(event => (event.data as { readonly value: { readonly observerId: string; readonly content: Record<string, unknown> } }).value)
      store.close()
      // The public refusal reaches everyone in the Scene, which is what makes it witnessable at all.
      const refusalOfTake = observations.filter(entry => entry.content.reason === 'ITEM_NOT_AVAILABLE')
      expect(refusalOfTake.map(entry => entry.observerId).sort())
        .toEqual(['character:bob', 'character:npc', 'character:player'])
      expect(refusalOfTake.every(entry => entry.content.status === 'rejected')).toBe(true)
      // The private one reaches nobody but the actor, and it is still an Observation bound to the action.
      const refusalOfHold = observations.filter(entry => entry.content.reason === 'CONTACT_ALREADY_ACTIVE')
      expect(refusalOfHold.map(entry => entry.observerId)).toEqual(['character:player'])
      expect(refusalOfHold[0]!.content.status).toBe('rejected')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('records an accepted step as an observation fact, and nothing else about the round changes', async () => {
    // A hand-over is the one first-batch definition that sanctions a self-expression. The step it accepts
    // becomes a fact every observer can see, while the effect itself is built as if the step were not
    // stated - which is the whole point of keeping the performance out of the execution context.
    const compiled = frozenInteractionWorld()
    const run = async (performance?: WorldJsonObject): Promise<readonly StoredWorldEvent[]> => {
      const root = mkdtempSync(join(tmpdir(), 'frozen-performance-'))
      const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'),
        sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20 })
      try {
        app.activate(compiled)
        const submit = (key: string, parameters: WorldJsonObject) => app.submit(compiled.manifest.address, {
          idempotencyKey: key, principalId: 'principal:player', correlationId: `frozen-${key}`,
          action: { actionType: 'interact', parameters: parameters as never },
        })
        await submit('take', { targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} })
        await submit('give', { targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:give', definitionRef: { id: 'base:give', version: 1 },
          arguments: { recipientId: 'character:npc' }, ...(performance === undefined ? {} : { performance }) })
      } finally { await app.close() }
      const store = new WorldStore(join(root, 'world.sqlite'))
      try { return store.readEvents(compiled.manifest.address) } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
    }
    const plain = await run()
    const expressed = await run({ independent: ['frown'], onSuccess: ['smile'] })
    // The effect is the one the same hand-over builds without a step: the ids differ because the input
    // does, but what the world recorded happening is the same fact.
    const effectOf = (events: readonly StoredWorldEvent[]) => events
      .filter(event => event.eventType === 'entity.transferred').map(event => event.data)
    expect(effectOf(expressed)).toEqual(effectOf(plain))
    const manifested = expressed.filter(event => event.eventType === 'character.manifested')
    expect(manifested).toHaveLength(1)
    expect(manifested[0]!.data).toMatchObject({ characterId: 'character:player', actionId: expect.any(String) })
    expect((manifested[0]!.data as { readonly cues: readonly { readonly description: string }[] }).cues
      .map(cue => cue.description)).toEqual(['微微皱眉', '微微一笑'])
    // Everyone who observed the hand-over observes the expression with it.
    const observed = expressed.filter(event => event.eventType === 'observation.upsert')
      .map(event => (event.data as { readonly value: { readonly observerId: string; readonly content: WorldJsonObject } }).value)
      .filter(value => value.content.manifestation !== undefined)
    expect(observed.map(value => value.observerId).sort()).toContain('character:npc')
    expect(plain.some(event => event.eventType === 'character.manifested')).toBe(false)
    // A refused hand-over still plays what its author said plays whatever the outcome, and cancels the
    // rest: an expression that only rides on success cannot be claimed by an attempt that failed. The
    // recipient here is one the snapshot does not hold, so the plan refuses while the attempt stands.
    const path = rulebook()
    // A step that plays cues needs the Round it belongs to. A Host that withheld the Round gets told so
    // rather than a fact recorded against nothing.
    expect(() => path.resolve({ ...context('action:no-round'), roundId: undefined },
      { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:give', definitionRef: { id: 'base:give', version: 1 },
        arguments: { recipientId: 'character:npc' }, performance: { independent: ['frown'], onSuccess: [] } } }))
      .toThrow('a manifested interaction step requires the Round it belongs to')
    const take = path.resolve(context('action:step-take'),
      { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take', definitionRef: { id: 'base:take', version: 1 }, arguments: {} } })
    const refused = path.resolve(context('action:step-refused', [...origin, ...take.events]),
      { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:give', definitionRef: { id: 'base:give', version: 1 },
        arguments: { recipientId: 'character:missing' }, performance: { independent: ['nod'], onSuccess: ['smile'] } } })
    expect(refused.status).toBe('rejected')
    expect(refused.manifestation).toMatchObject({
      proposal: { cues: [{ cueId: 'cue:0', description: '点了点头' }] },
      resolution: { status: 'accepted', cueResolutions: [{ cueId: 'cue:0', status: 'accepted' }] },
    })
    expect(refused.events.map(event => event.eventType)).toEqual(['action.rejected', 'character.manifested'])
    expect((refused.events[1]!.data as { readonly cues: readonly { readonly description: string }[] }).cues
      .map(cue => cue.description)).toEqual(['点了点头'])
  }, 60_000)

  it('closes the relation a move ended, exactly once, without a Kernel-side contact branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-interaction-'))
    const worldPath = join(root, 'world.sqlite')
    const compiled = frozenInteractionWorld()
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20,
    })
    let relationId = ''
    try {
      app.activate(compiled)
      // The precondition the release and the fold both rest on: the pair shares a Location and a Scene.
      const opening = new WorldStore(worldPath)
      try {
        const events = opening.readEvents(compiled.manifest.address)
        const location = (id: string): unknown => events.filter(event => event.eventType === 'character.created'
          && (event.data as { characterId: string }).characterId === id).at(-1)?.data
        expect((location('character:player') as { locationId: string }).locationId).toBe('location:room')
        expect((location('character:npc') as { locationId: string }).locationId).toBe('location:room')
        expect(events.some(event => event.eventType === 'scene.upsert'
          && (event.data as { sceneId: string }).sceneId === 'scene:room'
          && ((event.data as { value: { participantIds: readonly string[] } }).value.participantIds).includes('character:npc'))).toBe(true)
      } finally { opening.close() }

      // One player interaction through the frozen path: the pair is holding hands.
      await app.submit(compiled.manifest.address, { idempotencyKey: 'hold', principalId: 'principal:player',
        correlationId: 'frozen-hold', action: { actionType: 'interact', parameters: {
          targetRef: { kind: 'character', id: 'character:npc' }, bindingId: 'binding:character:npc:base:hold-hand',
          definitionRef: { id: 'base:hold-hand', version: 1 }, arguments: {},
        } } })
      const afterHold = new WorldStore(worldPath)
      try {
        const relations = currentCharacterRelations(afterHold.readEvents(compiled.manifest.address))
        expect(relations).toHaveLength(1)
        expect(relations[0]!.active).toBe(true)
        relationId = relations[0]!.relationId
      } finally { afterHold.close() }

      // A move is not an interaction: the world fold is what ends the relation, and it runs once.
      await app.submit(compiled.manifest.address, { idempotencyKey: 'move', principalId: 'principal:player',
        correlationId: 'frozen-move', action: { actionType: 'move', parameters: { locationId: 'location:next' } } })
    } finally { await app.close() }
    try {
      const store = new WorldStore(worldPath)
      const events = store.readEvents(compiled.manifest.address)
      store.close()
      expect(currentCharacterRelations(events).filter(relation => relation.active)).toEqual([])
      const endings = events.filter(event => event.eventType === 'character.relation-ended')
      // Exactly one ending: a second fold over the same candidate set would emit it again.
      expect(endings).toHaveLength(1)
      // The Kernel cannot be the source of that ending. For a v10 Manifest its move emits the movement
      // and nothing about relations, so what ended the contact above can only be the frozen fold.
      expect(new SpeakMoveRulebook().resolve(compiled.manifest, events, 'character:player', {
        actionType: 'move', parameters: { locationId: 'location:room' },
      }).events.map(event => event.eventType)).toEqual(['character.moved'])
      expect(endings[0]!.data).toEqual({
        relationId, endedByCharacterId: 'character:player', reason: 'participant_moved',
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('refuses to open a v10 world whose selection this Host cannot resolve', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-unrelated-'))
    const worldPath = join(root, 'world.sqlite')
    const compiled = frozenInteractionWorld()
    // A real, installable package that is simply not the one this world selected. Counting installed
    // packages would call this Host ready; freezing the selection says otherwise.
    const { lock: _lock, ...contents } = basicInteractionPackage
    const unrelated: InteractionPackageImplementation = { ...contents, lock: {
      ref: { id: 'package:unrelated', version: 1 }, dependencies: [], implementationHash: interactionPackageHash(contents),
    } }
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20, interactionPackages: [unrelated],
    })
    try {
      expect(() => app.activate(compiled)).toThrow(/cannot resolve the interaction selection/u)
    } finally { await app.close() }
    // Refused before Genesis, so the branch is still unactivated and nothing was written.
    const store = new WorldStore(worldPath)
    try { expect(store.readManifest(compiled.manifest.address)).toBeUndefined() } finally { store.close() }
    rmSync(root, { recursive: true, force: true })
  }, 60_000)
})
