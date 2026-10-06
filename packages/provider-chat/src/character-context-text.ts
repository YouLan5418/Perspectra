import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

function isObject(value: WorldJsonValue): value is WorldJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
/** A table factors repeated keys and common values; heterogeneous/empty rows keep their original shape. */
function table(rows: readonly WorldJsonObject[]): WorldJsonValue {
  if (rows.length < 2) return rows
  const columns = Object.keys(rows[0]!).sort()
  if (!rows.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(columns))) return rows
  const common: Record<string, WorldJsonValue> = {}
  for (const key of columns) if (rows.every(row => JSON.stringify(row[key]) === JSON.stringify(rows[0]![key]))) {
    common[key] = rows[0]![key]!
  }
  const varying = columns.filter(key => !Object.hasOwn(common, key))
  return { common, columns: varying, rows: rows.map(row => varying.map(key => row[key]!)) }
}

/** Render only this role's already-authorized cognition. No value, identifier, provenance or hash is discarded. */
export function compactCognition(cognition: WorldJsonObject): WorldJsonObject {
  const counts = new Map<string, number>()
  const sourceObject = (value: WorldJsonValue) => isObject(value)
    && typeof value.sourceKind === 'string' && typeof value.sourceId === 'string' && typeof value.sourceHash === 'string'
  const count = (value: WorldJsonValue): void => {
    if (sourceObject(value)) {
      const key = JSON.stringify(value); counts.set(key, (counts.get(key) ?? 0) + 1)
    } else if (Array.isArray(value)) value.forEach(count)
    else if (isObject(value)) Object.values(value).forEach(count)
  }
  count(cognition)
  const sources: WorldJsonObject[] = [], indices = new Map<string, number>()
  const pack = (value: WorldJsonValue): WorldJsonValue => {
    if (sourceObject(value) && counts.get(JSON.stringify(value))! > 1) {
      const key = JSON.stringify(value)
      let index = indices.get(key)
      if (index === undefined) { index = sources.length; indices.set(key, index); sources.push(value as WorldJsonObject) }
      return { sourceIndex: index }
    }
    if (Array.isArray(value)) return value.map(pack)
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pack(item)]))
    return value
  }
  const result: Record<string, WorldJsonValue> = {}
  for (const [key, value] of Object.entries(cognition)) {
    if (Array.isArray(value) && value.length > 0 && value.every(row => isObject(row) && isObject(row.value!))) {
      const records = value as WorldJsonObject[]
      result[key] = {
        records: table(records.map(({ value: _value, ...record }) => pack(record) as WorldJsonObject)),
        values: table(records.map(record => pack(record.value!) as WorldJsonObject)),
      }
    } else result[key] = pack(value)
  }
  return { ...result, sources: table(sources) }
}

export function characterRequestText(request: { readonly context: WorldJsonObject }): string {
  const cognition = request.context.cognition
  if (cognition === undefined || !isObject(cognition)) return JSON.stringify(request)
  return JSON.stringify({ ...request, context: { ...request.context, cognition: compactCognition(cognition) } })
}

export const cognitionTableNote = 'context.cognition仅属于你本人。其表格columns是列名，rows按列顺序读取，每行都继承common。各类records和values按行一一对应，values是记录的value；数组表示原样记录。sourceIndex引用cognition.sources的对应行，保存完整来源。表格只是无损紧凑表达，认识、目标和情绪仍是你的主观状态，不是他人的知识或已确认世界事实。'
