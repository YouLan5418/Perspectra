import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { loadTables } from './table-source.ts'
import { tableActivity } from './encounter-tables.ts'
import { lockedPackAsset } from './pack-modules.ts'
import { SCRIPT_SOURCE_LIMIT } from '@perspectra/sdk/contracts'
import type { ActivitySource, ActivitySourceEntry, GeneratedActivity } from '@perspectra/sdk'
import type { CompiledWorldPackV5 } from '@perspectra/world-pack'

/** The script file of an activity key, the way the host loads them: a single-activity pack's `default` activity is
 * `scripts/activity.js`, every other key `scripts/activities/<key>.js`. */
export const activityScriptPath = (key: string) =>
  key === 'default' ? 'scripts/activity.js' : `scripts/activities/${key}.js`

/** 读取包内活动脚本，再合入玩法插件注册的原生活动（与包内同名脚本冲突时在开档前报错）。 */
export function loadActivitySource(
  packPath: string,
  pack: CompiledWorldPackV5,
  generated: readonly (GeneratedActivity & { readonly generator: string })[] = [],
): (ActivitySource & { eventTables: string[] }) | undefined {
  const entries: ActivitySourceEntry[] = [],
    keys = new Set<string>()
  for (const asset of pack.plugins?.['pack-scripts'] ? pack.assets : []) {
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
  const book = loadTables(pack, file => lockedPackAsset(packPath, pack, file))
  const eventTables: string[] = []
  for (const table of book?.tables ?? []) {
    const key = 'table-' + table.key
    keys.add(key)
    if (table.rows.some(row => row.event || row.completeEvent)) eventTables.push(key)
    entries.push({ key, activity: tableActivity(table, book!.catalog) })
  }
  for (const { key, activity, generator } of generated) {
    const entry = `scripts/activities/${key}.js`
    if (keys.has(key)) throw new TypeError(`${generator} 插件生成的活动 ${key} 与包内 ${entry} 重名`)
    keys.add(key)
    entries.push({ key, activity })
  }
  return entries.length ? { entries, eventTables } : undefined
}
