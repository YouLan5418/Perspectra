import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandId, type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { runPrototypeActivations } from '../../packages/application/src/prototype-activation-cycle.ts'

describe('prototype reaction tuning', () => {
  it('uses the configured call ceiling when offering an NPC activation', async () => {
    const characterId = brandId('character:test', 'CharacterId')
    const address = {
      tenantId: brandId('tenant:test', 'TenantId'),
      worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const offered: number[] = []
    const store = {
      readEventsRange: (_address: unknown, after: number, head: number) => [{ seq: 2, eventType: 'observation.upsert',
        data: { value: { observerId: characterId, content: { status: 'accepted', actorId: 'character:other' } } } }]
        .filter(event => event.seq > after && event.seq <= head),
      head: () => ({ headSeq: 2 }),
    }
    const turn = { run: async (_id: unknown, options: { maxCalls: number }) => {
      offered.push(options.maxCalls)
      return { calls: 2, status: 'published' as const }
    } }
    const result = await runPrototypeActivations({
      store: store as never, address, turn: turn as never, afterSeq: 1,
      characterIds: [characterId], signal: new AbortController().signal,
      limits: { maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1, reactionDeadlineSeconds: 30 },
    })
    expect(offered).toEqual([2])
    expect(result.calls).toBe(2)
    expect(result.wave).toBe(1)
  })
})


afterEach(() => vi.restoreAllMocks())

it('shuffles present observers before off-scene observers and refreshes groups each wave', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const ids = ['claude', 'deepseek', 'glm', 'gpt', 'silent'].map(id => brandId('character:' + id, 'CharacterId'))
  const [claude, deepseek, glm, gpt] = ids
  const address = { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
  let headSeq = 2, wave = 0, active = 0
  const visited: string[] = []
  const events = () => ids.slice(0, 4).map(id => ({seq: headSeq, eventType: 'observation.upsert',
    data: {value: {observerId: id, content: {status: 'accepted', actorId: 'character:other'}}}}))
  const store = { readEventsRange: (_address: unknown, after: number, head: number) => events().filter(event => event.seq > after && event.seq <= head), head: () => ({headSeq}) }
  const turn = {run: async (id: string) => {
    expect(active).toBe(0); active++
    await Promise.resolve(); visited.push(id); headSeq++; active--
    return {calls: 1, status: 'published' as const}
  }}
  const result = await runPrototypeActivations({store: store as never, address, turn: turn as never,
    afterSeq: 1, characterIds: ids, signal: new AbortController().signal,
    presentCharacterIds: () => ++wave === 1 ? [claude!, deepseek!] : [glm!, gpt!],
    limits: {maximumWaves: 2, maximumNpcCalls: 40, maximumCallsPerCharacter: 2}})
  expect(visited).toEqual([deepseek, claude, gpt, glm, gpt, glm, deepseek, claude])
  expect(visited).not.toContain(ids[4])
  expect(result.calls).toBe(8)
})

it('allows a later-listed observer to receive the first bounded activation', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const ids = ['claude', 'deepseek', 'glm', 'gpt'].map(id => brandId('character:' + id, 'CharacterId'))
  const address = { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
  const visited: string[] = []
  const store = {head: () => ({headSeq: 2}), readEventsRange: (_address: unknown, after: number, head: number) => ids.map(id => ({seq: 2, eventType: 'observation.upsert',
    data: {value: {observerId: id, content: {status: 'accepted', actorId: 'character:other'}}}})).filter(event => event.seq > after && event.seq <= head)}
  const turn = {run: async (id: string) => {visited.push(id); return {calls: 2, status: 'published' as const}}}
  const result = await runPrototypeActivations({store: store as never, address, turn: turn as never,
    afterSeq: 1, characterIds: ids, signal: new AbortController().signal,
    limits: {maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1}})
  expect(visited).toEqual([ids[1]])
  expect(result.terminalReason).toBe('call_limit')
  expect(result.calls).toBe(2)
})

it.each(['serial', 'dynamic'] as const)('collects only unconsumed branch observations in %s scheduling', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'prototype-observation-range-'))
  const store = new WorldStore(join(root, 'world.sqlite'))
  try {
    const parent = { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'), branchId: brandId('branch:parent', 'BranchId') }
    const child = { ...parent, branchId: brandId('branch:child', 'BranchId') }
    const actor = brandId('character:observer', 'CharacterId')
    const consumed = brandId('character:consumed', 'CharacterId')
    const future = brandId('character:parent-future', 'CharacterId')
    const observation = (observerId: string, marker: string): WorldEventDraft => ({ eventType: 'observation.upsert', eventVersion: 1,
      data: { value: { observerId, content: { actorId: 'character:other', status: 'accepted', marker } } } })
    let commits = 0
    const append = async (address: WorldAddress, events: readonly WorldEventDraft[]) => {
      const head = store.head(address), id = ++commits
      await store.commitRound({ address, transactionId: brandId(`transaction:range:${id}`, 'TransactionId'),
        roundId: brandId(`round:range:${id}`, 'InteractionRoundId'), expectedHeadSeq: head.headSeq, expectedTick: head.tick,
        nextTick: head.tick + 1, events, outbox: [], correlationId: 'range-test' })
    }
    store.createBranch(parent)
    await append(parent, [observation(consumed, 'consumed'),
      { eventType: 'fixture.ignored', eventVersion: 1, data: {} }, observation(actor, 'inherited')])
    store.forkBranch(parent, child, 3)
    await append(parent, [observation(future, 'parent-future')])
    await append(child, [{ eventType: 'fixture.ignored', eventVersion: 1, data: {} }, observation(actor, 'child')])
    vi.spyOn(store, 'readEvents').mockImplementation(() => { throw new Error('scheduler must not replay full history') })
    const received: { actor: string; markers: unknown[] }[] = []
    const turn = { run: async (id: string, options: { stimulus: readonly WorldJsonObject[] }) => {
      received.push({ actor: id, markers: options.stimulus.map(value => (value.content as WorldJsonObject).marker) })
      return { calls: 1, status: 'abstained' as const, asOfWorldSeq: 5 }
    } }
    const result = await runPrototypeActivations({ store, address: child, turn: turn as never, afterSeq: 1,
      characterIds: [actor, consumed, future], signal: new AbortController().signal,
      ...(mode === 'dynamic' ? { locationId: (id: string) => id } : {}),
      limits: { maximumWaves: 1, maximumNpcCalls: 6, maximumCallsPerCharacter: 1, reactionDeadlineSeconds: 5 } })
    expect(received).toEqual([{ actor, markers: ['inherited', 'child'] }])
    expect(result.calls).toBe(1)
    expect(result.terminalReason).toBe('quiescent')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
