import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type CharacterView,
  type ProjectionRecord,
  type WorldAddress,
} from '@harness-world/contracts'
import { CharacterReflectRule, LocalMemoryStore, type MemorySourceRef } from '@harness-world/memory'

const characterA = brandId('character:p4:a', 'CharacterId')
const characterB = brandId('character:p4:b', 'CharacterId')

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:p4', 'TenantId'),
    worldId: brandId('world:p4', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function observation(characterId: typeof characterA, sourceSeq: number): ProjectionRecord {
  return {
    kind: 'observation',
    id: 'observation:p4',
    value: { observerId: characterId, content: 'a blue key under the table' },
    sourceSeq,
  }
}

function view(characterId = characterA, branch = 'main', sourceSeq = 7): CharacterView {
  const base = {
    address: address(branch),
    characterId,
    asOfWorldSeq: sourceSeq,
    locationId: 'location:room',
    scenes: [],
    observations: [observation(characterId, sourceSeq)],
    selfObservations: [],
    claims: [],
    goals: [],
    visibility: [],
  } as const
  return { ...base, bundleHash: hashWorldJson('world-character-view', base) }
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
  it('recalls verified evidence and rejects every namespace, time, and summary escape', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p4-'))
    try {
      const memory = new LocalMemoryStore(join(directory, 'memory.sqlite'))
      const current = view()
      const future = view(characterA, 'main', 9)
      const otherCharacter = view(characterB)
      const otherBranch = view(characterA, 'alternate')
      memory.reconcile(current)

      const currentRef = ref(current.observations[0]!)
      expect(memory.capture({
        address: current.address,
        characterId: characterA,
        memoryId: 'memory:p4:key',
        text: 'blue key under table',
        metadata: { salience: 'high' },
        sources: [currentRef],
        asOfWorldSeq: 7,
        correlationId: 'p4:capture',
      })).toBe('captured')
      expect(memory.recall(current.address, characterA, 'blue key', 7)).toMatchObject([
        { memoryId: 'memory:p4:key', sourceMaxSeq: 7 },
      ])

      memory.reconcile(future)
      memory.reconcile(otherCharacter)
      memory.reconcile(otherBranch)

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
      expect(rejected('future', ref(future.observations[0]!), 8)).toThrow('later than')
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
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
