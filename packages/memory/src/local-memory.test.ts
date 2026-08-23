import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type CharacterId,
  type CharacterView,
  type ProjectionRecord,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { LocalMemoryStore, memorySourceRef, TENCENTDB_MEMORY_ENABLED, type MemorySourceRef } from './local-memory.ts'

const directories: string[] = []

function paths(): { world: string; memory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-memory-'))
  directories.push(directory)
  return { world: join(directory, 'world.sqlite'), memory: join(directory, 'memory.sqlite') }
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

function observation(id: string, characterId: CharacterId, content = `content:${id}`): WorldEventDraft {
  return { eventType: 'observation.upsert', eventVersion: 1, data: { id, value: { observerId: characterId, content } } }
}

function claim(id: string, characterId: CharacterId, proposition = `claim:${id}`): WorldEventDraft {
  return { eventType: 'claim.upsert', eventVersion: 1, data: { id, value: { characterId, proposition } } }
}

function goal(id: string, characterId: CharacterId, intent = `goal:${id}`): WorldEventDraft {
  return { eventType: 'goal.upsert', eventVersion: 1, data: { id, value: { characterId, intent } } }
}

async function commit(store: WorldStore, target: WorldAddress, suffix: string, events: readonly WorldEventDraft[]): Promise<void> {
  const head = store.head(target)
  await store.commitRound({
    address: target,
    transactionId: brandId(`transaction:memory:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:memory:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq,
    expectedTick: head.tick,
    nextTick: head.tick + 1,
    events,
    outbox: [],
    correlationId: `memory:${suffix}`,
  })
}

function reconcile(memory: LocalMemoryStore, view: CharacterView): number {
  return memory.reconcile({
    address: view.address,
    characterId: view.characterId,
    asOfWorldSeq: view.asOfWorldSeq,
    correlationId: `reconcile:${view.characterId}:${view.asOfWorldSeq}`,
  })
}

function ref(value: ProjectionRecord): MemorySourceRef {
  const sourceKind = value.kind as 'observation' | 'claim' | 'goal'
  return {
    sourceKind,
    sourceId: value.id,
    sourceSeq: value.sourceSeq,
    sourceHash: hashWorldJson(`memory-source/${sourceKind}`, value),
  }
}

describe('LocalMemoryStore', () => {
  it('reconciles and captures committed Goal sources under the same as-of firewall', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, address(), 'goal', [goal('goal:investigate', characterA, 'pursue the clue')])
    const view = new CharacterViewBuilder(world).rebuildAt(address(), characterA, 1)
    const memory = new LocalMemoryStore(path.memory, world)
    expect(reconcile(memory, view)).toBe(1)
    const source = memorySourceRef('goal', view.goals[0]!)
    expect(source).toEqual(ref(view.goals[0]!))
    expect(memory.capture({
      address: address(), characterId: characterA, memoryId: 'memory:goal', text: 'pursue the clue',
      metadata: { kind: 'goal', source }, sources: [source], asOfWorldSeq: 1, correlationId: 'memory:goal',
    })).toBe('captured')
    expect(memory.recall(address(), characterA, 'pursue', 1)).toHaveLength(1)
    memory.close()
    world.close()
  })

  it('captures and recalls only sources rebuilt from the authoritative WorldStore', async () => {
    expect(TENCENTDB_MEMORY_ENABLED).toBe(false)
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, address(), 'base', [observation('observation:1', characterA), claim('claim:1', characterA)])
    const builder = new CharacterViewBuilder(world)
    const current = builder.rebuildAt(address(), characterA, 2)
    const memory = new LocalMemoryStore(path.memory, world)
    expect(reconcile(memory, current)).toBe(2)
    expect(memorySourceRef('observation', current.observations[0]!)).toEqual(ref(current.observations[0]!))
    expect(memory.cognitiveJob(address(), characterA, 2)).toBeUndefined()
    expect(memory.enqueueCognitiveJob(address(), characterA, 2)).toBe('enqueued')
    expect(memory.enqueueCognitiveJob(address(), characterA, 2)).toBe('already_enqueued')
    memory.recordCognitiveJobResult(address(), characterA, 2, 'completed', null)
    expect(memory.cognitiveJob(address(), characterA, 2)).toMatchObject({
      asOfWorldSeq: 2, status: 'completed', attemptCount: 1, lastError: null,
    })
    memory.recordCognitiveJobResult(address(), characterA, 2, 'failed', 'retry')
    expect(memory.cognitiveJob(address(), characterA, 2)).toMatchObject({ status: 'failed', attemptCount: 2, lastError: 'retry' })
    expect(() => memory.recordCognitiveJobResult(address(), characterA, 99, 'completed', null)).toThrow('missing')
    const request = {
      address: current.address,
      characterId: characterA,
      memoryId: 'memory:1',
      text: 'red apple near window',
      metadata: { salience: 'normal' },
      sources: [ref(current.observations[0]!), ref(current.claims[0]!)],
      asOfWorldSeq: 2,
      correlationId: 'capture:1',
    } as const
    expect(memory.capture(request)).toBe('captured')
    expect(memory.capture(request)).toBe('already_captured')

    await commit(world, address(), 'second', [observation('observation:2', characterA)])
    const advanced = builder.rebuildAt(address(), characterA, 3)
    expect(reconcile(memory, advanced)).toBe(3)
    expect(memory.capture({
      ...request,
      memoryId: 'memory:2',
      text: 'two observations',
      sources: [ref(advanced.observations[1]!), ref(advanced.observations[0]!)],
      asOfWorldSeq: 3,
    })).toBe('captured')
    expect(memory.recall(address(), characterA, 'red apple', 2)).toMatchObject([{
      memoryId: 'memory:1', text: 'red apple near window', metadata: { salience: 'normal' }, sourceMaxSeq: 2,
    }])
    expect(memory.recall(address(), characterA, 'missing', 3)).toEqual([])
    expect(memory.recall(address('other'), characterA, 'red', 3)).toEqual([])
    expect(memory.recall(address(), characterB, 'red', 3)).toEqual([])
    expect(memory.recall(address(), characterA, 'red', 1)).toEqual([])
    expect(memory.recall(address(), characterA, '   ', 3)).toEqual([])
    expect(memory.recall(address(), characterA, '"red"', 3)).toHaveLength(1)
    expect(() => memory.recall(address(), characterA, 'red', -1)).toThrow(RangeError)
    expect(() => memory.recall(address(), characterA, 'red', 3, 0)).toThrow(RangeError)
    expect(() => memory.capture({ ...request, text: 'changed' })).toThrow('different content')
    expect(() => memory.forget(address(), characterA, 'memory:1', 1)).toThrow('cannot be forgotten')
    memory.forget(address(), characterA, 'memory:1', 3)
    expect(memory.recall(address(), characterA, 'red', 2)).toHaveLength(1)
    expect(memory.recall(address(), characterA, 'red', 3)).toEqual([])
    memory.close()
    world.close()
  })

  it('rejects future, summary, missing, divergent, cross-character, and cross-branch sources', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    world.createBranch(address('other'))
    await commit(world, address(), 'base', [observation('observation:base', characterA), claim('claim:base', characterA)])
    const builder = new CharacterViewBuilder(world)
    const base = builder.rebuildAt(address(), characterA, 2)
    await commit(world, address(), 'future', [observation('observation:future', characterA)])
    const future = builder.rebuildAt(address(), characterA, 3)
    await commit(world, address(), 'character-b', [observation('observation:b', characterB)])
    const otherCharacter = builder.rebuildAt(address(), characterB, 4)
    await commit(world, address('other'), 'other-branch', [observation('observation:other', characterA)])
    const otherBranch = builder.rebuildAt(address('other'), characterA, 1)
    const memory = new LocalMemoryStore(path.memory, world)
    reconcile(memory, base)
    reconcile(memory, future)
    reconcile(memory, otherCharacter)
    reconcile(memory, otherBranch)
    const template = {
      address: address(), characterId: characterA, memoryId: 'memory:test', text: 'verified text', metadata: {},
      sources: [ref(future.observations[1]!)], asOfWorldSeq: 2, correlationId: 'memory-rejection',
    } as const
    expect(() => memory.capture(template)).toThrow('later than')
    expect(() => memory.capture({ ...template, memoryId: 'summary', sources: [{ ...ref(base.observations[0]!), sourceKind: 'summary' }] }))
      .toThrow('Summary')
    expect(() => memory.capture({ ...template, memoryId: 'missing', sources: [{ ...ref(base.observations[0]!), sourceId: 'missing' }], asOfWorldSeq: 3 }))
      .toThrow('missing or divergent')
    expect(() => memory.capture({ ...template, memoryId: 'hash', sources: [{ ...ref(future.observations[1]!), sourceHash: hashWorldJson('wrong', 1) }], asOfWorldSeq: 3 }))
      .toThrow('missing or divergent')
    expect(() => memory.capture({ ...template, memoryId: 'character', sources: [ref(otherCharacter.observations[0]!)], asOfWorldSeq: 4 }))
      .toThrow('missing or divergent')
    expect(() => memory.capture({ ...template, memoryId: 'branch', sources: [ref(otherBranch.observations[0]!)], asOfWorldSeq: 3 }))
      .toThrow('missing or divergent')
    expect(() => memory.capture({ ...template, memoryId: '', asOfWorldSeq: 3 })).toThrow(TypeError)
    expect(() => memory.capture({ ...template, memoryId: 'empty-text', text: '', asOfWorldSeq: 3 })).toThrow(TypeError)
    expect(() => memory.capture({ ...template, memoryId: 'no-sources', sources: [], asOfWorldSeq: 3 })).toThrow('requires committed')
    expect(() => memory.capture({ ...template, memoryId: 'bad-asof', asOfWorldSeq: -1 })).toThrow(RangeError)
    memory.close()
    world.close()
  })

  it('enforces monotonic reconciliation and removes mappings absent from a newer view', async () => {
    const path = paths()
    const world = new WorldStore(path.world)
    world.createBranch(address())
    await commit(world, address(), 'original', [observation('observation:stale', characterA, 'stale source')])
    const builder = new CharacterViewBuilder(world)
    const original = builder.rebuildAt(address(), characterA, 1)
    const memory = new LocalMemoryStore(path.memory, world)
    reconcile(memory, original)
    memory.capture({
      address: address(), characterId: characterA, memoryId: 'memory:stale', text: 'stale source text', metadata: {},
      sources: [ref(original.observations[0]!)], asOfWorldSeq: 1, correlationId: 'stale',
    })
    expect(memory.recall(address(), characterA, 'stale', 1)).toHaveLength(1)

    await commit(world, address(), 'revised', [observation('observation:stale', characterA, 'revised source')])
    const revised = builder.rebuildAt(address(), characterA, 2)
    expect(reconcile(memory, revised)).toBe(1)
    expect(memory.recall(address(), characterA, 'stale', 2)).toEqual([])
    expect(() => memory.reconcile({
      address: address(), characterId: characterA, asOfWorldSeq: 1, correlationId: 'rollback',
    })).toThrow('cannot move a namespace backward')
    expect(() => memory.reconcile({
      address: address(), characterId: characterA, asOfWorldSeq: -1, correlationId: 'invalid',
    })).toThrow(RangeError)

    await commit(world, address(), 'removed', [{
      eventType: 'observation.remove', eventVersion: 1, data: { id: 'observation:stale' },
    }])
    const removed = builder.rebuildAt(address(), characterA, 3)
    expect(reconcile(memory, removed)).toBe(0)
    expect(reconcile(memory, removed)).toBe(0)
    expect(memory.recall(address(), characterA, 'stale', 3)).toEqual([])

    const raw = new DatabaseSync(path.memory)
    raw.prepare(`UPDATE memory_namespace_watermarks SET bundle_hash = 'sha256:corrupt'`).run()
    raw.close()
    expect(() => reconcile(memory, removed)).toThrow('diverged at the same asOfWorldSeq')
    memory.close()
    world.close()
  })

  it('fails closed when a source mapping is corrupted backward or diverges at one sequence', async () => {
    for (const [suffix, sql, expected] of [
      ['backward', `UPDATE memory_source_mappings SET source_seq = 99`, 'cannot move backward'],
      ['divergent', `UPDATE memory_source_mappings SET source_hash = 'sha256:corrupt'`, 'diverged at the same sequence'],
    ] as const) {
      const path = paths()
      const world = new WorldStore(path.world)
      world.createBranch(address())
      await commit(world, address(), suffix, [observation('observation:corrupt', characterA)])
      const current = new CharacterViewBuilder(world).rebuildAt(address(), characterA, 1)
      const memory = new LocalMemoryStore(path.memory, world)
      reconcile(memory, current)
      const raw = new DatabaseSync(path.memory)
      raw.exec(sql)
      raw.close()
      expect(() => reconcile(memory, current)).toThrow(expected)
      memory.close()
      world.close()
    }
  })
})
