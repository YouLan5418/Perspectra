import type { LensRequestState } from '../../../../desktop/lens/store.ts'
import type { LensField, LensSection, LensSource } from '../../../../desktop/lens/view.ts'

export const SECTION_LABEL: Record<LensSection, string> = {
  characters: '角色',
  knowledge: '谁知道什么',
  places: '地点与场景',
  statuses: '状态',
  items: '物品',
  events: '事件与活动',
  rules: '规则与钩子',
  presets: '预设与记忆',
}

export const REQUEST_STATE_LABEL: Record<LensRequestState, string> = {
  open: '待改',
  changed: '已改动，待确认',
  removed: '已删除',
  closed: '已关闭',
}

/** 字段值的游戏内写法：列表用顿号连起来，真假写成是／否。 */
export function showValue(value: LensField['value'] | null): string {
  if (value === null) return '（无）'
  if (Array.isArray(value)) return value.length ? value.join('、') : '（无）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return value === '' ? '（空）' : String(value)
}

/** 源码位置：JSON 文件加 JSON Pointer，或脚本文件、hook 名和条件标签。 */
export function showSource(source: LensSource): string {
  if (source.kind === 'json') return `${source.file} ${source.pointer || '/'}`
  return `${source.file} · ${source.hook}${source.label === undefined ? '' : ' · ' + source.label}`
}

export const fieldValue = (fields: readonly LensField[], key: string) => fields.find(field => field.key === key)?.value
