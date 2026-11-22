import { parseEventBook } from '@perspectra/sdk'
import { packContentFacts, type CompiledWorldPackV5 } from '@perspectra/world-pack'
import { baseStatusFields, basePacingEvents } from '../official-pack-metadata.ts'
import { parseTables, type TableCatalog } from './encounter-tables.ts'

export function tableEvents(rules: readonly { id: string; trigger?: string; observation: string }[], paced: string[]) {
  return rules
    .filter(r => r.trigger !== 'paced' || paced.includes(r.id))
    .map(r => ({ id: r.id, label: r.observation, paced: r.trigger === 'paced' }))
}
/** Read only the installed pack's locked assets. Table activities share the pack's public rules and dice. */
export function loadTables(pack: CompiledWorldPackV5, read: (path: string) => string) {
  const file = pack.plugins?.['official-dice']?.config
  if (!file) return
  const config = JSON.parse(read(file))
  if (!Object.hasOwn(config, 'tables')) return
  const has = (path: string) => pack.assets.some(a => a.path === path)
  const fields =
    pack.plugins?.['pack-scripts'] && has('scripts/status.js') ? baseStatusFields(read('scripts/status.js')) : []
  const variables: TableCatalog['variables'] = fields.flatMap(v => {
    if (
      v.owner !== 'public' ||
      !v.alwaysKnown ||
      v.activities ||
      v.locations?.length ||
      (v.type !== 'boolean' && v.type !== 'number' && v.type !== 'string')
    )
      return []
    const options = v.schema?.enum
    return [
      {
        key: v.key,
        label: v.label,
        type: v.type,
        writable:
          Object.keys(v.schema ?? {}).every(k => k === 'type' || k === 'enum') &&
          (!options || (Array.isArray(options) && options.every(s => typeof s === 'string'))),
        ...(Array.isArray(options) && options.every(s => typeof s === 'string')
          ? { options: options as string[] }
          : {}),
      },
    ]
  })
  const events = pack.plugins?.['official-world-events']
  const rules = events
    ? parseEventBook(JSON.parse(read(events.config ?? 'world-events.json')), packContentFacts(pack)).rules
    : []
  const paced =
    pack.plugins?.['official-pacing'] && has('scripts/pacing.js')
      ? basePacingEvents(read('scripts/pacing.js')).map(p => p.id)
      : []
  const catalog: TableCatalog = {
    locations: pack.content.locations.map(l => ({ id: l.locationId, name: l.name })),
    variables,
    events: tableEvents(rules, paced),
  }
  const tables = parseTables(config.tables, catalog)
  for (const table of tables)
    if (pack.plugins?.['pack-scripts'] && has('scripts/activities/table-' + table.key + '.js'))
      throw new TypeError('候选表与已有活动重名：table-' + table.key)
  return { catalog, tables }
}
