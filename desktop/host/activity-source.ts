import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { SCRIPT_SOURCE_LIMIT } from '@harness-world/contracts'
import type { ActivitySource } from '@harness-world/plugin-sdk'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
export function loadActivitySource(packPath: string, pack: CompiledWorldPackV5): ActivitySource | undefined {
  const entries: { key: string; entry: string; source: string }[] = [],
    keys = new Set<string>()
  for (const asset of pack.assets) {
    const match = /^scripts\/activities\/([a-z][a-z0-9-]{0,40})\.js$/u.exec(asset.path)
    if (asset.path !== 'scripts/activity.js' && !match) continue
    const key = match?.[1] ?? 'default'
    if (keys.has(key)) throw new TypeError('重复的活动标识：' + key)
    keys.add(key)
    const file = resolve(packPath, asset.path)
    if (
      !lstatSync(file).isFile() ||
      relative(realpathSync(packPath), realpathSync(file)) !== asset.path.split('/').join(sep)
    )
      throw new TypeError('活动脚本必须位于包内')
    const bytes = readFileSync(file)
    if (
      bytes.length > SCRIPT_SOURCE_LIMIT ||
      bytes.length !== asset.size ||
      'sha256:' + createHash('sha256').update(bytes).digest('hex') !== asset.contentHash
    )
      throw new TypeError('活动脚本与编译资产不一致')
    entries.push({ key, entry: asset.path, source: bytes.toString('utf8') })
  }
  return entries.length ? { entries } : undefined
}
