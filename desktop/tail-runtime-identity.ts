import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corePythonRoot } from './host/memory/python-paths.ts'

/** Executable identity only; no Git dependency, credentials or generic replay protocol. */
export function tailRuntimeIdentity(): string {
  const entry = fileURLToPath(import.meta.url), hash = createHash('sha256')
  const bundled = !entry.endsWith('.ts')
  const root = bundled ? resolve(process.env.PERSPECTRA_RUNTIME_ROOT ?? '.') : resolve(dirname(entry),'..')
  if (bundled) hash.update(readFileSync(entry))
  const walk = (directory: string): void => {
    for (const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = join(directory,item.name)
      if (item.isDirectory()) walk(path)
      else if ((item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) || item.name === 'package.json') {
        hash.update(path.slice(root.length)).update(readFileSync(path))
      }
    }
  }
  if (!bundled) {
    walk(join(root,'packages'))
    for (const name of ['desktop/tail-storage.ts','desktop/tail-runtime-identity.ts','desktop/story-nodes.ts',
      'desktop/host/tail-runtime.ts','desktop/host/world-runtime.ts','desktop/host/decision-format.ts','desktop/host/frontend-adapter.ts',
      'desktop/host/memory/core-memory.ts','desktop/host/runtime-tuning.ts',
      'desktop/host/pack-activity.ts','desktop/host/pack-activities.ts','desktop/host/pack-status.ts',
      'desktop/host/pack-autonomy.ts','desktop/play-settings.ts',
      'desktop/host/pack-knowledge.ts','desktop/host/pack-json-asset.ts',
      'desktop/host/gateway-turn-call.ts','desktop/host/memory/python-worker.ts','desktop/host/memory/python-paths.ts','desktop/host/memory/alias-history.ts','package.json','pnpm-lock.yaml']) {
      hash.update(name).update(readFileSync(join(root,name)))
    }
  }
  const pythonRoot = corePythonRoot(root)
  for (const directory of [join(pythonRoot, 'bridge'), join(pythonRoot, 'core')]) {
    const walkPython = (dir: string): void => {
      for (const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (item.isDirectory() && !['__pycache__','.venv','reports','assets','tests'].includes(item.name)) walkPython(join(dir,item.name))
        else if (item.isFile() && item.name.endsWith('.py') && !item.name.startsWith('test_')) hash.update(join(dir,item.name).slice(root.length)).update(readFileSync(join(dir,item.name)))
      }
    }
    walkPython(directory)
  }
  return hash.digest('hex')
}
