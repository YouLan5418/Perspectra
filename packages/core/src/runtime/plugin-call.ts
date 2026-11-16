import type { PluginFault, SeamProvider, WorldServices } from '@perspectra/sdk'
import type { WorldInstanceScope } from './instance-scope.ts'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'

/** Errors thrown by Host callbacks cross plugin frames unchanged; they do not belong to that plugin. */
export class HostCallbackErrors {
  readonly #passedOn = new Set<unknown>()

  mark(error: unknown): void {
    this.#passedOn.add(error)
  }

  has(error: unknown): boolean {
    return this.#passedOn.has(error)
  }
}

export class PluginFaultError extends Error implements PluginFault {
  readonly origin = 'plugin'

  constructor(
    readonly pluginId: string,
    readonly operation: string,
    readonly invalidResult: boolean,
    readonly httpStatus?: number,
  ) {
    super(
      invalidResult
        ? `插件 ${pluginId} 的 ${operation} 返回了无效结果。`
        : `插件 ${pluginId} 的 ${operation} 操作失败。`,
    )
    this.name = 'PluginFault'
  }
}

export interface PluginCallContext {
  readonly scope: WorldInstanceScope
  readonly callbacks: HostCallbackErrors
  readonly diagnostics: PluginFaultError[]
}

export function createPluginCallContext(
  scope: WorldInstanceScope,
  callbacks: HostCallbackErrors = new HostCallbackErrors(),
): PluginCallContext {
  return { scope, callbacks, diagnostics: [] }
}

export function invalidPluginResult(context: PluginCallContext, pluginId: string, operation: string): PluginFaultError {
  return new PluginFaultError(pluginId, operation, true)
}

export function requirePluginObject<T>(context: PluginCallContext, pluginId: string, operation: string, value: T): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    throw invalidPluginResult(context, pluginId, operation)
  return value
}

export function isPluginFault(error: unknown): error is PluginFaultError {
  return error instanceof PluginFaultError
}

export function publicPluginFailure(error: unknown): string | undefined {
  if (!isPluginFault(error)) return undefined
  return error.httpStatus === undefined ? error.message : `${error.message}（HTTP ${error.httpStatus}）`
}

function safeHttpStatus(error: unknown): number | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return undefined
  let value: unknown
  try {
    value = Reflect.get(error, 'httpStatus')
  } catch {
    return undefined
  }
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function pluginFailure(
  context: PluginCallContext,
  pluginId: string,
  operation: string,
  error: unknown,
  invalidResult: boolean,
  signal?: AbortSignal,
): unknown {
  if (context.callbacks.has(error)) return error
  if (
    (signal?.aborted && error === signal.reason) ||
    (context.scope.signal.aborted && error === context.scope.signal.reason)
  )
    return error
  const fault = isPluginFault(error)
    ? error
    : new PluginFaultError(pluginId, operation, invalidResult, safeHttpStatus(error))
  if (!context.diagnostics.includes(fault)) {
    context.diagnostics.push(fault)
    console.error(`[插件 ${fault.pluginId}] ${fault.message}`)
  }
  return fault
}

export function callPluginSync<T>(context: PluginCallContext, pluginId: string, operation: string, work: () => T): T {
  context.scope.assertActive()
  try {
    return work()
  } catch (error) {
    throw pluginFailure(context, pluginId, operation, error, false)
  }
}

export async function callPluginOpen<T>(
  context: PluginCallContext,
  binding: string,
  pluginId: string,
  provider: SeamProvider<T>,
  services: WorldServices,
  signal: AbortSignal | undefined,
): Promise<T> {
  context.scope.assertActive(signal)
  return context.scope.open(
    binding,
    {
      ...provider,
      open: async (world, operationSignal) => {
        try {
          return await provider.open(world, operationSignal)
        } catch (error) {
          throw pluginFailure(context, pluginId, 'open', error, false, operationSignal)
        }
      },
    },
    services,
    signal,
  )
}

export async function callPluginAsync<T>(
  context: PluginCallContext,
  pluginId: string,
  operation: string,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => T | PromiseLike<T>,
): Promise<T> {
  context.scope.assertActive(signal)
  let observedCoreFailure = false
  let coreFailure: unknown
  try {
    return await context.scope.invoke(async operationSignal => {
      try {
        return await work(operationSignal)
      } catch (error) {
        if (context.callbacks.has(error)) {
          observedCoreFailure = true
          coreFailure = error
        }
        throw pluginFailure(context, pluginId, operation, error, false, operationSignal)
      }
    }, signal)
  } catch (error) {
    if (
      (signal?.aborted && error === signal.reason) ||
      (context.scope.signal.aborted && error === context.scope.signal.reason)
    ) {
      // Drain already-settled callbacks, without awaiting a provider that ignores cancellation.
      await nextEventLoopTurn()
      if (observedCoreFailure) throw coreFailure
    }
    throw error
  }
}

export function clonePluginValue<T>(context: PluginCallContext, pluginId: string, operation: string, value: T): T {
  try {
    return structuredClone(value)
  } catch {
    throw new PluginFaultError(pluginId, operation, true)
  }
}

export function callPluginForValue<T>(
  context: PluginCallContext,
  pluginId: string,
  operation: string,
  work: () => T,
): T {
  const value = callPluginSync(context, pluginId, operation, work)
  return clonePluginValue(context, pluginId, operation, value)
}

export async function callPluginForValueAsync<T>(
  context: PluginCallContext,
  pluginId: string,
  operation: string,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => T | PromiseLike<T>,
): Promise<T> {
  const value = await callPluginAsync(context, pluginId, operation, signal, work)
  return clonePluginValue(context, pluginId, operation, value)
}

export function hostCallback<T>(callbacks: HostCallbackErrors, work: () => T): T {
  try {
    return work()
  } catch (error) {
    callbacks.mark(error)
    throw error
  }
}

export async function hostCallbackAsync<T>(
  context: PluginCallContext,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => T | PromiseLike<T>,
): Promise<T> {
  return context.scope.invoke(async operationSignal => {
    try {
      return await work(operationSignal)
    } catch (error) {
      if (!operationSignal.aborted || error !== operationSignal.reason) context.callbacks.mark(error)
      throw error
    }
  }, signal)
}

export function hostCapability<A extends unknown[], R>(
  context: PluginCallContext,
  callback: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    context.scope.signal.throwIfAborted()
    context.scope.assertActive()
    return hostCallback(context.callbacks, () => callback(...args))
  }
}

export function hostCapabilityAsync<A extends unknown[], R>(
  context: PluginCallContext,
  signal: AbortSignal | undefined,
  callback: (...args: A) => PromiseLike<R>,
): (...args: A) => Promise<R> {
  return (...args) => hostCallbackAsync(context, signal, () => callback(...args))
}
