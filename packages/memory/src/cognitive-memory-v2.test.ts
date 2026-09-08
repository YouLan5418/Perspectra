import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type CharacterId,
  type RecallQueryPlan,
  type WorldAddress,
  type WorldEventDraft,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { CognitiveMemoryWorker } from './cognitive-context.ts'
import { LocalMemoryStore } from './local-memory.ts'

const directories: string[] = []

function paths(): { readonly world: string; readonly memory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-memory-v2-'))
  directories.push(directory)
  return { world: join(directory, 'world.sqlite'), memory: join(directory, 'memory.sqlite') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:memory-v2', 'TenantId'),
    worldId: brandId('world:memory-v2', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

const alice = brandId('character:alice', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const charlie = brandId('character:charlie', 'CharacterId')

function authorSource(id: string): WorldJsonObject {
  return { sourceKind: 'worldpack-test/v2', sourceId: id, sourceHash: hashWorldJson('memory-v2-author-source', id) }
}

function claimValue(): WorldJsonObject {
  return {
    proposition: { text: 'The north road is blocked' }, stance: 'believed', confidencePermille: 700,
    saliencePermille: 600, awareness: 'conscious', status: 'active', basisRefs: [], source: authorSource('claim:road'),
  }
}

function goalValue(): WorldJsonObject {
  return {
    objective: { kind: 'narrative', value: 'Reach the station' }, priorityPermille: 700,
    awareness: 'conscious', status: 'active', parentGoalKey: null, targetKeys: ['location:station'],
    blockerKeys: [], basisRefs: [], source: authorSource('goal:station'),
  }
}

async function commit(store: WorldStore, suffix: string, events: readonly WorldEventDraft[], target = address()): Promise<void> {
  const head = store.head(target)
  await store.commitRound({
    address: target,
    transactionId: brandId(`transaction:memory-v2:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:memory-v2:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
    events, outbox: [], correlationId: `memory-v2:${suffix}`,
  })
}

async function fixture() {
  const path = paths()
  const world = new WorldStore(path.world)
  world.createBranch(address())
  await commit(world, 'genesis', [
    { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:road' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: charlie, locationId: 'location:road' } },
    { eventType: 'observation.upsert', eventVersion: 1, data: {
      id: 'observation:rain', value: { observerId: alice, content: 'cold rain at the station', epistemicKind: 'direct_observation' },
    } },
    { eventType: 'observation.upsert', eventVersion: 1, data: {
      id: 'observation:speech', value: { observerId: alice, content: {
        actionType: 'speak', actorId: bob, speech: { characterId: bob, text: 'the bridge is closed' },
      } },
    } },
    { eventType: 'observation.upsert', eventVersion: 1, data: {
      id: 'observation:bob', value: { observerId: bob, content: { actionType: 'take', entityId: 'entity:ticket' } },
    } },
    { eventType: 'subjective-claim.upsert', eventVersion: 1, data: { id: 'claim:road', characterId: alice, value: claimValue() } },
    { eventType: 'character-goal.upsert', eventVersion: 1, data: { id: 'goal:station', characterId: alice, value: goalValue() } },
  ])
  return { path, world, memory: new LocalMemoryStore(path.memory, world) }
}

function plan(characterId: CharacterId, query: string, asOfWorldSeq = 8, planId = `plan:${characterId}:${query}`): RecallQueryPlan {
  return {
    schemaVersion: 'recall-query-plan/v1', planId, address: address(), characterId, asOfWorldSeq,
    query, limit: 10, rankingAlgorithm: 'fts5-bm25-stable/v1',
  }
}

describe('Cognitive Memory v2', () => {
  it('captures only committed, observer-scoped manifestation content without promoting private affect', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, 'manifestation-observations', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:road' } },
      { eventType: 'observation.upsert', eventVersion: 1, data: {
        id: 'observation:alice:manifested-speech', value: { observerId: alice, content: {
          actionType: 'speak', actorId: bob,
          speech: { characterId: bob, text: '我没事。' },
          manifestation: {
            characterId: bob, description: 'Bob 避开视线，声音发颤。',
            cues: [
              { cueId: 'cue:gaze', channel: 'gaze', description: '避开视线', persistence: 'event_only' },
              { cueId: 'cue:voice', channel: 'voice', description: '声音发颤', persistence: 'event_only' },
            ],
          },
        } },
      } },
      { eventType: 'observation.upsert', eventVersion: 1, data: {
        id: 'observation:alice:manifested-only', value: { observerId: alice, content: {
          actionType: 'move', actorId: bob,
          manifestation: {
            characterId: bob, description: null,
            cues: [{ cueId: 'cue:posture', channel: 'posture', description: '抱起双臂', persistence: 'event_only' }],
          },
        } },
      } },
    ])
    const memory = new LocalMemoryStore(path.memory, world)
    memory.catchUpV2(address(), alice, 4, 'catchup:manifestation:alice')
    expect(memory.recallV2(plan(alice, '声音发颤', 4)).memories).toMatchObject([{
      memoryKind: 'communication', epistemicKind: 'reported_speech',
      text: 'character:bob said: 我没事。; character:bob appeared: Bob 避开视线，声音发颤。',
      metadata: { manifestation: { characterId: bob } },
    }])
    expect(memory.recallV2(plan(alice, '抱起双臂', 4)).memories).toMatchObject([{
      memoryKind: 'episodic', epistemicKind: 'direct_observation',
      text: 'character:bob appeared: 抱起双臂',
    }])
    memory.catchUpV2(address(), bob, 4, 'catchup:manifestation:bob')
    expect(memory.recallV2(plan(bob, '声音发颤', 4)).memories).toEqual([])
    expect(JSON.stringify(memory.recallV2(plan(alice, '声音发颤', 4)).memories)).not.toContain('jealousy')
    memory.close()
    world.close()
  })

  it.each([
    ['missing-character', { description: 'visible', cues: [{ description: 'visible' }] }, 'requires characterId'],
    ['invalid-description', { characterId: bob, description: 1, cues: [{ description: 'visible' }] }, 'description must be string'],
    ['missing-cues', { characterId: bob, description: 'visible', cues: [] }, 'requires accepted cues'],
    ['invalid-cue', { characterId: bob, description: null, cues: [{}] }, 'cue requires description'],
  ] as const)('fails closed for malformed committed manifestation observations: %s', async (suffix, manifestation, message) => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, `malformed-manifestation:${suffix}`, [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      { eventType: 'observation.upsert', eventVersion: 1, data: {
        id: `observation:alice:${suffix}`, value: { observerId: alice, content: { manifestation } },
      } },
    ])
    const memory = new LocalMemoryStore(path.memory, world)
    expect(() => memory.catchUpV2(address(), alice, 2, `catchup:${suffix}`)).toThrow(message)
    memory.close()
    world.close()
  })

  it('captures the frozen subjective inference and self intention observation kinds', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, 'subjective-observations', [
      { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:road' } },
      { eventType: 'observation.upsert', eventVersion: 1, data: {
        id: 'observation:alice:inference',
        value: { observerId: alice, content: 'Bob may be hiding something', epistemicKind: 'subjective_inference' },
      } },
      { eventType: 'observation.upsert', eventVersion: 1, data: {
        id: 'observation:alice:intention',
        value: { observerId: alice, content: 'I will reach the station', epistemicKind: 'self_intention' },
      } },
    ])
    const memory = new LocalMemoryStore(path.memory, world)
    memory.catchUpV2(address(), alice, 3, 'catchup:subjective-observations')
    expect(memory.recallV2(plan(alice, 'Bob', 3)).memories).toMatchObject([{
      memoryKind: 'episodic', epistemicKind: 'subjective_inference',
    }])
    expect(memory.recallV2(plan(alice, 'station', 3)).memories).toMatchObject([{
      memoryKind: 'episodic', epistemicKind: 'self_intention',
    }])
    memory.close()
    world.close()
  })

  it('captures four source kinds, keeps reported speech subjective, and persists stable receipts and L1 extracts', async () => {
    const { world, memory } = await fixture()
    const fullHistoryRead = vi.spyOn(world, 'readEvents').mockImplementation(() => {
      throw new Error('Cognitive Memory must use typed Event range reads')
    })
    const first = new CognitiveMemoryWorker(memory).catchUp(address(), alice, 8)
    const replay = memory.catchUpV2(address(), alice, 8, 'catchup:alice:replay')
    expect(replay).toEqual(first)
    expect(first.watermark).toMatchObject({
      verifiedThroughSeq: 8, capturedThroughSeq: 8, memoryEpoch: 1,
    })
    expect(first.capturedMemoryIds).toHaveLength(4)
    expect(memory.cognitiveReceipt(first.receiptId)).toEqual(first)
    expect(memory.cognitiveReceipt('missing')).toBeUndefined()

    const communication = memory.recallV2(plan(alice, 'bridge'))
    expect(communication.memories).toMatchObject([{
      memoryKind: 'communication', epistemicKind: 'reported_speech',
      text: 'character:bob said: the bridge is closed',
    }])
    expect(communication.receipt.selectedSourceRefs).toHaveLength(1)
    expect(memory.recallV2(plan(alice, 'north')).memories[0]).toMatchObject({
      memoryKind: 'belief', epistemicKind: 'subjective_inference',
    })
    expect(memory.recallV2(plan(alice, 'station')).memories.some(value => value.memoryKind === 'intention')).toBe(true)
    expect(memory.recallV2(plan(alice, '   ')).memories).toEqual([])
    expect(memory.cognitiveSummaries(address(), alice)).toMatchObject([{
      schemaVersion: 'memory-l1/v1', sourceStartSeq: 4, sourceEndSeq: 8,
      algorithmId: 'deterministic-extractive-l1/v1',
    }])
    expect(memory.cognitiveSummaries(address(), alice)[0]!.extracts).toContain('character:bob said: the bridge is closed')

    memory.catchUpV2(address(), bob, 8, 'catchup:bob')
    expect(memory.recallV2(plan(bob, 'bridge')).memories).toEqual([])
    expect(memory.recallV2(plan(bob, 'ticket')).memories).toMatchObject([{
      memoryKind: 'episodic', epistemicKind: 'observed_action',
    }])
    memory.catchUpV2(address(), charlie, 8, 'catchup:charlie')
    expect(memory.cognitiveSummaries(address(), charlie)).toEqual([])
    expect(fullHistoryRead).not.toHaveBeenCalled()
    memory.close()
    world.close()
  })

  it('keeps fork, character, and future sources outside the selected namespace before ranking', async () => {
    const { world, memory } = await fixture()
    const child = address('child')
    world.forkBranch(address(), child, 8)
    await commit(world, 'future', [{
      eventType: 'observation.upsert', eventVersion: 1,
      data: { id: 'observation:future', value: { observerId: alice, content: 'FUTURE_CANARY' } },
    }])
    memory.catchUpV2(address(), alice, 9, 'catchup:parent')
    memory.catchUpV2(child, alice, 8, 'catchup:child')
    memory.catchUpV2(address(), bob, 9, 'catchup:bob')
    expect(memory.recallV2({ ...plan(alice, 'FUTURE_CANARY', 9), address: address() }).memories).toHaveLength(1)
    expect(memory.recallV2({ ...plan(alice, 'FUTURE_CANARY', 8), address: child }).memories).toEqual([])
    expect(memory.recallV2(plan(bob, 'cold')).memories).toEqual([])
    memory.close()
    world.close()
  })

  it('fails closed on backward, divergent, malformed, unverified, and conflicting derived state', async () => {
    const { path, world, memory } = await fixture()
    expect(() => memory.catchUpV2(address(), alice, -1, 'negative')).toThrow(RangeError)
    memory.catchUpV2(address(), alice, 8, 'catchup:base')
    expect(() => memory.catchUpV2(address(), alice, 7, 'backward')).toThrow('cannot move backward')
    expect(() => memory.recallV2(plan(bob, 'anything'))).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({ errorCode: 'MEMORY_CATCHUP_FAILED' }),
    }))
    for (const invalid of [
      { ...plan(alice, 'x'), asOfWorldSeq: -1 },
      { ...plan(alice, 'x'), limit: 0 },
      { ...plan(alice, 'x'), rankingAlgorithm: 'unknown' },
    ] as unknown as RecallQueryPlan[]) expect(() => memory.recallV2(invalid)).toThrow()

    const raw = new DatabaseSync(path.memory)
    raw.prepare(`UPDATE cognitive_memory_v2_namespaces SET source_map_hash = 'sha256:corrupt'`).run()
    raw.close()
    expect(() => memory.catchUpV2(address(), alice, 8, 'watermark-diverged')).toThrow('source map diverged')
    memory.close()

    const repaired = new LocalMemoryStore(path.memory, world)
    repaired.resetCognitiveNamespace(address(), alice)
    repaired.catchUpV2(address(), alice, 8, 'recaptured')
    const sourceDamage = new DatabaseSync(path.memory)
    sourceDamage.prepare(`UPDATE cognitive_memory_v2_sources SET source_hash = 'sha256:corrupt' WHERE namespace_key LIKE ?`).run(`%${alice}`)
    sourceDamage.close()
    expect(() => repaired.catchUpV2(address(), alice, 8, 'source-diverged')).toThrow('divergent content')

    const receiptDamage = new DatabaseSync(path.memory)
    receiptDamage.prepare(`UPDATE cognitive_memory_v2_receipts SET receipt_hash = 'sha256:corrupt'`).run()
    receiptDamage.close()
    repaired.resetCognitiveNamespace(address(), alice)
    const receipt = repaired.catchUpV2(address(), alice, 8, 'receipt-base')
    const conflicting = new DatabaseSync(path.memory)
    conflicting.prepare(`UPDATE cognitive_memory_v2_receipts SET receipt_hash = 'sha256:corrupt' WHERE receipt_id = ?`).run(receipt.receiptId)
    conflicting.close()
    expect(() => repaired.catchUpV2(address(), alice, 8, 'receipt-diverged')).toThrow('receipt diverged')
    repaired.close()
    world.close()
  })

  it('rejects malformed communication and episodic vocabularies and rolls back a damaged v2 reset', async () => {
    {
      const path = paths()
      const world = new WorldStore(path.world)
      world.createBranch(address())
      await commit(world, 'content-fallback', [
        { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:a' } },
        { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:self', value: { observerId: alice } } },
      ])
      const memory = new LocalMemoryStore(path.memory, world)
      expect(memory.catchUpV2(address(), alice, 2, 'content-fallback').capturedMemoryIds).toHaveLength(1)
      memory.close()
      world.close()
    }
    for (const [suffix, value, message] of [
      ['speech', { observerId: alice, content: { speech: { characterId: bob } } }, 'speech requires'],
      ['epistemic', { observerId: alice, content: 'text', epistemicKind: 'omniscient' }, 'epistemicKind'],
      ['value', null, 'must be an object'],
      ['id', { observerId: alice, content: 'text' }, 'observation id'],
    ] as const) {
      const path = paths()
      const world = new WorldStore(path.world)
      world.createBranch(address())
      await commit(world, `malformed:${suffix}`, [
        { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:a' } },
        { eventType: 'observation.upsert', eventVersion: 1, data: { id: suffix === 'id' ? '' : `observation:${suffix}`, value } },
      ])
      const memory = new LocalMemoryStore(path.memory, world)
      expect(() => memory.catchUpV2(address(), alice, 2, `malformed:${suffix}`)).toThrow(message)
      memory.close()
      world.close()
    }

    const fixtureValue = await fixture()
    fixtureValue.memory.catchUpV2(address(), alice, 8, 'reset:base')
    const raw = new DatabaseSync(fixtureValue.path.memory)
    raw.exec('DROP TABLE cognitive_memory_v2_fts')
    raw.close()
    expect(() => fixtureValue.memory.resetCognitiveNamespace(address(), alice)).toThrow()
    fixtureValue.memory.close()
    fixtureValue.world.close()
  })

  it('increments memoryEpoch on rebuild and rejects a reused recall plan identity with different results', async () => {
    const { path, world, memory } = await fixture()
    memory.catchUpV2(address(), alice, 8, 'epoch:first')
    expect(memory.resetCognitiveNamespace(address(), alice)).toBe(2)
    const second = memory.catchUpV2(address(), alice, 8, 'epoch:second')
    expect(second.watermark.memoryEpoch).toBe(2)
    const basePlan = plan(alice, 'bridge', 8, 'plan:stable')
    memory.recallV2(basePlan)
    expect(memory.recallV2(basePlan).receipt.receiptHash).toBe(memory.recallV2(basePlan).receipt.receiptHash)
    expect(() => memory.recallV2({ ...basePlan, query: 'station' })).toThrow('bound to another result')
    memory.close()

    const unopened = new LocalMemoryStore(path.memory, world)
    expect(unopened.resetCognitiveNamespace(address(), bob)).toBe(1)
    expect(unopened.cognitiveWatermark(address(), bob)).toMatchObject({ memoryEpoch: 1, verifiedThroughSeq: 0 })
    unopened.close()
    world.close()
  })
})
