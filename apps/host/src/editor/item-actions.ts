import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { EditConflict, manifest, manifestFile, packPath } from './project.ts'
import { locked, writeAtomic } from './source-files.ts'
import { worldRecords } from './world-records.ts'
import { baseItemOperations } from '../official-pack-metadata.ts'

const actions = ['take', 'drop', 'give'] as const
type Action = (typeof actions)[number]
type Flags = Record<Action, boolean>
const file = 'scripts/status.js'
const flags = (test: (action: Action) => boolean): Flags => ({
  take: test('take'),
  drop: test('drop'),
  give: test('give'),
})
// Only the leading, literal ITEM_RULES table of the creator template can be edited.
const head =
  /^(?:(?:[ \t]*\/\/[^\r\n]*)?[ \t]*\r?\n)*[ \t]*const ITEM_RULES\s*=\s*\{\s*take\s*:\s*\[([^\]]*)\]\s*,\s*drop\s*:\s*\[([^\]]*)\]\s*,\s*give\s*:\s*\[([^\]]*)\]\s*,?\s*\}/du
function table(source: string) {
  const match = head.exec(source)
  if (!match || !match[0].includes('// ---- 物品规则模板：拿起、放下、交给 ----')) return
  const rows = {} as Record<Action, { ids: string[]; start: number; end: number }>
  for (const [index, key] of actions.entries()) {
    const list = match[index + 1]!.trim().replace(/,\s*$/, '')
    const ids = []
    for (const token of list ? list.split(',') : []) {
      const item = /^(['"])(entity:[\p{L}\p{N}:.@_-]+)\1$/u.exec(token.trim())
      if (!item) return
      ids.push(item[2]!)
    }
    const [start, end] = match.indices![index + 1]!
    rows[key] = { ids, start, end }
  }
  return rows
}
function scriptState(root: string) {
  const m = manifest(root),
    exists = existsSync(packPath(root, file)),
    active = !!m.plugins?.['pack-scripts'] && m.assetFiles.includes(file)
  if (exists && !active) return { mode: 'inactive' as const, source: '', rows: undefined, operations: [] }
  if (
    !exists &&
    (m.assetFiles.includes(file) ||
      (!m.plugins?.['pack-scripts'] &&
        m.assetFiles.some(
          f => f === 'plugins.json' || f === 'scripts/activity.js' || f.startsWith('scripts/activities/'),
        )))
  )
    return { mode: 'inactive' as const, source: '', rows: undefined, operations: [] }
  const source = exists
    ? readFileSync(packPath(root, file), 'utf8')
    : readFileSync(
        new URL(
          import.meta.url.endsWith('.mjs')
            ? '../skills/perspectra-creator/assets/status-items.js'
            : '../../../../skills/perspectra-creator/assets/status-items.js',
          import.meta.url,
        ),
        'utf8',
      )
  const rows = table(source)
  return {
    mode: exists ? (rows ? ('template' as const) : ('custom' as const)) : ('new' as const),
    source,
    rows,
    operations: exists ? baseItemOperations(source) : [],
  }
}
export function itemActions(root: string, id: string) {
  const { mode, source, rows, operations } = scriptState(root)
  return {
    mode,
    file,
    allowed: flags(k => !!rows?.[k].ids.includes(id)),
    operations: operations.filter(o => o.targets?.includes(id)).map(({ id, label }) => ({ id, label })),
    source: mode === 'custom' || mode === 'template' ? source : undefined,
  }
}
export function saveItemActions(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    id = body.id
  if (typeof id !== 'string' || !/^entity:[\p{L}\p{N}:.@_-]+$/u.test(id))
    throw new TypeError('请选择模板支持的物品标识')
  return locked(root, () => {
    if (!worldRecords(root).records.some(r => r.kind === 'item' && r.id === id)) throw new TypeError('找不到物品')
    const state = scriptState(root),
      rows = state.rows
    if (!rows) throw new TypeError('请在包内状态脚本中配置此物品的操作')
    const before = flags(k => rows[k].ids.includes(id))
    const next = body.allowed as Flags
    if (!next || Object.keys(next).length !== actions.length || actions.some(k => typeof next[k] !== 'boolean'))
      throw new TypeError('请提供拿起、放下、交给三项布尔值')
    if (!isDeepStrictEqual(before, body.base) && !isDeepStrictEqual(before, next))
      throw new EditConflict(id + '/ITEM_RULES', body.base, before, next)
    if (isDeepStrictEqual(before, next)) return itemActions(root, id)
    let updated = state.source
    for (const k of [...actions].reverse()) {
      if (before[k] === next[k]) continue
      const { ids, start, end } = rows[k],
        newIds = next[k] ? [...ids, id] : ids.filter(v => v !== id)
      updated = updated.slice(0, start) + newIds.map(v => JSON.stringify(v)).join(', ') + updated.slice(end)
    }
    const ops = baseItemOperations(updated)
    if (actions.some(k => !!ops.find(o => o.id === k)?.targets?.includes(id) !== next[k]))
      throw new TypeError('状态脚本的实际操作与模板配置不一致')
    writeAtomic(root, file, updated)
    if (state.mode === 'new') {
      try {
        const m = JSON.parse(readFileSync(packPath(root, manifestFile), 'utf8'))
        m.assetFiles = [...m.assetFiles, file]
        m.plugins = { ...m.plugins, 'pack-scripts': m.plugins?.['pack-scripts'] ?? {} }
        writeAtomic(root, manifestFile, JSON.stringify(m, null, 2) + '\n')
      } catch (e) {
        rmSync(packPath(root, file))
        throw e
      }
    }
    return itemActions(root, id)
  })
}
