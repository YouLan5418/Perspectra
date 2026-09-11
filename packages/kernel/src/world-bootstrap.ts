import { brandId, deterministicId, failWorld, worldAddressKey } from '@harness-world/contracts'
import { WorldStore, type ActivateBranchResult } from '@harness-world/store-sqlite'
import { manifestUsesPhase8Contracts, type CompiledWorldManifestV9, type CompiledWorldSpec } from './world-spec.ts'

/** Activates a compiled world through the Store's Tick 0 administrative transaction. */
export class WorldBootstrap {
  constructor(private readonly store: WorldStore) {}

  activate(compiled: CompiledWorldSpec, correlationId = 'world-bootstrap'): ActivateBranchResult {
    if (compiled.manifest.rulebook.rulebookId === 'builtin:speak-move'
      && compiled.manifest.rulebook.version === 3
      && this.store.readManifest(compiled.manifest.address) === undefined) {
      failWorld({
        errorCode: 'INVALID_REQUEST', category: 'admission',
        message: 'Rulebook builtin:speak-move@3 is historical-only and cannot activate a new world', retryable: false,
        correlationId, address: compiled.manifest.address,
        details: { rulebookId: compiled.manifest.rulebook.rulebookId, version: 3, addressKey: worldAddressKey(compiled.manifest.address) },
      })
    }
    const playerInputPolicy = compiled.manifest.schemaVersion === 9
      ? (compiled.manifest as CompiledWorldManifestV9).playerInputPolicy
      : undefined
    if (playerInputPolicy?.version === 'player-intent/v1') {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime',
        message: 'player-intent/v1 activation requires the C3 durable interpreter', retryable: false,
        correlationId, address: compiled.manifest.address,
        details: { playerInputPolicy: 'player-intent/v1', requiredStage: 'C3' },
      })
    }
    const identity = { address: compiled.manifest.address, manifestHash: compiled.manifestHash, genesisHash: compiled.genesisHash }
    return this.store.activateBranch({
      address: compiled.manifest.address,
      manifest: compiled.manifest,
      manifestHash: compiled.manifestHash,
      genesisEvents: compiled.genesisEvents,
      genesisHash: compiled.genesisHash,
      transactionId: brandId(deterministicId('transaction:genesis', identity), 'TransactionId'),
      roundId: brandId(deterministicId('round:genesis', identity), 'InteractionRoundId'),
      ...(manifestUsesPhase8Contracts(compiled.manifest)
        ? { cognitiveJobs: compiled.manifest.characters.map(character => ({ characterId: character.characterId })) }
        : {}),
      correlationId,
    })
  }
}
