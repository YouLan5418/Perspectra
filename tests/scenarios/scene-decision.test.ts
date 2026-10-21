import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SceneDecisionService } from '@harness-world/application'
import { brandId, interactionPackageDescription, WorldError, type WorldJsonValue } from '@harness-world/contracts'
import { FrozenInteractionRulebook, WorldBootstrap, type RulebookEvent } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'

const SCENE_IDS = {
  player: 'character:player', bob: 'character:companion', detective: 'character:friend',
  scene: 'scene:front-room',
} as const

async function sceneWorld() {
  const pack = await compileWorldPackSource(resolve('examples/world-packs/prototype-g1'), [
    interactionPackageDescription(createBasicInteractionPackage()),
  ])
  return adaptCompiledWorldPack(pack, {
    address: { tenantId: brandId('tenant:scene-test', 'TenantId'),
      worldId: brandId('world:scene-test', 'WorldId'), branchId: brandId('branch:main', 'BranchId') },
    principalId: 'principal:scene-player', sessionId: brandId('session:scene-player', 'SessionId'),
  })
}

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-scene-decision-'))
  directories.push(directory)
  const path = join(directory, 'world.sqlite')
  const compiled = await sceneWorld()
  const store = new WorldStore(path)
  new WorldBootstrap(store, true, new FrozenInteractionRulebook([createBasicInteractionPackage()])).activate(compiled)
  const availability = new CharacterRuntimeAvailabilityService(path)
  availability.initialize(compiled.manifest.address, compiled.manifest.characters.map(character => ({
    characterId: character.characterId,
    state: 'ready' as const,
  })))
  return { compiled, store, availability }
}

