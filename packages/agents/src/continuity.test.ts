import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashContinuityCheckpoint,
  hashInteractionTail,
  type CharacterId,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import { CognitiveMemoryService } from '@harness-world/memory'
import { WorldStore } from '@harness-world/store-sqlite'
import { ContinuityCheckpointService, InteractionTailBuilder } from './continuity.ts'
import { CONTEXT_SCHEMA_VERSION } from './context-database.ts'

const directories: string[] = []
const alice = brandId('character:alice', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const authoredHash = `sha256:${'a'.repeat(64)}` as const

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:continuity', 'TenantId'),
    worldId: brandId('world:continuity', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function source(id: string) {
  return { sourceKind: 'author', sourceId: id, sourceHash: authoredHash }
}

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'hcw-continuity-'))
  directories.push(root)
  return { worldPath: join(root, 'world.sqlite'), memoryPath: join(root, 'memory.sqlite'), contextPath: join(root, 'context.sqlite') }
}

async function commit(
  world: WorldStore,
  target: WorldAddress,
  transactionId: TransactionId,
  events: readonly WorldEventDraft[],
  cognitiveCharacters: readonly CharacterId[] = [alice, bob],
) {
  const head = world.head(target)
  return world.commitRound({
    address: target, transactionId,
    roundId: brandId(transactionId.replace('transaction:', 'round:'), 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
    events, outbox: [], cognitiveJobs: cognitiveCharacters.map(characterId => ({ characterId })),
    correlationId: transactionId,
  })
}

async function fixture() {
  const storage = paths()
  const world = new WorldStore(storage.worldPath)
  world.createBranch(address())
  const genesis: WorldEventDraft[] = [
    { eventType: 'character.created', eventVersion: 1, data: { characterId: alice, locationId: 'location:station' } },
    { eventType: 'character.created', eventVersion: 1, data: { characterId: bob, locationId: 'location:station' } },
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:alice:1', value: { observerId: alice, content: 'Alice saw rain' } } },
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:alice:2', value: { observerId: alice, content: 'Alice heard bells' } } },
    ...Array.from({ length: 7 }, (_, index): WorldEventDraft => ({
      eventType: 'observation.upsert', eventVersion: 1,
      data: { id: `observation:alice:extra:${index}`, value: { observerId: alice, content: `Alice memory ${index}` } },
    })),
    { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:bob:1', value: { observerId: bob, content: 'Bob hid a letter' } } },
    {
      eventType: 'subjective-claim.upsert', eventVersion: 1,
      data: {
        id: 'claim:alice:rain', characterId: alice,
        value: {
          proposition: 'The road is flooded', stance: 'believed', confidencePermille: 800,
          saliencePermille: 700, awareness: 'conscious', status: 'active', basisRefs: [],
          source: source('AUTHOR_SECRET_SOURCE_CANARY'),
        },
      },
    },
    {
      eventType: 'subjective-claim.upsert', eventVersion: 1,
      data: {
        id: 'claim:alice:bell', characterId: alice,
        value: {
          proposition: 'The bell marks departure', stance: 'suspected', confidencePermille: 500,
          saliencePermille: 400, awareness: 'conscious', status: 'active', basisRefs: [],
          source: source('claim:alice:bell'),
        },
      },
    },
    {
      eventType: 'character-goal.upsert', eventVersion: 1,
      data: {
        id: 'goal:alice:leave', characterId: alice,
        value: {
          objective: { kind: 'narrative', text: 'Leave the station' }, priorityPermille: 900,
          awareness: 'unrecognized', status: 'blocked', parentGoalKey: null,
          targetKeys: [], blockerKeys: [], basisRefs: [], source: source('goal:alice:leave'),
        },
      },
    },
    {
      eventType: 'character-goal.upsert', eventVersion: 1,
      data: {
        id: 'goal:alice:active', characterId: alice,
        value: {
          objective: { kind: 'registered', actionType: 'move' }, priorityPermille: 500,
          awareness: 'conscious', status: 'active', parentGoalKey: null,
          targetKeys: [], blockerKeys: [], basisRefs: [], source: source('goal:alice:active'),
        },
      },
    },
    {
      eventType: 'character-goal.upsert', eventVersion: 1,
      data: {
        id: 'goal:alice:completed', characterId: alice,
        value: {
          objective: { kind: 'registered', actionType: 'wait' }, priorityPermille: 100,
          awareness: 'conscious', status: 'completed', parentGoalKey: null,
          targetKeys: [], blockerKeys: [], basisRefs: [], source: source('goal:alice:completed'),
        },
      },
    },
    {
      eventType: 'affect-episode.upsert', eventVersion: 1,
      data: {
        id: 'affect:alice:anxiety', characterId: alice,
        value: {
          type: 'anxiety', intensityPermille: 600, cause: { kind: 'weather' }, targetKey: null,
          awareness: 'partially_conscious', expressionMode: 'restrained', duration: 'short_lived',
          status: 'active', basisRefs: [], source: source('affect:alice:anxiety'),
        },
      },
    },
    {
      eventType: 'inner-tension.upsert', eventVersion: 1,
      data: {
        id: 'tension:alice:stay-or-go', characterId: alice,
        value: {
          title: 'Stay or go', pressurePermille: 700, awareness: 'unrecognized', status: 'active',
          poles: [
            { key: 'stay', tendency: 'preserve', impulseText: 'wait for Bob', strengthPermille: 600, awareness: 'unrecognized', basisRefs: [] },
            { key: 'go', tendency: 'change', impulseText: 'leave now', strengthPermille: 700, awareness: 'partially_conscious', basisRefs: [] },
          ],
          basisRefs: [], source: source('tension:alice:stay-or-go'),
        },
      },
    },
    {
      eventType: 'commitment.upsert', eventVersion: 1,
      data: {
        id: 'commitment:alice:wait', characterId: alice,
        value: {
          content: 'Wait for Bob', origin: 'promise', saliencePermille: 800,
          awareness: 'conscious', status: 'active', basisRefs: [], source: source('commitment:alice:wait'),
        },
      },
    },
    {
      eventType: 'open-loop.upsert', eventVersion: 1,
      data: {
        id: 'open-loop:alice:ticket', characterId: alice,
        value: {
          kind: 'question', summary: 'Where is the ticket?', saliencePermille: 500,
          status: 'open', basisRefs: [], source: source('open-loop:alice:ticket'),
        },
      },
    },
    {
      eventType: 'open-loop.upsert', eventVersion: 1,
      data: {
        id: 'open-loop:alice:closed', characterId: alice,
        value: {
          kind: 'question', summary: 'Already answered', saliencePermille: 100,
          status: 'answered', basisRefs: [], source: source('open-loop:alice:closed'),
        },
      },
    },
    {
      eventType: 'relationship-attitude.upsert', eventVersion: 1,
      data: {
        id: 'relationship:alice:bob:old', characterId: alice,
        value: {
          target: bob, type: 'trust', facet: 'travel', intensityPermille: 300,
          confidencePermille: 500, awareness: 'unrecognized', status: 'resolved', basisRefs: [],
          source: source('relationship:alice:bob:old'),
        },
      },
    },
  ]
  await commit(world, address(), brandId('transaction:genesis', 'TransactionId'), genesis)
  const memory = new CognitiveMemoryService(storage.memoryPath, world, undefined, 2)
  const head = world.head(address())
  memory.catchUpReceipt(address(), alice, head.headSeq)
  memory.catchUpReceipt(address(), bob, head.headSeq)
  return { ...storage, world, memory, head }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Phase 8 continuity derivation', () => {
  it('stores an exact Checkpoint that references the only L1 summary without copying its text', async () => {
    const { world, memory, contextPath, head } = await fixture()
    const checkpoints = new ContinuityCheckpointService(contextPath, world, memory)
    const first = checkpoints.rebuildAt(address(), alice, head.headSeq)
    expect(first.activeCognition).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'subjective-claim', id: 'claim:alice:rain' }),
      expect.objectContaining({ kind: 'character-goal', id: 'goal:alice:leave' }),
      expect.objectContaining({ kind: 'affect-episode', id: 'affect:alice:anxiety' }),
      expect.objectContaining({ kind: 'inner-tension', id: 'tension:alice:stay-or-go' }),
      expect.objectContaining({ kind: 'commitment', id: 'commitment:alice:wait' }),
      expect.objectContaining({ kind: 'open-loop', id: 'open-loop:alice:ticket' }),
    ]))
    expect(first.activeCognition.map(value => value.id)).not.toContain('relationship:alice:bob:old')
    expect(JSON.stringify(first)).not.toContain('AUTHOR_SECRET_SOURCE_CANARY')
    // The genesis log carries no Tick event, so every Memory falls in one Round and one Summary: this is
    // the one-summary case at the other end of the range from per-Round grouping.
    expect(first.summaryRefs).toHaveLength(1)
    expect(JSON.stringify(first.summaryRefs)).not.toContain('Alice saw rain')
    expect(checkpoints.rebuildAt(address(), alice, head.headSeq)).toEqual(first)
    checkpoints.close()

    const reopened = new ContinuityCheckpointService(contextPath, world, memory)
    expect(reopened.latestAt(address(), alice, head.headSeq)).toEqual(first)
    expect(reopened.latestAt(address(), bob, head.headSeq)).toBeUndefined()
    const bobCheckpoint = reopened.rebuildAt(address(), bob, head.headSeq)
    // Bob has exactly one visible Memory, and a group of one is still a Summary now, so the baseline
    // reaches that Memory's source range without copying any of its text.
    expect(bobCheckpoint).toMatchObject({ activeCognition: [] })
    expect(bobCheckpoint.summaryRefs).toHaveLength(1)
    expect(JSON.stringify(bobCheckpoint)).not.toContain('Bob hid a letter')
    reopened.reset(address(), alice)
    expect(reopened.latestAt(address(), alice, head.headSeq)).toBeUndefined()
    reopened.close()
    memory.close()
    world.close()
  })

  it('fails closed for missing Memory watermarks, divergent L1 identities, and damaged stored Checkpoints', async () => {
    const { world, memory, contextPath, head } = await fixture()
    const missing = new ContinuityCheckpointService(contextPath, world, {
      watermark: () => undefined,
      summaries: () => [],
    })
    expect(() => missing.rebuildAt(address(), alice, head.headSeq)).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({
        errorCode: 'MEMORY_CATCHUP_FAILED', category: 'runtime', retryable: true,
        details: expect.objectContaining({ verifiedThroughSeq: null, capturedThroughSeq: null }),
      }),
    }))
    expect(() => missing.rebuildAt(address(), alice, -1)).toThrow(RangeError)
    missing.close()
    const behindVerified = new ContinuityCheckpointService(join(contextPath, '..', 'behind-verified.sqlite'), world, {
      watermark: () => ({ ...memory.watermark(address(), alice)!, verifiedThroughSeq: head.headSeq - 1 }),
      summaries: () => [],
    })
    expect(() => behindVerified.rebuildAt(address(), alice, head.headSeq)).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({
        errorCode: 'MEMORY_CATCHUP_FAILED',
        details: expect.objectContaining({ verifiedThroughSeq: head.headSeq - 1 }),
      }),
    }))
    behindVerified.close()
    const behindCaptured = new ContinuityCheckpointService(join(contextPath, '..', 'behind-captured.sqlite'), world, {
      watermark: () => ({ ...memory.watermark(address(), alice)!, capturedThroughSeq: head.headSeq - 1 }),
      summaries: () => [],
    })
    expect(() => behindCaptured.rebuildAt(address(), alice, head.headSeq)).toThrowError(expect.objectContaining({
      envelope: expect.objectContaining({
        errorCode: 'MEMORY_CATCHUP_FAILED',
        details: expect.objectContaining({ capturedThroughSeq: head.headSeq - 1 }),
      }),
    }))
    behindCaptured.close()

    const divergent = new ContinuityCheckpointService(contextPath, world, {
      watermark: (target, characterId) => memory.watermark(target, characterId),
      summaries: (target, characterId) => memory.summaries(target, characterId).map(summary => ({
        ...summary, summaryHash: authoredHash,
      })),
    })
    expect(() => divergent.rebuildAt(address(), alice, head.headSeq)).toThrow('Summary')
    divergent.close()

    const valid = new ContinuityCheckpointService(contextPath, world, memory)
    const checkpoint = valid.rebuildAt(address(), alice, head.headSeq)
    valid.close()
    const raw = new DatabaseSync(contextPath)
    raw.prepare('UPDATE continuity_checkpoints SET checkpoint_hash = ? WHERE checkpoint_id = ?')
      .run(authoredHash, checkpoint.checkpointId)
    raw.close()
    const wrongColumnHash = new ContinuityCheckpointService(contextPath, world, memory)
    expect(() => wrongColumnHash.rebuildAt(address(), alice, head.headSeq)).toThrow('divergent')
    wrongColumnHash.close()

    const restore = new DatabaseSync(contextPath)
    restore.prepare('UPDATE continuity_checkpoints SET checkpoint_hash = ?, checkpoint_json = ? WHERE checkpoint_id = ?')
      .run(checkpoint.checkpointHash, JSON.stringify(checkpoint), checkpoint.checkpointId)
    restore.close()
    const validAgain = new ContinuityCheckpointService(contextPath, world, memory)
    expect(validAgain.latestAt(address(), alice, head.headSeq)).toEqual(checkpoint)
    validAgain.close()

    const damagedRaw = new DatabaseSync(contextPath)
    damagedRaw.prepare('UPDATE continuity_checkpoints SET checkpoint_json = ? WHERE checkpoint_id = ?')
      .run(JSON.stringify({ ...checkpoint, memoryEpoch: 999 }), checkpoint.checkpointId)
    damagedRaw.close()
    const damaged = new ContinuityCheckpointService(contextPath, world, memory)
    expect(() => damaged.latestAt(address(), alice, head.headSeq)).toThrow('hash diverged')
    expect(() => damaged.rebuildAt(address(), alice, head.headSeq)).toThrow('divergent')
    damaged.close()

    const scopedInput = { ...checkpoint, characterId: bob }
    const { checkpointHash: _oldHash, ...scopedBase } = scopedInput
    const scoped = { ...scopedBase, checkpointHash: hashContinuityCheckpoint(scopedBase) }
    const scopeRaw = new DatabaseSync(contextPath)
    scopeRaw.prepare('UPDATE continuity_checkpoints SET checkpoint_json = ?, checkpoint_hash = ? WHERE checkpoint_id = ?')
      .run(JSON.stringify(scoped), scoped.checkpointHash, checkpoint.checkpointId)
    scopeRaw.close()
    const wrongScope = new ContinuityCheckpointService(contextPath, world, memory)
    expect(() => wrongScope.latestAt(address(), alice, head.headSeq)).toThrow('scope diverged')
    wrongScope.close()

    const receiptSchemaPath = join(contextPath, '..', 'receipt-schema.sqlite')
    const receiptSchemaDb = new DatabaseSync(receiptSchemaPath)
    receiptSchemaDb.exec('PRAGMA user_version=2')
    receiptSchemaDb.close()
    const receiptCompatible = new ContinuityCheckpointService(receiptSchemaPath, world, memory)
    expect(receiptCompatible.latestAt(address(), alice, head.headSeq)).toBeUndefined()
    receiptCompatible.close()

    const wrongVersionPath = join(contextPath, '..', 'wrong-version.sqlite')
    const wrongVersionDb = new DatabaseSync(wrongVersionPath)
    wrongVersionDb.exec(`PRAGMA user_version=${CONTEXT_SCHEMA_VERSION + 1}`)
    wrongVersionDb.close()
    expect(() => new ContinuityCheckpointService(wrongVersionPath, world, memory)).toThrow('user_version mismatch')
    memory.close()
    world.close()
  })

  it('rebuilds a fork Checkpoint without parent future cognition or Memory canaries', async () => {
    const { world, memory, contextPath, head } = await fixture()
    const child = address('child')
    world.forkBranch(address(), child, head.headSeq)
    await commit(world, address(), brandId('transaction:future', 'TransactionId'), [{
      eventType: 'observation.upsert', eventVersion: 1,
      data: { id: 'observation:FUTURE_CANARY', value: { observerId: alice, content: 'FUTURE_CANARY' } },
    }], [alice])
    memory.catchUpReceipt(child, alice, head.headSeq)
    const checkpoints = new ContinuityCheckpointService(contextPath, world, memory)
    const childCheckpoint = checkpoints.rebuildAt(child, alice, head.headSeq)
    expect(JSON.stringify(childCheckpoint)).not.toContain('FUTURE_CANARY')
    expect(childCheckpoint.address.branchId).toBe(child.branchId)
    checkpoints.close()
    memory.close()
    world.close()
  })

  it('references one Summary per group of committed Rounds, in source order', async () => {
    const { world, memory, contextPath } = await fixture()
    // Five more Rounds, each closing with its Tick event, so the Memories span two Summary groups.
    for (let round = 1; round <= 5; round += 1) {
      await commit(world, address(), brandId(`transaction:round-${round}`, 'TransactionId'), [
        { eventType: 'observation.upsert', eventVersion: 1, data: {
          id: `observation:alice:round-${round}`, value: { observerId: alice, content: `Alice round ${round}` },
        } },
        { eventType: 'world.tick-advanced', eventVersion: 1,
          data: { tick: round, roundId: `round:round-${round}` } },
      ])
    }
    const asOf = world.head(address()).headSeq
    memory.catchUpReceipt(address(), alice, asOf)
    const checkpoints = new ContinuityCheckpointService(contextPath, world, memory)
    const checkpoint = checkpoints.rebuildAt(address(), alice, asOf)
    // The baseline names every group the character's history falls into, ordered by source range.
    expect(checkpoint.summaryRefs.length).toBeGreaterThan(1)
    const starts = checkpoint.summaryRefs.map(ref => ref.sourceStartSeq)
    expect([...starts].sort((left, right) => left - right)).toEqual(starts)
    expect(JSON.stringify(checkpoint.summaryRefs)).not.toContain('Alice round')
    checkpoints.close()
    memory.close()
    world.close()
  })

  it('rebuilds complete character-scoped Interaction Blocks with stable limits and hashes', async () => {
    const { world, memory, head } = await fixture()
    await commit(world, address(), brandId('transaction:second', 'TransactionId'), [
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:alice:second', value: { observerId: alice, content: 'Alice replied' } } },
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:bob:second', value: { observerId: bob, content: 'BOB_PRIVATE_CANARY' } } },
    ])
    await commit(world, address(), brandId('transaction:bob-only', 'TransactionId'), [
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:bob:only', value: { observerId: bob, content: 'BOB_ONLY_CANARY' } } },
    ])
    const asOf = world.head(address()).headSeq
    Object.defineProperty(world, 'readEvents', {
      value: () => { throw new Error('Interaction Tail must not scan the complete Event Log') },
    })
    const tails = new InteractionTailBuilder(world)
    const tail = tails.rebuildAt(address(), alice, 0, asOf, 1)
    expect(tail.blocks).toHaveLength(1)
    expect(tail.blocks[0]).toMatchObject({ roundId: 'round:second', startSeq: head.headSeq + 1 })
    expect(JSON.stringify(tail)).not.toContain('BOB_PRIVATE_CANARY')
    expect(tails.rebuildAt(address(), alice, 0, asOf, 0).blocks).toEqual([])
    expect(tails.rebuildAt(address(), alice, asOf, asOf, 3).blocks).toEqual([])
    expect(() => tails.rebuildAt(address(), alice, -1, asOf, 1)).toThrow(RangeError)
    expect(() => tails.rebuildAt(address(), alice, 0.5, asOf, 1)).toThrow(RangeError)
    expect(() => tails.rebuildAt(address(), alice, 0, asOf + 0.5, 1)).toThrow(RangeError)
    expect(() => tails.rebuildAt(address(), alice, asOf, asOf - 1, 1)).toThrow(RangeError)
    expect(() => tails.rebuildAt(address(), alice, 0, asOf, -1)).toThrow(RangeError)
    expect(() => tails.rebuildAt(address(), alice, 0, asOf, 0.5)).toThrow(RangeError)
    expect(() => hashInteractionTail({ ...tail, blocks: [{ ...tail.blocks[0]!, blockHash: authoredHash }] }))
      .toThrow('block hash diverged')
    memory.close()
    world.close()
  })

  it('advances the Tail floor past the blocks the retained window cannot hold', async () => {
    const { world, memory } = await fixture()
    const tails = new InteractionTailBuilder(world)
    for (const [index, id] of ['second', 'third', 'fourth'].entries()) {
      await commit(world, address(), brandId(`transaction:${id}`, 'TransactionId'), [{
        eventType: 'observation.upsert', eventVersion: 1,
        data: { id: `observation:alice:${id}`, value: { observerId: alice, content: `Alice round ${index}` } },
      }])
    }
    const asOf = world.head(address()).headSeq
    // Genesis already carries one visible Alice block, so four blocks are committed in total.
    const everyBlock = tails.rebuildAt(address(), alice, 0, asOf, 10).blocks
    expect(everyBlock).toHaveLength(4)

    // While the window still fits, the floor does not move and the Tail keeps every block.
    const fits = tails.rebuildRolling(address(), alice, 0, asOf, 4)
    expect(fits.floor).toBe(0)
    expect(fits.tail.blocks).toHaveLength(4)

    // Once it cannot, the floor parks at the end of the last dropped block and only the window remains.
    // This is what bounds the next rebuild to the increment instead of the whole history.
    const rolling = tails.rebuildRolling(address(), alice, 0, asOf, 2)
    expect(rolling.floor).toBe(everyBlock[1]!.endSeq)
    expect(rolling.tail.afterSeq).toBe(rolling.floor)
    expect(rolling.tail.blocks.map(block => block.roundId))
      .toEqual(['round:third', 'round:fourth'])
    expect(rolling.tail).toEqual(tails.rebuildAt(address(), alice, rolling.floor, asOf, 2))

    // A floor that already fits is stable, so a caller that reuses its baseline keeps agreeing with it.
    const stable = tails.rebuildRolling(address(), alice, rolling.floor, asOf, 2)
    expect(stable.floor).toBe(rolling.floor)
    expect(stable.tail).toEqual(rolling.tail)

    // Zero blocks keeps nothing and parks the floor at the last committed block.
    const none = tails.rebuildRolling(address(), alice, 0, asOf, 0)
    expect(none.floor).toBe(everyBlock[3]!.endSeq)
    expect(none.tail.blocks).toEqual([])

    expect(() => tails.rebuildRolling(address(), alice, -1, asOf, 1)).toThrow(RangeError)
    expect(() => tails.rebuildRolling(address(), alice, asOf, asOf - 1, 1)).toThrow(RangeError)
    expect(() => tails.rebuildRolling(address(), alice, 0, asOf, -1)).toThrow(RangeError)
    memory.close()
    world.close()
  })

  it('fails closed on malformed visible Observation history', async () => {
    const { world, memory } = await fixture()
    const beforeMalformed = world.head(address()).headSeq
    await commit(world, address(), brandId('transaction:malformed', 'TransactionId'), [{
      eventType: 'observation.upsert', eventVersion: 1, data: { id: 'observation:bad', value: 'bad' },
    }], [])
    expect(() => new InteractionTailBuilder(world).rebuildAt(
      address(), alice, beforeMalformed, world.head(address()).headSeq, 10,
    ))
      .toThrow('malformed')
    const beforeBadId = world.head(address()).headSeq
    await commit(world, address(), brandId('transaction:malformed-id', 'TransactionId'), [{
      eventType: 'observation.upsert', eventVersion: 1, data: { id: 1, value: { observerId: alice } },
    }], [])
    expect(() => new InteractionTailBuilder(world).rebuildAt(
      address(), alice, beforeBadId, world.head(address()).headSeq, 10,
    ))
      .toThrow('malformed')
    const beforeNull = world.head(address()).headSeq
    await commit(world, address(), brandId('transaction:malformed-null', 'TransactionId'), [{
      eventType: 'observation.upsert', eventVersion: 1, data: null,
    }], [])
    expect(() => new InteractionTailBuilder(world).rebuildAt(
      address(), alice, beforeNull, world.head(address()).headSeq, 10,
    ))
      .toThrow('malformed')
    memory.close()
    world.close()
  })

  it('rejects a visible Interaction whose transaction has no committed Round record', async () => {
    const { world, memory } = await fixture()
    const event = world.readEvents(address()).find(value => value.eventType === 'observation.upsert')!
    const uncommitted = {
      readEventsRange: () => [event],
      committedRound: () => undefined,
      readRoundAuthority: () => undefined,
    } as unknown as WorldStore
    expect(() => new InteractionTailBuilder(uncommitted).rebuildAt(address(), alice, 0, event.seq, 1))
      .toThrow('is not committed')
    memory.close()
    world.close()
  })
})
