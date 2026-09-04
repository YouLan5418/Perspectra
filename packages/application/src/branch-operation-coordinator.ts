import { failWorld, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import {
  BranchAdministration,
  WorldStore,
  type BranchControlState,
} from '@harness-world/store-sqlite'

export interface AcceptedRoundDrainPort {
  drainAccepted(correlationId: string): Promise<number>
  close(): void | Promise<void>
}

export interface CriticalDeliveryDrainPort {
  drainCritical(correlationId: string): Promise<number>
}

export interface ForkAtHeadRequest {
  readonly parent: WorldAddress
  readonly child: WorldAddress
  readonly reason: string
  readonly correlationId: string
}

export interface ForkAtHeadResult extends WorldJsonObject {
  readonly forkSeq: number
  readonly drainedRounds: number
  readonly parentState: BranchControlState
}

export interface ArchiveBranchRequest {
  readonly address: WorldAddress
  readonly reason: string
  readonly correlationId: string
}

export interface ArchiveBranchResult extends WorldJsonObject {
  readonly drainedRounds: number
  readonly drainedDeliveries: number
  readonly state: BranchControlState
}

/** Owns the close-gate, drain, barrier recheck, and administrative mutation sequence. */
export class BranchOperationCoordinator {
  constructor(
    private readonly store: WorldStore,
    private readonly administration: BranchAdministration,
    private readonly rounds: AcceptedRoundDrainPort,
    private readonly deliveries: CriticalDeliveryDrainPort,
  ) {}

  async forkAtHead(request: ForkAtHeadRequest): Promise<ForkAtHeadResult> {
    this.#assertNoOpenCycle(request.parent, request.correlationId)
    this.administration.setAdmission(request.parent, 'draining', request.reason, `${request.correlationId}:drain`)
    const drainedRounds = await this.rounds.drainAccepted(`${request.correlationId}:rounds`)
    const forkSeq = this.store.head(request.parent).headSeq
    try {
      this.store.forkDrainedBranch(request.parent, request.child, forkSeq)
    } catch (error: unknown) {
      try {
        this.administration.setAdmission(
          request.parent,
          'open',
          `${request.reason}:fork-compensated`,
          `${request.correlationId}:compensate-reopen`,
        )
      } catch (compensationError: unknown) {
        throw new AggregateError([error, compensationError], 'fork failed and parent admission could not be reopened')
      }
      throw error
    }
    const parentState = this.administration.setAdmission(
      request.parent,
      'open',
      `${request.reason}:fork-complete`,
      `${request.correlationId}:reopen`,
    )
    return { forkSeq, drainedRounds, parentState }
  }

  async archive(request: ArchiveBranchRequest): Promise<ArchiveBranchResult> {
    this.#assertNoOpenCycle(request.address, request.correlationId)
    this.administration.setAdmission(request.address, 'draining', request.reason, `${request.correlationId}:drain`)
    const drainedRounds = await this.rounds.drainAccepted(`${request.correlationId}:rounds`)
    const drainedDeliveries = await this.deliveries.drainCritical(`${request.correlationId}:outbox`)
    await this.rounds.close()
    const state = this.administration.archive(request.address, request.reason, `${request.correlationId}:archive`)
    return { drainedRounds, drainedDeliveries, state }
  }

  #assertNoOpenCycle(address: WorldAddress, correlationId: string): void {
    if (this.store.openReactionCycleId(address) !== undefined) {
      failWorld({
        errorCode: 'BRANCH_DRAINING', category: 'admin', retryable: true,
        message: 'administrative operation must wait for the open Reaction Cycle', correlationId, address,
      })
    }
  }
}
