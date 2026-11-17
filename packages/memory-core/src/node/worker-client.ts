import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { assertCoreAssets, coreAssetDirectory, coreE5WorkerEntry, coreWorkerEntry } from '../node-paths.ts'
import type { CoreRuntimeConfig } from './runtime.ts'
import type { MemoryModel } from './utility.ts'

export type CoreRunner = (input: WorldJsonObject, signal: AbortSignal) => Promise<WorldJsonObject>

export interface MemoryRunners {
  readonly recall: CoreRunner
  readonly build: CoreRunner
  readonly close?: () => Promise<void>
}

export interface CoreWorkerOptions {
  readonly entry?: URL | string
  readonly buildTimeoutMs?: number
  readonly recallTimeoutMs?: number
  readonly closeGraceMs?: number
}

type WorkerReply = {
  type?: string
  id?: number
  result?: WorldJsonObject
  error?: { message?: string }
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError(`Invalid ${name}`)
  return timeout
}

function workerExecArgv(entry: URL | string): string[] {
  const location = entry instanceof URL ? entry.pathname : entry
  return /\.tsx?$/.test(location) ? ['--experimental-transform-types'] : []
}

function runtimeConfig(environment: NodeJS.ProcessEnv = {}): CoreRuntimeConfig {
  const protocol = environment.HCW_MODEL_PROTOCOL ?? 'openai',
    endpoint = environment.HCW_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8045/v1/chat/completions',
    model = environment.HCW_LOCAL_MODEL ?? 'gemini-3.7-flash',
    apiKey = environment.HCW_LOCAL_API_KEY,
    modelConfig: MemoryModel = {
      protocol,
      endpoint,
      model,
      ...(apiKey ? { apiKey } : {}),
    },
    assetDirectory = environment.HCW_HINDSIGHT_ONNX_DIR
      ? resolve(environment.HCW_HINDSIGHT_ONNX_DIR)
      : coreAssetDirectory(),
    attemptsPath = environment.HCW_HINDSIGHT_UTILITY_ATTEMPTS
  return {
    model: modelConfig,
    assetDirectory,
    e5WorkerEntry: String(coreE5WorkerEntry()),
    ...(attemptsPath ? { utilityAttemptsFile: resolve(attemptsPath) } : {}),
  }
}

/** Checks only the local frozen E5 files. No interpreter or subprocess is involved. */
export function assertCoreEnvironment(): void {
  assertCoreAssets(coreAssetDirectory())
}

/** One request per worker thread. Builds get their own thread and release it on completion. */
export function coreRunner(environment: NodeJS.ProcessEnv = {}, options: CoreWorkerOptions = {}): CoreRunner {
  return async (input, signal) => {
    const worker = createCoreWorker(environment, options)
    try {
      return await worker.run(input, signal)
    } finally {
      await worker.close()
    }
  }
}

