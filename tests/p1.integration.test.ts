import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorldBootstrap, WorldKernel, WorldSpecCompiler } from '@harness-world/kernel'
import { WorldRuntimeRegistry } from '@harness-world/runtime-cordis'
import { RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'

describe('Phase 1 no-Agent acceptance', () => {
  it('commits, retries, fully replays, and restarts one player message with the same hashes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p1-'))
    const path = join(directory, 'world.sqlite')
    const compiler = new WorldSpecCompiler()
    const compiled = compiler.compile({
      schemaVersion: 1,
      address: { tenantId: 'tenant:p1', worldId: 'world:p1', branchId: 'branch:main' },
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:room', name: 'Room' }],
      characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:room' }],
      playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
      plugins: [],
    })
    const request = {
      idempotencyKey: 'message:1',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'Phase 1' } },
      correlationId: 'p1-acceptance',
    } as const
    try {
      const store = new WorldStore(path)
      const genesis = new WorldBootstrap(store).activate(compiled)
      const registry = new WorldRuntimeRegistry(new Context())
      const runtime = await registry.acquire(compiled.manifest.address, compiled.manifestHash)
      const inbox = new RoundInbox(path)
      const leases = new WriterLeaseService(path)
      const kernel = new WorldKernel({ store, inbox, leases, runtimeSlot: runtime.slot, ownerId: 'kernel:p1:first' })
      const committed = await kernel.submitPlayerInput(request)
      expect(await kernel.submitPlayerInput(request)).toEqual(committed)
      const eventHashes = store.readEvents(compiled.manifest.address).map(event => event.eventHash)
      expect(committed.tick).toBe(1)
      kernel.close()
      inbox.close()
      leases.close()
      store.close()
      await runtime.dispose()

      const restartedStore = new WorldStore(path)
      expect(new WorldBootstrap(restartedStore).activate(compiler.compile({
        schemaVersion: 1,
        address: { tenantId: 'tenant:p1', worldId: 'world:p1', branchId: 'branch:main' },
        timeMode: 'TURN_DRIVEN',
        roundQueueLimit: 4,
        rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
        locations: [{ locationId: 'location:room', name: 'Room' }],
        characters: [{ characterId: 'character:player', name: 'Player', locationId: 'location:room' }],
        playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
        plugins: [],
      }))).toEqual({ ...genesis, status: 'already_active' })
      const restartedRegistry = new WorldRuntimeRegistry(new Context())
      const restartedRuntime = await restartedRegistry.acquire(compiled.manifest.address, compiled.manifestHash)
      const restartedInbox = new RoundInbox(path)
      const restartedLeases = new WriterLeaseService(path)
      const restartedKernel = new WorldKernel({
        store: restartedStore,
        inbox: restartedInbox,
        leases: restartedLeases,
        runtimeSlot: restartedRuntime.slot,
        ownerId: 'kernel:p1:restart',
      })
      expect(await restartedKernel.submitPlayerInput(request)).toEqual(committed)
      expect(restartedStore.readEvents(compiled.manifest.address).map(event => event.eventHash)).toEqual(eventHashes)
      restartedKernel.close()
      restartedInbox.close()
      restartedLeases.close()
      restartedStore.close()
      await restartedRuntime.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
