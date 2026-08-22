import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type ProjectionRecord,
  type WorldAddress,
} from '@harness-world/contracts'
import { CharacterReflectRule, LocalMemoryStore, type MemorySourceRef } from '@harness-world/memory'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'

const characterA = brandId('character:p4:a', 'CharacterId')
const characterB = brandId('character:p4:b', 'CharacterId')

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:p4', 'TenantId'),
    worldId: brandId('world:p4', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function ref(record: ProjectionRecord): MemorySourceRef {
  return {
    sourceKind: 'observation',
    sourceId: record.id,
    sourceSeq: record.sourceSeq,
    sourceHash: hashWorldJson('memory-source/observation', record),
  }
}

describe('Phase 4 local memory and cognition acceptance', () => {
  it('recalls verified evidence and rejects every namespace, time, and summary escape', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p4-'))
    try {
      const world = new WorldStore(join(directory, 'world.sqlite'))
      world.createBranch(address())
      world.createBranch(address('alternate'))
      const append = async (target: WorldAddress, suffix: string, id: string, characterId: typeof characterA) => {
        const head = world.head(target)
        await world.commitRound({
          address: target,
          transactionId: brandId(`transaction:p4:${suffix}`, 'TransactionId'),
          roundId: brandId(`round:p4:${suffix}`, 'InteractionRoundId'),
          expectedHeadSeq: head.headSeq,
          expectedTick: head.tick,
          nextTick: head.tick + 1,
          events: [{
            eventType: 'observation.upsert', eventVersion: 1,
            data: { id, value: { observerId: characterId, content: 'a blue key under the table' } },
          }],
          outbox: [],
          correlationId: `p4:${suffix}`,
        })
      }
      await append(address(), 'current', 'observation:p4', characterA)
      const builder = new CharacterViewBuilder(world)
      const current = builder.rebuildAt(address(), characterA, 1)
      const memory = new LocalMemoryStore(join(directory, 'memory.sqlite'), world)
      memory.reconcile({ address: current.address, characterId: characterA, asOfWorldSeq: 1, correlationId: 'p4:current' })

      const currentRef = ref(current.observations[0]!)
      expect(memory.capture({
        address: current.address,
        characterId: characterA,
        memoryId: 'memory:p4:key',
        text: 'blue key under table',
        metadata: { salience: 'high' },
        sources: [currentRef],
        asOfWorldSeq: 1,
        correlationId: 'p4:capture',
      })).toBe('captured')
      expect(memory.recall(current.address, characterA, 'blue key', 1)).toMatchObject([
        { memoryId: 'memory:p4:key', sourceMaxSeq: 1 },
      ])

      await append(address(), 'future', 'observation:p4:future', characterA)
      const future = builder.rebuildAt(address(), characterA, 2)
      await append(address(), 'other-character', 'observation:p4:b', characterB)
      const otherCharacter = builder.rebuildAt(address(), characterB, 3)
      await append(address('alternate'), 'other-branch', 'observation:p4:other', characterA)
      const otherBranch = builder.rebuildAt(address('alternate'), characterA, 1)
      for (const [candidate, correlationId] of [
        [future, 'p4:future'], [otherCharacter, 'p4:character'], [otherBranch, 'p4:branch'],
      ] as const) memory.reconcile({
        address: candidate.address,
        characterId: candidate.characterId,
        asOfWorldSeq: candidate.asOfWorldSeq,
        correlationId,
      })

      const rejected = (memoryId: string, source: MemorySourceRef, asOfWorldSeq = 9) => () => memory.capture({
        address: current.address,
        characterId: characterA,
        memoryId,
        text: `rejected ${memoryId}`,
        metadata: {},
        sources: [source],
        asOfWorldSeq,
        correlationId: `p4:${memoryId}`,
      })
      expect(rejected('future', ref(future.observations[1]!), 1)).toThrow('later than')
      expect(rejected('cross-character', ref(otherCharacter.observations[0]!))).toThrow('missing or divergent')
      expect(rejected('cross-branch', ref(otherBranch.observations[0]!))).toThrow('missing or divergent')
      expect(rejected('summary', { ...currentRef, sourceKind: 'summary' })).toThrow('Summary')

      const reflected = new CharacterReflectRule().resolve(current, {
        claimId: 'claim:p4:reflection',
        proposition: 'I remember where the blue key is.',
        sourceRefs: [{ kind: 'observation', id: current.observations[0]!.id }],
        correlationId: 'p4:reflect',
      })
      expect(reflected).toMatchObject({ eventType: 'claim.upsert', data: { id: 'claim:p4:reflection' } })
      memory.close()
      world.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