/** A lazy, reusable Core thread for recalls; every request carries its own authorized snapshot. */
export function createCoreWorker(environment: NodeJS.ProcessEnv = {}, options: CoreWorkerOptions = {}) {
  const config = runtimeConfig(environment),
    entry = options.entry ?? coreWorkerEntry(),
    buildTimeoutMs = positiveTimeout(options.buildTimeoutMs, 600_000, 'build timeout'),
    recallTimeoutMs = positiveTimeout(options.recallTimeoutMs, 120_000, 'recall timeout'),
    closeGraceMs = positiveTimeout(options.closeGraceMs, 400, 'close grace')
  let worker: Worker | undefined,
    pending:
      | {
          id: number
          resolve: (value: WorldJsonObject) => void
          reject: (error: Error) => void
          cleanup: () => void
        }
      | undefined,
    nextId = 0,
    closed = false,
    stopping: Promise<void> | undefined,
    closeAck: (() => void) | undefined

  const failPending = (error: Error) => {
    const request = pending
    if (!request) return
    pending = undefined
    request.cleanup()
    request.reject(error)
  }

  const stopWorker = (graceful: boolean): Promise<void> => {
    if (stopping) return stopping
    const current = worker
    worker = undefined
    if (!current) return Promise.resolve()
    stopping = (async () => {
      if (graceful) {
        const acknowledged = new Promise<void>(resolveAck => {
          closeAck = resolveAck
        })
        let graceTimer: NodeJS.Timeout | undefined
        try {
          current.postMessage({ type: 'close' })
          await Promise.race([
            acknowledged,
            new Promise<void>(resolveTimeout => {
              graceTimer = setTimeout(resolveTimeout, closeGraceMs)
            }),
          ])
        } catch {
          // Termination below is authoritative if the worker cannot close itself.
        } finally {
          if (graceTimer) clearTimeout(graceTimer)
          closeAck = undefined
        }
      }
      await current.terminate()
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }

  const startWorker = (): Worker => {
    const current = new Worker(entry, {
      workerData: { runtimeConfig: config },
      env: {},
      execArgv: workerExecArgv(entry),
    })
    worker = current
    current.on('message', (value: unknown) => {
      if (value !== null && typeof value === 'object' && (value as WorkerReply).type === 'closed') {
        closeAck?.()
        return
      }
      const reply = value as WorkerReply,
        request = pending
      if (!request || reply?.type !== 'result' || reply.id !== request.id) return
      pending = undefined
      request.cleanup()
      if (reply.error) request.reject(new Error(reply.error.message || 'Core 记忆处理失败。'))
      else if (reply.result !== null && typeof reply.result === 'object' && !Array.isArray(reply.result))
        request.resolve(reply.result)
      else {
        request.reject(new Error('Core 记忆返回了无效 JSON。'))
        void stopWorker(false)
      }
    })
    current.on('error', () => {
      failPending(new Error('Core 记忆 worker 失败。'))
      void stopWorker(false)
    })
    current.on('exit', code => {
      if (worker === current) worker = undefined
      if (pending) failPending(new Error(`Core 记忆 worker 意外退出（${code}）。`))
    })
    return current
  }

  const run: CoreRunner = async (input, signal) => {
    if (closed) throw new Error('Core 记忆会话已关闭。')
    if (signal.aborted) throw abortError('Core 记忆处理已取消。')
    if (pending) throw new Error('请等待当前记忆处理完成。')
    if (stopping) await stopping
    if (closed) throw new Error('Core 记忆会话已关闭。')
    if (signal.aborted) throw abortError('Core 记忆处理已取消。')
    if (pending) throw new Error('请等待当前记忆处理完成。')
    const current = worker ?? startWorker(),
      id = ++nextId,
      timeout = input.operation === 'build' ? buildTimeoutMs : recallTimeoutMs
    return new Promise<WorldJsonObject>((resolveResult, rejectResult) => {
      const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        },
        terminate = (error: Error) => {
          if (pending?.id !== id) return
          failPending(error)
          try {
            current.postMessage({ type: 'abort', id })
          } catch {
            // The worker is already exiting.
          }
          void stopWorker(true)
        },
        abort = () => terminate(abortError('Core 记忆处理已取消。')),
        timer = setTimeout(() => terminate(new Error('Core 记忆处理超时。')), timeout)
      pending = { id, resolve: resolveResult, reject: rejectResult, cleanup }
      signal.addEventListener('abort', abort, { once: true })
      try {
        current.postMessage({ type: 'run', id, input })
      } catch {
        terminate(new Error('Core 记忆请求发送失败。'))
      }
    })
  }

  return {
    run,
    async close(): Promise<void> {
      if (closed) {
        if (stopping) await stopping
        return
      }
      closed = true
      failPending(new Error('Core 记忆会话已关闭。'))
      await stopWorker(true)
    },
  }
}

/** One runner group per memory model; each worker receives only that model's credentials. */
export function coreRunnerGroups(
  dataDirectory: string,
  start: (environment: NodeJS.ProcessEnv) => MemoryRunners = environment => {
    const worker = createCoreWorker(environment)
    return { recall: worker.run, build: coreRunner(environment), close: worker.close }
  },
) {
  const groups = new Map<string, MemoryRunners>()
  let closed = false,
    closing: Promise<void> | undefined
  return {
    runnersFor(target: MemoryModel): MemoryRunners {
      if (closed) throw new Error('Core memory runner groups are closed')
      const key = JSON.stringify([target.protocol, target.endpoint, target.model, target.apiKey ?? ''])
      let runners = groups.get(key)
      if (runners === undefined) {
        runners = start({
          HCW_LOCAL_MODEL: target.model,
          HCW_LOCAL_ENDPOINT: target.endpoint,
          HCW_MODEL_PROTOCOL: target.protocol,
          HCW_LOCAL_API_KEY: target.apiKey ?? '',
          HCW_HINDSIGHT_UTILITY_ATTEMPTS: resolve(dataDirectory, 'memory-core', 'utility-attempts.jsonl'),
        })
        groups.set(key, runners)
      }
      return runners
    },
    async close(): Promise<void> {
      if (closing) return closing
      closed = true
      closing = Promise.all([...groups.values()].map(runners => runners.close?.())).then(() => undefined)
      await closing
    },
  }
}
