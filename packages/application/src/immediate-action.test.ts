import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandId, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { FrozenInteractionRulebook, WorldBootstrap, type RulebookResolution } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore } from '@harness-world/store-sqlite'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { immediateActionDrafts } from './immediate-action.ts'
import { SceneDecisionService } from './scene-decision.ts'

const PLAYER = 'character:player',
  NPC = 'character:npc'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'immediate-action-'))
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
  const address = world.manifest.address,
    events = store.readEvents(address)
  return (
    result: Pick<RulebookResolution, 'status' | 'events' | 'observationScope'>,
    actionType = 'interact',
    parameters: WorldJsonObject = {},
  ) =>
    immediateActionDrafts({
      scene: new SceneDecisionService(store, availability),
      address,
      manifest: world.manifest,
      events,
      headSeq: store.head(address).headSeq,
      actorId: brandId(PLAYER, 'CharacterId'),
      actionId: 'action:test',
      action: { actionType, parameters },
      result,
      description: '你做了一件事。',
    })
}
const observations = (events: readonly WorldEventDraft[]) =>
  new Map(
    events
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => {
        const value = (event.data as WorldJsonObject).value as WorldJsonObject
        return [String(value.observerId), value.content as WorldJsonObject]
      }),
  )

it('tells the whole scene a public action, addressing only the actor as you', () => {
  const seen = observations(fixture()({ status: 'accepted', events: [] }))
  expect(seen.get(PLAYER)).toMatchObject({ resultDescription: '你做了一件事。', status: 'accepted' })
  expect(seen.get(NPC)).toMatchObject({ resultDescription: '行动者做了一件事。' })
})

it('limits a direct action to the actor and its present recipients', () => {
  const seen = observations(
    fixture()({ status: 'accepted', events: [], observationScope: { scope: 'direct', recipientIds: [PLAYER] } }),
  )
  expect([...seen.keys()]).toEqual([PLAYER])
})

it('tells others only that a private action happened', () => {
  const seen = observations(
    fixture()({ status: 'accepted', events: [], observationScope: { scope: 'private', recipientIds: [PLAYER] } }),
  )
  expect(seen.get(PLAYER)).toMatchObject({ resultDescription: '你做了一件事。' })
  expect(seen.get(NPC)).toEqual({
    actorId: PLAYER,
    actionType: 'private_interaction',
    status: 'accepted',
    contentVisibility: 'occurrence_only',
  })
})

it('shares an item transfer with witnesses and records the action last', () => {
  const transfer: WorldEventDraft = {
    eventType: 'entity.transferred',
    eventVersion: 1,
    data: {
      entityId: 'entity:cup',
      characterId: PLAYER,
      interactionId: 'test',
      fromHolderId: null,
      fromLocationId: 'location:room',
      toHolderId: PLAYER,
      toLocationId: null,
    },
  }
  const events = fixture()({ status: 'accepted', events: [transfer] })
  expect(observations(events).get(NPC)?.interaction).toEqual(transfer.data)
  expect(events[0]).toEqual(transfer)
  expect(events.at(-1)).toMatchObject({
    eventType: 'action.resolved',
    data: { actorId: PLAYER, actionId: 'action:test', accepted: true, sourceRole: 'player' },
  })
})

it('tells those left behind where the actor came from, and the actor the whole route', () => {
  const moved: WorldEventDraft = {
    eventType: 'character.moved',
    eventVersion: 1,
    data: { characterId: PLAYER, fromLocationId: 'location:room', toLocationId: 'location:next' },
  }
  const events = fixture()({ status: 'accepted', events: [moved] }, 'move', { locationId: 'location:next' })
  const seen = observations(events)
  expect(seen.get(NPC)?.movement).toEqual({ characterId: PLAYER, fromLocationId: 'location:room' })
  expect(seen.get(PLAYER)?.movement).toEqual({
    characterId: PLAYER,
    fromLocationId: 'location:room',
    toLocationId: 'location:next',
  })
})

it('does not repeat a line that an interaction carried with its own observations', () => {
  const speak: WorldEventDraft = {
    eventType: 'character.speak',
    eventVersion: 1,
    data: { characterId: PLAYER, text: '脚本替玩家说的话', scope: 'scene_public', addresseeIds: [] },
  }
  const scripted = observations(fixture()({ status: 'accepted', events: [speak] }))
  expect(scripted.get(PLAYER)).not.toHaveProperty('speech')
  const said = observations(fixture()({ status: 'accepted', events: [speak] }, 'speak', { text: '脚本替玩家说的话' }))
  expect(said.get(NPC)?.speech).toEqual(speak.data)
})
