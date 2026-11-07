import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldEventDraft } from '@harness-world/contracts'
import { FrozenInteractionRulebook, WorldBootstrap, type RulebookEvent } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { moveEffects } from './move-effects.ts'
import { SceneDecisionService } from './scene-decision.ts'

const PLAYER = 'character:player',
  NPC = 'character:npc'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** The fixture room plus a not yet active scene in the next room, so a move both leaves and joins. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'move-effects-'))
  const path = join(root, 'world.sqlite'),
    store = new WorldStore(path),
    availability = new CharacterRuntimeAvailabilityService(path)
  cleanups.push(() => {
    availability.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const world = frozenInteractionWorld()
  new WorldBootstrap(store, false, new FrozenInteractionRulebook([basicInteractionPackage])).activate(world)
  const address = world.manifest.address
  const events: RulebookEvent[] = [
    ...store.readEvents(address),
    {
      eventType: 'scene.upsert',
      eventVersion: 1,
      data: { sceneId: 'scene:next', value: { lifecycle: 'created', locationId: 'location:next', participantIds: [] } },
    },
  ]
  return { scene: new SceneDecisionService(store, availability), address, events, headSeq: store.head(address).headSeq }
}

const moved = (characterId: string): WorldEventDraft => ({
  eventType: 'character.moved',
  eventVersion: 1,
  data: { characterId, fromLocationId: 'location:room', toLocationId: 'location:next' },
})

it('gives a scene transition to every moved character, not only the actor', () => {
  const f = fixture()
  const { transitions, moved: movers } = moveEffects({ ...f, drafts: [moved(PLAYER), moved(NPC)] })
  expect(transitions).toEqual([
    { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:room', characterId: PLAYER } },
    { eventType: 'scene.activated', eventVersion: 1, data: { sceneId: 'scene:next' } },
    { eventType: 'scene.member_joined', eventVersion: 1, data: { sceneId: 'scene:next', characterId: PLAYER } },
    // The second mover reads the first one's transitions: the next room is already active.
    { eventType: 'scene.member_left', eventVersion: 1, data: { sceneId: 'scene:room', characterId: NPC } },
    { eventType: 'scene.member_joined', eventVersion: 1, data: { sceneId: 'scene:next', characterId: NPC } },
  ])
  expect(movers).toEqual([
    { characterId: PLAYER, fromLocationId: 'location:room', toLocationId: 'location:next' },
    { characterId: NPC, fromLocationId: 'location:room', toLocationId: 'location:next' },
  ])
})

it('matches the single-mover transition when only the actor moves', () => {
  const f = fixture()
  expect(moveEffects({ ...f, drafts: [moved(PLAYER)] }).transitions).toEqual(
    f.scene.transitionForMove(f.address, f.events, PLAYER as never, 'location:next', f.headSeq),
  )
  expect(moveEffects({ ...f, drafts: [] })).toEqual({ transitions: [], moved: [] })
})
