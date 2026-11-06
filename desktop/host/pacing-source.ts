import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { SCRIPT_SOURCE_LIMIT } from '@harness-world/contracts'
import type { PacingSource } from '@harness-world/plugin-sdk'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

/** Validate the locked asset before handing its text to the selected mechanism. */
export function loadPacingSource(packPath: string, pack: CompiledWorldPackV5): PacingSource | undefined {
  const entry = 'scripts/pacing.js',
    lock = pack.assets.find(asset => asset.path === entry)
  if (!lock) return undefined
  const file = resolve(packPath, entry)
  if (!lstatSync(file).isFile() || relative(realpathSync(packPath), realpathSync(file)) !== entry.split('/').join(sep))
    throw new TypeError('节奏脚本必须位于包内')
  const bytes = readFileSync(file)
  if (
    bytes.length > SCRIPT_SOURCE_LIMIT ||
    bytes.length !== lock.size ||
    'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash
  )
    throw new TypeError('节奏脚本与已编译的包不一致')
  return { script: bytes.toString('utf8') }
}
