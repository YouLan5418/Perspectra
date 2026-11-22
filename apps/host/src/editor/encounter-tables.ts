import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { isJsonObject, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { acceptsVariableValue } from '@perspectra/world-pack/editor-fields'
import { EditConflict, manifest, packPath, readProject, type EditorProject } from './project.ts'
import { locked, writeAtomic } from './source-files.ts'
import {
  parseTables,
  tableCandidates,
  tableOperations,
  tablePhases,
  type EncounterTable,
  type TableCatalog,
} from '../runtime/encounter-tables.ts'
import { tableEvents } from '../runtime/table-source.ts'
import type { ActivityMenu } from '../runtime/activity-page-catalog.ts'

function tableCatalog({ locations, rules }: Pick<EditorProject, 'locations' | 'rules'>): TableCatalog {
  const variables = rules.variables.filter(v => v.readable && !v.activities && !v.locations?.length)
  return {
    locations,
    variables,
    events: tableEvents(
      rules.events,
      rules.pacing.map(p => p.id),
    ),
  }
}
const draftPath = 'creator-tables.json'
function source(root: string) {
  const declaration = manifest(root).plugins?.['official-dice']
  const file = declaration?.config ?? 'gameplay-tables.json'
  if (file === draftPath) throw new TypeError('骰子配置与编辑草稿不能共用文件 ' + file)
  const existing = declaration?.config ? readFileSync(packPath(root, file), 'utf8') : null
  const config = existing === null ? {} : JSON.parse(existing)
  if (!isJsonObject(config) || ('tables' in config && !Array.isArray(config.tables)))
    throw new TypeError('骰子配置的 tables 需要数组')
  const draft = existsSync(packPath(root, draftPath))
    ? JSON.parse(readFileSync(packPath(root, draftPath), 'utf8'))
    : undefined
  if (draft !== undefined && (!isJsonObject(draft) || !Array.isArray(draft.tables)))
    throw new TypeError('候选表草稿无效')
  return {
    file,
    existing,
    config,
    draft,
    base: { file, tables: (draft?.tables ?? config.tables ?? []) as unknown as EncounterTable[] },
  }
}
export function validateTableReferences(root: string, project: Pick<EditorProject, 'locations' | 'rules'>) {
  parseTables(source(root).base.tables, tableCatalog(project))
}
export function encounterTables(root: string) {
  return { base: source(root).base, catalog: tableCatalog(readProject(root)) }
}
export function addDraftTableMenus(root: string, menus: Map<string, ActivityMenu>, locations: string[]) {
  if (!existsSync(packPath(root, draftPath))) return
  const { config, base } = source(root)
  for (const table of (config.tables ?? []) as EncounterTable[]) menus.delete('table-' + table.key)
  const operations = Object.entries(tableOperations).map(([id, label]) => ({ id: 'activity:' + id, label }))
  for (const t of base.tables)
    menus.set('table-' + t.key, { title: t.title, phases: tablePhases, operations, destinations: locations })
}
export function isTableActivity(root: string, key: string) {
  return key.startsWith('table-') && source(root).base.tables.some(t => 'table-' + t.key === key)
}
export function tableReferences(root: string, kind: unknown, id: unknown) {
  const found: { section: 'tables'; id: string; field: string; label: string }[] = []
  if (typeof id !== 'string' || (kind !== 'world' && kind !== 'event')) return found
  for (const t of source(root).base.tables) {
    const add = (field: string, label: string) =>
      found.push({ section: 'tables', id: t.key, field, label: t.title + ' › ' + label })
    if (kind === 'world' && t.clockKey === id) add('clockKey', '期限计时变量')
    for (const r of t.rows) {
      for (const [i, c] of (r.conditions ?? []).entries())
        if (kind === 'world' && c.key === id) add(r.key + '/condition/' + i, r.title + ' › 出现条件 ' + (i + 1))
      if (kind === 'world' && r.rewardKey === id) add(r.key + '/rewardKey', r.title + ' › 奖励')
      if (kind === 'event' && r.event === id) add(r.key + '/event', r.title + ' › 出现所需事件')
      if (kind === 'event' && r.completeEvent === id) add(r.key + '/completeEvent', r.title + ' › 交付所需事件')
    }
  }
  return found
}
export function saveTables(root: string, body: Record<string, unknown>) {
  return locked(root, () => {
    const { file, existing, base } = source(root)
    const project = readProject(root),
      current = tableCatalog(project),
      tables = parseTables(body.tables, current)
    const next = { file, tables }
    if (!isDeepStrictEqual(base, body.base) && !isDeepStrictEqual(next, base))
      throw new EditConflict(file, body.base, base, next)
    if (isDeepStrictEqual(next, base)) return { base, catalog: current }
    const raw = manifest(root)
    if (existing === null && existsSync(packPath(root, file)))
      throw new TypeError('文件已存在，请在 official-dice.config 引用已有文件或移开同名文件：' + file)
    for (const t of tables)
      if (
        project.graphs.some(g => g.key === 'table-' + t.key) ||
        (raw.plugins?.['pack-scripts'] && raw.assetFiles.includes('scripts/activities/table-' + t.key + '.js'))
      )
        throw new TypeError('候选表与已有活动重名：table-' + t.key)
    writeAtomic(root, draftPath, JSON.stringify({ tables }, null, 2) + '\n')
    return { base: next, catalog: current }
  })
}
export function materializeTables(
  root: string,
  target: string,
  assets: Set<string>,
  raw: { plugins?: Record<string, { config?: string }> },
) {
  if (!existsSync(packPath(root, draftPath))) return
  const { file, existing, config, base } = source(root)
  if (existing === null && existsSync(packPath(root, file))) throw new TypeError('包内已有同名配置文件：' + file)
  writeAtomic(target, file, JSON.stringify({ ...config, tables: base.tables }, null, 2) + '\n')
  assets.add(file)
  raw.plugins = { ...raw.plugins, 'official-dice': { ...raw.plugins?.['official-dice'], config: file } }
}
export function previewTable(root: string, body: Record<string, unknown>) {
  const book = encounterTables(root),
    table = parseTables([body.table ?? book.base.tables.find(t => t.key === body.key)], book.catalog)[0]!
  const location = body.location ?? null,
    values = body.values ?? {},
    counts = body.counts ?? {}
  if (location !== null && !book.catalog.locations.some(l => l.id === location)) throw new TypeError('预览地点不存在')
  if (
    !isJsonObject(values) ||
    !isJsonObject(counts) ||
    Object.entries(counts).some(
      ([key, n]) => !table.rows.some(r => r.key === key) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0,
    )
  )
    throw new TypeError('预览需要有效的变量值和非负出现次数')
  for (const [key, value] of Object.entries(values)) {
    const variable = book.catalog.variables.find(v => v.key === key)
    if (!variable || !acceptsVariableValue(variable, value)) throw new TypeError('预览变量缺失或取值无效：' + key)
  }
  const events = body.events ?? []
  if (!Array.isArray(events) || events.some(id => !book.catalog.events.some(e => e.id === id)))
    throw new TypeError('预览事件必须来自包内候选')
  return tableCandidates(table, book.catalog, {
    location: location as string | null,
    values: values as WorldJsonObject,
    counts: counts as WorldJsonObject,
    events,
  })
}
