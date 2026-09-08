import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type WorldAddress, type WorldEventDraft } from '@harness-world/contracts'
import { VisibleStateRebuilder } from './visible-state.ts'
import { WorldStore } from './world-store.ts'

const roots: string[] = []

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:visible-state', 'TenantId'),
    worldId: brandId('world:visible-state', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'hcw-visible-state-'))
  roots.push(root)
  return join(root, 'world.sqlite')
}

async function commit(store: WorldStore, suffix: string, events: readonly WorldEventDraft[], target = address()): Promise<void> {
  const head = store.head(target)
  await store.commitRound({
    address: target,
    transactionId: brandId(`transaction:visible:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:visible:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1,
    events, outbox: [], correlationId: `visible:${suffix}`,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('VisibleStateRebuilder', () => {
  it('rebuilds set, replace, remove, filtering, fork as-of, and stable ordering from events', async () => {
    const store = new WorldStore(path())
    store.createBranch(address())
    await commit(store, 'base', [
      { eventType: 'character.visible-state-upserted', eventVersion: 1, data: {
        characterId: 'character:b', stateKey: 'posture:arms',
        value: { channel: 'posture', description: '抱起双臂' },
      } },
      { eventType: 'character.visible-state-upserted', eventVersion: 1, data: {
        characterId: 'character:a', stateKey: 'appearance:sleeve',
        value: { channel: 'appearance', description: '袖口湿了' },
      } },
    ])
    const fork = address('fork')
    store.forkBranch(address(), fork, 2)
    await commit(store, 'change', [
      { eventType: 'character.visible-state-upserted', eventVersion: 1, data: {
        characterId: 'character:b', stateKey: 'posture:arms',
        value: { channel: 'posture', description: '放下双臂' },
      } },
      { eventType: 'character.visible-state-removed', eventVersion: 1, data: {
        characterId: 'character:a', stateKey: 'appearance:sleeve',
      } },
    ])
    const rebuilder = new VisibleStateRebuilder(store)
    expect(rebuilder.rebuildAt(address(), 2).states.map(value => value.characterId))
      .toEqual(['character:a', 'character:b'])
    expect(rebuilder.rebuildAt(address(), 4).states).toMatchObject([{
      characterId: 'character:b', stateKey: 'posture:arms', description: '放下双臂', sourceSeq: 3,
    }])
    expect(rebuilder.rebuildAt(address(), 4, brandId('character:a', 'CharacterId')).states).toEqual([])
    const inherited = rebuilder.rebuildAt(fork, 2)
    expect(inherited.states).toHaveLength(2)
    expect(inherited.bundleHash).toMatch(/^sha256:/)
    store.close()
  })

  it('rejects invalid watermarks and malformed authoritative state events', async () => {
    const store = new WorldStore(path())
    store.createBranch(address())
    const rebuilder = new VisibleStateRebuilder(store)
    expect(() => rebuilder.rebuildAt(address(), -1)).toThrow(RangeError)
    expect(() => rebuilder.rebuildAt(address(), 1)).toThrow('later than')
    for (const [suffix, event, message] of [
      ['data', { eventType: 'character.visible-state-upserted', eventVersion: 1, data: null }, 'must be an object'],
      ['identity', { eventType: 'character.visible-state-removed', eventVersion: 1, data: { characterId: 1, stateKey: 'x' } }, 'requires characterId'],
      ['value', { eventType: 'character.visible-state-upserted', eventVersion: 1, data: { characterId: 'character:a', stateKey: 'x', value: null } }, 'must be an object'],
      ['channel', { eventType: 'character.visible-state-upserted', eventVersion: 1, data: { characterId: 'character:a', stateKey: 'x', value: { channel: 'voice', description: 'quiet' } } }, 'malformed'],
      ['description', { eventType: 'character.visible-state-upserted', eventVersion: 1, data: { characterId: 'character:a', stateKey: 'x', value: { channel: 'posture', description: '' } } }, 'malformed'],
    ] as const) {
      const target = address(suffix)
      store.createBranch(target)
      await commit(store, suffix, [event as WorldEventDraft], target)
      expect(() => rebuilder.rebuildAt(target, 1)).toThrow(message)
    }
    store.close()
  })
})
