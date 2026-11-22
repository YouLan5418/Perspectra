import type { PageElement, PageField, PageRule, PageStep } from './activity-page-rules.ts'
import { checkPageTargets, readPageElements } from './activity-page-elements.ts'
import type { PackWebAsset } from './pack-frontend.ts'

export interface ActivityPage {
  html: string
  css?: string
  elements?: PageElement[]
}
export const activityPagesFile = 'frontend/activity-pages.json'
export function activityAssetPath(value: unknown, extension: 'html' | 'css' | 'image'): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('activities/') ||
    (extension === 'image'
      ? !/\.(png|jpe?g|webp|gif|svg)$/i.test(value)
      : !value.toLowerCase().endsWith('.' + extension)) ||
    value
      .split('/')
      .some(
        p =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[\\:?#%]/u.test(p) ||
          p.endsWith('.') ||
          p.endsWith(' ') ||
          Array.from(p).some(c => c.charCodeAt(0) < 32),
      )
  )
    throw new TypeError('请选择 frontend/activities/ 内的 .' + extension + ' 文件')
  return value
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new TypeError('页面联动字段无效')
  return value as Record<string, unknown>
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError('请填写有效的页面引用')
  return value
}
function operationId(value: unknown) {
  const id = name(value)
  if (!id.startsWith('activity:') && id !== 'host:activity-handoff' && !(id.startsWith('move:') && id.length > 5))
    throw new TypeError('请选择当前活动的操作或移动目的地')
  return id
}
function readField(raw: unknown): PageField {
  const { source } = record(raw, ['source', 'key', 'path', 'relativeTo'])
  if (source === 'phase') {
    record(raw, ['source'])
    return { source }
  }
  if (source === 'held' || source === 'world' || source === 'available') {
    const { key } = record(raw, ['source', 'key'])
    return { source, key: source === 'available' ? operationId(key) : name(key) }
  }
  if (source !== 'public' && source !== 'personal' && source !== 'stage')
    throw new TypeError('只能选择玩家可见的活动字段')
  const { path, relativeTo } = record(raw, ['source', 'path', 'relativeTo'])
  if (!Array.isArray(path) || !path.length || path.length > 32) throw new TypeError('字段路径无效')
  const steps = path.map((step): PageStep => {
    if (typeof step === 'string') return name(step)
    const { by, is } = record(step, ['by', 'is'])
    if (by !== 'id' && by !== 'key') throw new TypeError('列表记录需要稳定的 id 或 key')
    return { by, is: name(is) }
  })
  return { source, path: steps, ...(relativeTo !== undefined ? { relativeTo: name(relativeTo) } : {}) }
}
function readRule(raw: unknown): PageRule {
  const row = record(raw, ['field', 'compare', 'value', 'effect']),
    field = readField(row.field),
    { compare, value } = row
  if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
    throw new TypeError('条件值须为文字、布尔或有效数字')
  if (
    compare !== 'eq' &&
    compare !== 'ne' &&
    !(typeof value === 'number' && (compare === 'lt' || compare === 'lte' || compare === 'gt' || compare === 'gte'))
  )
    throw new TypeError('比较方式与条件值不匹配')
  if (
    (field.source === 'phase' && typeof value !== 'string') ||
    ((field.source === 'held' || field.source === 'available') && typeof value !== 'boolean') ||
    ('relativeTo' in field && typeof value !== 'number')
  )
    throw new TypeError('目标值与所选字段类型不匹配')
  const effect = record(row.effect, ['kind', 'value'])
  if (effect.kind === 'show') {
    record(effect, ['kind'])
    return { field, compare, value, effect: { kind: 'show' } }
  }
  if (effect.kind === 'image')
    return { field, compare, value, effect: { kind: 'image', value: activityAssetPath(effect.value, 'image') } }
  if (
    effect.kind === 'class' &&
    typeof effect.value === 'string' &&
    effect.value.length > 0 &&
    !/\s/.test(effect.value)
  )
    return { field, compare, value, effect: { kind: 'class', value: effect.value } }
  throw new TypeError('请选择显示、CSS 类名或包内图片')
}
function readElements(raw: unknown) {
  if (!Array.isArray(raw)) throw new TypeError('元素绑定需要列表')
  const seen = new Set<string>()
  return raw.map((item): PageElement => {
    const row = record(item, ['id', 'operation', 'rules']),
      id = name(row.id)
    if (seen.has(id)) throw new TypeError('同一元素请在一行中配置：' + id)
    seen.add(id)
    if (row.rules !== undefined && !Array.isArray(row.rules)) throw new TypeError('显示条件需要列表')
    const rules = row.rules?.map(readRule)
    return {
      id,
      ...(row.operation !== undefined ? { operation: operationId(row.operation) } : {}),
      ...(rules?.length ? { rules } : {}),
    }
  })
}
export function activityPageAssets(page: ActivityPage) {
  return [
    page.html,
    ...(page.css ? [page.css] : []),
    ...(page.elements ?? []).flatMap(e =>
      (e.rules ?? []).flatMap(r => (r.effect.kind === 'image' ? [r.effect.value] : [])),
    ),
  ]
}
export function activityPage(value: unknown): ActivityPage {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(k => !['html', 'css', 'elements'].includes(k))
  )
    throw new TypeError('活动页面需要 html，可选 css')
  const row = value as Record<string, unknown>
  return {
    html: activityAssetPath(row.html, 'html'),
    ...(row.css === undefined ? {} : { css: activityAssetPath(row.css, 'css') }),
    ...(row.elements === undefined ? {} : { elements: readElements(row.elements) }),
  }
}
export function readActivityPages(
  bytes: Buffer | undefined,
  assets?: ReadonlyMap<string, PackWebAsset>,
): Record<string, ActivityPage> {
  const value: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('activity-pages.json 需要活动键到页面的映射')
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      if (!key.trim() || key.length > 200) throw new TypeError('活动键无效')
      const page = activityPage(raw)
      for (const path of activityPageAssets(page))
        if (path && assets && !assets.has('/frontend/custom/' + path))
          throw new TypeError('活动 ' + key + ' 缺少页面资源：' + path)
      if (assets && page.elements?.length)
        checkPageTargets(
          readPageElements(assets.get('/frontend/custom/' + page.html)!.bytes.toString('utf8')),
          page.elements,
        )
      return [key, page]
    }),
  )
}
