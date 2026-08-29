import {
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  deterministicId,
  failWorld,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
  type TransactionId,
} from '@harness-world/contracts'
import {
  RoundInbox,
  WorldStore,
  WriterLeaseService,
  type ClaimedRound,
  type WriterLease,
} from '@harness-world/store-sqlite'
import { parsePlayerActionInput, type PlayerActionInput } from './rulebook.ts'
import { createCoreRulebookRegistry, type RulebookRegistry, type RulebookResolver } from './rulebook-registry.ts'
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
  readonly runtimeLane: RoundExecutionLane
  readonly ownerId: string
  readonly leaseTtlMs?: number
  readonly rulebooks?: RulebookRegistry
}

/** Minimal execution capability required by the authoritative Kernel. */
export interface RoundExecutionLane {
  readonly address: WorldAddress
  readonly manifestHash: WorldHash
  enqueueRound<T>(work: () => Promise<T>): Promise<T>
}

/** Revalidate the durable idempotency result before exposing it to a caller. */
export function parsePlayerRoundResult(value: WorldJsonValue): PlayerRoundResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('completed Round result must be an object')
  const result = value as Record<string, WorldJsonValue>
  const keys = Object.keys(result).sort(compareWorldText)
  if (keys.join(',') !== 'bundleHash,headSeq,reason,status,tick') throw new TypeError('completed Round result has an invalid shape')
  if (result.status !== 'accepted' && result.status !== 'rejected') throw new TypeError('completed Round status is invalid')
  if (result.reason !== null && typeof result.reason !== 'string') throw new TypeError('completed Round reason is invalid')
  if (!Number.isSafeInteger(result.headSeq) || (result.headSeq as number) < 0) throw new TypeError('completed Round headSeq is invalid')
  if (!Number.isSafeInteger(result.tick) || (result.tick as number) < 0) throw new TypeError('completed Round tick is invalid')
  if (typeof result.bundleHash !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(result.bundleHash)) {
    throw new TypeError('completed Round bundleHash is invalid')
  }
  return result as unknown as PlayerRoundResult
}

/** Single-branch authoritative player-input pipeline; it has no Agent or model dependency. */
export class WorldKernel {
  readonly #manifest: CompiledWorldManifest
  readonly #address: WorldAddress
  readonly #rulebook: RulebookResolver
  #lease: WriterLease
  #closed = false

  constructor(private readonly options: WorldKernelOptions) {
    const stored = options.store.readManifest(options.runtimeLane.address)
    if (stored === undefined || stored.manifestHash !== options.runtimeLane.manifestHash) {
      failWorld({
        errorCode: 'MANIFEST_RUNTIME_UNAVAILABLE',
        category: 'integrity',
        message: 'runtime slot manifest is not active in WorldStore',
        retryable: false,
        correlationId: `kernel:${worldAddressKey(options.runtimeLane.address)}`,
      })
    }
    this.#manifest = stored.manifest as CompiledWorldManifest
    this.#address = options.runtimeLane.address
    this.#rulebook = (options.rulebooks ?? createCoreRulebookRegistry()).resolve(
      this.#manifest.rulebook.rulebookId,
      this.#manifest.rulebook.version,
      `kernel:${worldAddressKey(this.#address)}`,
      this.#address,
    )
    this.#lease = options.leases.acquire(this.#address, options.ownerId, options.leaseTtlMs)
  }

  submitPlayerInput(request: SubmitPlayerInputRequest): Promise<PlayerRoundResult> {
    if (this.#closed) return Promise.reject(new Error('WorldKernel is closed'))
    this.#validateSubmission(request)
    const binding = this.#manifest.playerBindings.find(value => value.principalId === request.principalId)
    if (binding === undefined) {
      failWorld({
        errorCode: 'UNAUTHORIZED',
        category: 'admission',
        message: 'principal has no PlayerBinding in this world',
        retryable: false,
        correlationId: request.correlationId,
        address: this.#address,
      })
    }
    const queued = this.options.inbox.enqueue({
      address: this.#address,
      idempotencyKey: request.idempotencyKey,
      principalId: request.principalId,
      input: request.action,
      correlationId: request.correlationId,
    }, this.#manifest.roundQueueLimit)
    return this.options.runtimeLane.enqueueRound(async () => {
      const completed = this.options.inbox.readCompleted(this.#address, request.idempotencyKey)
      if (completed !== undefined) return parsePlayerRoundResult(completed)
      return this.#drainUntil(queued.inboxSeq, request.correlationId)
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.options.leases.release(this.#address, this.options.ownerId, this.#lease.fencingToken)
  }

  async #drainUntil(targetSeq: number, correlationId: string): Promise<PlayerRoundResult> {
    while (true) {
      this.#lease = this.options.leases.acquire(this.#address, this.options.ownerId, this.options.leaseTtlMs)
      const claimed = this.options.inbox.claimNext(this.#address, this.options.ownerId, this.#lease.fencingToken)
      if (claimed === undefined) throw new Error(`Round Inbox lost admitted item ${targetSeq}`)
      const committed = await this.#commitClaimed(claimed, correlationId)
      this.options.inbox.complete(
        this.#address,
        claimed.inboxSeq,
        this.options.ownerId,
        this.#lease.fencingToken,
        { transactionId: committed.transactionId, bundleHash: committed.result.bundleHash },
        committed.result,
      )
      if (claimed.inboxSeq === targetSeq) return committed.result
    }
  }

  async #commitClaimed(
    claimed: ClaimedRound,
    correlationId: string,
  ): Promise<{ readonly transactionId: TransactionId; readonly result: PlayerRoundResult }> {
    const binding = this.#manifest.playerBindings.find(value => value.principalId === claimed.principalId)
    if (binding === undefined) throw new Error('admitted Round lost its PlayerBinding')
    const action = parsePlayerActionInput(claimed.input)
    const identity = {
      address: this.#address,
      inboxSeq: claimed.inboxSeq,
      idempotencyKey: claimed.idempotencyKey,
      inputHash: claimed.inputHash,
    }
    const transactionId = brandId(deterministicId('transaction:player-round', identity), 'TransactionId')
    const roundId = brandId(deterministicId('round:player', identity), 'InteractionRoundId')
    const deliveryId = brandId(deterministicId('delivery:player-round', identity), 'DeliveryId')
    const frozenBase = this.options.store.roundBase(transactionId)
    const head = frozenBase === undefined
      ? this.options.store.head(this.#address)
      : { headSeq: frozenBase.headSeq, tick: frozenBase.tick }
    const history = this.options.store.readEvents(this.#address, head.headSeq)
    const resolution = this.#rulebook.resolve({ manifest: this.#manifest, events: history, characterId: binding.characterId, action })
    const committed = await this.options.store.commitRound({
      address: this.#address,
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
      admissionProof: { inboxSeq: claimed.inboxSeq, inputHash: claimed.inputHash },
      writerFencingToken: this.#lease.fencingToken,
    })
    return {
      transactionId,
      result: {
        status: resolution.status,
        reason: resolution.reason ?? null,
        headSeq: committed.headSeq,
        tick: committed.tick,
        bundleHash: committed.bundleHash,
      },
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
      if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
      assertProtocolString(value, name)
    }
    const actionKeys = Object.keys(request.action).sort(compareWorldText)
    if (actionKeys.length !== 2 || actionKeys[0] !== 'actionType' || actionKeys[1] !== 'parameters') {
      throw new TypeError('action must contain exactly actionType and parameters')
    }
  }

}
