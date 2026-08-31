import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  failWorld,
  hashWorldJson,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from './cognitive-context.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(): WorldAddress {
  return {
    tenantId: brandId('tenant:cognitive', 'TenantId'),
    worldId: brandId('world:cognitive', 'WorldId'),
    branchId: brandId('branch:main', 'BranchId'),
  }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-cognitive-context-'))
  directories.push(directory)
  const worldPath = join(directory, 'world.sqlite')
  const memoryPath = join(directory, 'memory.sqlite')
  const world = new WorldStore(worldPath)
  world.createBranch(address())
  const alice = brandId('character:alice', 'CharacterId')
  const bob = brandId('character:bob', 'CharacterId')
  const events: WorldEventDraft[] = [
    { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:a' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:a' } },
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:alice', value: { observerId: alice, content: 'secret red key' } } },
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:bob', value: { observerId: bob, content: 'secret blue key' } } },
    { eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:alice', value: { characterId: alice, proposition: 'Alice trusts Bob' } } },
    { eventType: 'claim.upsert', eventVersion: 1, data: { id: 'claim:bob', value: { characterId: bob, proposition: 'Bob knows culprit' } } },
  ]
  await world.commitRound({
    address: address(),
    transactionId: brandId('transaction:cognitive', 'TransactionId'),
    roundId: brandId('round:cognitive', 'InteractionRoundId'),
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events,
    outbox: [],
    cognitiveJobs: [{ characterId: alice }],
    correlationId: 'cognitive:fixture',
  })
  const memory = new CognitiveMemoryService(memoryPath, world)
  return { world, memory, alice, bob, worldPath, memoryPath }
}

