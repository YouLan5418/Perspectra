import { Script, createContext } from 'node:vm'
import type { ActivityState, StatusTruth, WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import type {
  ActivityHooks,
  ActivitySource,
  ActivitySourceEntry,
  ActivityInstance,
  ActivitiesInstance,
  DiceRoll,
  MemoryRequest,
  SeamProvider,
} from '@perspectra/sdk'

const ACTIVITY_CALL_LIMIT = 65536
const SIMULATE_INPUT_LIMIT = 1024 * 1024

function cloneActivityJson<T>(value: T, limit: number, label: string): T {
  if (value instanceof Promise) {
    void value.catch(() => {})
    throw new TypeError(`${label}必须同步返回有限 JSON`)
  }
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new TypeError(`${label}必须返回有限 JSON`, { cause: error })
  }
  if (typeof text !== 'string' || text.length > limit) throw new TypeError(`${label}超出有限 JSON 长度上限`)
  return JSON.parse(text) as T
}

/** The existing author hooks, evaluated synchronously without storage or a host reference. */
export class ActivityScript implements ActivityInstance {
  readonly #script: Script
  readonly key: string
  readonly definition: unknown
  readonly hasAutoStart: boolean
  constructor(source: Extract<ActivitySourceEntry, { readonly source: string }>) {
    this.key = source.key
    this.#script = new Script(
      source.source +
        '\nJSON.stringify(__method === "definition" ? activityScript.definition : __method === "hasResume" ? typeof activityScript.resume === "function" : __method === "hasAutoStart" ? activityScript.autoStart !== undefined : (["simulate","onPublished","resume","autoStart"].includes(__method) && activityScript[__method] === undefined) ? null : activityScript[__method](...JSON.parse(__args)))',
    )
    this.definition = this.#call('definition', [])
    this.hasAutoStart = this.#call('hasAutoStart', []) === true
  }
  hasResume() {
    return this.#call('hasResume', []) === true
  }
  initialize(input: WorldJsonObject, random: () => number) {
    return this.#call('initialize', [input], random)
  }
  policy(scoped: WorldJsonObject, actorId: string) {
    return this.#call('policy', [scoped, actorId])
  }
  resolve(
    state: ActivityState,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    truth: StatusTruth | null,
    roll?: (expression: string) => DiceRoll,
  ) {
    return this.#call('resolve', [state, actorId, operation, parameters, world, truth], undefined, roll)
  }
  published(state: ActivityState, actorId: string, publication: WorldJsonValue | null) {
    return this.#call('onPublished', [state, actorId, publication])
  }
  resume(scoped: WorldJsonObject, world: WorldJsonObject) {
    return this.#call('resume', [scoped, world])
  }
  autoStart(truth: StatusTruth | null, world: WorldJsonObject, previous: WorldJsonObject | null) {
    return this.#call('autoStart', [truth, world, previous])
  }
  simulate(request: MemoryRequest) {
    return this.#call('simulate', [request])
  }
  schedule(state: ActivityState) {
    return this.#call('schedule', [state])
  }
  outcome(result: WorldJsonObject, state: ActivityState) {
    return this.#call('onOutcome', [result, state])
  }
  /** `random` replaces Math.random during initialize; `roll` is the global `rollDice` during resolve. Both are
   * recorded by the core and gone once this call returns, since each call gets a fresh context. */
  #call(
    method: string,
    args: readonly unknown[],
    random?: () => number,
    roll?: (expression: string) => DiceRoll,
  ): unknown {
    const input = JSON.stringify(args)
    // A simulated model receives the role's full authorized context, unlike small game operations.
    // Core history in the official prologue already exceeds 64 KiB; keep this path bounded at 1 MiB.
    const maximumInput = method === 'simulate' ? SIMULATE_INPUT_LIMIT : ACTIVITY_CALL_LIMIT
    if (input.length > maximumInput) throw new RangeError('活动输入过长')
    const context = createContext(
      Object.assign(Object.create(null), {
        __method: method,
        __args: input,
        ...(method === 'initialize' ? { __initialRandom: random } : {}),
        ...(method === 'resolve' && roll ? { rollDice: roll } : {}),
      }),
      { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' },
    )
    let output: unknown
    try {
      if (method === 'initialize') new Script('Math.random = __initialRandom').runInContext(context, { timeout: 100 })
      output = this.#script.runInContext(context, { timeout: 100 })
    } catch {
      throw new TypeError('包内活动脚本执行失败或超时')
    }
    if (typeof output !== 'string' || output.length > ACTIVITY_CALL_LIMIT)
      throw new TypeError('活动脚本必须返回有限 JSON')
    return JSON.parse(output)
  }
}

