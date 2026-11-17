/** Core CPU and request worker. Only the model-specific config crosses into this thread. */
import { parentPort, workerData } from 'node:worker_threads'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { createCoreRuntime, type CoreRuntimeConfig } from './runtime.ts'

if (!parentPort) throw new Error('Core worker requires a parent thread')
const port = parentPort,
  runtime = createCoreRuntime((workerData as { runtimeConfig: CoreRuntimeConfig }).runtimeConfig),
  controllers = new Map<number, AbortController>()
let running = false,
  closing = false

port.on('message', async (message: unknown) => {
  if (message === null || typeof message !== 'object') return
  const request = message as { type?: string; id?: number; input?: WorldJsonObject }
  if (request.type === 'abort' && Number.isSafeInteger(request.id)) {
    controllers.get(request.id!)?.abort(new Error('Core request cancelled'))
    return
  }
  if (request.type === 'close') {
    if (closing) return
    closing = true
    for (const controller of controllers.values()) controller.abort(new Error('Core worker closed'))
    await runtime.close()
    port.postMessage({ type: 'closed' })
    port.close()
    return
  }
  if (request.type !== 'run' || !Number.isSafeInteger(request.id) || !request.input) return
  const id = request.id!
  if (closing || running) {
    port.postMessage({ type: 'result', id, error: { message: 'Core 记忆 worker 正忙或已关闭。' } })
    return
  }
  running = true
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    const result = await runtime.run(request.input, controller.signal)
    if (!controller.signal.aborted) port.postMessage({ type: 'result', id, result })
  } catch (error) {
    if (!controller.signal.aborted)
      port.postMessage({
        type: 'result',
        id,
        error: { message: error instanceof Error ? error.message : 'Core 记忆处理失败。' },
      })
  } finally {
    controllers.delete(id)
    running = false
  }
})
