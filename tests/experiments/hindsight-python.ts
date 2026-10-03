import { execFile } from 'node:child_process'
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
