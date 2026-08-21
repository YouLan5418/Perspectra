import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, hashWorldJson, type CharacterView, type ProjectionRecord, type WorldAddress } from '@harness-world/contracts'
import { LocalMemoryStore, TENCENTDB_MEMORY_ENABLED, type MemorySourceRef } from './local-memory.ts'

const directories: string[] = []

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-memory-'))
  directories.push(directory)
  return join(directory, 'memory.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:memory', 'TenantId'),
    worldId: brandId('world:memory', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

const characterA = brandId('character:a', 'CharacterId')
const characterB = brandId('character:b', 'CharacterId')

function record(kind: 'observation' | 'claim', id: string, characterId = characterA, sourceSeq = 5): ProjectionRecord {
  return {
    kind,
    id,
    value: kind === 'observation'
      ? { observerId: characterId, content: `content:${id}` }
      : { characterId, proposition: `claim:${id}` },
    sourceSeq,
  }
}

function view(characterId = characterA, branch = 'main', sourceSeq = 5): CharacterView {
  const observation = record('observation', 'observation:1', characterId, sourceSeq)
  const claim = record('claim', 'claim:1', characterId, sourceSeq)
  const base = {
    address: address(branch), characterId, asOfWorldSeq: sourceSeq, locationId: 'location:room', scenes: [],
    observations: [observation], selfObservations: [], claims: [claim], goals: [], visibility: [],
  }
  return { ...base, bundleHash: hashWorldJson('world-character-view', base) }
}

function ref(value: ProjectionRecord): MemorySourceRef {
  const sourceKind = value.kind as 'observation' | 'claim'
  return {
    sourceKind,
    sourceId: value.id,
    sourceSeq: value.sourceSeq,
    sourceHash: hashWorldJson(`memory-source/${sourceKind}`, value),
  }
}

describe('LocalMemoryStore', () => {
  it('captures and recalls only verified local sources as of the query boundary', () => {
    expect(TENCENTDB_MEMORY_ENABLED).toBe(false)
    const store = new LocalMemoryStore(database())
    const characterView = view()
    expect(store.reconcile(characterView)).toBe(2)
    const request = {
      address: characterView.address,
      characterId: characterA,
      memoryId: 'memory:1',
      text: 'red apple near window',
      metadata: { salience: 'normal' },
      sources: [ref(characterView.observations[0]!), ref(characterView.claims[0]!)],
      asOfWorldSeq: 5,
      correlationId: 'capture:1',
    } as const
    expect(store.capture(request)).toBe('captured')
    expect(store.capture(request)).toBe('already_captured')
    const secondObservation = record('observation', 'observation:2')
    store.reconcile({ ...characterView, observations: [...characterView.observations, secondObservation] })
    expect(store.capture({
      ...request,
      memoryId: 'memory:2',
      text: 'two observations',
      sources: [ref(secondObservation), ref(characterView.observations[0]!)],
    })).toBe('captured')
    expect(store.recall(address(), characterA, 'red apple', 5)).toMatchObject([{
      memoryId: 'memory:1', text: 'red apple near window', metadata: { salience: 'normal' }, sourceMaxSeq: 5,
    }])
    expect(store.recall(address(), characterA, 'missing', 5)).toEqual([])
    expect(store.recall(address('other'), characterA, 'red', 5)).toEqual([])
    expect(store.recall(address(), characterB, 'red', 5)).toEqual([])
    expect(store.recall(address(), characterA, 'red', 4)).toEqual([])
    expect(store.recall(address(), characterA, '   ', 5)).toEqual([])
    expect(store.recall(address(), characterA, '"red"', 5)).toHaveLength(1)
    expect(() => store.recall(address(), characterA, 'red', -1)).toThrow(RangeError)
    expect(() => store.recall(address(), characterA, 'red', 5, 0)).toThrow(RangeError)
    expect(() => store.capture({ ...request, text: 'changed' })).toThrow('different content')
    expect(() => store.forget(address(), characterA, 'memory:1', 4)).toThrow('cannot be forgotten')
    store.forget(address(), characterA, 'memory:1', 6)
    expect(store.recall(address(), characterA, 'red', 5)).toHaveLength(1)
    expect(store.recall(address(), characterA, 'red', 6)).toEqual([])
    store.close()
  })

  it('rejects future, summary, missing, divergent, cross-character, and cross-branch sources', () => {
    const store = new LocalMemoryStore(database())
    const base = view()
    const future = view(characterA, 'main', 10)
    const otherCharacter = view(characterB)
    const otherBranch = view(characterA, 'other')
    store.reconcile(base)
    store.reconcile(future)
    store.reconcile(otherCharacter)
    store.reconcile(otherBranch)
    const template = {
      address: address(), characterId: characterA, memoryId: 'memory:test', text: 'verified text', metadata: {},
      sources: [ref(future.observations[0]!)], asOfWorldSeq: 9, correlationId: 'memory-rejection',
    } as const
    expect(() => store.capture(template)).toThrow('later than')
    expect(() => store.capture({ ...template, memoryId: 'summary', sources: [{ ...ref(base.observations[0]!), sourceKind: 'summary' }] }))
      .toThrow('Summary')
    expect(() => store.capture({ ...template, memoryId: 'missing', sources: [{ ...ref(base.observations[0]!), sourceId: 'missing' }], asOfWorldSeq: 10 }))
      .toThrow('missing or divergent')
    expect(() => store.capture({ ...template, memoryId: 'hash', sources: [{ ...ref(future.observations[0]!), sourceHash: hashWorldJson('wrong', 1) }], asOfWorldSeq: 10 }))
      .toThrow('missing or divergent')
    expect(() => store.capture({ ...template, memoryId: 'character', sources: [ref(otherCharacter.observations[0]!)], asOfWorldSeq: 10 }))
      .toThrow('missing or divergent')
    expect(() => store.capture({ ...template, memoryId: 'branch', sources: [ref(otherBranch.observations[0]!)], asOfWorldSeq: 10 }))
      .toThrow('missing or divergent')
    expect(() => store.capture({ ...template, memoryId: '', asOfWorldSeq: 10 })).toThrow(TypeError)
    expect(() => store.capture({ ...template, memoryId: 'empty-text', text: '', asOfWorldSeq: 10 })).toThrow(TypeError)
    expect(() => store.capture({ ...template, memoryId: 'no-sources', sources: [], asOfWorldSeq: 10 })).toThrow('requires committed')
    expect(() => store.capture({ ...template, memoryId: 'bad-asof', asOfWorldSeq: -1 })).toThrow(RangeError)
    store.close()
  })

  it('fails recall closed when reconciliation changes a source mapping', () => {
    const store = new LocalMemoryStore(database())
    const original = view(characterA, 'main', 5)
    store.reconcile(original)
    store.capture({
      address: address(), characterId: characterA, memoryId: 'memory:stale', text: 'stale source text', metadata: {},
      sources: [ref(original.observations[0]!)], asOfWorldSeq: 5, correlationId: 'stale',
    })
    expect(store.recall(address(), characterA, 'stale', 5)).toHaveLength(1)
    const revised = view(characterA, 'main', 7)
    expect(store.reconcile(revised)).toBe(2)
    expect(store.recall(address(), characterA, 'stale', 7)).toEqual([])

    const invalid = view(characterA, 'main', -1)
    expect(() => store.reconcile(invalid)).toThrow()
    store.close()
  })
})
