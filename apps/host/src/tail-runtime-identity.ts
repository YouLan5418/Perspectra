import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corePythonRoot } from './official-bundle.ts'

/** Executable identity only; no Git dependency, credentials or generic replay protocol. */
export function tailRuntimeIdentity(): string {
  const entry = fileURLToPath(import.meta.url),
    hash = createHash('sha256')
  const bundled = !entry.endsWith('.ts')
  const root = bundled ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT ?? '.') : resolve(dirname(entry), '../../..')
  if (bundled) hash.update(readFileSync(entry))
  const walk = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name)
      if (item.isDirectory()) walk(path)
      else if ((item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) || item.name === 'package.json') {
        hash.update(path.slice(root.length)).update(readFileSync(path))
      }
    }
  }
  if (!bundled) {
    walk(join(root, 'packages'))
    for (const name of [
      'apps/host/src/tail-storage.ts',
      'apps/host/src/tail-runtime-identity.ts',
      'apps/host/src/story-nodes.ts',
      'apps/host/src/runtime/tail-runtime.ts',
      'apps/host/src/runtime/world-runtime.ts',
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
      'packages/memory-core/src/core-memory.ts',
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
      'packages/memory-core/src/python-worker.ts',
      'packages/memory-core/src/python-paths.ts',
      'packages/memory-core/src/alias-history.ts',
      'package.json',
      'pnpm-lock.yaml',
    ]) {
      hash.update(name).update(readFileSync(join(root, name)))
    }
  }
  const pythonRoot = corePythonRoot(root)
  for (const directory of [join(pythonRoot, 'bridge'), join(pythonRoot, 'core')]) {
    const walkPython = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.isDirectory() && !['__pycache__', '.venv', 'reports', 'assets', 'tests'].includes(item.name))
          walkPython(join(dir, item.name))
        else if (item.isFile() && item.name.endsWith('.py') && !item.name.startsWith('test_'))
          hash.update(join(dir, item.name).slice(root.length)).update(readFileSync(join(dir, item.name)))
      }
    }
    walkPython(directory)
  }
  return hash.digest('hex')
}
