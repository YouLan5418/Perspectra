import {
  failWorld,
  hashWorldJson,
  type CharacterId,
  type DeliveryId,
  type RuntimeAvailabilityState,
  type SessionId,
  type WorldAddress,
} from '@harness-world/contracts'
import { runtimeManifestFromStoredRecord } from '@harness-world/kernel'
import { CognitiveMemoryService } from '@harness-world/memory'
import {
  BranchAdministration,
  BranchQuarantineService,
  ProjectionRebuilder,
  SessionDeliveryAdapter,
  SnapshotStore,
  WorldArchiveService,
  WorldOutbox,
  WorldStore,
  type DeadLetterRecord,
} from '@harness-world/store-sqlite'
import { existsSync } from 'node:fs'
import {
  BranchOperationCoordinator,
  type ArchiveBranchResult,
  type ForkAtHeadResult,
} from './branch-operation-coordinator.ts'
import type { WorldBranchAccess } from './world-branch-access.ts'

/** Operator actions: availability overrides, dead letters, snapshots, backups, forks, archive, maintenance and recovery. */
export class WorldAdministration {
  readonly #access: WorldBranchAccess

  constructor(access: WorldBranchAccess) {
    this.#access = access
  }

  async setCharacterAvailability(
    address: WorldAddress,
    characterId: CharacterId,
    state: RuntimeAvailabilityState,
    reason: string | null,
  ) {
    return (await this.#access.branch(address)).store.availability.set(address, characterId, state, reason)
  }

  async deadLetters(address: WorldAddress): Promise<DeadLetterRecord[]> {
    return (await this.#access.branch(address)).store.deadLetters()
  }

  async retryDeadLetter(address: WorldAddress, deliveryId: DeliveryId, correlationId: string): Promise<void> {
    return (await this.#access.branch(address)).store.retryDeadLetter(deliveryId, correlationId)
  }

  async createSnapshot(address: WorldAddress, snapshotPath: string, correlationId: string) {
    return this.#access.integrityGuard(address, 'snapshot.create', branch => this.#access.projectionRead(address, correlationId, () => {
        const head = branch.store.store.head(address)
        const projection = new ProjectionRebuilder(branch.store.store).rebuildAt(address, head.headSeq)
        const snapshots = new SnapshotStore(snapshotPath)
        try {
          return snapshots.create(address, head.headSeq, { projection }, correlationId)
        } finally {
          snapshots.close()
        }
      }))
  }

