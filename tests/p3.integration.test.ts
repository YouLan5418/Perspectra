import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelBudgetLedger, SafeAgentRunner } from '@harness-world/agents'
import { brandId, type AgentProvider } from '@harness-world/contracts'
import { WorldBootstrap, WorldKernel, WorldSpecCompiler } from '@harness-world/kernel'
import { WorldRuntimeRegistry } from '@harness-world/runtime-cordis'
import { RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'

describe('Phase 3 provider failure containment acceptance', () => {
  it('does not block a player Round on provider failure, timeout, or exhausted budget', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p3-'))
    const path = join(directory, 'world.sqlite')
    try {
      const compiled = new WorldSpecCompiler().compile({
        schemaVersion: 1,
        address: { tenantId: 'tenant:p3', worldId: 'world:p3', branchId: 'branch:main' },
        timeMode: 'TURN_DRIVEN',
        roundQueueLimit: 4,
        rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
        locations: [{ locationId: 'location:room', name: 'Room' }],
        characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:room' }],
        playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
        plugins: [],
      })
      const store = new WorldStore(path)
      new WorldBootstrap(store).activate(compiled)
      const registry = new WorldRuntimeRegistry(new Context(), {
        create: () => ({ kernel: {}, store: {}, agents: {}, director: {} }),
      })
      const runtime = await registry.acquire(compiled.manifest.address, compiled.manifestHash)
      const inbox = new RoundInbox(path)
      const leases = new WriterLeaseService(path)
      const kernel = new WorldKernel({ store, inbox, leases, runtimeLane: runtime.slot, ownerId: 'kernel:p3' })
      const context = {
        address: compiled.manifest.address,
        roundId: brandId('round:provider', 'InteractionRoundId'),
        tick: 0,
        playerAction: { actionId: 'action:player', actorId: compiled.manifest.characters[0]!.characterId, actionType: 'speak', actionVersion: 1, parameters: {} },
        candidateHash: compiled.manifestHash,
      }
      const failed: AgentProvider = { propose: async () => { throw new Error('offline') } }
      const never: AgentProvider = { propose: async () => new Promise(() => undefined) }
      const runner = new SafeAgentRunner(new ModelBudgetLedger(4))
      expect(await runner.propose('call:failed', 1, 100, 'npc:failed', failed, context)).toMatchObject({ status: 'fallback' })
      expect(await runner.propose('call:timeout', 1, 5, 'npc:timeout', never, context)).toMatchObject({ status: 'fallback' })
      const exhausted = new SafeAgentRunner(new ModelBudgetLedger(0))
      expect(await exhausted.propose('call:budget', 1, 100, 'npc:budget', failed, context)).toMatchObject({ status: 'fallback' })

      const committed = await kernel.submitPlayerInput({
        idempotencyKey: 'player:after-provider-failures',
        principalId: 'principal:player',
        action: { actionType: 'speak', parameters: { text: 'still running' } },
        correlationId: 'p3-player',
      })
      expect(committed).toMatchObject({ status: 'accepted', tick: 1 })
      kernel.close()
      inbox.close()
      leases.close()
      store.close()
      await runtime.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
