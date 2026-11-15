import { Script, createContext } from 'node:vm'
import {
  SCRIPT_SOURCE_LIMIT,
  STATUS_CALL_LIMIT as CALL_LIMIT,
  type StatusTruth,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import type { StatusInstance, StatusSource, SeamProvider } from '@harness-world/plugin-sdk'
import { openStatusModule, type ResolvedStatusModule } from './modules.ts'

class BaseStatusScript {
  readonly #script: Script
  readonly definition: unknown
  readonly hasRoundHook: boolean
  constructor(source: string) {
    if (Buffer.byteLength(source) > SCRIPT_SOURCE_LIMIT) throw new RangeError('状态脚本过长')
    this.#script = new Script(
      source +
        '\nJSON.stringify(__method === "definition" ? statusScript.definition' +
        ' : __method === "hasRoundHook" ? typeof statusScript.onRoundEnd === "function"' +
        ' : __method === "onRoundEnd" && typeof statusScript.onRoundEnd !== "function" ? null' +
        ' : __method === "policy" && typeof statusScript.policy !== "function" ? null' +
        ' : statusScript[__method](...JSON.parse(__args)))',
      { filename: 'scripts/status.js' },
    )
    this.hasRoundHook = this.#call('hasRoundHook', []) === true
    this.definition = this.#call('definition', [])
  }
  initialize(characterIds: readonly string[]) {
    return this.#call('initialize', [characterIds])
  }
  policy(known: WorldJsonObject, actorId: string, place: WorldJsonObject) {
    return this.#call('policy', [known, actorId, place])
  }
  resolve(input: Parameters<StatusInstance['resolve']>[0]) {
    return this.#call('resolve', [
      input.truth,
      input.actorId,
      input.operation,
      input.parameters,
      input.world,
      input.targetId,
      input.external,
    ])
  }
  endRound(truth: StatusTruth, round: number) {
    return this.#call('onRoundEnd', [truth, round])
  }
  #call(
    method: 'definition' | 'hasRoundHook' | 'initialize' | 'resolve' | 'onRoundEnd' | 'policy',
    args: readonly unknown[],
  ): unknown {
    const input = JSON.stringify(args)
    if (Buffer.byteLength(input) > CALL_LIMIT) throw new RangeError('状态脚本输入过长')
    const context = createContext(Object.assign(Object.create(null), { __method: method, __args: input }), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate',
    })
    let output: unknown
    try {
      output = this.#script.runInContext(context, { timeout: 100 })
    } catch (error) {
      throw new TypeError('状态脚本执行失败或超时：' + (error instanceof Error ? error.message : String(error)))
    }
    if (typeof output !== 'string' || Buffer.byteLength(output) > CALL_LIMIT)
      throw new TypeError('状态脚本必须返回有限 JSON')
    return JSON.parse(output)
  }
}