describe('CognitiveMemoryService', () => {
  it('exposes v2 catch-up, recall, watermark, summary, prepare, and rebuild receipts without changing v1 defaults', async () => {
    const { world, memory: legacy, alice, memoryPath } = await fixture()
    expect(() => legacy.catchUpReceipt(address(), alice, 6)).toThrow('requires version 2')
    expect(() => legacy.recallWithReceipt({
      schemaVersion: 'recall-query-plan/v1', planId: 'legacy', address: address(), characterId: alice,
      asOfWorldSeq: 6, query: 'secret', limit: 2, rankingAlgorithm: 'fts5-bm25-stable/v1',
    })).toThrow('requires Cognitive Memory version 2')
    expect(legacy.watermark(address(), alice)).toBeUndefined()
    expect(legacy.summaries(address(), alice)).toEqual([])
    legacy.close()

    const memory = new CognitiveMemoryService(memoryPath, world, undefined, 2)
    const receipt = memory.catchUpReceipt(address(), alice, 6)
    expect(memory.watermark(address(), alice)).toEqual(receipt.watermark)
    expect(memory.summaries(address(), alice)).toHaveLength(0)
    const recalled = memory.recallWithReceipt({
      schemaVersion: 'recall-query-plan/v1', planId: 'recall:alice', address: address(), characterId: alice,
      asOfWorldSeq: 6, query: 'secret', limit: 2, rankingAlgorithm: 'fts5-bm25-stable/v1',
    })
    expect(recalled.memories).toMatchObject([{ memoryKind: 'episodic', text: 'secret red key' }])
    expect(memory.recall(address(), alice, 'secret', 6)).toMatchObject([{ text: 'secret red key', sourceMaxSeq: 3 }])
    const context = memory.prepare({
      address: address(), roundId: brandId('round:v2-context', 'InteractionRoundId'), tick: 2,
      participantId: 'agent:alice', characterId: alice, asOfWorldSeq: 6,
      playerAction: {
        actionId: 'action:v2', actorId: alice, actionType: 'speak', actionVersion: 1,
        parameters: { text: 'secret' },
      },
      candidateHash: hashWorldJson('candidate:v2', null), allowedActionTypes: ['speak'],
      sceneDecision: { sceneId: 'scene:a' }, correlationId: 'prepare:v2',
    })
    expect(context.memorySourceRefs).toMatchObject([{ sourceKind: 'world_event', sourceSeq: 3 }])
    expect(context.recallResultHash).toBe(recalled.receipt.resultHash)
    const rebuilt = memory.rebuildBranch(address(), [alice, alice], 6, 'rebuild:v2')
    expect(rebuilt).toMatch(/^sha256:/)
    expect(memory.watermark(address(), alice)?.memoryEpoch).toBe(2)
    await world.commitRound({
      address: address(), transactionId: brandId('transaction:cognitive:second', 'TransactionId'),
      roundId: brandId('round:cognitive:second', 'InteractionRoundId'),
      expectedHeadSeq: 6, expectedTick: 1, nextTick: 2,
      events: [{
        eventType: 'observation.upsert', eventVersion: 1,
        data: { id: 'observation:alice:second', value: { observerId: alice, content: 'secret green key' } },
      }],
      outbox: [], correlationId: 'cognitive:second',
    })
    const reaction = memory.prepareStimulus({
      address: address(), roundId: brandId('round:v2-reaction-context', 'InteractionRoundId'),
      participantId: 'agent:alice', characterId: alice, asOfWorldSeq: 7,
      stimulus: { entries: [{ speech: 'secret' }, null] }, correlationId: 'prepare:v2-reaction',
    })
    expect(reaction.memoryRecall.map(value => value.text).toSorted()).toEqual(['secret green key', 'secret red key'])
    expect(reaction.recallResultHash).toMatch(/^sha256:/)
    memory.close()
    world.close()
  })

  it('retries a world cognitive job after failure following a committed v2 Memory receipt', async () => {
    const { world, memory: legacy, alice, worldPath, memoryPath } = await fixture()
    legacy.close()
    const leases = new WriterLeaseService(worldPath)
    const lease = leases.acquire(address(), 'cognitive:v2-worker')
    let fail = true
    const interrupted = new CognitiveMemoryService(memoryPath, world, {
      hit(point) {
        if (point === 'memory.after-catchup-commit' && fail) {
          fail = false
          throw new Error('after v2 Memory commit')
        }
      },
    }, 2)
    expect(interrupted.processPending(address(), 'cognitive:v2-worker', lease.fencingToken, () => undefined)).toEqual({
      completed: 0, failed: [{ characterId: alice, error: 'Error: after v2 Memory commit' }],
    })
    expect(interrupted.watermark(address(), alice)).toMatchObject({ capturedThroughSeq: 6 })
    expect(world.readCognitiveJobs(address(), true)[0]).toMatchObject({ status: 'failed', attemptCount: 1 })
    expect(interrupted.processPending(address(), 'cognitive:v2-worker', lease.fencingToken, () => undefined)).toEqual({
      completed: 1, failed: [],
    })
    expect(world.readCognitiveJobs(address(), true)[0]).toMatchObject({ status: 'completed', attemptCount: 2 })
    interrupted.close()
    leases.close()
    world.close()
  })

  it('catches up distinct character namespaces and assembles a stable Context v2', async () => {
    const { world, memory, alice, bob } = await fixture()
    memory.enqueue(address(), [bob, alice, alice], 6)
    expect(memory.catchUp(address(), alice, 6, 'catchup:alice')).toMatchObject({ characterId: alice, asOfWorldSeq: 6 })
    expect(memory.recall(address(), alice, 'secret', 6).map(value => value.text)).toEqual([
      '{"content":"secret red key","observerId":"character:alice"}',
    ])
    expect(memory.recall(address(), bob, 'secret', 6).map(value => value.text)).toEqual([
      '{"content":"secret blue key","observerId":"character:bob"}',
    ])
    const context = memory.prepare({
      address: address(),
      roundId: brandId('round:context', 'InteractionRoundId'),
      tick: 2,
      participantId: 'agent:alice',
      characterId: alice,
      asOfWorldSeq: 6,
      playerAction: {
        actionId: 'action:player', actorId: alice, actionType: 'speak', actionVersion: 1,
        parameters: { text: 'secret red' },
      },
      candidateHash: hashWorldJson('candidate', 1),
      allowedActionTypes: ['take', 'speak'],
      sceneDecision: { sceneId: 'scene:a' },
      correlationId: 'prepare:alice',
    })
    expect(context).toMatchObject({
      agentContextVersion: 2,
      participantId: 'agent:alice',
      capability: { actorId: alice, allowedActionTypes: ['speak', 'take'] },
      memoryRecall: [expect.objectContaining({ metadata: expect.objectContaining({ kind: 'observation' }) })],
      memorySourceRefs: [expect.objectContaining({ sourceId: 'observation:alice' })],
    })
    expect(memory.job(address(), alice, 6)).toMatchObject({ status: 'completed' })
    memory.close()
    world.close()
  })

  it('records a durable failed catch-up and handles non-text recall candidates', async () => {
    const { world, memory, alice } = await fixture()
    memory.catchUp(address(), alice, 6, 'catchup:base')
    expect(() => memory.catchUp(address(), alice, 2, 'catchup:backward')).toThrow('cannot move')
    expect(memory.job(address(), alice, 2)).toMatchObject({ status: 'failed', attemptCount: 1 })
    for (const parameters of [null, [], 1] as const) {
      expect(memory.prepare({
        address: address(), roundId: brandId(`round:${String(parameters)}`, 'InteractionRoundId'), tick: 2,
        participantId: 'agent:alice', characterId: alice, asOfWorldSeq: 6,
        playerAction: { actionId: `action:${String(parameters)}`, actorId: alice, actionType: 'wait', actionVersion: 1, parameters },
        candidateHash: hashWorldJson('candidate', parameters), allowedActionTypes: ['speak'], sceneDecision: null,
        correlationId: `prepare:${String(parameters)}`,
      }).memoryRecall).toEqual([])
    }
    expect(memory.prepare({
      address: address(), roundId: brandId('round:string', 'InteractionRoundId'), tick: 2,
      participantId: 'agent:alice', characterId: alice, asOfWorldSeq: 6,
      playerAction: { actionId: 'action:string', actorId: alice, actionType: 'speak', actionVersion: 1, parameters: 'secret' },
      candidateHash: hashWorldJson('candidate', 'string'), allowedActionTypes: ['speak'], sceneDecision: null,
      correlationId: 'prepare:string',
    }).memoryRecall).toHaveLength(1)
    memory.close()
    world.close()
  })

  it('records and rethrows an integrity failure from the durable cognitive worker', async () => {
    const { world, memory, alice, worldPath, memoryPath } = await fixture()
    memory.close()
    const leases = new WriterLeaseService(worldPath)
    const lease = leases.acquire(address(), 'cognitive:integrity-worker')
    const integrity = new CognitiveMemoryService(memoryPath, world, {
      hit(point) {
        if (point !== 'memory.before-catchup') return
        failWorld({
          errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'integrity worker fixture',
          retryable: false, correlationId: 'cognitive:integrity-worker', address: address(),
        })
      },
    })
    expect(() => integrity.processPending(
      address(), 'cognitive:integrity-worker', lease.fencingToken, () => undefined,
    )).toThrowError(expect.objectContaining({ envelope: expect.objectContaining({ category: 'integrity' }) }))
    expect(world.readCognitiveJobs(address(), true)).toMatchObject([{
      characterId: alice, status: 'failed', attemptCount: 1,
    }])
    integrity.close()
    leases.close()
    world.close()
  })
})
