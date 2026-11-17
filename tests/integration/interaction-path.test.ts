import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorldApplication } from '@perspectra/core'
import {
  brandId,
  type InteractionPackageImplementation,
  type RulebookResolutionAuthorityV1,
  type WorldJsonValue,
  type WorldJsonObject,
  type StoredWorldEvent,
} from '@perspectra/sdk/contracts'
import {
  FrozenInteractionRulebook,
  createCoreRulebookRegistry,
  interactionHostSnapshot,
  runtimeManifestFromStored,
  type RulebookEvent,
} from '@perspectra/core/kernel'
import { interactionPackageHash } from '@perspectra/core/interactions'
import { WorldStore } from '@perspectra/core/store'
import {
  basicInteractionPackage,
  frozenGenesisEvents,
  frozenInteractionWorld,
} from '../fixtures/frozen-interaction-world.ts'

const world = frozenInteractionWorld()
const address = world.manifest.address
const authority: RulebookResolutionAuthorityV1 = {
  version: 'resolution-authority/v1',
  sourceRole: 'player',
  adjudicationMode: 'manual_player_immediate',
}
const origin = frozenGenesisEvents()

function rulebook(): FrozenInteractionRulebook {
  return new FrozenInteractionRulebook([basicInteractionPackage])
}

function context(actionId: string, events: readonly RulebookEvent[] = origin, over: Record<string, unknown> = {}) {
  return {
    manifest: world.manifest,
    events,
    characterId: 'character:player',
    actionId,
    manifestHash: world.manifestHash,
    asOfWorldSeq: 4,
    resolutionAuthority: authority,
    roundId: brandId('round:frozen-interaction', 'InteractionRoundId'),
    ...over,
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
    const current = world.manifest.characters.find(
      character => character.characterId === 'character:player',
    )!.locationId
    const move = path.affordances(context('action:affordance-view')).find(entry => entry.actionType === 'move')!
    const offered = (move.destinations ?? []).map(place => place.locationId)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered).not.toContain(current)
    expect([...offered].sort()).toEqual(
      world.manifest.locations
        .map(location => location.locationId)
        .filter(locationId => locationId !== current)
        .sort(),
    )
    for (const locationId of offered) {
      const resolved = path.resolve(context('action:affordance-probe'), {
        actionType: 'move',
        parameters: { locationId },
      })
      expect(resolved.status, locationId).toBe('accepted')
    }
    // A world with nowhere to go states no list at all: an empty one would be the same answer, and the
    // adapter reads "no list" as "nothing to offer" for the same reason it does for accepted cues.
    const only = world.manifest.characters.find(character => character.characterId === 'character:player')!.locationId!
    const nowhere = path.affordances({
      ...context('action:affordance-nowhere'),
      manifest: {
        ...world.manifest,
        locations: world.manifest.locations.filter(location => location.locationId === only),
      },
    })
    expect(nowhere.find(entry => entry.actionType === 'move')).not.toHaveProperty('destinations')

    // The place it is standing in is refused, so offering it would have been a lie.
    expect(
      path.resolve(context('action:affordance-here'), { actionType: 'move', parameters: { locationId: current } })
        .status,
    ).toBe('rejected')
  })

  it('resolves every first-batch definition through the world selection', () => {
    const path = rulebook()
    const take = path.resolve(context('action:take'), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
    })
    expect(take.status).toBe('accepted')
    expect(take.events[0]!.data).toMatchObject({
      entityId: 'entity:cup',
      characterId: 'character:player',
      toHolderId: 'character:player',
    })
    const held = [...origin, ...take.events]
    const drop = path.resolve(context('action:drop', held), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:drop',
        definitionRef: { id: 'base:drop', version: 1 },
        arguments: {},
      },
    })
    expect(drop.status).toBe('accepted')
  })

  it('lets the definition say who may observe a refusal, and records it either way', () => {
    const path = rulebook()
    const take = (
      events: readonly RulebookEvent[],
      actionId: string,
    ): ReturnType<FrozenInteractionRulebook['resolve']> =>
      path.resolve(context(actionId, events), {
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 },
          arguments: {},
        },
      })
    // A shared cup cannot be taken twice, and being told no is something the Scene can see happen.
    const first = take(origin, 'action:first-take')
    expect(first.status).toBe('accepted')
    expect(first.observationScope).toEqual({ scope: 'scene_public' })
    const refusedTake = take([...origin, ...first.events], 'action:refused-take')
    expect(refusedTake.status).toBe('rejected')
    expect(refusedTake.observationScope).toEqual({ scope: 'scene_public' })
    // The fact is written either way; the policy only decides who is told.
    expect(refusedTake.events.map(event => event.eventType)).toEqual(['action.rejected'])
    // A request that never named a definition has no policy to consult, and the reason names the catalog.
    const unbound = path.resolve(context('action:unbound'), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:missing',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
    })
    expect(unbound.reason).toBe('INTERACTION_NOT_BOUND')
    expect(unbound.observationScope).toEqual({ scope: 'self' })
  })

  it('tells the model which cues the offered definition accepts, and only when it accepts any', () => {
    const path = rulebook()
    const take = path.resolve(context('action:view-take'), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
    })
    // Nothing is in anyone's hands yet, so the only option is a take, and a take sanctions no step.
    const before = path
      .affordances(context('action:view-before'))
      .find(affordance => affordance.actionType === 'interact')!
    expect(before.interactions!.map(option => (option as { readonly bindingId: string }).bindingId)).toContain(
      'binding:entity:cup:base:take',
    )
    expect(before.performances).toEqual([])
    // With the cup in hand the hand-over is offered, and its definition is the one that takes cues.
    const after = path
      .affordances(context('action:view-after', [...origin, ...take.events]))
      .find(affordance => affordance.actionType === 'interact')!
    expect(after.performances).toHaveLength(1)
    expect(after.performances![0]!.definitionRef).toEqual({ id: 'base:give', version: 1 })
    expect(after.performances![0]!.accepted.map(entry => `${entry.cue}:${entry.placement}`)).toEqual([
      'smile:both',
      'frown:both',
      'nod:both',
      'shake_head:both',
      'avert_gaze:both',
    ])
  })

  it('answers an unroutable proposal with a rejection instead of throwing the round', () => {
    const path = rulebook()
    const reject = (parameters: unknown): string => {
      const resolution = path.resolve(context('action:bad'), {
        actionType: 'interact',
        parameters: parameters as never,
      })
      expect(resolution.status).toBe('rejected')
      return resolution.reason!
    }
    expect(
      reject({
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:missing',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      }),
    ).toBe('INTERACTION_NOT_BOUND')
    expect(
      reject({
        targetRef: { kind: 'entity', id: 'entity:other' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      }),
    ).toBe('INVALID_INTERACTION_PARAMETERS')
    expect(
      reject({
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:drop', version: 1 },
        arguments: {},
      }),
    ).toBe('INVALID_INTERACTION_PARAMETERS')
    // What an interaction step may carry at all is decided here: the closed vocabulary, no cue that names
    // an action of its own, and no cue stated twice inside one list.
    const takeWith = (performance: WorldJsonValue) => ({
      targetRef: { kind: 'entity', id: 'entity:cup' },
      bindingId: 'binding:entity:cup:base:take',
      definitionRef: { id: 'base:take', version: 1 },
      arguments: {},
      performance,
    })
    for (const performance of [
      { independent: ['slow_walk'], onSuccess: [] },
      { independent: ['quiet_voice'], onSuccess: [] },
      { independent: ['unknown_cue'], onSuccess: [] },
      { independent: ['frown', 'frown'], onSuccess: [] },
      { independent: ['frown'], onSuccess: ['frown', 'frown'] },
      { independent: 'frown', onSuccess: [] },
      { independent: ['frown'] },
      { independent: ['frown'], onSuccess: [], extra: true },
      {
        independent: ['frown', 'smile', 'nod', 'shake_head', 'avert_gaze', 'frown', 'smile', 'nod', 'shake_head'],
        onSuccess: [],
      },
      { independent: ['frown', 42], onSuccess: [] },
      { independent: ['frown', null], onSuccess: [] },
    ])
      expect(reject(takeWith(performance))).toBe('INVALID_INTERACTION_PARAMETERS')
    // A step that states no cue states nothing, exactly as an empty step reads on the action-group path.
    expect(
      path.resolve(context('action:empty-step'), {
        actionType: 'interact',
        parameters: takeWith({ independent: [], onSuccess: [] }),
      }).status,
    ).toBe('accepted')
    // A well-formed step this definition's own locked policy does not accept is a refused proposal, and
    // the caller is told so rather than meeting an exception from inside the trusted runtime.
    expect(
      path.resolve(context('action:refused-step'), {
        actionType: 'interact',
        parameters: takeWith({ independent: ['frown'], onSuccess: [] }),
      }),
    ).toMatchObject({ status: 'rejected', reason: 'PERFORMANCE_NOT_ACCEPTED' })
    expect(
      reject({
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
      }),
    ).toBe('INVALID_INTERACTION_PARAMETERS')
    expect(reject(null)).toBe('INVALID_INTERACTION_PARAMETERS')
    for (const broken of [
      {
        targetRef: { kind: 'entity' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
      {
        targetRef: { kind: 'entity', id: 'entity:cup', extra: 1 },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
      {
        targetRef: { kind: 'entity', id: 42 },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
      {
        targetRef: { kind: 'room', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
      {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 42,
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
      {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take' },
        arguments: {},
      },
      {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: null,
        arguments: {},
      },
      {
        targetRef: null,
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
      {
        targetRef: { kind: 'entity', id: '' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
    ])
      expect(reject(broken)).toBe('INVALID_INTERACTION_PARAMETERS')
    // Arguments are checked against the definition's own frozen schema at this boundary, so a payload
    // that does not fit it is a rejection here rather than an exception from inside the trusted runtime.
    for (const badArguments of [null, { unexpected: true }, { recipientId: 'character:npc' }]) {
      expect(
        reject({
          targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 },
          arguments: badArguments,
        }),
      ).toBe('INVALID_INTERACTION_ARGUMENTS')
    }
    // A definition that does take an argument still accepts a well-formed one through the same check.
    expect(
      path.resolve(context('action:give'), {
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 },
          arguments: {},
        },
      }).status,
    ).toBe('accepted')
    // A character named through the release binding is not a relation, so there is no instance to read
    // a class from and no binding it could have addressed.
    expect(
      reject({
        targetRef: { kind: 'character', id: 'character:npc' },
        bindingId: 'binding:release',
        definitionRef: { id: 'base:end-contact', version: 1 },
        arguments: {},
      }),
    ).toBe('INTERACTION_NOT_BOUND')
    // A relation of another class is not addressable through the release binding; it is refused rather
    // than silently ending somebody else's relation.
    expect(
      reject({
        targetRef: { kind: 'relation', id: 'relation:other' },
        bindingId: 'binding:release',
        definitionRef: { id: 'base:end-contact', version: 1 },
        arguments: {},
      }),
    ).toBe('INTERACTION_NOT_BOUND')
    // A rejection that is about this proposal rather than about routing keeps its own reason, so a
    // caller can tell "that is not a binding" from "that binding does not authorize you here".
    const elsewhere = path.resolve(context('action:gone', []), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
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
    expect(path.resolve(context('action:adopted'), { actionType: 'speak', parameters: { text: '好' } }).status).toBe(
      'accepted',
    )
    expect(() => path.adopt({ ...world.manifest, schemaVersion: 9 } as never, world.manifestHash)).toThrow(
      /only serves Manifest v10/u,
    )
  })

  it('refuses to resolve without the Host facts the frozen trace binds', () => {
    const path = rulebook()
    const action = { actionType: 'move', parameters: { locationId: 'location:next' } }
    expect(() => path.resolve(context('action:x', origin, { manifestHash: undefined }), action)).toThrow(
      /manifest hash and world sequence/u,
    )
    expect(() => path.resolve(context('action:x', origin, { asOfWorldSeq: undefined }), action)).toThrow(
      /manifest hash and world sequence/u,
    )
    expect(() => path.resolve(context('action:x', origin, { actionId: undefined }), action)).toThrow(
      /requires an actionId/u,
    )
    expect(() => path.resolve(context('action:x', origin, { resolutionAuthority: undefined }), action)).toThrow(
      /requires Host authority/u,
    )
    const v9 = frozenInteractionWorld().manifest
    expect(() => path.resolve(context('action:x', origin, { manifest: { ...v9, schemaVersion: 9 } }), action)).toThrow(
      /only serves Manifest v10/u,
    )
  })

  it('authorizes what the actor can reach and nothing else', () => {
    const snapshot = interactionHostSnapshot(world.manifest, origin, 'character:player')
    const keys = snapshot.authorizedTargets.map(ref => `${ref.kind}:${ref.id}`)
    expect(keys).toEqual(['character:character:npc', 'entity:entity:cup', 'entity:entity:other'])
    // An entity somebody else is holding is not the actor's to address.
    const held = [
      ...origin,
      {
        eventType: 'entity.transferred',
        eventVersion: 1,
        data: {
          entityId: 'entity:cup',
          characterId: 'character:npc',
          interactionId: 'base:take',
          fromLocationId: 'location:room',
          fromHolderId: null,
          toLocationId: null,
          toHolderId: 'character:bob',
        },
      },
    ]
    expect(
      interactionHostSnapshot(world.manifest, held, 'character:player').authorizedTargets.map(ref => ref.id),
    ).toEqual(['character:npc', 'entity:other'])
    // Out of the Scene as well as out of the Location: no co-location and no shared Scene, so there is
    // nothing left that makes the pair reachable.
    const gone = [
      ...origin,
      {
        eventType: 'character.moved',
        eventVersion: 1,
        data: { characterId: 'character:npc', fromLocationId: 'location:room', toLocationId: 'location:next' },
      },
      {
        eventType: 'scene.member_left',
        eventVersion: 1,
        data: { sceneId: 'scene:room', characterId: 'character:npc' },
      },
    ]
    expect(
      interactionHostSnapshot(world.manifest, gone, 'character:player').authorizedTargets.map(ref => ref.id),
    ).toEqual(['entity:cup', 'entity:other'])
    // Moving away while the Scene still holds them is enough for the rules to refuse, but the reach
    // projection is about reach, not about a particular rule: the Scene alone keeps them addressable.
    const stillInScene = [
      ...origin,
      {
        eventType: 'character.moved',
        eventVersion: 1,
        data: { characterId: 'character:npc', fromLocationId: 'location:room', toLocationId: 'location:next' },
      },
    ]
    expect(
      interactionHostSnapshot(world.manifest, stillInScene, 'character:player').authorizedTargets.map(ref => ref.id),
    ).toEqual(['character:npc', 'entity:cup', 'entity:other'])
  })

  it('identifies a candidate prefix by its contents, including events that name no version', () => {
    const path = rulebook()
    const take = {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
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
    const twoScenes = [
      ...origin,
      {
        eventType: 'scene.upsert',
        eventVersion: 1,
        data: {
          sceneId: 'scene:second',
          value: {
            lifecycle: 'active',
            locationId: 'location:room',
            participantIds: ['character:player', 'character:npc'],
          },
        },
      },
      {
        eventType: 'scene.upsert',
        eventVersion: 1,
        data: {
          sceneId: 'scene:third',
          value: {
            lifecycle: 'closed',
            locationId: 'location:room',
            participantIds: ['character:player', 'character:npc'],
          },
        },
      },
    ]
    const state = interactionHostSnapshot(world.manifest, twoScenes, 'character:player').targets.find(
      entry => entry.ref.kind === 'character' && entry.ref.id === 'character:player',
    )!.state
    // Both active Scenes are recorded and the closed one is not, so a rule reading sceneIds sees the
    // whole membership rather than whichever Scene happened to be read last.
    expect(state.sceneIds).toEqual(['scene:room', 'scene:second'])
  })
})

describe('the Rulebook registry on the frozen path', () => {
  it('fails closed when the Host installed no interaction package', () => {
    const registry = createCoreRulebookRegistry()
    const resolver = registry.resolve('builtin:speak-move', 2, 'correlation:i4b', address)
    expect(() =>
      resolver.resolve({
        manifest: world.manifest,
        events: origin,
        characterId: 'character:player',
        actionId: 'action:x',
        manifestHash: world.manifestHash,
        asOfWorldSeq: 4,
        resolutionAuthority: authority,
        action: { actionType: 'move', parameters: { locationId: 'location:next' } },
      }),
    ).toThrow(/package missing or lock drift/u)
    // speak is still the shared Rulebook's, so a world nobody can resolve interactions in still speaks.
    const spoke = resolver.resolve({
      manifest: world.manifest,
      events: origin,
      characterId: 'character:player',
      actionId: 'action:y',
      manifestHash: world.manifestHash,
      asOfWorldSeq: 4,
      resolutionAuthority: authority,
      action: { actionType: 'speak', parameters: { text: '走吧' } },
    })
    expect(spoke.status).toBe('accepted')
  })
})

describe('a v10 world through the production entry point', () => {
  it('records an accepted step as an observation fact, and nothing else about the round changes', async () => {
    // A hand-over is the one first-batch definition that sanctions a self-expression. The step it accepts
    // becomes a fact every observer can see, while the effect itself is built as if the step were not
    // stated - which is the whole point of keeping the performance out of the execution context.
    const compiled = frozenInteractionWorld()
    const run = async (performance?: WorldJsonObject): Promise<readonly StoredWorldEvent[]> => {
      const root = mkdtempSync(join(tmpdir(), 'frozen-performance-'))
      const app = new WorldApplication({
        interactionPackages: [basicInteractionPackage],
        worldPath: join(root, 'world.sqlite'),
        sessionPath: join(root, 'session.sqlite'),
        memoryPath: join(root, 'memory.sqlite'),
        modelBudgetTokens: 20,
      })
      try {
        app.activate(compiled)
        const submit = (key: string, parameters: WorldJsonObject) =>
          app.submit(compiled.manifest.address, {
            idempotencyKey: key,
            principalId: 'principal:player',
            correlationId: `frozen-${key}`,
            action: { actionType: 'interact', parameters: parameters as never },
          })
        await submit('take', {
          targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:take',
          definitionRef: { id: 'base:take', version: 1 },
          arguments: {},
        })
        await submit('give', {
          targetRef: { kind: 'entity', id: 'entity:cup' },
          bindingId: 'binding:entity:cup:base:give',
          definitionRef: { id: 'base:give', version: 1 },
          arguments: { recipientId: 'character:npc' },
          ...(performance === undefined ? {} : { performance }),
        })
      } finally {
        await app.close()
      }
      const store = new WorldStore(join(root, 'world.sqlite'))
      try {
        return store.readEvents(compiled.manifest.address)
      } finally {
        store.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
    const plain = await run()
    const expressed = await run({ independent: ['frown'], onSuccess: ['smile'] })
    // The effect is the one the same hand-over builds without a step: the ids differ because the input
    // does, but what the world recorded happening is the same fact.
    const effectOf = (events: readonly StoredWorldEvent[]) =>
      events.filter(event => event.eventType === 'entity.transferred').map(event => event.data)
    expect(effectOf(expressed)).toEqual(effectOf(plain))
    const manifested = expressed.filter(event => event.eventType === 'character.manifested')
    expect(manifested).toHaveLength(1)
    expect(manifested[0]!.data).toMatchObject({ characterId: 'character:player', actionId: expect.any(String) })
    expect(
      (manifested[0]!.data as { readonly cues: readonly { readonly description: string }[] }).cues.map(
        cue => cue.description,
      ),
    ).toEqual(['微微皱眉', '微微一笑'])
    // Everyone who observed the hand-over observes the expression with it.
    const observed = expressed
      .filter(event => event.eventType === 'observation.upsert')
      .map(
        event =>
          (event.data as { readonly value: { readonly observerId: string; readonly content: WorldJsonObject } }).value,
      )
      .filter(value => value.content.manifestation !== undefined)
    expect(observed.map(value => value.observerId).sort()).toContain('character:npc')
    expect(plain.some(event => event.eventType === 'character.manifested')).toBe(false)
    // A refused hand-over still plays what its author said plays whatever the outcome, and cancels the
    // rest: an expression that only rides on success cannot be claimed by an attempt that failed. The
    // recipient here is one the snapshot does not hold, so the plan refuses while the attempt stands.
    const path = rulebook()
    // A step that plays cues needs the Round it belongs to. A Host that withheld the Round gets told so
    // rather than a fact recorded against nothing.
    expect(() =>
      path.resolve(
        { ...context('action:no-round'), roundId: undefined },
        {
          actionType: 'interact',
          parameters: {
            targetRef: { kind: 'entity', id: 'entity:cup' },
            bindingId: 'binding:entity:cup:base:give',
            definitionRef: { id: 'base:give', version: 1 },
            arguments: { recipientId: 'character:npc' },
            performance: { independent: ['frown'], onSuccess: [] },
          },
        },
      ),
    ).toThrow('a manifested interaction step requires the Round it belongs to')
    const take = path.resolve(context('action:step-take'), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:take',
        definitionRef: { id: 'base:take', version: 1 },
        arguments: {},
      },
    })
    const refused = path.resolve(context('action:step-refused', [...origin, ...take.events]), {
      actionType: 'interact',
      parameters: {
        targetRef: { kind: 'entity', id: 'entity:cup' },
        bindingId: 'binding:entity:cup:base:give',
        definitionRef: { id: 'base:give', version: 1 },
        arguments: { recipientId: 'character:missing' },
        performance: { independent: ['nod'], onSuccess: ['smile'] },
      },
    })
    expect(refused.status).toBe('rejected')
    expect(refused.manifestation).toMatchObject({
      proposal: { cues: [{ cueId: 'cue:0', description: '点了点头' }] },
      resolution: { status: 'accepted', cueResolutions: [{ cueId: 'cue:0', status: 'accepted' }] },
    })
    expect(refused.events.map(event => event.eventType)).toEqual(['action.rejected', 'character.manifested'])
    expect(
      (refused.events[1]!.data as { readonly cues: readonly { readonly description: string }[] }).cues.map(
        cue => cue.description,
      ),
    ).toEqual(['点了点头'])
  }, 60_000)

  it('refuses to open a v10 world whose selection this Host cannot resolve', async () => {
    const root = mkdtempSync(join(tmpdir(), 'frozen-unrelated-'))
    const worldPath = join(root, 'world.sqlite')
    const compiled = frozenInteractionWorld()
    // A real, installable package that is simply not the one this world selected. Counting installed
    // packages would call this Host ready; freezing the selection says otherwise.
    const { lock: _lock, ...contents } = basicInteractionPackage
    const unrelated: InteractionPackageImplementation = {
      ...contents,
      lock: {
        ref: { id: 'package:unrelated', version: 1 },
        dependencies: [],
        implementationHash: interactionPackageHash(contents),
      },
    }
    const app = new WorldApplication({
      worldPath,
      sessionPath: join(root, 'session.sqlite'),
      memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20,
      interactionPackages: [unrelated],
    })
    try {
      expect(() => app.activate(compiled)).toThrow(/cannot resolve the interaction selection/u)
    } finally {
      await app.close()
    }
    // Refused before Genesis, so the branch is still unactivated and nothing was written.
    const store = new WorldStore(worldPath)
    try {
      expect(store.readManifest(compiled.manifest.address)).toBeUndefined()
    } finally {
      store.close()
    }
    rmSync(root, { recursive: true, force: true })
  }, 60_000)
})
