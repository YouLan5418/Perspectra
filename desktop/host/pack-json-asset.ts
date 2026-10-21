import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

/** Only explicitly compiled, unchanged local assets are runtime configuration. */
export function packJsonAsset(root: string, pack: CompiledWorldPackV5, entry: string, maximumBytes = 65536): unknown {
  const lock = pack.assets.find(asset => asset.path === entry)
  if (!lock) return undefined
  const path = resolve(root, entry)
  if (!lstatSync(path).isFile() || relative(realpathSync(root), realpathSync(path)) !== entry.split('/').join(sep))
    throw new TypeError('配置必须是包内普通文件：' + entry)
  const bytes = readFileSync(path)
  if (bytes.length > maximumBytes || bytes.length !== lock.size || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== lock.contentHash)
    throw new TypeError('配置与编译包不一致：' + entry)
  return JSON.parse(bytes.toString('utf8'))
}
