import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CORE_MEMORY_ID = 'official-memory-core'

/** Package root in a source checkout or the installed memory-core runtime. */
export function coreMemoryRoot(sourceRoot = resolve('.')): string {
  return process.env.PERSPECTRA_RUNTIME_ROOT
    ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT, 'memory-core')
    : resolve(sourceRoot, 'packages/memory-core')
}

/** Node resolves the TypeScript source directly during development and the MJS entry in a bundle. */
export function coreWorkerEntry(sourceRoot = resolve('.')): URL {
  return process.env.PERSPECTRA_RUNTIME_ROOT
    ? pathToFileURL(join(coreMemoryRoot(), 'node/core-worker.mjs'))
    : pathToFileURL(join(coreMemoryRoot(sourceRoot), 'src/node/core-worker.ts'))
}

/** The encoder has its own thread so native inference cannot block the Core worker. */
export function coreE5WorkerEntry(sourceRoot = resolve('.')): URL {
  return process.env.PERSPECTRA_RUNTIME_ROOT
    ? pathToFileURL(join(coreMemoryRoot(), 'node/e5-worker.mjs'))
    : pathToFileURL(join(coreMemoryRoot(sourceRoot), 'src/node/e5-worker.ts'))
}

/** Existing local E5 assets remain selectable through HCW_HINDSIGHT_ONNX_DIR. */
export function coreAssetDirectory(sourceRoot = resolve('.')): string {
  if (process.env.HCW_HINDSIGHT_ONNX_DIR) return resolve(process.env.HCW_HINDSIGHT_ONNX_DIR)
  return process.env.PERSPECTRA_RUNTIME_ROOT
    ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT, 'models/e5-small')
    : resolve(sourceRoot, '.tmp/hindsight-e5-small')
}

export function assertCoreAssets(directory = coreAssetDirectory()): void {
  const required = [
    'config.json',
    'sentencepiece.bpe.model',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
  ]
  const missing = required.filter(file => !existsSync(join(directory, file)))
  if (missing.length)
    throw new Error(
      `Core 记忆所需的 E5 资产不完整：${join(directory, missing[0]!)}。请准备固定的 E5 资产，或设置 HCW_HINDSIGHT_ONNX_DIR。`,
    )
}
