import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coreMemoryRoot } from './official-bundle.ts'

/** Executable identity only; no Git dependency, credentials or generic replay protocol. */
export function tailRuntimeIdentity(): string {
  const entry = fileURLToPath(import.meta.url),
    hash = createHash('sha256')
  const bundled = !entry.endsWith('.ts')
  const root = bundled ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT ?? '.') : resolve(dirname(entry), '../../..')
  const add = (name: string, path: string) =>
    hash.update(name.replaceAll('\\', '/')).update('\0').update(readFileSync(path))
  const hashTree = (directory: string, label: string, include: (path: string) => boolean) => {
    const base = realpathSync(directory)
    const visit = (folder: string): void => {
      for (const item of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const path = join(folder, item.name)
        if (item.isDirectory()) visit(path)
        else if (item.isFile() && include(path)) add(join(label, relative(base, path)), path)
      }
    }
    visit(base)
  }
  const packageRoot = (name: string, from: ReturnType<typeof createRequire>): string => {
    let folder = dirname(realpathSync(from.resolve(name)))
    for (;;) {
      try {
        if (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).name === name) return realpathSync(folder)
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
          throw error
      }
      const parent = dirname(folder)
      if (parent === folder) throw new Error(`Cannot locate runtime dependency: ${name}`)
      folder = parent
    }
  }

  if (bundled) add('apps/host/runtime-entry.mjs', entry)
  if (!bundled) {
    const packages = join(root, 'packages')
    const visit = (directory: string): void => {
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const path = join(directory, item.name)
        if (item.isDirectory()) visit(path)
        else if ((item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) || item.name === 'package.json')
          add(relative(root, path), path)
      }
    }
    visit(packages)
    for (const name of [
      'apps/host/src/tail-storage.ts',
      'apps/host/src/tail-runtime-identity.ts',
      'apps/host/src/story-nodes.ts',
      'apps/host/src/runtime/tail-runtime.ts',
      'apps/host/src/runtime/world-runtime.ts',
      'apps/host/src/runtime/world-events.ts',
      'apps/host/src/runtime/notice-registration.ts',
      'apps/host/src/runtime/notice-board.ts',
      'apps/host/src/runtime/notice-commission.ts',
      'apps/host/src/runtime/pack-time.ts',
      'apps/host/src/world-event-registry.ts',
      'apps/host/src/runtime/decision-format.ts',
      'apps/host/src/runtime/character-decision.ts',
      'apps/host/src/runtime/world-adapters.ts',
      'apps/host/src/runtime/world-cast.ts',
      'apps/host/src/official-bundle.ts',
      'apps/host/src/runtime/autonomy-round.ts',
      'apps/host/src/runtime/activity-round.ts',
      'apps/host/src/runtime/player-input.ts',
      'apps/host/src/runtime/rule-layers.ts',
      'apps/host/src/runtime/frontend-adapter.ts',
      'apps/host/src/runtime/runtime-tuning.ts',
      'apps/host/src/runtime/activity-runtime.ts',
      'apps/host/src/runtime/activity-service.ts',
      'apps/host/src/runtime/activities-runtime.ts',
      'apps/host/src/runtime/activity-source.ts',
      'apps/host/src/runtime/status-runtime.ts',
      'apps/host/src/runtime/status-source.ts',
      'apps/host/src/runtime/pack-modules.ts',
      'apps/host/src/runtime/autonomy-runtime.ts',
      'apps/host/src/runtime/communication-runtime.ts',
      'apps/host/src/runtime/gameplay-source.ts',
      'apps/host/src/runtime/gameplay-services.ts',
      'apps/host/src/play-settings.ts',
      'apps/host/src/runtime/knowledge-source.ts',
      'apps/host/src/runtime/pack-json-asset.ts',
      'packages/providers/src/llm/gateway-turn-call.ts',
      'packages/providers/src/llm/role-providers.ts',
      'packages/memory-core/src/alias-history.ts',
      'package.json',
      'pnpm-lock.yaml',
    ])
      add(name, join(root, name))
  }

  const memoryRoot = process.env.PERSPECTRA_RUNTIME_ROOT
    ? coreMemoryRoot(root)
    : bundled && existsSync(join(root, 'memory-core/node/core-worker.mjs'))
      ? join(root, 'memory-core')
      : coreMemoryRoot(root)
  const runtimeWorker = join(memoryRoot, 'node/core-worker.mjs')
  const usesRuntimeWorker = existsSync(runtimeWorker)
  const workerEntry = usesRuntimeWorker ? runtimeWorker : join(memoryRoot, 'src/node/core-worker.ts')
  if (!existsSync(workerEntry)) throw new Error('Node Core worker is missing: ' + workerEntry)
  if (usesRuntimeWorker)
    hashTree(
      join(memoryRoot, 'node'),
      'runtime/memory-core/node',
      path => path.endsWith('.mjs') || path.endsWith('.json'),
    )

  const requireFromWorker = createRequire(workerEntry)
  const dependencies = usesRuntimeWorker
    ? ['onnxruntime-node', 'onnxruntime-common']
    : ['@huggingface/tokenizers', 'onnxruntime-node', 'onnxruntime-common']
  for (const name of dependencies) {
    const dependencyRoot = packageRoot(name, requireFromWorker)
    hashTree(dependencyRoot, `node_modules/${name}`, path => {
      const file = relative(dependencyRoot, path).replaceAll('\\', '/')
      if (file === 'package.json') return true
      if (file.startsWith('dist/') && /\.(?:[cm]?js|json)$/u.test(file)) return true
      // E5 explicitly uses CPU. Other platforms and optional GPU libraries cannot
      // execute in this worker; hashing them on every story operation stalls hosts.
      const nativePrefix = `bin/napi-v6/${process.platform}/${process.arch}/`
      if (name !== 'onnxruntime-node' || !file.startsWith(nativePrefix)) return false
      const nativeFile = file.slice(nativePrefix.length)
      return (
        nativeFile === 'onnxruntime_binding.node' ||
        nativeFile === 'onnxruntime.dll' ||
        /^libonnxruntime\.(?:so(?:\.\d+)*|[\d.]+dylib)$/u.test(nativeFile)
      )
    })
  }

  return hash.digest('hex')
}
