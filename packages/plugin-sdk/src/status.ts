import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { SeamProvider } from './world.ts'

export interface StatusModuleSource {
  readonly id: string
  readonly source: string
  readonly characters: readonly string[]
  readonly unavailableCapabilities: readonly string[]
}
export interface StatusSource {
  readonly script?: string
  readonly modules: readonly StatusModuleSource[]
}
export interface StatusInstance {
  /** Undefined only when the world has no declared status script or modules. */
  readonly definition: unknown
  readonly hasRoundHook: boolean
  readonly moduleDefinitions: readonly { readonly id: string; readonly definition: WorldJsonObject }[]
  initialize(characterIds: readonly string[]): unknown
  policy(known: WorldJsonObject, actorId: string, place: WorldJsonObject): unknown
  resolve(input: {
    readonly truth: import('@harness-world/contracts').StatusTruth
    readonly actorId: string
    readonly operation: string
    readonly parameters: WorldJsonObject
    readonly world: WorldJsonObject
    readonly targetId: string | null
    readonly external: WorldJsonValue | null
  }): unknown
  endRound(truth: import('@harness-world/contracts').StatusTruth, round: number): unknown
  prepareModule(
    moduleId: string,
    known: WorldJsonObject,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
  ): unknown
  close?(): void | Promise<void>
}

export interface StatusSlotApi {
  register(provider: SeamProvider<StatusInstance>): () => void
  readonly current: SeamProvider<StatusInstance> | undefined
}
