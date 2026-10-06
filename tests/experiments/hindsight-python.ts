import { execFile, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'

export type CoreRunner = (input: WorldJsonObject, signal: AbortSignal) => Promise<WorldJsonObject>

export function hindsightPython(): string {
  return process.env.HCW_HINDSIGHT_PYTHON ?? resolve('.tmp/hindsight-vector-venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

/** Experimental JSON bridge. Evidence goes through stdin, never command arguments. */
export function coreRunner(environment: NodeJS.ProcessEnv = {}): CoreRunner {
  return (input, signal) => new Promise((resolveResult, reject) => {
    const child = execFile(hindsightPython(), [resolve('experiments/activity-memory/core_bridge.py')], {
      signal, timeout: input.operation === 'build' ? 600_000 : 120_000, maxBuffer: 128 * 1024 * 1024,
      windowsHide: true, encoding: 'utf8',
      env: { ...process.env, ...environment, PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0' },
    }, (error, stdout) => {
      if (error) { reject(new Error('实验记忆处理失败；请检查本机 Python、E5 资产和模型接口。', { cause: error })); return }
      try { resolveResult(JSON.parse(stdout) as WorldJsonObject) } catch (cause) {
        reject(new Error('实验记忆返回了无效 JSON。', { cause }))
      }
    })
    child.stdin!.on('error', () => { /* execFile reports cancellation/exit through its callback. */ })
    child.stdin!.end(JSON.stringify(input))
  })
}

/** One lazy Python process per web session. Only the encoder is reused; every request supplies its own scope. */
export function createCoreWorker(environment: NodeJS.ProcessEnv = {}, command?: {
  readonly executable: string; readonly args: readonly string[]
}) {
  let child: import('node:child_process').ChildProcessWithoutNullStreams | undefined
  let exited: Promise<void> = Promise.resolve()
  let closed = false
  let output = ''
  let pending: { resolve: (result: WorldJsonObject) => void; reject: (error: Error) => void; cleanup: () => void } | undefined
  const failure = () => new Error('实验记忆处理失败；请检查本机 Python、E5 资产和模型接口。')
  const stop = () => { child?.kill() }
  const start = () => {
    const worker = spawn(command?.executable ?? hindsightPython(),
      [...(command?.args ?? [resolve('experiments/activity-memory/core_bridge.py'), '--serve'])], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...environment, PYTHONIOENCODING: 'utf-8', PYTHONHASHSEED: '0' },
      })
    child = worker; output = ''
    worker.stdout.setEncoding('utf8')
    // Drain library warnings. Private request text and credentials never enter an exposed error message.
    worker.stderr.resume()
    worker.stdout.on('data', (chunk: string) => {
      output += chunk
      if (Buffer.byteLength(output) > 128 * 1024 * 1024) { stop(); return }
      const newline = output.indexOf('\n')
      if (newline === -1) return
      const line = output.slice(0, newline); output = output.slice(newline + 1)
      const request = pending
      if (!request) { stop(); return }
      pending = undefined; request.cleanup()
      try {
        const reply = JSON.parse(line) as { result?: WorldJsonObject; error?: boolean }
        if (reply.error || reply.result === null || typeof reply.result !== 'object' || Array.isArray(reply.result)) {
          request.reject(failure()); return
        }
        request.resolve(reply.result)
      } catch {
        request.reject(new Error('实验记忆返回了无效 JSON。')); stop()
      }
    })
    worker.on('error', stop)
    worker.stdin.on('error', stop)
    exited = new Promise<void>(done => worker.once('close', () => {
      if (child === worker) { child = undefined; output = '' }
      const request = pending; pending = undefined
      if (request) { request.cleanup(); request.reject(failure()) }
      done()
    }))
    return worker
  }
  const run: CoreRunner = (input, signal) => {
    if (closed) return Promise.reject(new Error('实验记忆会话已关闭。'))
    if (signal.aborted) return Promise.reject(signal.reason)
    if (pending) return Promise.reject(new Error('请等待当前记忆处理完成。'))
    const worker = child ?? start()
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(stop, input.operation === 'build' ? 600_000 : 120_000)
      signal.addEventListener('abort', stop, { once: true })
      pending = { resolve: resolveResult, reject, cleanup: () => {
        clearTimeout(timer); signal.removeEventListener('abort', stop)
      } }
      worker.stdin.write(JSON.stringify(input) + '\n')
    })
  }
  return { run, close: async () => { closed = true; stop(); await exited } }
}
