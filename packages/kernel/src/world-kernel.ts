import {
  brandId,
  canonicalizeWorldJson,
  deterministicId,
  failWorld,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { BranchRuntimeSlot } from '@harness-world/runtime-cordis'
import {
  RoundInbox,
  WorldStore,
  WriterLeaseService,
  type ClaimedRound,
  type WriterLease,
} from '@harness-world/store-sqlite'
import { SpeakMoveRulebook, type PlayerActionInput } from './rulebook.ts'
import type { CompiledWorldManifest } from './world-spec.ts'

export interface SubmitPlayerInputRequest {
  readonly idempotencyKey: string
  readonly principalId: string
  readonly action: PlayerActionInput
  readonly correlationId: string
}

export interface PlayerRoundResult extends WorldJsonObject {
  readonly status: 'accepted' | 'rejected'
  readonly reason: string | null
  readonly headSeq: number
  readonly tick: number
  readonly bundleHash: WorldHash
}

export interface WorldKernelOptions {
  readonly store: WorldStore
  readonly inbox: RoundInbox
  readonly leases: WriterLeaseService
  readonly runtimeSlot: BranchRuntimeSlot
  readonly ownerId: string
  readonly leaseTtlMs?: number
}

/** Single-branch authoritative player-input pipeline; it has no Agent or model dependency. */
export class WorldKernel {
  readonly #manifest: CompiledWorldManifest
  readonly #rulebook = new SpeakMoveRulebook()
  #lease: WriterLease
  #closed = false

  constructor(private readonly options: WorldKernelOptions) {
    const stored = options.store.readManifest(options.runtimeSlot.address)
    if (stored === undefined || stored.manifestHash !== options.runtimeSlot.manifestHash) {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE',
        category: 'integrity',
        message: 'runtime slot manifest is not active in WorldStore',
        retryable: false,
        correlationId: `kernel:${options.runtimeSlot.addressKey}`,
      })
    }
    this.#manifest = stored.manifest as CompiledWorldManifest
    this.#lease = options.leases.acquire(this.#manifest.address, options.ownerId, options.leaseTtlMs)
  }

  submitPlayerInput(request: SubmitPlayerInputRequest): Promise<PlayerRoundResult> {
    if (this.#closed) return Promise.reject(new Error('WorldKernel is closed'))
    this.#validateSubmission(request)
    this.options.store.assertAdmissionOpen(this.#manifest.address, request.correlationId)
    const binding = this.#manifest.playerBindings.find(value => value.principalId === request.principalId)
    if (binding === undefined) {
      failWorld({
        errorCode: 'UNAUTHORIZED',
        category: 'admission',
        message: 'principal has no PlayerBinding in this world',
        retryable: false,
        correlationId: request.correlationId,
        address: this.#manifest.address,
      })
    }
    const queued = this.options.inbox.enqueue({
      address: this.#manifest.address,
      idempotencyKey: request.idempotencyKey,
      principalId: request.principalId,
      input: request.action,
      correlationId: request.correlationId,
    }, this.#manifest.roundQueueLimit)
    return this.options.runtimeSlot.enqueueRound(async () => {
      const completed = this.options.inbox.readCompleted(this.#manifest.address, request.idempotencyKey)
      if (completed !== undefined) return completed as PlayerRoundResult
      return this.#drainUntil(queued.inboxSeq, request.correlationId)
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.options.leases.release(this.#manifest.address, this.options.ownerId, this.#lease.fencingToken)
  }

  async #drainUntil(targetSeq: number, correlationId: string): Promise<PlayerRoundResult> {
    while (true) {
      this.#lease = this.options.leases.acquire(this.#manifest.address, this.options.ownerId, this.options.leaseTtlMs)
      const claimed = this.options.inbox.claimNext(this.#manifest.address, this.options.ownerId, this.#lease.fencingToken)
      if (claimed === undefined) throw new Error(`Round Inbox lost admitted item ${targetSeq}`)
      const result = await this.#commitClaimed(claimed, correlationId)
      this.options.inbox.complete(
        this.#manifest.address,
        claimed.inboxSeq,
        this.options.ownerId,
        this.#lease.fencingToken,
        result,
      )
      if (claimed.inboxSeq === targetSeq) return result
    }
  }

  async #commitClaimed(claimed: ClaimedRound, correlationId: string): Promise<PlayerRoundResult> {
    const binding = this.#manifest.playerBindings.find(value => value.principalId === claimed.principalId)
    if (binding === undefined) throw new Error('admitted Round lost its PlayerBinding')
    const action = claimed.input as PlayerActionInput
    const identity = {
      address: this.#manifest.address,
      inboxSeq: claimed.inboxSeq,
      idempotencyKey: claimed.idempotencyKey,
      inputHash: claimed.inputHash,
    }
    const transactionId = brandId(deterministicId('transaction:player-round', identity), 'TransactionId')
    const roundId = brandId(deterministicId('round:player', identity), 'InteractionRoundId')
    const deliveryId = brandId(deterministicId('delivery:player-round', identity), 'DeliveryId')
    const frozenBase = this.options.store.roundBase(transactionId)
    const head = frozenBase === undefined
      ? this.options.store.head(this.#manifest.address)
      : { headSeq: frozenBase.headSeq, tick: frozenBase.tick }
    const history = this.options.store.readEvents(this.#manifest.address, head.headSeq)
    const resolution = this.#rulebook.resolve(this.#manifest, history, binding.characterId, action)
    const committed = await this.options.store.commitRound({
      address: this.#manifest.address,
      transactionId,
      roundId,
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events: resolution.events,
      outbox: [{
        deliveryId,
        sessionId: binding.sessionId,
        payload: {
          observationType: 'player-action-result',
          characterId: binding.characterId,
          actionType: action.actionType,
          status: resolution.status,
          reason: resolution.reason ?? null,
        },
        critical: true,
      }],
      correlationId,
      writerFencingToken: this.#lease.fencingToken,
    })
    return {
      status: resolution.status,
      reason: resolution.reason ?? null,
      headSeq: committed.headSeq,
      tick: committed.tick,
      bundleHash: committed.bundleHash,
    }
  }

  #validateSubmission(request: SubmitPlayerInputRequest): void {
    canonicalizeWorldJson(request.action)
    for (const [name, value] of [
      ['idempotencyKey', request.idempotencyKey],
      ['principalId', request.principalId],
      ['correlationId', request.correlationId],
      ['action.actionType', request.action.actionType],
    ] as const) {
      if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new TypeError(`${name} must be a non-empty, unpadded string`)
      }
    }
    const actionKeys = Object.keys(request.action).sort()
    if (actionKeys.length !== 2 || actionKeys[0] !== 'actionType' || actionKeys[1] !== 'parameters') {
      throw new TypeError('action must contain exactly actionType and parameters')
    }
  }

}
