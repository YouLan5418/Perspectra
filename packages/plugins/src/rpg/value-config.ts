import { ConfigInputError } from './config.ts'
import type {
  RpgBattleValues,
  RpgInitialValues,
  RpgValueRef,
  RpgValueAdjustment,
  RpgValueRequirement,
} from './battle-values.ts'
type Json = Record<string, any>
const fail = (path: string, message: string): never => {
  throw new ConfigInputError(path, message)
}
const object = (value: unknown, path: string): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : fail(path, '需要对象')
const only = (row: Json, path: string, keys: string[]) => {
  for (const key of Object.keys(row)) if (!keys.includes(key)) fail(`${path}.${key}`, '不认识的字段')
}
const integer = (value: unknown, path: string, min = 0, max = 9999): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail(path, `需要 ${min} 到 ${max} 的整数`)
const keys = (row: Json, path: string) => {
  if (Object.keys(row).length > 16) fail(path, '每类最多 16 项')
  for (const key of Object.keys(row))
    if (!/^[a-z][a-z0-9-]{0,32}$/u.test(key)) fail(`${path}.${key}`, '需要小写字母开头的有限名称')
}
export function parseBattleValues(value: unknown, statuses: unknown): RpgBattleValues {
  const root = object(value ?? {}, 'battleValues')
  only(root, 'battleValues', ['shared', 'attributes', 'resources'])
  const out: RpgBattleValues = { shared: {}, attributes: {}, resources: {} }
  for (const kind of ['shared', 'attributes', 'resources'] as const) {
    const path = `battleValues.${kind}`,
      rows = object(root[kind] ?? {}, path)
    keys(rows, path)
    for (const [key, value] of Object.entries(rows)) {
      const at = `${path}.${key}`,
        row = object(value, at)
      only(row, at, ['label', 'initial', 'min', 'max', ...(kind === 'resources' ? ['onHpLoss', 'onZeroStatus'] : [])])
      if (typeof row.label !== 'string' || !row.label.length || row.label.length > 36)
        fail(at + '.label', '需要 1 到 36 字')
      const min = integer(row.min, at + '.min'),
        max = integer(row.max, at + '.max', min),
        initial = integer(row.initial, at + '.initial', min, max)
      if (kind === 'resources' && min !== 0) fail(at + '.min', '资源下界必须为零')
      const onHpLoss = row.onHpLoss === undefined ? undefined : integer(row.onHpLoss, at + '.onHpLoss', 1)
      if (
        row.onZeroStatus !== undefined &&
        (typeof row.onZeroStatus !== 'string' ||
          !Object.hasOwn(object(statuses ?? {}, 'combatStatuses'), row.onZeroStatus))
      )
        fail(at + '.onZeroStatus', '未知状态')
      out[kind][key] = {
        label: row.label,
        min,
        max,
        initial,
        ...(onHpLoss === undefined ? {} : { onHpLoss }),
        ...(row.onZeroStatus === undefined ? {} : { onZeroStatus: row.onZeroStatus }),
      }
    }
  }
  return out
}
export function parseInitialValues(value: unknown, path: string, defs: RpgBattleValues): RpgInitialValues | undefined {
  if (value === undefined) return
  const root = object(value, path)
  only(root, path, ['attributes', 'resources'])
  const out: RpgInitialValues = {}
  for (const kind of ['attributes', 'resources'] as const)
    if (root[kind] !== undefined) {
      out[kind] = {}
      for (const [key, value] of Object.entries(object(root[kind], path + '.' + kind))) {
        const def = defs[kind][key]
        if (!def) fail(path + '.' + kind + '.' + key, '未知战斗数值')
        out[kind]![key] = integer(value, path + '.' + kind + '.' + key, def!.min, def!.max)
      }
    }
  return out
}
export function parseValueRef(value: unknown, path: string, defs: RpgBattleValues, allowTarget = true): RpgValueRef {
  const row = object(value, path)
  only(row, path, row.scope === 'shared' ? ['scope', 'key'] : ['scope', 'kind', 'key'])
  if (row.scope !== 'shared' && row.scope !== 'actor' && !(allowTarget && row.scope === 'target'))
    fail(path + '.scope', '非法读取范围')
  if (row.scope !== 'shared' && row.kind !== 'attribute' && row.kind !== 'resource')
    fail(path + '.kind', '只读 attribute/resource')
  const group = row.scope === 'shared' ? defs.shared : row.kind === 'attribute' ? defs.attributes : defs.resources
  if (typeof row.key !== 'string' || !Object.hasOwn(group, row.key)) fail(path + '.key', '未知战斗数值')
  return row.scope === 'shared' ? { scope: 'shared', key: row.key } : { scope: row.scope, kind: row.kind, key: row.key }
}
export function parseAdjustments(
  value: unknown,
  path: string,
  defs: RpgBattleValues,
): RpgValueAdjustment[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || !value.length || value.length > 4) fail(path, '需要 1 到 4 项')
  return (value as unknown[]).map((raw, i) => {
    const at = `${path}[${i}]`,
      row = object(raw, at)
    only(row, at, ['value', 'multiplier'])
    return {
      value: parseValueRef(row.value, at + '.value', defs),
      multiplier: integer(row.multiplier, at + '.multiplier', -10, 10),
    }
  })
}
export function parseRequirements(
  value: unknown,
  path: string,
  defs: RpgBattleValues,
): RpgValueRequirement[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || !value.length || value.length > 4) fail(path, '需要 1 到 4 项')
  return (value as unknown[]).map((raw, i) => {
    const at = `${path}[${i}]`,
      row = object(raw, at)
    only(row, at, ['value', 'atLeast'])
    return {
      value: parseValueRef(row.value, at + '.value', defs, false),
      atLeast: integer(row.atLeast, at + '.atLeast'),
    }
  })
}
export function parseResourceCost(
  value: unknown,
  path: string,
  defs: RpgBattleValues,
): Record<string, number> | undefined {
  if (value === undefined) return
  return Object.fromEntries(
    Object.entries(object(value, path)).map(([key, value]) => {
      if (!Object.hasOwn(defs.resources, key)) fail(path + '.' + key, '未知单位资源')
      return [key, integer(value, path + '.' + key, 1, defs.resources[key]!.max)]
    }),
  )
}
export function parseAttributeModifiers(
  value: unknown,
  path: string,
  defs: RpgBattleValues,
): Record<string, number> | undefined {
  if (value === undefined) return
  const row = object(value, path)
  if (!Object.keys(row).length) fail(path, '不能为空')
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (!Object.hasOwn(defs.attributes, key)) fail(path + '.' + key, '未知单位属性')
      return [key, integer(value, path + '.' + key, -1000, 1000)]
    }),
  )
}
export function parseValueEffect(
  value: unknown,
  path: string,
  defs: RpgBattleValues,
): { kind: 'value'; scope: 'shared' | 'actor' | 'target'; key: string; delta: number } {
  const row = object(value, path)
  only(row, path, ['kind', 'scope', 'key', 'delta'])
  if (!['shared', 'actor', 'target'].includes(row.scope)) fail(path + '.scope', '非法写入范围')
  const group = row.scope === 'shared' ? defs.shared : defs.resources
  if (typeof row.key !== 'string' || !Object.hasOwn(group, row.key)) fail(path + '.key', '只能修改声明共享值或单位资源')
  const delta = integer(row.delta, path + '.delta', -9999, 9999)
  if (!delta) fail(path + '.delta', '不能为零')
  return { kind: 'value', scope: row.scope, key: row.key, delta }
}
