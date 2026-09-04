import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import {
  adaptCompiledWorldPack,
  compileWorldPackSource,
  executeWorldPackCli,
} from '@harness-world/world-pack'
import { reactionBinding, roundProvider, type ProviderScript } from './reaction-fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('worldpack-source/v3 runtime entry', () => {
  it('opens a real responsive Cycle only after the Host supplies the required actors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hcw-worldpack-v3-e2e-'))
    roots.push(root)
    const source = join(root, 'source')
    await executeWorldPackCli(['init', '--profile', 'responsive-social', source])
    const pack = await compileWorldPackSource(source)
    const address = {
      tenantId: brandId('tenant:worldpack-v3', 'TenantId'),
      worldId: brandId('world:worldpack-v3', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const compiled = adaptCompiledWorldPack(pack, {
      address, principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId'),
    })
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const application = new WorldApplication({
      worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'Alice hears the player'), roundProvider(bob, 'Bob hears the player')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    try {
      await application.submit(address, {
        idempotencyKey: 'worldpack-v3:first', principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: 'Are we ready?' } }, correlationId: 'worldpack-v3:first',
      })
      const opened = await application.listReactionCycles(address)
      expect(opened).toEqual([expect.objectContaining({ status: 'active', profileId: 'responsive/v1' })])
      await application.processReactionCycles(address)
      expect((await application.listReactionCycles(address))[0]).toMatchObject({
        status: 'terminal', terminalReason: 'all_abstained',
      })
      expect(aliceScript.calls.value).toBe(1)
      expect(bobScript.calls.value).toBe(1)
    } finally { await application.close() }
  })
})
