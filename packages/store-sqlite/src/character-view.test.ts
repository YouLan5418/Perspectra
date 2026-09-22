import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandId, type WorldAddress, type WorldEventDraft } from '@harness-world/contracts'
import { CharacterViewBuilder } from './character-view.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function database(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-character-view-'))
  directories.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:view', 'TenantId'),
    worldId: brandId('world:view', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

async function commit(store: WorldStore, worldAddress: WorldAddress, suffix: string, events: readonly WorldEventDraft[]) {
  const head = store.head(worldAddress)
  return store.commitRound({
    address: worldAddress,
    transactionId: brandId(`transaction:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events,
    outbox: [],
    correlationId: suffix,
  })
}

describe('CharacterViewBuilder', () => {
  it('combines only one character owner scope and excludes parent future canaries', async () => {
    const store = new WorldStore(database('views.sqlite'))
    const parent = address('parent')
    const child = address('child')
    const characterA = brandId('character:a', 'CharacterId')
    const characterB = brandId('character:b', 'CharacterId')
    store.createBranch(parent)
    await commit(store, parent, 'base', [
      { eventType: 'character.upsert', eventVersion: 1, data: { characterId: characterA, locationId: 'location:a' } },
      { eventType: 'character.upsert', eventVersion: 1, data: { characterId: characterB, locationId: 'location:b' } },
      { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:shared', value: { participantIds: [characterA, characterB] } } },
      { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:a', value: { participantIds: [characterA] } } },
      { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:none', value: { participantIds: 'invalid' } } },
      { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:array', value: [] } },
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:a', value: { observerId: characterA, content: 'A_ONLY' } } },
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:b', value: { observerId: characterB, content: 'B_ONLY' } } },
      { eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:a', value: { characterId: characterA, proposition: 'A_CLAIM' } } },
      { eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:b', value: { characterId: characterB, proposition: 'B_CLAIM' } } },
      { eventType: 'goal.upsert', eventVersion: 1, data: { id: 'goal:a', value: { characterId: characterA, goal: 'A_GOAL' } } },
      { eventType: 'goal.upsert', eventVersion: 1, data: { id: 'goal:b', value: { characterId: characterB, goal: 'B_GOAL' } } },
      { eventType: 'visibility.upsert', eventVersion: 1, data: { id: 'visibility:a:shared', value: { observerId: characterA, sceneId: 'scene:shared', visible: true } } },
      { eventType: 'visibility.upsert', eventVersion: 1, data: { id: 'visibility:b:shared', value: { observerId: characterB, sceneId: 'scene:shared', visible: false } } },
      { eventType: 'character.speak', eventVersion: 1, data: { characterId: characterA, text: 'hello', narration: 'A_EXPRESSION' } },
      { eventType: 'action.rejected', eventVersion: 1, data: { characterId: characterA, actionType: 'move', reason: 'HIDDEN_REASON' } },
      { eventType: 'character.moved', eventVersion: 1, data: { characterId: characterA, toLocationId: 'location:b' } },
    ])
    const forkSeq = store.head(parent).headSeq
    store.forkBranch(parent, child, forkSeq)
    await commit(store, parent, 'future', [
      { eventType: 'character.lifecycle-changed', eventVersion: 1, data: { characterId: characterA, lifecycleState: 'dead' } },
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:future', value: { observerId: characterA, content: 'FUTURE_CANARY' } } },
      { eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:future', value: { characterId: characterB, proposition: 'B_FUTURE' } } },
      { eventType: 'scene.remove', eventVersion: 1, data: { sceneId: 'scene:a' } },
    ])

    const builder = new CharacterViewBuilder(store)
    const fullHistoryRead = vi.spyOn(store, 'readEvents').mockImplementation(() => {
      throw new Error('CharacterView must use typed Event range reads')
    })
    const viewA = builder.rebuildAt(child, characterA, forkSeq)
    expect(viewA.lifecycleState).toBe('active')
    expect(viewA.locationId).toBe('location:b')
    expect(viewA.scenes.map(scene => scene.sceneId)).toEqual(['scene:a', 'scene:shared'])
    expect(viewA.observations.map(record => record.id)).toEqual(['observation:a'])
    expect(viewA.claims.map(record => record.id)).toEqual(['claim:a'])
    expect(viewA.goals.map(record => record.id)).toEqual(['goal:a'])
    expect(viewA.visibility.map(record => record.id)).toEqual(['visibility:a:shared'])
    expect(viewA.selfObservations.map(value => value.content)).toEqual([
      { actionType: 'speak', text: 'hello', narration: 'A_EXPRESSION' },
      { actionType: 'move', status: 'rejected' },
      { actionType: 'move', locationId: 'location:b' },
    ])
    const serializedA = JSON.stringify(viewA)
    expect(serializedA).not.toContain('B_ONLY')
    expect(serializedA).not.toContain('B_CLAIM')
    expect(serializedA).not.toContain('HIDDEN_REASON')
    expect(serializedA).not.toContain('FUTURE_CANARY')

    const viewB = builder.rebuildAt(child, characterB, forkSeq)
    expect(viewB.scenes).toEqual([])
    expect(viewB.observations.map(record => record.id)).toEqual(['observation:b'])
    expect(viewB.claims.map(record => record.id)).toEqual(['claim:b'])
    expect(viewB.goals.map(record => record.id)).toEqual(['goal:b'])
    expect(viewB.bundleHash).not.toBe(viewA.bundleHash)

    const parentNow = builder.rebuildAt(parent, characterA, store.head(parent).headSeq)
    expect(parentNow.lifecycleState).toBe('dead')
    expect(JSON.stringify(parentNow)).toContain('FUTURE_CANARY')
    expect(parentNow.scenes.map(scene => scene.sceneId)).toEqual(['scene:shared'])
    expect(fullHistoryRead).not.toHaveBeenCalled()
    expect(() => builder.rebuildAt(parent, characterA, -1)).toThrow(RangeError)
    expect(() => builder.rebuildAt(parent, characterA, store.head(parent).headSeq + 1)).toThrow('later than the branch head')
    store.close()
  })

  it('replays every lifecycle state and retains the character after death, revival, and departure', async () => {
    const store = new WorldStore(database('lifecycle.sqlite'))
    const target = address('lifecycle')
    const character = brandId('character:lifecycle', 'CharacterId')
    store.createBranch(target)
    await commit(store, target, 'lifecycle', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: character, locationId: 'location:home', lifecycleState: 'active' } },
      { eventType: 'character.lifecycle-changed', eventVersion: 1, data: { characterId: character, lifecycleState: 'incapacitated' } },
      { eventType: 'character.lifecycle-changed', eventVersion: 1, data: { characterId: character, lifecycleState: 'dead' } },
      { eventType: 'character.lifecycle-changed', eventVersion: 1, data: { characterId: character, lifecycleState: 'active', transition: 'revived' } },
      { eventType: 'character.lifecycle-changed', eventVersion: 1, data: { characterId: character, lifecycleState: 'departed' } },
    ])
    const builder = new CharacterViewBuilder(store)
    expect([1, 2, 3, 4, 5].map(seq => builder.rebuildAt(target, character, seq).lifecycleState))
      .toEqual(['active', 'incapacitated', 'dead', 'active', 'departed'])
    expect(builder.rebuildAt(target, character, 5).locationId).toBe('location:home')
    store.close()
  })

  it('fails closed for malformed Scene events and ignores incomplete self-state events', async () => {
    const character = brandId('character:test', 'CharacterId')
    for (const [suffix, event] of [
      ['missing-id', { eventType: 'scene.upsert', eventVersion: 1, data: { value: {} } }],
      ['missing-value', { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:test' } }],
    ] as const) {
      const store = new WorldStore(database(`${suffix}.sqlite`))
      const worldAddress = address(suffix)
      store.createBranch(worldAddress)
      await commit(store, worldAddress, suffix, [event])
      expect(() => new CharacterViewBuilder(store).rebuildAt(worldAddress, character, 1)).toThrow()
      store.close()
    }

    const store = new WorldStore(database('incomplete-self.sqlite'))
    const worldAddress = address('incomplete-self')
    store.createBranch(worldAddress)
    await commit(store, worldAddress, 'incomplete-self', [
      { eventType: 'ignored', eventVersion: 1, data: null },
      { eventType: 'character.upsert', eventVersion: 1, data: { characterId: character, locationId: 1 } },
      { eventType: 'character.moved', eventVersion: 1, data: { characterId: character, toLocationId: 1 } },
      { eventType: 'character.speak', eventVersion: 1, data: { characterId: character, text: 1 } },
      { eventType: 'action.rejected', eventVersion: 1, data: { characterId: character, actionType: 1 } },
      { eventType: 'scene.remove', eventVersion: 1, data: { sceneId: 'scene:absent' } },
    ])
    const view = new CharacterViewBuilder(store).rebuildAt(worldAddress, character, store.head(worldAddress).headSeq)
    expect(view.locationId).toBeNull()
    expect(view.selfObservations).toEqual([])
    const missing = address('missing-character')
    store.createBranch(missing)
    await commit(store, missing, 'missing-character', [{ eventType: 'ignored', eventVersion: 1, data: null }])
    expect(() => new CharacterViewBuilder(store).rebuildAt(missing, character, 1)).toThrow('no creation event')
    store.close()
  })
})
