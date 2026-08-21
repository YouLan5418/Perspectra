import { brandId, deterministicId } from '@harness-world/contracts'
import { WorldStore, type ActivateBranchResult } from '@harness-world/store-sqlite'
import type { CompiledWorldSpec } from './world-spec.ts'

/** Activates a compiled world through the Store's Tick 0 administrative transaction. */
export class WorldBootstrap {
  constructor(private readonly store: WorldStore) {}

  activate(compiled: CompiledWorldSpec, correlationId = 'world-bootstrap'): ActivateBranchResult {
    const identity = { address: compiled.manifest.address, manifestHash: compiled.manifestHash, genesisHash: compiled.genesisHash }
    return this.store.activateBranch({
      address: compiled.manifest.address,
      manifest: compiled.manifest,
      manifestHash: compiled.manifestHash,
      genesisEvents: compiled.genesisEvents,
      genesisHash: compiled.genesisHash,
      transactionId: brandId(deterministicId('transaction:genesis', identity), 'TransactionId'),
      roundId: brandId(deterministicId('round:genesis', identity), 'InteractionRoundId'),
      correlationId,
    })
  }
}
