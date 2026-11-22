import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import type { Scalar } from './editor-fields.ts'
import { configObject } from './editor-config.ts'
export type KnowledgePath = (string | null)[]
export const knowledgeComparisons = {
  eq: '等于',
  ne: '不等于',
  gte: '至少',
  gt: '大于',
  lte: '至多',
  lt: '小于',
  known: '已知此字段',
} as const
export interface KnowledgeTerm {
  path: KnowledgePath
  activity?: string
  comparison: keyof typeof knowledgeComparisons
  value?: Scalar
}
export interface KnowledgeCondition {
  match: 'one' | 'all' | 'any'
  terms: KnowledgeTerm[]
}
export interface KnowledgeField {
  path: KnowledgePath
  activity?: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'object'
  choices?: { value: Scalar; label: string }[]
  openChoices?: boolean
}
const ranges = { gt: 'exclusiveMinimum', gte: 'minimum', lt: 'exclusiveMaximum', lte: 'maximum' } as const
const scalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
function nativeTerm(t: KnowledgeTerm): WorldJsonObject {
  if (
    !Array.isArray(t.path) ||
    !t.path.length ||
    t.path.some(p => p !== null && (typeof p !== 'string' || !p.length)) ||
    typeof t.path[0] !== 'string'
  )
    throw new TypeError('请选择知识条件字段')
  let s: WorldJsonObject
  if (t.comparison === 'known') s = {}
  else if (t.comparison === 'eq' || t.comparison === 'ne') {
    if (!scalar(t.value)) throw new TypeError('请选择或填写条件值')
    s = t.comparison === 'eq' ? { const: t.value } : { not: { const: t.value } }
  } else if (Object.hasOwn(ranges, t.comparison) && typeof t.value === 'number' && Number.isFinite(t.value)) {
    s = { type: 'number', [ranges[t.comparison as keyof typeof ranges]]: t.value }
  } else throw new TypeError('数值比较需要数字')
  for (const p of [...t.path].reverse())
    s = p === null ? { type: 'array', contains: s } : { type: 'object', required: [p], properties: { [p]: s } }
  if (!t.activity) return s
  if (t.path[0] !== 'activity' || t.path.length < 2) throw new TypeError('活动条件必须引用活动内字段')
  const key = nativeTerm({ path: ['activityKey'], comparison: 'eq', value: t.activity })
  return {
    type: 'object',
    required: ['activity'],
    properties: { activity: { type: 'object', allOf: [key, configObject(s.properties).activity!] } },
  }
}
export function knowledgeSchema(group: KnowledgeCondition): WorldJsonObject {
  if (
    !group ||
    !['one', 'all', 'any'].includes(group.match) ||
    !Array.isArray(group.terms) ||
    !group.terms.length ||
    (group.match === 'one' && group.terms.length !== 1)
  )
    throw new TypeError('需要至少一条知识条件')
  const terms = group.terms.map(nativeTerm)
  return group.match === 'one' ? terms[0]! : { type: 'object', [group.match === 'all' ? 'allOf' : 'anyOf']: terms }
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && same(v, (b as Record<string, unknown>)[k]))
  )
}
function readTerm(raw: unknown): KnowledgeTerm | undefined {
  let node = configObject(raw)
  const scoped = configObject(configObject(node.properties).activity).allOf
  if (Array.isArray(scoped) && scoped.length === 2) {
    const key = readTerm(scoped[0]),
      inner = readTerm(scoped[1])
    if (
      key?.path.length === 1 &&
      key.path[0] === 'activityKey' &&
      key.comparison === 'eq' &&
      typeof key.value === 'string' &&
      inner
    )
      return { ...inner, path: ['activity', ...inner.path], activity: key.value }
  }
  const path: KnowledgePath = []
  while (true) {
    const key = Array.isArray(node.required) && node.required.length === 1 ? node.required[0] : undefined
    if (node.type === 'object' && typeof key === 'string' && key && Object.hasOwn(configObject(node.properties), key)) {
      path.push(key)
      node = configObject(configObject(node.properties)[key])
    } else if (node.type === 'array' && node.contains) {
      path.push(null)
      node = configObject(node.contains)
    } else break
  }
  if (!path.length || typeof path[0] !== 'string') return
  if (!Object.keys(node).length) return { path, comparison: 'known' }
  if (scalar(node.const)) return { path, comparison: 'eq', value: node.const }
  const not = configObject(node.not)
  if (scalar(not.const)) return { path, comparison: 'ne', value: not.const }
  for (const [op, key] of Object.entries(ranges))
    if (typeof node[key] === 'number') return { path, comparison: op as keyof typeof ranges, value: node[key] }
  return
}
/** Only recognize a complete native condition. Unknown schema constraints stay intact in the advanced editor. */
export function readKnowledgeCondition(raw: unknown): KnowledgeCondition | undefined {
  const node = configObject(raw)
  const match = Array.isArray(node.allOf) ? 'all' : Array.isArray(node.anyOf) ? 'any' : 'one'
  const sources = match === 'one' ? [raw] : ((match === 'all' ? node.allOf : node.anyOf) as unknown[])
  const terms = sources.map(readTerm)
  if (!terms.length || !terms.every((t): t is KnowledgeTerm => !!t)) return
  const group = { match, terms } as KnowledgeCondition
  return same(knowledgeSchema(group), raw) ? group : undefined
}
export function knowledgeField(fields: KnowledgeField[], path: KnowledgePath, activity?: string) {
  return (
    fields.find(
      f => f.activity === activity && f.path.length === path.length && f.path.every((k, i) => k === path[i]),
    ) ??
    fields.find(
      f =>
        f.activity === activity &&
        f.path.length === path.length &&
        f.path.every((k, i) => k === path[i] || (k === '*' && typeof path[i] === 'string')),
    )
  )
}
export function knowledgeComparators(field: KnowledgeField): KnowledgeTerm['comparison'][] {
  if (field.type === 'object') return ['known']
  return field.type === 'number' ? ['eq', 'ne', 'gte', 'gt', 'lte', 'lt', 'known'] : ['eq', 'ne', 'known']
}
export function knowledgeTermError(fields: KnowledgeField[], actors: readonly { value: string }[], t: KnowledgeTerm) {
  const f = knowledgeField(fields, t.path, t.activity)
  if (!f || !knowledgeComparators(f).includes(t.comparison)) return '请选择可用知识字段和比较方式'
  if (t.path[0] === 'characters' && !actors.some(o => o.value === t.path[1])) return '请选择包内角色'
  if (
    t.comparison !== 'known' &&
    (typeof t.value !== f.type ||
      (['eq', 'ne'].includes(t.comparison) && f.choices && !f.openChoices && !f.choices.some(c => c.value === t.value)))
  )
    return '知识条件的值与字段不匹配：' + f.label
}
