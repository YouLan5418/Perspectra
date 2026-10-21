import {
  WorldError,
  failWorld,
  worldAddressKey,
  type CharacterId,
  type CharacterView,
  type SessionId,
  type StoredRoundAuthority,
  type StoredWorldEvent,
  type TransactionId,
  type WorldAddress,
} from '@harness-world/contracts'
import { runtimeManifestFromStored } from '@harness-world/kernel'
import type { CognitiveMemoryService, RecallCandidateDiagnostics, RecalledMemory } from '@harness-world/memory'
import type { PresentationResult, PresenterOptions } from '@harness-world/presentation'
import {
  BranchAdministration,
  BranchQuarantineService,
  CharacterViewBuilder,
  SnapshotStore,
  WorldStore,
} from '@harness-world/store-sqlite'
import type { PlayerChatScope } from './world-application.ts'
import type { WorldBranchAccess } from './world-branch-access.ts'

/** Creator, debug and operator reads. Nothing here changes world state; integrity failures still quarantine. */
export class WorldReadQueries {
  readonly #access: WorldBranchAccess

  constructor(access: WorldBranchAccess) {
    this.#access = access
  }

  listWorlds() {
    this.#access.assertOpen()
    const store = new WorldStore(this.#access.options.worldPath)
    try {
      const worlds = new Map<string, { tenantId: WorldAddress['tenantId']; worldId: WorldAddress['worldId']; branchCount: number }>()
      for (const address of store.listBranches()) {
        const key = `${address.tenantId}\u001f${address.worldId}`
        const current = worlds.get(key)
        worlds.set(key, current === undefined
          ? { tenantId: address.tenantId, worldId: address.worldId, branchCount: 1 }
          : { ...current, branchCount: current.branchCount + 1 })
      }
      return [...worlds.values()]
    } finally {
      store.close()
    }
  }

  /** Discover player-safe chat bindings without exposing full Manifests or NPC views. */
  listPlayerChatScopes(): PlayerChatScope[] {
    this.#access.assertOpen()
    const store = new WorldStore(this.#access.options.worldPath)
    try {
      return store.listBranches().flatMap(address => {
        const record = store.readManifest(address)
        if (record === undefined) return []
        const manifest = runtimeManifestFromStored(record.manifest)
        return manifest.playerBindings.map(binding => ({
          address,
          principalId: binding.principalId,
          characterId: binding.characterId,
        }))
      })
    } finally {
      store.close()
    }
  }

  getWorld(address: WorldAddress) {
    this.#access.assertOpen()
    const store = new WorldStore(this.#access.options.worldPath)
    const administration = new BranchAdministration(this.#access.options.worldPath)
    try {
      const manifest = store.readManifest(address)
      if (manifest === undefined) throw new Error('world branch has no active Compiled Manifest')
      return {
        address,
        manifest: manifest.manifest,
        manifestHash: manifest.manifestHash,
        head: store.head(address),
        control: administration.status(address),
      }
    } finally {
      administration.close()
      store.close()
    }
  }

  /** Integrity-checked authority history for local authoring/debug composition; not exposed by the player RPC surface. */
  async eventHistory(address: WorldAddress, asOfWorldSeq?: number): Promise<StoredWorldEvent[]> {
    return this.#access.integrityGuard(address, 'world.events', branch => branch.store.store.readEvents(address, asOfWorldSeq))
  }

  /** Read the immutable Round Authority bound to a committed transaction. */
  async roundAuthority(address: WorldAddress, transactionId: TransactionId): Promise<StoredRoundAuthority | undefined> {
    return this.#access.integrityGuard(address, 'round.authority', branch => branch.store.store.readRoundAuthority(address, transactionId))
  }

  async characterView(address: WorldAddress, characterId: CharacterId, asOfWorldSeq?: number): Promise<CharacterView> {
    return this.#access.integrityGuard(address, 'view.character', branch => this.#access.projectionRead(
      address,
      `view:${worldAddressKey(address)}:${characterId}`,
      () => {
        const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
        return new CharacterViewBuilder(branch.store.store).rebuildAt(address, characterId, asOf)
      },
    ))
  }

  async recallMemory(
    address: WorldAddress,
    characterId: CharacterId,
    query: string,
    asOfWorldSeq?: number,
  ): Promise<RecalledMemory[]> {
    return this.#access.integrityGuard(address, 'memory.recall', branch => {
      const memory = this.#requireCognitiveMemory(branch.agents.cognitiveMemory, address, characterId, 'recall')
      const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
      return memory.recall(address, characterId, query, asOf)
    })
  }

