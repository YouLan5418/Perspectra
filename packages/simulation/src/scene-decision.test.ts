import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SceneDecisionService } from '@harness-world/application'
import { brandId, WorldError, type WorldJsonValue } from '@harness-world/contracts'
import { WorldBootstrap, type RulebookEvent } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'
import { compileMysteryDemo, MYSTERY_DEMO_IDS } from './mystery-demo.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-scene-decision-'))
  directories.push(directory)
  const path = join(directory, 'world.sqlite')
  const compiled = compileMysteryDemo()
  const store = new WorldStore(path)
  new WorldBootstrap(store).activate(compiled)
  const availability = new CharacterRuntimeAvailabilityService(path)
  availability.initialize(compiled.manifest.address, compiled.manifest.characters.map(character => ({
    characterId: character.characterId,
    state: 'ready' as const,
  })))
  const service = new SceneDecisionService(store, availability)
  return { compiled, store, availability, service }
}

function phase8Events(): readonly RulebookEvent[] {
  return [
    { eventType: 'character.created', data: { characterId: MYSTERY_DEMO_IDS.player, locationId: 'location:road' } },
    { eventType: 'character.created', data: { characterId: MYSTERY_DEMO_IDS.bob, locationId: 'location:road' } },
    { eventType: 'character.created', data: { characterId: MYSTERY_DEMO_IDS.detective, locationId: 'location:road' } },
    {
      eventType: 'scene.upsert',
      data: {
        sceneId: 'scene:road',
        value: {
          lifecycle: 'active', locationId: 'location:road',
          participantIds: [MYSTERY_DEMO_IDS.player, MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective],
        },
      },
    },
    {
      eventType: 'scene.upsert',
      data: { sceneId: 'scene:station', value: { lifecycle: 'created', locationId: 'location:station', participantIds: [] } },
    },
  ]
}

