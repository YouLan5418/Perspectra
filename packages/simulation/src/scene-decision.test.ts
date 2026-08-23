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
})
