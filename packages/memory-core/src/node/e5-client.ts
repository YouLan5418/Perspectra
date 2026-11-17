import { Worker } from 'node:worker_threads'
/** Isolated CPU work; abort terminates the thread/native session. Caller creates another client to retry. */
export function createE5Worker(directory: string, entry = new URL('./e5-worker.ts', import.meta.url)) {
  let worker: Worker | undefined
  let closed = false
  let pending: { reject: (error: Error) => void; cleanup: () => void } | undefined
  const close = async () => {
    closed = true
    pending?.cleanup()
    pending?.reject(new Error('E5 worker closed'))
    pending = undefined
    await worker?.terminate()
  }
  return {
    encode(
      texts: readonly string[],
      query: boolean,
      signal: AbortSignal,
    ): Promise<{ tokens: number[][]; vectors: number[][] }> {
      if (closed || signal.aborted) return Promise.reject(new Error('E5 request cancelled'))
      if (pending) return Promise.reject(new Error('E5 worker is busy'))
      worker ??= new Worker(entry, {
        workerData: { directory },
        env: {},
        execArgv: entry.pathname.endsWith('.ts') ? ['--experimental-transform-types'] : [],
      })
      const active = worker
      return new Promise((resolve, reject) => {
        const abort = () => {
          void close()
        }
        const cleanup = () => {
          signal.removeEventListener('abort', abort)
          active.off('message', message)
          active.off('error', failure)
          active.off('exit', exit)
          clearTimeout(timer)
        }
        const failure = () => {
          cleanup()
          pending = undefined
          closed = true
          void active.terminate()
          reject(new Error('Local E5 worker failed'))
        }
        const exit = () => failure()
        const message = (reply: { error?: string; result?: { tokens: number[][]; vectors: number[][] } }) => {
          cleanup()
          pending = undefined
          if (reply.error || !reply.result) reject(new Error('Local E5 request failed'))
          else resolve(reply.result)
        }
        const timer = setTimeout(abort, 120_000)
        pending = { reject, cleanup }
        active.once('message', message)
        active.once('error', failure)
        active.once('exit', exit)
        signal.addEventListener('abort', abort, { once: true })
        active.postMessage({ texts, query })
      })
    },
    close,
  }
}