describe('SceneDecisionService', () => {
  it('selects one active Scene and filters lifecycle, location, visibility, and availability', () => {
    const { compiled, store, availability, service } = fixture()
    const player = brandId(MYSTERY_DEMO_IDS.player, 'CharacterId')
    const head = store.head(compiled.manifest.address)
    expect(service.decide(compiled.manifest.address, player, head.headSeq)).toMatchObject({
      sceneId: MYSTERY_DEMO_IDS.scene,
      observerIds: [MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective, MYSTERY_DEMO_IDS.player],
      schedulableCharacterIds: [MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective],
      asOfSeq: head.headSeq,
    })
    availability.set(
      compiled.manifest.address, brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId'),
      'provider_output_invalid', 'quality backoff',
    )
    expect(service.decide(compiled.manifest.address, player, head.headSeq).schedulableCharacterIds)
      .toContain(MYSTERY_DEMO_IDS.bob)
    const unavailable = brandId('character:unavailable', 'CharacterId')
    expect(service.decideFromEvents(compiled.manifest.address, player, [
      ...store.readEvents(compiled.manifest.address),
      { eventType: 'character.created', data: { characterId: unavailable, locationId: 'location:study' } },
      {
        eventType: 'scene.upsert',
        data: {
          sceneId: MYSTERY_DEMO_IDS.scene,
          value: {
            participantIds: [MYSTERY_DEMO_IDS.player, MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective, unavailable],
          },
        },
      },
    ], head.headSeq).schedulableCharacterIds).not.toContain(unavailable)
    availability.set(compiled.manifest.address, brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId'), 'offline', 'drill')
    const history = store.readEvents(compiled.manifest.address)
    const changed: RulebookEvent[] = [
      ...history,
      { eventType: 'visibility.upsert', data: { id: 'visibility:bob', value: { observerId: MYSTERY_DEMO_IDS.bob, sceneId: MYSTERY_DEMO_IDS.scene, visible: false } } },
      { eventType: 'visibility.upsert', data: { id: 'visibility:detective', value: { observerId: MYSTERY_DEMO_IDS.detective, sceneId: 'scene:other', visible: false } } },
      { eventType: 'visibility.remove', data: { id: 'visibility:detective' } },
      { eventType: 'character.moved', data: { characterId: MYSTERY_DEMO_IDS.detective, toLocationId: 'location:drawing-room' } },
      { eventType: 'character.lifecycle-changed', data: { characterId: MYSTERY_DEMO_IDS.bob, lifecycleState: 'departed' } },
    ]
    expect(service.decideFromEvents(compiled.manifest.address, player, changed, head.headSeq)).toMatchObject({
      observerIds: [MYSTERY_DEMO_IDS.player],
      schedulableCharacterIds: [],
      visibleResultCharacterIds: [MYSTERY_DEMO_IDS.player],
    })
    availability.close()
    store.close()
  })

  it('fails closed for zero/overlapping Scenes and malformed scene or visibility prefixes', () => {
    const { compiled, store, availability, service } = fixture()
    const player = brandId(MYSTERY_DEMO_IDS.player, 'CharacterId')
    const base = store.readEvents(compiled.manifest.address)
    const decide = (events: readonly RulebookEvent[]) => service.decideFromEvents(compiled.manifest.address, player, events, base.length)
    expect(() => decide([...base, { eventType: 'scene.remove', data: { sceneId: MYSTERY_DEMO_IDS.scene } }]))
      .toThrowError(expect.objectContaining<Partial<WorldError>>({ envelope: expect.objectContaining({ errorCode: 'PROJECTION_INVARIANT_FAILED' }) }))
    expect(() => decide([...base, {
      eventType: 'scene.upsert', data: { sceneId: 'scene:overlap', value: { participantIds: [MYSTERY_DEMO_IDS.player] } },
    }])).toThrow('exactly one')
    for (const event of [
      { eventType: 'scene.upsert', data: { value: { participantIds: [] } } },
      { eventType: 'scene.upsert', data: { sceneId: 'scene:missing-value' } },
      { eventType: 'scene.upsert', data: { sceneId: 'scene:bad', value: { participantIds: [1] } } },
      { eventType: 'visibility.upsert', data: { value: {} } },
      { eventType: 'visibility.upsert', data: { id: 'visibility:bad', value: { observerId: 1, sceneId: 'scene:x', visible: 'yes' } } },
      { eventType: 'visibility.remove', data: {} },
    ] as readonly { readonly eventType: string; readonly data: WorldJsonValue }[]) {
      expect(() => decide([...base, event])).toThrow(TypeError)
    }
    availability.close()
    store.close()
  })

  it('rebuilds Scene Decision v2 lifecycle, zero-focal state, and same-prefix membership changes', () => {
    const { compiled, store, availability } = fixture()
    const service = new SceneDecisionService(store, availability, 2)
    const player = brandId(MYSTERY_DEMO_IDS.player, 'CharacterId')
    const bob = brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId')
    const base = phase8Events()
    expect(service.decideFromEvents(compiled.manifest.address, player, base, 5)).toMatchObject({
      schemaVersion: 'scene-decision/v2', sceneId: 'scene:road',
      memberIds: [MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective, MYSTERY_DEMO_IDS.player],
      observerIds: [MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective, MYSTERY_DEMO_IDS.player],
      schedulableCharacterIds: [MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective],
      directorEligible: true, asOfSeq: 5, decisionHash: expect.stringMatching(/^sha256:/),
    })

    const transferred: RulebookEvent[] = [
      ...base,
      { eventType: 'scene.member_left', data: { sceneId: 'scene:road', characterId: MYSTERY_DEMO_IDS.player } },
      { eventType: 'scene.member_left', data: { sceneId: 'scene:road', characterId: MYSTERY_DEMO_IDS.bob } },
      { eventType: 'scene.member_joined', data: { sceneId: 'scene:station', characterId: MYSTERY_DEMO_IDS.bob } },
      { eventType: 'character.moved', data: { characterId: MYSTERY_DEMO_IDS.bob, toLocationId: 'location:station' } },
      { eventType: 'scene.activated', data: { sceneId: 'scene:station' } },
    ]
    expect(service.decideFromEvents(compiled.manifest.address, player, transferred, 10)).toMatchObject({
      sceneId: null, memberIds: [], observerIds: [], schedulableCharacterIds: [], directorEligible: false,
    })
    expect(service.decideFromEvents(compiled.manifest.address, bob, transferred, 10)).toMatchObject({
      sceneId: 'scene:station', memberIds: [MYSTERY_DEMO_IDS.bob], observerIds: [MYSTERY_DEMO_IDS.bob],
    })
    const completedLifecycle: RulebookEvent[] = [
      ...base,
      { eventType: 'scene.created', data: { sceneId: 'scene:temporary', locationId: null } },
      { eventType: 'scene.member_joined', data: { sceneId: 'scene:temporary', characterId: 'character:temporary' } },
      { eventType: 'scene.activated', data: { sceneId: 'scene:temporary' } },
      { eventType: 'scene.closed', data: { sceneId: 'scene:temporary' } },
    ]
    expect(service.decideFromEvents(compiled.manifest.address, player, completedLifecycle, 9).sceneId).toBe('scene:road')

    const overlap = [...base, {
      eventType: 'scene.upsert',
      data: { sceneId: 'scene:overlap', value: { lifecycle: 'active', locationId: null, participantIds: [MYSTERY_DEMO_IDS.bob] } },
    }]
    expect(() => service.decideFromEvents(compiled.manifest.address, player, overlap, 6)).toThrowError(
      expect.objectContaining<Partial<WorldError>>({ envelope: expect.objectContaining({ errorCode: 'SCENE_MEMBERSHIP_INVARIANT' }) }),
    )
    for (const event of [
      { eventType: 'scene.remove', data: { sceneId: 'scene:road' } },
      { eventType: 'scene.closed', data: { sceneId: 'scene:station' } },
      { eventType: 'scene.activated', data: { sceneId: 'scene:road' } },
      { eventType: 'scene.member_joined', data: { sceneId: 'scene:road', characterId: MYSTERY_DEMO_IDS.player } },
      { eventType: 'scene.member_left', data: { sceneId: 'scene:road', characterId: 'character:absent' } },
      { eventType: 'scene.member_left', data: { sceneId: 'scene:road' } },
      { eventType: 'scene.created', data: { sceneId: 'scene:road', locationId: null } },
      { eventType: 'scene.created', data: { sceneId: 'scene:new', locationId: 1 } },
      { eventType: 'scene.activated', data: { sceneId: 'scene:absent' } },
      { eventType: 'scene.upsert', data: { sceneId: 'scene:bad', value: { participantIds: [] } } },
      { eventType: 'scene.upsert', data: { sceneId: 'scene:bad', value: { lifecycle: 'active', locationId: null, participantIds: ['x', 'x'] } } },
      { eventType: 'scene.upsert', data: { sceneId: 'scene:road', value: { lifecycle: 'active', locationId: null, participantIds: [] } } },
    ] as readonly RulebookEvent[]) {
      expect(() => service.decideFromEvents(compiled.manifest.address, player, [...base, event], 6)).toThrowError(
        expect.objectContaining<Partial<WorldError>>({ envelope: expect.objectContaining({ errorCode: 'PROJECTION_INVARIANT_FAILED' }) }),
      )
    }
    expect(service.decideFromEvents(compiled.manifest.address, player, [
      ...base, { eventType: 'scene.policy_recorded', data: { sceneId: 'scene:road' } },
    ], 6).sceneId).toBe('scene:road')
    availability.close()
    store.close()
  })

  it('derives deterministic Location-bound Scene transitions for generic movement', () => {
    const { compiled, store, availability } = fixture()
    const service = new SceneDecisionService(store, availability, 2)
    const legacy = new SceneDecisionService(store, availability)
    const player = brandId(MYSTERY_DEMO_IDS.player, 'CharacterId')
    const bob = brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId')
    const base = phase8Events()
    const transition = (characterId: typeof bob, locationId: string, events = base) => service.transitionForMove(
      compiled.manifest.address, events, characterId, locationId, events.length,
    )
    expect(transition(bob, 'location:station')).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:road', characterId: bob } },
      { eventType: 'scene.activated', eventVersion: 1, data: { sceneId: 'scene:station' } },
      { eventType: 'scene.member_joined', eventVersion: 1, data: { sceneId: 'scene:station', characterId: bob } },
    ])
    expect(transition(player, 'location:road')).toEqual([])
    expect(transition(player, 'location:absent')).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:road', characterId: player } },
    ])
    const singleMember = base.map(event => event.eventType !== 'scene.upsert'
      || (event.data as Record<string, unknown>).sceneId !== 'scene:road'
      ? event
      : {
        ...event,
        data: { sceneId: 'scene:road', value: { lifecycle: 'active', locationId: 'location:road', participantIds: [player] } },
      })
    expect(transition(player, 'location:absent', singleMember)).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:road', characterId: player } },
      { eventType: 'scene.closed', eventVersion: 1, data: { sceneId: 'scene:road' } },
    ])
    const activeDestination = [
      ...base,
      { eventType: 'scene.activated', data: { sceneId: 'scene:station' } },
    ]
    expect(transition(bob, 'location:station', activeDestination)).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:road', characterId: bob } },
      { eventType: 'scene.member_joined', eventVersion: 1, data: { sceneId: 'scene:station', characterId: bob } },
    ])
    const alreadyWaiting = base.map(event => event.eventType !== 'scene.upsert'
      || (event.data as Record<string, unknown>).sceneId !== 'scene:station'
      ? event
      : {
        ...event,
        data: { sceneId: 'scene:station', value: { lifecycle: 'created', locationId: 'location:station', participantIds: [bob] } },
      })
    expect(transition(bob, 'location:station', alreadyWaiting)).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:road', characterId: bob } },
      { eventType: 'scene.activated', eventVersion: 1, data: { sceneId: 'scene:station' } },
    ])
    const absent = brandId('character:absent', 'CharacterId')
    expect(transition(absent, 'location:station')).toEqual([
      { eventType: 'scene.activated', eventVersion: 1, data: { sceneId: 'scene:station' } },
      { eventType: 'scene.member_joined', eventVersion: 1, data: { sceneId: 'scene:station', characterId: absent } },
    ])
    expect(() => legacy.transitionForMove(compiled.manifest.address, base, bob, 'location:station', 5)).toThrow(TypeError)
    expect(() => transition(bob, 'location:station', [...base, {
      eventType: 'scene.upsert',
      data: { sceneId: 'scene:overlap', value: { lifecycle: 'active', locationId: null, participantIds: [bob] } },
    }])).toThrowError(expect.objectContaining<Partial<WorldError>>({
      envelope: expect.objectContaining({ errorCode: 'PROJECTION_INVARIANT_FAILED' }),
    }))
    expect(() => transition(bob, 'location:station', [...base, {
      eventType: 'scene.upsert',
      data: { sceneId: 'scene:station-2', value: { lifecycle: 'created', locationId: 'location:station', participantIds: [] } },
    }])).toThrowError(expect.objectContaining<Partial<WorldError>>({
      envelope: expect.objectContaining({ errorCode: 'PROJECTION_INVARIANT_FAILED' }),
    }))
    availability.close()
    store.close()
  })

  it('narrows full and occurrence-only action audiences without leaking private content', () => {
    const { compiled, store, availability } = fixture()
    const service = new SceneDecisionService(store, availability, 2)
    const legacy = new SceneDecisionService(store, availability)
    const player = brandId(MYSTERY_DEMO_IDS.player, 'CharacterId')
    const bob = brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId')
    const detective = brandId(MYSTERY_DEMO_IDS.detective, 'CharacterId')
    const base = phase8Events()
    expect(service.audienceForAction(compiled.manifest.address, player, base, 5)).toEqual({
      fullContentCharacterIds: [bob, detective, player], occurrenceOnlyCharacterIds: [],
    })
    expect(service.audienceForAction(compiled.manifest.address, player, base, 5, { scope: 'self' })).toEqual({
      fullContentCharacterIds: [player], occurrenceOnlyCharacterIds: [],
    })
    expect(service.audienceForAction(compiled.manifest.address, player, base, 5, { scope: 'direct', recipientIds: [bob] })).toEqual({
      fullContentCharacterIds: [bob, player], occurrenceOnlyCharacterIds: [],
    })
    expect(service.audienceForAction(compiled.manifest.address, player, base, 5, { scope: 'private', recipientIds: [bob] })).toEqual({
      fullContentCharacterIds: [bob, player], occurrenceOnlyCharacterIds: [detective],
    })
    const hidden = [...base, {
      eventType: 'visibility.upsert',
      data: { id: 'visibility:detective', value: { observerId: detective, sceneId: 'scene:road', visible: false } },
    }]
    expect(service.audienceForAction(compiled.manifest.address, player, hidden, 6, { scope: 'private', recipientIds: [bob] }))
      .toEqual({ fullContentCharacterIds: [bob, player], occurrenceOnlyCharacterIds: [] })
    expect(() => legacy.audienceForAction(compiled.manifest.address, player, base, 5)).toThrow(TypeError)
    for (const policy of [
      { scope: 'direct' },
      { scope: 'private', recipientIds: [] },
      { scope: 'self', recipientIds: [bob] },
      { scope: 'scene_public', recipientIds: [bob] },
      { scope: 'direct', recipientIds: [bob, bob] },
      { scope: 'direct', recipientIds: [1] },
    ] as unknown as Parameters<SceneDecisionService['audienceForAction']>[4][]) {
      expect(() => service.audienceForAction(compiled.manifest.address, player, base, 5, policy)).toThrow(TypeError)
    }
    availability.close()
    store.close()
  })
})
