import type { WorldAddress } from '@harness-world/contracts'
import type { BranchRuntimeLease } from '@harness-world/runtime-cordis'
import type { RoundCoordinator } from './round-coordinator.ts'
import type {
  BranchAgentComponent,
  BranchPresentationComponent,
  BranchStoreComponent,
  WorldApplicationOptions,
} from './world-application.ts'

/** The components one mounted branch exposes to the application. */
export interface MountedBranch {
  readonly lease: BranchRuntimeLease
  readonly kernel: RoundCoordinator
  readonly store: BranchStoreComponent
  readonly agents: BranchAgentComponent
  readonly director: BranchPresentationComponent
}

/**
 * What WorldApplication lends its read and administration surfaces: branch mounting and the guards that
 * quarantine a branch on an integrity failure. They never mount or release a branch on their own terms.
 */
export interface WorldBranchAccess {
  readonly options: WorldApplicationOptions
  assertOpen(): void
  branch(address: WorldAddress): Promise<MountedBranch>
  release(address: WorldAddress): Promise<void>
  integrityGuard<T>(
    address: WorldAddress,
    source: string,
    operation: (branch: MountedBranch) => T | Promise<T>,
  ): Promise<T>
  projectionRead<T>(address: WorldAddress, correlationId: string, operation: () => T): T
}
