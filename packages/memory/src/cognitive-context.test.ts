import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
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
  const world = new WorldStore(join(directory, 'world.sqlite'))
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
    correlationId: 'cognitive:fixture',
  })
  const memory = new CognitiveMemoryService(join(directory, 'memory.sqlite'), world)
  return { world, memory, alice, bob }
}

describe('CognitiveMemoryService', () => {
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
})
