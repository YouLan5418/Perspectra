import type { StatusTruth, WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import type { SeamProvider } from './world.ts'

/** 原生 TypeScript 状态模块钩子；无需经由脚本文本或 node:vm 执行。 */
export interface StatusModuleHooks {
  readonly definition: {
    readonly statuses: readonly WorldJsonObject[]
    readonly actions: readonly WorldJsonObject[]
  }
  initialize(characterIds: readonly string[]): {
    readonly public: WorldJsonObject
    readonly characters: Record<string, WorldJsonObject>
    readonly reveals?: readonly WorldJsonObject[]
  }
  policy(
    known: WorldJsonObject,
    actorId: string,
    place: WorldJsonObject,
  ): {
    readonly operations: readonly string[]
    readonly targets?: Readonly<Record<string, readonly string[]>>
  }
  resolve(
    truth: StatusTruth,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    targetId: string | null,
    external: WorldJsonValue | null,
  ): WorldJsonObject
  prepare?(
    known: WorldJsonObject,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
  ): WorldJsonObject
}

export type StatusModuleSource =
  | {
      readonly id: string
      readonly source: string
      readonly characters: readonly string[]
      readonly unavailableCapabilities: readonly string[]
    }
  | {
      readonly id: string
      readonly module: StatusModuleHooks
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
    readonly truth: StatusTruth
    readonly actorId: string
    readonly operation: string
    readonly parameters: WorldJsonObject
    readonly world: WorldJsonObject
    readonly targetId: string | null
    readonly external: WorldJsonValue | null
  }): unknown
  endRound(truth: StatusTruth, round: number): unknown
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
