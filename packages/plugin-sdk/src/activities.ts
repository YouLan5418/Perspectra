import type { ActivityState, StatusTruth, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type { MemoryRequest } from './memory.ts'
import type { DiceRoll } from './dice.ts'
import type { SeamProvider } from './world.ts'

/** 原生 TypeScript 活动定义与钩子；受控随机源与骰子由核心按调用作用域注入。 */
export interface ActivityHooks {
  readonly definition: WorldJsonObject
  /** 持久状态中允许出现的阶段名列表，读档数据兼容校验按此核对。 */
  readonly phases?: readonly string[]
  initialize(input: WorldJsonObject, random: () => number): WorldJsonObject
  policy(scoped: WorldJsonObject, actorId: string): WorldJsonObject
  resolve(
    state: ActivityState,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    truth: StatusTruth | null,
    roll?: (expression: string) => DiceRoll,
  ): WorldJsonObject
  onPublished?(state: ActivityState, actorId: string, publication: WorldJsonValue | null): WorldJsonObject | null
  resume?(scoped: WorldJsonObject, world: WorldJsonObject): WorldJsonObject | null
  autoStart?(
    truth: StatusTruth | null,
    world: WorldJsonObject,
    previous: WorldJsonObject | null,
  ): WorldJsonObject | null
  simulate?(request: MemoryRequest): WorldJsonObject | null
  schedule(state: ActivityState): WorldJsonObject
  onOutcome(result: WorldJsonObject, state: ActivityState): WorldJsonObject
}

export type ActivitySourceEntry =
  | { readonly key: string; readonly entry: string; readonly source: string }
  | { readonly key: string; readonly activity: ActivityHooks }

export interface ActivitySource {
  readonly entries: readonly ActivitySourceEntry[]
}
/** Data computation only. Scoped policy/simulation inputs and trusted adjudication inputs stay distinct. */
export interface ActivityInstance {
  readonly key: string
  readonly phases?: readonly string[]
  readonly definition: unknown
  readonly hasAutoStart: boolean
  hasResume(): boolean
  /** Random draws are recorded by the core and expire when this synchronous call returns. */
  initialize(input: WorldJsonObject, random: () => number): unknown
  /** Participant public state and this actor's private state only; never internal or other private values. */
  policy(scoped: WorldJsonObject, actorId: string): unknown
  /** `roll` draws from the core's round record through `ctx.dice` and expires when this synchronous call returns;
   * an invalid expression throws a TypeError and nothing commits. */
  resolve(
    state: ActivityState,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    truth: StatusTruth | null,
    roll?: (expression: string) => DiceRoll,
  ): unknown
  published(state: ActivityState, actorId: string, publication: WorldJsonValue | null): unknown
  resume(scoped: WorldJsonObject, world: WorldJsonObject): unknown
  autoStart(truth: StatusTruth | null, world: WorldJsonObject, previous: WorldJsonObject | null): unknown
  simulate(request: MemoryRequest): unknown
  /** Trusted rule input includes internal state. The core validates the proposed participant activation. */
  schedule(state: ActivityState): unknown
  outcome(result: WorldJsonObject, state: ActivityState): unknown
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
