import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandId, hashWorldJson } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { runtimeManifestFromStored, WorldBootstrap, WorldSpecCompiler, type CompiledWorldSpec } from '@harness-world/kernel'

describe('retired WorldSpec and Manifest versions', () => {
  it('rejects v1 source instead of silently upgrading it', () => {
    expect(() => new WorldSpecCompiler().compile({ schemaVersion: 1 }))
      .toThrow('WorldSpec.schemaVersion must be 2')
  })

  it('rejects retired stored Manifest versions instead of constructing runtime facts', () => {
    for (const schemaVersion of [1, 2, 9]) {
      expect(() => runtimeManifestFromStored({ schemaVersion }))
        .toThrow('stored Manifest schemaVersion is unsupported')
    }
  })

  it('refuses direct Store activation of a retired Manifest before writing Genesis', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retired-manifest-'))
    const store = new WorldStore(join(directory, 'world.sqlite'))
    try {
      const address = { tenantId: brandId('tenant:retired', 'TenantId'),
        worldId: brandId('world:retired', 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
      const manifest = { schemaVersion: 9, address }
      const genesisEvents = [{ eventType: 'world.created', eventVersion: 1, data: null }] as const
      expect(() => new WorldBootstrap(store).activate({ manifest } as unknown as CompiledWorldSpec))
        .toThrow('new worlds require Manifest v10')
      expect(() => store.activateBranch({
        address, manifest, manifestHash: hashWorldJson('compiled-world-manifest', manifest),
        genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
        transactionId: brandId('transaction:retired', 'TransactionId'),
        roundId: brandId('round:retired', 'InteractionRoundId'), correlationId: 'retired-version',
      })).toThrow('new worlds require Manifest v10')
      expect(store.listBranches()).toEqual([])
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
