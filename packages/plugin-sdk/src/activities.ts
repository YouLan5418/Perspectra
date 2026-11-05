import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { MemoryRequest } from './memory.ts'
import type { SeamProvider } from './world.ts'

export interface ActivitySource {
  readonly entries: readonly { readonly key: string; readonly entry: string; readonly source: string }[]
}
/** Data computation only. Scoped policy/simulation inputs and trusted adjudication inputs stay distinct. */
export interface ActivityInstance {
  readonly key: string
  readonly definition: unknown
  readonly hasAutoStart: boolean
  hasResume(): boolean
  /** Random draws are recorded by the core and expire when this synchronous call returns. */
  initialize(input: WorldJsonObject, random: () => number): unknown
  /** Participant public state and this actor's private state only; never internal or other private values. */
  policy(scoped: WorldJsonObject, actorId: string): unknown
  resolve(
    state: import('@harness-world/contracts').ActivityState,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    truth: import('@harness-world/contracts').StatusTruth | null,
  ): unknown
  published(
    state: import('@harness-world/contracts').ActivityState,
    actorId: string,
    publication: WorldJsonValue | null,
  ): unknown
  resume(scoped: WorldJsonObject, world: WorldJsonObject): unknown
  autoStart(
    truth: import('@harness-world/contracts').StatusTruth | null,
    world: WorldJsonObject,
    previous: WorldJsonObject | null,
  ): unknown
  simulate(request: MemoryRequest): unknown
  /** Trusted rule input includes internal state. The core validates the proposed participant activation. */
  schedule(state: import('@harness-world/contracts').ActivityState): unknown
  outcome(result: WorldJsonObject, state: import('@harness-world/contracts').ActivityState): unknown
}
export interface ActivitiesInstance {
  readonly entries: readonly ActivityInstance[]
  /** Must keep any committed active foreground and return an installed key or undefined. */
  select(
    progress: readonly { readonly key: string; readonly active: boolean }[],
    latestKey: string | undefined,
  ): string | undefined
  /** Receives only eligible candidates; choose one key. Random expires after this synchronous call. */
  chooseAutoStart(
    candidates: readonly { readonly key: string; readonly conditions: number }[],
    random: () => number,
  ): string | undefined
  close?(): void | Promise<void>
}

export interface ActivitiesSlotApi {
  register(provider: SeamProvider<ActivitiesInstance>): () => void
  readonly current: SeamProvider<ActivitiesInstance> | undefined
}
