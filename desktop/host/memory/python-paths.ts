import { resolve } from 'node:path'

/** Bundling does not imply installation: a built backend can still run from a source checkout. */
export function corePythonRoot(sourceRoot = resolve('.')): string {
  return process.env.PERSPECTRA_RUNTIME_ROOT
    ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT, 'memory-core/python')
    : resolve(sourceRoot, 'desktop/host/memory/python')
}