function sceneEvents(): readonly RulebookEvent[] {
  return [
    { eventType: 'character.created', data: { characterId: SCENE_IDS.player, locationId: 'location:road' } },
    { eventType: 'character.created', data: { characterId: SCENE_IDS.bob, locationId: 'location:road' } },
    { eventType: 'character.created', data: { characterId: SCENE_IDS.detective, locationId: 'location:road' } },
    {
      eventType: 'scene.upsert',
      data: {
        sceneId: 'scene:road',
        value: {
          lifecycle: 'active', locationId: 'location:road',
          participantIds: [SCENE_IDS.player, SCENE_IDS.bob, SCENE_IDS.detective],
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
  it('selects one active Scene and filters lifecycle, location, visibility, and availability', async () => {
    const { compiled, availability, store } = await fixture()
    const service = new SceneDecisionService(store, availability)
    const player = brandId(SCENE_IDS.player, 'CharacterId')
    const bob = brandId(SCENE_IDS.bob, 'CharacterId')
    const base = sceneEvents()
    expect(service.decideFromEvents(compiled.manifest.address, player, base, 5)).toMatchObject({
      sceneId: 'scene:road',
      observerIds: [SCENE_IDS.bob, SCENE_IDS.detective, SCENE_IDS.player],
      schedulableCharacterIds: [SCENE_IDS.bob, SCENE_IDS.detective],
      asOfSeq: 5,
    })
    availability.set(compiled.manifest.address, bob, 'provider_output_invalid', 'quality backoff')
    expect(service.decideFromEvents(compiled.manifest.address, player, base, 5).schedulableCharacterIds).toContain(SCENE_IDS.bob)
    const unavailable = brandId('character:unavailable', 'CharacterId')
    expect(service.decideFromEvents(compiled.manifest.address, player, [
      ...base,
      { eventType: 'character.created', data: { characterId: unavailable, locationId: 'location:road' } },
      { eventType: 'scene.member_joined', data: { sceneId: 'scene:road', characterId: unavailable } },
    ], 7).schedulableCharacterIds).not.toContain(unavailable)
    availability.set(compiled.manifest.address, bob, 'offline', 'drill')
    const changed: RulebookEvent[] = [
      ...base,
      { eventType: 'visibility.upsert', data: { id: 'visibility:bob', value: { observerId: SCENE_IDS.bob, sceneId: 'scene:road', visible: false } } },
      { eventType: 'visibility.upsert', data: { id: 'visibility:detective', value: { observerId: SCENE_IDS.detective, sceneId: 'scene:other', visible: false } } },
      { eventType: 'visibility.remove', data: { id: 'visibility:detective' } },
      { eventType: 'character.moved', data: { characterId: SCENE_IDS.detective, toLocationId: 'location:back-room' } },
      { eventType: 'character.lifecycle-changed', data: { characterId: SCENE_IDS.bob, lifecycleState: 'departed' } },
    ]
    expect(service.decideFromEvents(compiled.manifest.address, player, changed, 10)).toMatchObject({
      observerIds: [SCENE_IDS.player],
      schedulableCharacterIds: [],
      visibleResultCharacterIds: [SCENE_IDS.player],
    })
    availability.close()
    store.close()
  })

  it('fails closed for malformed visibility prefixes', async () => {
    const { compiled, availability, store } = await fixture()
    const service = new SceneDecisionService(store, availability)
    const player = brandId(SCENE_IDS.player, 'CharacterId')
    const base = sceneEvents()
    for (const event of [
      { eventType: 'visibility.upsert', data: { value: {} } },
      { eventType: 'visibility.upsert', data: { id: 'visibility:bad', value: { observerId: 1, sceneId: 'scene:x', visible: 'yes' } } },
      { eventType: 'visibility.remove', data: {} },
    ] as readonly { readonly eventType: string; readonly data: WorldJsonValue }[]) {
      expect(() => service.decideFromEvents(compiled.manifest.address, player, [...base, event], 6)).toThrowError(
        expect.objectContaining<Partial<WorldError>>({ envelope: expect.objectContaining({ errorCode: 'PROJECTION_INVARIANT_FAILED' }) }),
      )
    }
    availability.close()
    store.close()
  })

  it('rebuilds Scene lifecycle, zero-focal state, and same-prefix membership changes', async () => {
    const { compiled, store, availability } = await fixture()
    const service = new SceneDecisionService(store, availability)
    const player = brandId(SCENE_IDS.player, 'CharacterId')
    const bob = brandId(SCENE_IDS.bob, 'CharacterId')
    const base = sceneEvents()
    expect(service.decideFromEvents(compiled.manifest.address, player, base, 5)).toMatchObject({
      schemaVersion: 'scene-decision/v2', sceneId: 'scene:road',
      memberIds: [SCENE_IDS.bob, SCENE_IDS.detective, SCENE_IDS.player],
      observerIds: [SCENE_IDS.bob, SCENE_IDS.detective, SCENE_IDS.player],
      schedulableCharacterIds: [SCENE_IDS.bob, SCENE_IDS.detective],
      directorEligible: true, asOfSeq: 5, decisionHash: expect.stringMatching(/^sha256:/),
    })

    const transferred: RulebookEvent[] = [
      ...base,
      { eventType: 'scene.member_left', data: { sceneId: 'scene:road', characterId: SCENE_IDS.player } },
      { eventType: 'scene.member_left', data: { sceneId: 'scene:road', characterId: SCENE_IDS.bob } },
      { eventType: 'scene.member_joined', data: { sceneId: 'scene:station', characterId: SCENE_IDS.bob } },
      { eventType: 'character.moved', data: { characterId: SCENE_IDS.bob, toLocationId: 'location:station' } },
      { eventType: 'scene.activated', data: { sceneId: 'scene:station' } },
    ]
    expect(service.decideFromEvents(compiled.manifest.address, player, transferred, 10)).toMatchObject({
      sceneId: null, memberIds: [], observerIds: [], schedulableCharacterIds: [], directorEligible: false,
    })
    expect(service.decideFromEvents(compiled.manifest.address, bob, transferred, 10)).toMatchObject({
      sceneId: 'scene:station', memberIds: [SCENE_IDS.bob], observerIds: [SCENE_IDS.bob],
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
      data: { sceneId: 'scene:overlap', value: { lifecycle: 'active', locationId: null, participantIds: [SCENE_IDS.bob] } },
    }]
    expect(() => service.decideFromEvents(compiled.manifest.address, player, overlap, 6)).toThrowError(
      expect.objectContaining<Partial<WorldError>>({ envelope: expect.objectContaining({ errorCode: 'SCENE_MEMBERSHIP_INVARIANT' }) }),
    )
    for (const event of [
      { eventType: 'scene.remove', data: { sceneId: 'scene:road' } },
      { eventType: 'scene.closed', data: { sceneId: 'scene:station' } },
      { eventType: 'scene.activated', data: { sceneId: 'scene:road' } },
      { eventType: 'scene.member_joined', data: { sceneId: 'scene:road', characterId: SCENE_IDS.player } },
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

  it('derives deterministic Location-bound Scene transitions for generic movement', async () => {
    const { compiled, store, availability } = await fixture()
    const service = new SceneDecisionService(store, availability)
    const player = brandId(SCENE_IDS.player, 'CharacterId')
    const bob = brandId(SCENE_IDS.bob, 'CharacterId')
    const base = sceneEvents()
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
    ])
    const returned = [...singleMember, ...transition(player, 'location:station', singleMember)]
    expect(transition(player, 'location:road', returned)).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:station', characterId: player } },
      { eventType: 'scene.member_joined', eventVersion: 1, data: { sceneId: 'scene:road', characterId: player } },
    ])
    const explicitlyClosed = [...returned, { eventType: 'scene.closed', data: { sceneId: 'scene:road' } }]
    expect(transition(player, 'location:road', explicitlyClosed)).toEqual([
      { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:station', characterId: player } },
    ])
    const temporary = singleMember.map(event => event.eventType === 'scene.upsert' && (event.data as Record<string, unknown>).sceneId === 'scene:road'
      ? { ...event, data: { sceneId: 'scene:road', value: { lifecycle: 'active', locationId: null, participantIds: [player] } } } : event)
    expect(transition(player, 'location:absent', temporary)).toEqual([
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

  it('narrows full and occurrence-only action audiences without leaking private content', async () => {
    const { compiled, store, availability } = await fixture()
    const service = new SceneDecisionService(store, availability)
    const player = brandId(SCENE_IDS.player, 'CharacterId')
    const bob = brandId(SCENE_IDS.bob, 'CharacterId')
    const detective = brandId(SCENE_IDS.detective, 'CharacterId')
    const base = sceneEvents()
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
