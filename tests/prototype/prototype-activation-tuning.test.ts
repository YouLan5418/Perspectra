import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandId } from '@harness-world/contracts'
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
      readEvents: () => [{ seq: 2, eventType: 'observation.upsert',
        data: { value: { observerId: characterId, content: { status: 'accepted', actorId: 'character:other' } } } }],
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
  const store = { readEvents: events, head: () => ({headSeq}) }
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
  const store = {head: () => ({headSeq: 2}), readEvents: () => ids.map(id => ({seq: 2, eventType: 'observation.upsert',
    data: {value: {observerId: id, content: {status: 'accepted', actorId: 'character:other'}}}}))}
  const turn = {run: async (id: string) => {visited.push(id); return {calls: 2, status: 'published' as const}}}
  const result = await runPrototypeActivations({store: store as never, address, turn: turn as never,
    afterSeq: 1, characterIds: ids, signal: new AbortController().signal,
    limits: {maximumWaves: 1, maximumNpcCalls: 2, maximumCallsPerCharacter: 1}})
  expect(visited).toEqual([ids[1]])
  expect(result.terminalReason).toBe('call_limit')
  expect(result.calls).toBe(2)
})
