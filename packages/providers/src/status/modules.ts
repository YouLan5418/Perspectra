import { Script, createContext } from 'node:vm'
import {
  STATUS_CALL_LIMIT,
  type StatusTruth,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@perspectra/sdk/contracts'
import type { StatusModuleHooks, StatusModuleSource } from '@perspectra/sdk'

/** Adapter for the existing synchronous packPlugin hooks. No native capability is visible in this VM. */
export function callModule(source: string, method: string, args: readonly WorldJsonValue[]): unknown {
  const context = createContext(
    { __method: method, __args: JSON.stringify(args) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' },
  )
  const output: unknown = new Script(
    source +
      '\nJSON.stringify(__method === "definition" ? packPlugin.definition : packPlugin[__method](...JSON.parse(__args)))',
  ).runInContext(context, { timeout: 100 })
  if (typeof output !== 'string' || output.length > 65536) throw new TypeError('Pack module must return bounded JSON')
  return JSON.parse(output)
}

function cloneBoundedJson<T>(value: T, label: string): T {
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
  if (typeof text !== 'string' || Buffer.byteLength(text) > STATUS_CALL_LIMIT)
    throw new TypeError(`${label}必须返回有限 JSON`)
  return JSON.parse(text) as T
}

function callNativeHook<T>(hooks: StatusModuleHooks, run: (target: StatusModuleHooks) => T): T {
  let result: T
  try {
    result = run(hooks)
  } catch (error) {
    throw new TypeError('原生状态模块执行失败：' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    })
  }
  return cloneBoundedJson(result, '原生状态模块')
}

export interface ResolvedStatusModule {
  readonly id: string
  readonly characters: readonly string[]
  readonly unavailableCapabilities: readonly string[]
  readonly definition: {
    readonly statuses: readonly WorldJsonObject[]
    readonly actions: readonly WorldJsonObject[]
  }
  initialize(characterIds: readonly string[]): WorldJsonObject
  policy(known: WorldJsonObject, actorId: string, place: WorldJsonObject): WorldJsonObject
  resolve(
    truth: StatusTruth,
    actorId: string,
    actionId: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
    targetId: string | null,
    external: WorldJsonValue | null,
  ): WorldJsonObject
  prepare(
    known: WorldJsonObject,
    actorId: string,
    operation: string,
    parameters: WorldJsonObject,
    world: WorldJsonObject,
  ): unknown
}

/** 将脚本状态模块与原生 TypeScript 状态模块统一为同一内存调用边界。 */
export function openStatusModule(entry: StatusModuleSource): ResolvedStatusModule {
  if ('source' in entry) {
    const definition = callModule(entry.source, 'definition', []) as {
      readonly statuses: readonly WorldJsonObject[]
      readonly actions: readonly WorldJsonObject[]
    }
    return {
      id: entry.id,
      characters: [...entry.characters],
      unavailableCapabilities: [...entry.unavailableCapabilities],
      definition,
      initialize: characterIds => callModule(entry.source, 'initialize', [[...characterIds]]) as WorldJsonObject,
      policy: (known, actorId, place) => callModule(entry.source, 'policy', [known, actorId, place]) as WorldJsonObject,
      resolve: (truth, actorId, actionId, parameters, world, targetId, external) =>
        callModule(entry.source, 'resolve', [
          truth as unknown as WorldJsonObject,
          actorId,
          actionId,
          parameters,
          world,
          targetId,
          external,
        ]) as WorldJsonObject,
      prepare: (known, actorId, operation, parameters, world) =>
        callModule(entry.source, 'prepare', [known, actorId, operation, parameters, world]),
    }
  }
  const hooks = entry.module
  const definition = cloneBoundedJson(hooks.definition, '原生状态模块定义')
  return {
    id: entry.id,
    characters: [...entry.characters],
    unavailableCapabilities: [...entry.unavailableCapabilities],
    definition,
    initialize: characterIds => {
      const ids = cloneBoundedJson([...characterIds], '原生状态模块输入')
      return callNativeHook(hooks, target => target.initialize(ids)) as WorldJsonObject
    },
    policy: (known, actorId, place) => {
      const [clonedKnown, clonedPlace] = cloneBoundedJson([known, place] as const, '原生状态模块输入')
      return callNativeHook(hooks, target => target.policy(clonedKnown, actorId, clonedPlace)) as WorldJsonObject
    },
    resolve: (truth, actorId, actionId, parameters, world, targetId, external) => {
      const [clonedTruth, clonedParams, clonedWorld, clonedExternal] = cloneBoundedJson(
        [truth, parameters, world, external] as const,
        '原生状态模块输入',
      )
      return callNativeHook(hooks, target =>
        target.resolve(clonedTruth, actorId, actionId, clonedParams, clonedWorld, targetId, clonedExternal),
      )
    },
    prepare: (known, actorId, operation, parameters, world) => {
      if (typeof hooks.prepare !== 'function') throw new TypeError('Module prepare hook unavailable')
      const [clonedKnown, clonedParams, clonedWorld] = cloneBoundedJson(
        [known, parameters, world] as const,
        '原生状态模块输入',
      )
      return callNativeHook(hooks, target =>
        target.prepare!(clonedKnown, actorId, operation, clonedParams, clonedWorld),
      )
    },
  }
}
