import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { SCRIPT_SOURCE_LIMIT } from '@harness-world/contracts'
import type { StatusSource, StatusModuleSource } from '@harness-world/plugin-sdk'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

/** Validate locked assets before handing text to the selected script mechanism. */
export function loadStatusSource(
  packPath: string,
  pack: CompiledWorldPackV5,
  modules?: readonly StatusModuleSource[],
): StatusSource | undefined {
  const entry = 'scripts/status.js',
    lock = pack.assets.find(asset => asset.path === entry)
  // An explicitly declared empty module bundle still has the existing empty-state initialization.
  if (!lock) return modules === undefined ? undefined : { modules }
  const file = resolve(packPath, entry)
  if (!lstatSync(file).isFile() || relative(realpathSync(packPath), realpathSync(file)) !== entry.split('/').join(sep))
    throw new TypeError('状态脚本必须位于包内')
  const bytes = readFileSync(file)
  if (
    bytes.length > SCRIPT_SOURCE_LIMIT ||
    bytes.length !== lock.size ||
    'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash
  )
    throw new TypeError('状态脚本与已编译的包不一致')
  return { script: bytes.toString('utf8'), modules: modules ?? [] }
}
