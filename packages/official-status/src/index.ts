import { Script, createContext } from 'node:vm'
import {
  SCRIPT_SOURCE_LIMIT,
  STATUS_CALL_LIMIT as CALL_LIMIT,
  type StatusTruth,
  type WorldJsonObject,
} from '@harness-world/contracts'
import type { StatusInstance, StatusSource, SeamProvider } from '@harness-world/plugin-sdk'
import { callModule, composeStatusSource } from './modules.ts'

/** World-local interpreter of existing status and packPlugin scripts, returning candidates only. */
export class StatusScripts implements StatusInstance {
  readonly #script: Script | undefined
  readonly #modules: NonNullable<StatusSource['modules']>
  readonly definition: unknown
  readonly hasRoundHook: boolean
  readonly moduleDefinitions: readonly { id: string; definition: WorldJsonObject }[]
  constructor(source: StatusSource | undefined) {
    this.#modules = source?.modules ?? []
    this.moduleDefinitions = this.#modules.map(module => ({
      id: module.id,
      definition: callModule(module.source, 'definition', []) as WorldJsonObject,
    }))
    if (source === undefined) {
      this.definition = undefined
      this.hasRoundHook = false
      return
    }
    const unavailable = this.#modules.flatMap(module => {
      const definition = this.moduleDefinitions.find(row => row.id === module.id)!.definition
      return (definition.actions as readonly WorldJsonObject[])
        .filter(action => module.unavailableCapabilities.includes(String(action.capability)))
        .map(action => module.id + '-' + action.id)
    })
    const script =
      this.#modules.length || source.script === undefined
        ? composeStatusSource(source.script, this.#modules, unavailable)
        : source.script
    if (script === undefined) throw new TypeError('状态脚本未声明')
    if (Buffer.byteLength(script) > SCRIPT_SOURCE_LIMIT) throw new RangeError('状态脚本过长')
    this.#script = new Script(
      script +
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
  prepareModule(
    moduleId: string,
    known: WorldJsonObject,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
  ) {
    const source = this.#modules.find(module => module.id === moduleId)
    if (!source) throw new TypeError('Module action unavailable')
    return callModule(source.source, 'prepare', [known, actorId, operation, parameters, world])
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
      if (!this.#script) throw new TypeError('状态脚本未声明')
      output = this.#script.runInContext(context, { timeout: 100 })
    } catch (error) {
      throw new TypeError('状态脚本执行失败或超时：' + (error instanceof Error ? error.message : String(error)))
    }
    if (typeof output !== 'string' || Buffer.byteLength(output) > CALL_LIMIT)
      throw new TypeError('状态脚本必须返回有限 JSON')
    return JSON.parse(output)
  }
}

export const officialStatusProvider: SeamProvider<StatusInstance> = {
  id: 'official-status',
  version: '1.0.0',
  open: async world => new StatusScripts(world.statusSource),
}
