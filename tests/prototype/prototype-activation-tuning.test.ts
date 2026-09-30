import { describe, expect, it } from 'vitest'
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
