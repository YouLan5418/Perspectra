import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { coreAssetDirectory, coreE5WorkerEntry, coreMemoryRoot, coreWorkerEntry } from './node-paths.ts'

afterEach(() => vi.unstubAllEnvs())

it('resolves source workers from the source root even when the caller was bundled', () => {
  vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', '')
  vi.stubEnv('HCW_HINDSIGHT_ONNX_DIR', '')
  const sourceRoot = 'D:/workspace/project'
  expect(coreMemoryRoot(sourceRoot)).toBe(resolve(sourceRoot, 'packages/memory-core'))
  expect(fileURLToPath(coreWorkerEntry(sourceRoot))).toBe(
    resolve(sourceRoot, 'packages/memory-core/src/node/core-worker.ts'),
  )
  expect(fileURLToPath(coreE5WorkerEntry(sourceRoot))).toBe(
    resolve(sourceRoot, 'packages/memory-core/src/node/e5-worker.ts'),
  )
  expect(coreAssetDirectory(sourceRoot)).toBe(resolve(sourceRoot, '.tmp/hindsight-e5-small'))
})

it('resolves packaged MJS workers and model assets under the runtime root', () => {
  vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', 'D:/game/runtime')
  vi.stubEnv('HCW_HINDSIGHT_ONNX_DIR', '')
  expect(fileURLToPath(coreWorkerEntry())).toBe(resolve('D:/game/runtime', 'memory-core/node/core-worker.mjs'))
  expect(fileURLToPath(coreE5WorkerEntry())).toBe(resolve('D:/game/runtime', 'memory-core/node/e5-worker.mjs'))
  expect(coreAssetDirectory()).toBe(resolve('D:/game/runtime', 'models/e5-small'))
})

it('preserves the existing E5 asset override in both layouts', () => {
  vi.stubEnv('PERSPECTRA_RUNTIME_ROOT', 'D:/game/runtime')
  vi.stubEnv('HCW_HINDSIGHT_ONNX_DIR', 'D:/shared/frozen-e5')
  expect(coreAssetDirectory()).toBe(resolve('D:/shared/frozen-e5'))
})
