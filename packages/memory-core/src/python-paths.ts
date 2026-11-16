import { resolve } from 'node:path'

/** Bundling does not imply installation: a built backend can still run from a source checkout. */
export function corePythonRoot(sourceRoot = resolve('.')): string {
  return process.env.PERSPECTRA_RUNTIME_ROOT
    ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT, 'memory-core/python')
    : resolve(sourceRoot, 'packages/memory-core/python')
}

export const CORE_MEMORY_ID = 'official-memory-core'

export function corePythonExecutable(): string {
  return (
    process.env.HCW_HINDSIGHT_PYTHON ??
    resolve('.tmp/hindsight-vector-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  )
}
