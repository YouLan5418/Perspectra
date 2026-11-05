import type { WorldJsonObject } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

export interface AutonomySource {
  readonly config: unknown
  readonly characterIds: readonly string[]
  readonly locationIds: readonly string[]
  readonly targetIds: readonly string[]
  readonly definitionIds: readonly string[]
}
/** Accepted player transactions only, with operation identities resolved by the host. No private contexts. */
export interface AutonomyAction {
  readonly transactionId: string
  readonly seq: number
  readonly pause: boolean
  readonly actionType?: string
  readonly definitionId?: string
  readonly activityKey?: string
  readonly operation?: string
}
export interface AutonomyInstance {
  readonly roles: readonly import('@harness-world/contracts').AutonomousRole[]
  readonly instruction: string
  due(input: { readonly actions: readonly AutonomyAction[]; readonly afterSeq: number }): readonly string[]
  permits(input: {
    readonly characterId: string
    readonly locationId: string | null
    readonly actionType: string
    readonly parameters: WorldJsonObject
  }): boolean
  close?(): void | Promise<void>
}
export interface AutonomySlotApi {
  register(provider: SeamProvider<AutonomyInstance>): () => void
  readonly current: SeamProvider<AutonomyInstance> | undefined
}
