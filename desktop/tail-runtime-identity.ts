import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Executable identity only; no Git dependency, credentials or generic replay protocol. */
export function tailRuntimeIdentity(): string {
  const entry = fileURLToPath(import.meta.url), hash = createHash('sha256')
  const bundled = !entry.endsWith('.ts')
  const root = bundled ? resolve('.') : resolve(dirname(entry),'..')
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
      'tests/experiments/playtest-tail-runtime.ts','tests/experiments/playtest-frozen-runtime.ts',
      'tests/experiments/playtest-memory-core.ts','tests/experiments/playtest-tuning.ts',
      'tests/experiments/pack-activity.ts','tests/experiments/pack-activities.ts','tests/experiments/pack-variables.ts',
      'tests/experiments/local-prototype-turn-call.ts','tests/experiments/hindsight-python.ts','package.json','pnpm-lock.yaml']) {
      hash.update(name).update(readFileSync(join(root,name)))
    }
  }
  for (const directory of ['experiments/activity-memory','experiments/hindsight-core']) {
    const walkPython = (dir: string): void => {
      for (const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (item.isDirectory() && !['__pycache__','.venv','reports','assets','tests'].includes(item.name)) walkPython(join(dir,item.name))
        else if (item.isFile() && item.name.endsWith('.py') && !item.name.startsWith('test_')) hash.update(join(dir,item.name).slice(root.length)).update(readFileSync(join(dir,item.name)))
      }
    }
    walkPython(join(root,directory))
  }
  return hash.digest('hex')
}