/** 原生 TypeScript 活动执行封装，保持与脚本活动相同的输入隔离、有限 JSON 输出和调用期受控随机／骰子边界。 */
export class NativeActivity implements ActivityInstance {
  readonly #hooks: ActivityHooks
  readonly key: string
  readonly phases?: readonly string[]
  readonly definition: unknown
  readonly hasAutoStart: boolean
  constructor(entry: Extract<ActivitySourceEntry, { readonly activity: ActivityHooks }>) {
    this.key = entry.key
    if (entry.activity.phases !== undefined) this.phases = [...entry.activity.phases]
    this.#hooks = entry.activity
    this.definition = cloneActivityJson(entry.activity.definition, ACTIVITY_CALL_LIMIT, '原生活动定义')
    this.hasAutoStart = entry.activity.autoStart !== undefined
  }
  hasResume() {
    return typeof this.#hooks.resume === 'function'
  }
  initialize(input: WorldJsonObject, random: () => number) {
    const cloned = this.#cloneInput([input], ACTIVITY_CALL_LIMIT)[0]
    let active = true
    const scopedRandom = () => {
      if (!active) throw new TypeError('活动随机源仅在 initialize 同步调用期间有效')
      return random()
    }
    try {
      return this.#run(() => this.#hooks.initialize(cloned, scopedRandom))
    } finally {
      active = false
    }
  }
  policy(scoped: WorldJsonObject, actorId: string) {
    const [cloned] = this.#cloneInput([scoped], ACTIVITY_CALL_LIMIT)
    return this.#run(() => this.#hooks.policy(cloned, actorId))
  }
  resolve(
    state: ActivityState,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    truth: StatusTruth | null,
    roll?: (expression: string) => DiceRoll,
  ) {
    const [clonedState, clonedParams, clonedWorld, clonedTruth] = this.#cloneInput(
      [state, parameters, world, truth],
      ACTIVITY_CALL_LIMIT,
    )
    let active = true
    const scopedRoll = roll
      ? (expression: string): DiceRoll => {
          if (!active) throw new TypeError('活动掷骰仅在 resolve 同步调用期间有效')
          return cloneActivityJson(roll(expression), ACTIVITY_CALL_LIMIT, '活动骰子结果')
        }
      : undefined
    try {
      return this.#run(() =>
        this.#hooks.resolve(clonedState, actorId, operation, clonedParams, clonedWorld, clonedTruth, scopedRoll),
      )
    } finally {
      active = false
    }
  }
  published(state: ActivityState, actorId: string, publication: WorldJsonValue | null) {
    if (!this.#hooks.onPublished) return null
    const [clonedState, clonedPublication] = this.#cloneInput([state, publication], ACTIVITY_CALL_LIMIT)
    return this.#runNullable(() => this.#hooks.onPublished!(clonedState, actorId, clonedPublication))
  }
  resume(scoped: WorldJsonObject, world: WorldJsonObject) {
    if (!this.#hooks.resume) return null
    const [clonedScoped, clonedWorld] = this.#cloneInput([scoped, world], ACTIVITY_CALL_LIMIT)
    return this.#runNullable(() => this.#hooks.resume!(clonedScoped, clonedWorld))
  }
  autoStart(truth: StatusTruth | null, world: WorldJsonObject, previous: WorldJsonObject | null) {
    if (!this.#hooks.autoStart) return null
    const [clonedTruth, clonedWorld, clonedPrevious] = this.#cloneInput([truth, world, previous], ACTIVITY_CALL_LIMIT)
    return this.#runNullable(() => this.#hooks.autoStart!(clonedTruth, clonedWorld, clonedPrevious))
  }
  simulate(request: MemoryRequest) {
    if (!this.#hooks.simulate) return null
    const [clonedRequest] = this.#cloneInput([request], SIMULATE_INPUT_LIMIT)
    return this.#runNullable(() => this.#hooks.simulate!(clonedRequest))
  }
  schedule(state: ActivityState) {
    const [clonedState] = this.#cloneInput([state], ACTIVITY_CALL_LIMIT)
    return this.#run(() => this.#hooks.schedule(clonedState))
  }
  outcome(result: WorldJsonObject, state: ActivityState) {
    const [clonedResult, clonedState] = this.#cloneInput([result, state], ACTIVITY_CALL_LIMIT)
    return this.#run(() => this.#hooks.onOutcome(clonedResult, clonedState))
  }
  #cloneInput<const T extends readonly unknown[]>(values: T, limit: number): T {
    const text = JSON.stringify(values)
    if (text.length > limit) throw new RangeError('活动输入过长')
    return JSON.parse(text) as T
  }
  #run<T>(call: () => T): T {
    let result: T
    try {
      result = call()
    } catch (error) {
      throw new TypeError('原生活动执行失败：' + (error instanceof Error ? error.message : String(error)), {
        cause: error,
      })
    }
    return cloneActivityJson(result, ACTIVITY_CALL_LIMIT, '原生活动输出')
  }
  #runNullable<T>(call: () => T | null): T | null {
    let result: T | null
    try {
      result = call()
    } catch (error) {
      throw new TypeError('原生活动执行失败：' + (error instanceof Error ? error.message : String(error)), {
        cause: error,
      })
    }
    if (result === null) return null
    return cloneActivityJson(result, ACTIVITY_CALL_LIMIT, '原生活动输出')
  }
}

export function createActivityInstance(entry: ActivitySourceEntry): ActivityInstance {
  return 'activity' in entry ? new NativeActivity(entry) : new ActivityScript(entry)
}

/** Default foreground and automatic-start selection; random draws are supplied and recorded by the core. */
export class ActivitiesScripts implements ActivitiesInstance {
  readonly entries: readonly ActivityInstance[]
  constructor(source: ActivitySource | undefined) {
    this.entries = (source?.entries ?? []).map(createActivityInstance)
  }
  select(
    progress: readonly { readonly key: string; readonly active: boolean }[],
    latestKey: string | undefined,
  ): string | undefined {
    return progress.find(entry => entry.active)?.key ?? latestKey ?? this.entries[0]?.key
  }
  chooseAutoStart(
    candidates: readonly { readonly key: string; readonly conditions: number }[],
    random: () => number,
  ): string | undefined {
    if (!candidates.length) return undefined
    const most = Math.max(...candidates.map(candidate => candidate.conditions)),
      tied = candidates.filter(candidate => candidate.conditions === most)
    return (tied.length === 1 ? tied[0]! : tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]!).key
  }
}
export const officialActivitiesProvider: SeamProvider<ActivitiesInstance> = {
  id: 'official-activities',
  version: '1.0.0',
  open: async world => new ActivitiesScripts(world.activitySource),
}

export { GameplayScript } from './gameplay-script.ts'