  /**
   * Report how many Recall candidates this query matches before the default result limit, so an operator can
   * see what one Recall leaves unseen. Reading this writes no Recall or Context record of its own.
   */
  async diagnoseMemoryRecall(
    address: WorldAddress,
    characterId: CharacterId,
    query: string,
    asOfWorldSeq?: number,
  ): Promise<RecallCandidateDiagnostics> {
    return this.#access.integrityGuard(address, 'memory.diagnose', branch => {
      const memory = this.#requireCognitiveMemory(branch.agents.cognitiveMemory, address, characterId, 'diagnose')
      const asOf = asOfWorldSeq ?? branch.store.store.head(address).headSeq
      return memory.diagnoseRecall(address, characterId, query, asOf)
    })
  }

  #requireCognitiveMemory(
    memory: CognitiveMemoryService | undefined,
    address: WorldAddress,
    characterId: CharacterId,
    operation: 'recall' | 'diagnose',
  ): CognitiveMemoryService {
    if (memory === undefined) {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE', category: 'runtime',
        message: 'Cognitive Memory is not enabled by this Manifest', retryable: false,
        correlationId: `memory-${operation}:${characterId}`, address,
      })
    }
    return memory
  }

  async characterAvailability(address: WorldAddress, characterId: CharacterId) {
    return (await this.#access.branch(address)).store.availability.get(address, characterId)
  }

  async renderSession(
    address: WorldAddress,
    sessionId: SessionId,
    sessionEventSeq: number,
    presenterOptions?: PresenterOptions,
  ): Promise<PresentationResult> {
    return this.#access.integrityGuard(address, 'session.render', branch => {
      try {
        const event = branch.store.session.readEvent(sessionId, sessionEventSeq)
        if (event === undefined) throw new Error(`Session event ${sessionEventSeq} is missing`)
        return branch.director.presenter.render(event.payload, presenterOptions)
      } catch (error: unknown) {
        if (error instanceof WorldError || (error instanceof Error && error.message.includes(' is missing'))) throw error
        failWorld({
          errorCode: 'SESSION_DELIVERY_DIVERGED', category: 'integrity',
          message: `Session presentation source failed validation: ${String(error)}`, retryable: false,
          correlationId: `session-render:${sessionId}:${sessionEventSeq}`, address,
        })
      }
    })
  }

  latestSnapshot(address: WorldAddress, snapshotPath: string) {
    this.#access.assertOpen()
    const snapshots = new SnapshotStore(snapshotPath)
    try {
      return snapshots.latest(address)
    } finally {
      snapshots.close()
    }
  }

  listSnapshots(address: WorldAddress, snapshotPath: string) {
    this.#access.assertOpen()
    const snapshots = new SnapshotStore(snapshotPath)
    try {
      return snapshots.list(address)
    } finally {
      snapshots.close()
    }
  }

  branchStatus(address: WorldAddress) {
    this.#access.assertOpen()
    const administration = new BranchAdministration(this.#access.options.worldPath)
    try {
      return administration.status(address)
    } finally {
      administration.close()
    }
  }

  branchAudit(address: WorldAddress) {
    this.#access.assertOpen()
    const administration = new BranchAdministration(this.#access.options.worldPath)
    try {
      return administration.readAudit(address)
    } finally {
      administration.close()
    }
  }

  quarantineExplain(address: WorldAddress) {
    this.#access.assertOpen()
    const quarantine = new BranchQuarantineService(this.#access.options.worldPath)
    try {
      return quarantine.explain(address)
    } finally {
      quarantine.close()
    }
  }
}