/** 组合包内可选基础状态脚本与脚本／原生状态模块，仅产出待核心校验的候选结果。 */
export class StatusScripts implements StatusInstance {
  readonly #base: BaseStatusScript | undefined
  readonly #modules: readonly ResolvedStatusModule[]
  readonly #unavailable: ReadonlySet<string>
  readonly definition: unknown
  readonly hasRoundHook: boolean
  readonly moduleDefinitions: readonly { id: string; definition: WorldJsonObject }[]
  constructor(source: StatusSource | undefined) {
    this.#modules = (source?.modules ?? []).map(openStatusModule)
    this.moduleDefinitions = this.#modules.map(module => ({
      id: module.id,
      definition: module.definition as unknown as WorldJsonObject,
    }))
    if (source === undefined) {
      this.#base = undefined
      this.#unavailable = new Set()
      this.definition = undefined
      this.hasRoundHook = false
      return
    }
    this.#base = source.script === undefined ? undefined : new BaseStatusScript(source.script)
    this.#unavailable = new Set(
      this.#modules.flatMap(module =>
        module.definition.actions
          .filter(action => module.unavailableCapabilities.includes(String(action.capability)))
          .map(action => module.id + '-' + String(action.id)),
      ),
    )
    if (!this.#modules.length && this.#base) {
      this.hasRoundHook = this.#base.hasRoundHook
      this.definition = this.#base.definition
      return
    }
    const baseDef = this.#base?.definition as
      | { readonly statuses?: readonly WorldJsonObject[]; readonly operations?: readonly WorldJsonObject[] }
      | null
      | undefined
    this.hasRoundHook = this.#base?.hasRoundHook ?? false
    this.definition = {
      statuses: [...(baseDef?.statuses ?? []), ...this.#modules.flatMap(module => module.definition.statuses)],
      operations: [
        ...(baseDef?.operations ?? []),
        ...this.#modules.flatMap(module =>
          module.definition.actions.map(({ capability: _capability, method: _method, ...op }) => ({
            ...op,
            id: module.id + '-' + String(op.id),
          })),
        ),
      ],
    }
  }
  initialize(characterIds: readonly string[]) {
    if (!this.#modules.length && this.#base) return this.#base.initialize(characterIds)
    const out: {
      public: Record<string, WorldJsonValue>
      characters: Record<string, Record<string, WorldJsonValue>>
      reveals: unknown[]
    } = {
      public: {},
      characters: Object.fromEntries(characterIds.map(id => [id, {}])),
      reveals: [],
    }
    const parts: { initialize(ids: readonly string[]): unknown }[] = [
      ...(this.#base ? [this.#base] : []),
      ...this.#modules,
    ]
    for (const part of parts) {
      const initial = part.initialize(characterIds) as {
        readonly public: WorldJsonObject
        readonly characters: Readonly<Record<string, WorldJsonObject>>
        readonly reveals?: readonly unknown[]
      }
      for (const [key, value] of Object.entries(initial.public)) {
        if (key in out.public) throw new TypeError('状态脚本执行失败或超时：Duplicate status')
        out.public[key] = value
      }
      for (const id of characterIds) {
        for (const [key, value] of Object.entries(initial.characters[id] ?? {})) {
          if (key in out.characters[id]!) throw new TypeError('状态脚本执行失败或超时：Duplicate status')
          out.characters[id]![key] = value
        }
      }
      out.reveals.push(...(initial.reveals ?? []))
    }
    return out
  }
  policy(known: WorldJsonObject, actorId: string, place: WorldJsonObject) {
    if (!this.#modules.length && this.#base) return this.#base.policy(known, actorId, place)
    const baseDef = this.#base?.definition as { readonly operations?: readonly WorldJsonObject[] } | null | undefined
    const original = (this.#base?.policy(known, actorId, place) ?? null) as
      | (WorldJsonObject & { readonly operations?: readonly string[] })
      | null
    const operations = [...(original?.operations ?? (baseDef?.operations ?? []).map(op => String(op.id)))]
    for (const module of this.#modules) {
      if (!module.characters.includes(actorId)) continue
      const offered = (module.policy(known, actorId, place) as { readonly operations: readonly string[] }).operations
      for (const id of offered) {
        if (!module.definition.actions.some(action => action.id === id))
          throw new TypeError('状态脚本执行失败或超时：Undeclared module action')
      }
      operations.push(
        ...offered.map(id => module.id + '-' + id).filter(operationId => !this.#unavailable.has(operationId)),
      )
    }
    return { ...original, operations }
  }
  resolve(input: Parameters<StatusInstance['resolve']>[0]) {
    if (!this.#modules.length && this.#base) return this.#base.resolve(input)
    for (const module of this.#modules) {
      for (const action of module.definition.actions) {
        if (input.operation === module.id + '-' + String(action.id)) {
          return module.resolve(
            input.truth,
            input.actorId,
            String(action.id),
            input.parameters,
            input.world,
            input.targetId,
            input.external,
          )
        }
      }
    }
    if (!this.#base) throw new TypeError('状态脚本未声明')
    return this.#base.resolve(input)
  }
  endRound(truth: StatusTruth, round: number) {
    return this.#base ? this.#base.endRound(truth, round) : null
  }
  prepareModule(
    moduleId: string,
    known: WorldJsonObject,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
  ) {
    const module = this.#modules.find(item => item.id === moduleId)
    if (!module) throw new TypeError('Module action unavailable')
    return module.prepare(known, actorId, operation, parameters, world)
  }
}

export const officialStatusProvider: SeamProvider<StatusInstance> = {
  id: 'official-status',
  version: '1.0.0',
  open: async world => new StatusScripts(world.statusSource),
}
