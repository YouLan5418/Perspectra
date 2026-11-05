import { Script, createContext } from 'node:vm'
import type { ActivityState, StatusTruth, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import type {
  ActivitySource,
  ActivityInstance,
  ActivitiesInstance,
  MemoryRequest,
  SeamProvider,
} from '@harness-world/plugin-sdk'

/** The existing author hooks, evaluated synchronously without storage or a host reference. */
export class ActivityScript implements ActivityInstance {
  readonly #script: Script
  readonly key: string
  readonly definition: unknown
  readonly hasAutoStart: boolean
  constructor(source: ActivitySource['entries'][number]) {
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
  ) {
    return this.#call('resolve', [state, actorId, operation, parameters, world, truth])
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
  #call(method: string, args: readonly unknown[], random?: () => number): unknown {
    const input = JSON.stringify(args)
    // A simulated model receives the role's full authorized context, unlike small game operations.
    // Core history in the official prologue already exceeds 64 KiB; keep this path bounded at 1 MiB.
    const maximumInput = method === 'simulate' ? 1024 * 1024 : 65536
    if (input.length > maximumInput) throw new RangeError('活动输入过长')
    const context = createContext(
      Object.assign(Object.create(null), {
        __method: method,
        __args: input,
        ...(method === 'initialize' ? { __initialRandom: random } : {}),
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
    if (typeof output !== 'string' || output.length > 65536) throw new TypeError('活动脚本必须返回有限 JSON')
    return JSON.parse(output)
  }
}

/** Default foreground and automatic-start selection; random draws are supplied and recorded by the core. */
export class ActivitiesScripts implements ActivitiesInstance {
  readonly entries: readonly ActivityScript[]
  constructor(source: ActivitySource | undefined) {
    this.entries = (source?.entries ?? []).map(entry => new ActivityScript(entry))
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