  backup(targetPath: string, correlationId: string) {
    this.#access.assertOpen()
    return new WorldArchiveService(this.#access.options.worldPath).backup(targetPath, correlationId)
  }

  restore(backupPath: string, targetPath: string, expectedHash: string, correlationId: string) {
    this.#access.assertOpen()
    return new WorldArchiveService(this.#access.options.worldPath).restore(
      backupPath,
      targetPath,
      expectedHash as `sha256:${string}`,
      correlationId,
    )
  }

  exportPortable(exportPath: string, correlationId: string) {
    this.#access.assertOpen()
    return new WorldArchiveService(this.#access.options.worldPath).exportPortable(exportPath, correlationId)
  }

  importPortable(exportPath: string, targetPath: string, correlationId: string) {
    this.#access.assertOpen()
    return new WorldArchiveService(this.#access.options.worldPath).importPortable(exportPath, targetPath, correlationId)
  }

  async forkAtHead(
    parent: WorldAddress,
    child: WorldAddress,
    reason: string,
    correlationId: string,
  ): Promise<ForkAtHeadResult> {
    const branch = await this.#access.branch(parent)
    return new BranchOperationCoordinator(branch.store.store, branch.store.administration, branch.kernel, branch.store)
      .forkAtHead({ parent, child, reason, correlationId })
  }

  async archive(address: WorldAddress, reason: string, correlationId: string): Promise<ArchiveBranchResult> {
    const branch = await this.#access.branch(address)
    try {
      return await new BranchOperationCoordinator(branch.store.store, branch.store.administration, branch.kernel, branch.store)
        .archive({ address, reason, correlationId })
    } finally {
      await this.#access.release(address)
    }
  }

  async enterMaintenance(address: WorldAddress, reason: string, correlationId: string) {
    const branch = await this.#access.branch(address)
    branch.store.administration.setAdmission(address, 'draining', reason, `${correlationId}:drain`)
    const drainedRounds = await branch.kernel.drainAccepted(`${correlationId}:rounds`)
    await branch.store.drainCritical(`${correlationId}:outbox`)
    await this.#access.release(address)
    const administration = new BranchAdministration(this.#access.options.worldPath)
    try {
      return {
        drainedRounds,
        state: administration.enterMaintenance(address, reason, `${correlationId}:enter`),
      }
    } finally {
      administration.close()
    }
  }

  async exitMaintenance(address: WorldAddress, reason: string, correlationId: string) {
    this.#access.assertOpen()
    await this.#access.release(address)
    const administration = new BranchAdministration(this.#access.options.worldPath)
    try {
      return administration.exitMaintenance(address, reason, `${correlationId}:exit`)
    } finally {
      administration.close()
    }
  }

  async quarantineRecover(address: WorldAddress, correlationId: string) {
    this.#access.assertOpen()
    await this.#access.release(address)
    const quarantine = new BranchQuarantineService(this.#access.options.worldPath)
    try {
      return quarantine.recover(address, correlationId, () => {
        if (!existsSync(this.#access.options.sessionPath)) {
          failWorld({
            errorCode: 'RECOVERY_VALIDATION_FAILED', category: 'integrity',
            message: 'Session database is missing during quarantine recovery', retryable: false,
            correlationId, address,
          })
        }
        const store = new WorldStore(this.#access.options.worldPath)
        const outbox = new WorldOutbox(this.#access.options.worldPath)
        const session = new SessionDeliveryAdapter(this.#access.options.sessionPath)
        try {
          const world = store.verifyBranchIntegrity(address)
          const projection = new ProjectionRebuilder(store).rebuildAt(address, world.headSeq)
          const manifest = runtimeManifestFromStoredRecord(store.readManifest(address))
          const contextPolicy = manifest.plugins.find(plugin => plugin.pluginId === 'builtin:agent-context')
          let memoryVerificationHash
          if (contextPolicy !== undefined) {
            if (this.#access.options.memoryPath === undefined) {
              failWorld({
                errorCode: 'RECOVERY_VALIDATION_FAILED', category: 'integrity',
                message: 'Memory database path is missing during quarantine recovery', retryable: false,
                correlationId, address,
              })
            }
            const memoryVersion = manifest.contentPack?.runtimeCapabilities.cognitiveMemoryVersion === 2 ? 2 : 1
            const memory = new CognitiveMemoryService(
              this.#access.options.memoryPath, store, this.#access.options.faultInjector, memoryVersion,
              this.#access.options.recallTokenizer, this.#access.options.recallDictionary ?? false,
            )
            try {
              memoryVerificationHash = memory.rebuildBranch(
                address, manifest.characters.map(character => character.characterId), world.headSeq, correlationId,
              )

            } finally {
              memory.close()
            }
          }
          const sessionIntegrity = session.verifyIntegrity(address, correlationId)
          const bindings = session.deliveryBindings()
          const byDelivery = new Map(bindings.map(binding => [binding.deliveryId, binding]))
          const bySequence = new Map(bindings.map(binding => [`${binding.sessionId}\u001f${binding.sessionDeliverySeq}`, binding]))
          const ledger = outbox.deliveryLedger(address, correlationId)
          const expectedDeliveryIds = new Set<string>(ledger.map(delivery => delivery.deliveryId))
          const relevantSessionIds = new Set<SessionId>([
            ...manifest.playerBindings.map(binding => binding.sessionId),
            ...ledger.map(delivery => delivery.sessionId),
          ])
          for (const delivery of ledger) {
            const binding = byDelivery.get(delivery.deliveryId)
            const occupied = delivery.sessionDeliverySeq === null
              ? undefined
              : bySequence.get(`${delivery.sessionId}\u001f${delivery.sessionDeliverySeq}`)
            const bindingHash = binding === undefined ? undefined : hashWorldJson('session-delivery-binding', binding)
            const expectedBindingHash = hashWorldJson('session-delivery-binding', {
              sessionId: delivery.sessionId,
              sessionDeliverySeq: delivery.sessionDeliverySeq,
              deliveryId: delivery.deliveryId,
              payloadHash: delivery.payloadHash,
            })
            if ((bindingHash !== undefined && bindingHash !== expectedBindingHash)
              || (occupied !== undefined && occupied.deliveryId !== delivery.deliveryId)
              || (delivery.status === 'delivered' && binding === undefined)) {
              failWorld({
                errorCode: 'SESSION_DELIVERY_DIVERGED', category: 'integrity',
                message: 'World Outbox and Session delivery bindings are divergent', retryable: false,
                correlationId, address,
              })
            }
          }
          if (bindings.some(binding => relevantSessionIds.has(binding.sessionId) && !expectedDeliveryIds.has(binding.deliveryId))) {
            failWorld({
              errorCode: 'SESSION_DELIVERY_DIVERGED', category: 'integrity',
              message: 'Session contains a delivery that is absent from the restored World Outbox', retryable: false,
              correlationId, address,
            })
          }
          return {
            worldVerificationHash: world.verificationHash,
            projectionBundleHash: projection.bundleHash,
            sessionVerificationHash: sessionIntegrity.verificationHash,
            ...(memoryVerificationHash === undefined ? {} : { memoryVerificationHash }),
          }
        } finally {
          session.close()
          outbox.close()
          store.close()
        }
      })
    } finally {
      quarantine.close()
    }
  }
}
