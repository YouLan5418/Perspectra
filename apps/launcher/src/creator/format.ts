import type { StatusTone, TraceKind } from './types.ts'

export const KIND_LABEL: Record<TraceKind, string> = {
  context: '上下文',
  recall: '召回',
  model: '模型',
  decision: '决策',
  action: '行动',
  turn: '轮次',
  speak: '对话',
  observation: '观察',
  event: '事件',
  entity: '物品',
  movement: '移动',
  activity: '活动',
  world: '世界',
}

/** 类型同时用颜色和文字标签表达，避免只凭色相判断。 */
export const KIND_TONE: Record<TraceKind, StatusTone> = {
  context: 'ok',
  recall: 'ok',
  model: 'accent',
  decision: 'accent',
  action: 'warn',
  turn: 'muted',
  speak: 'accent',
  observation: 'ok',
  event: 'muted',
  entity: 'warn',
  movement: 'muted',
  activity: 'accent',
  world: 'muted',
}

const TURN_STATUS: Record<string, [string, StatusTone]> = {
  responded: ['已回应', 'ok'],
  silent: ['选择沉默', 'muted'],
  expired: ['已过期', 'warn'],
  cancelled: ['已取消', 'muted'],
  failed: ['失败', 'danger'],
  budget_exhausted: ['预算用尽', 'warn'],
  stale: ['视图过期重算', 'warn'],
}
const REQUEST_STATUS: Record<string, [string, StatusTone]> = {
  ok: ['已返回', 'ok'],
  failed: ['失败', 'danger'],
  pending: ['未完成', 'warn'],
}

/** 活动最近提交的 state 是对象（game.active / phase 等），未开始时为 null；只取人读的状态文字。 */
export function activityStatus(state: unknown): [string, StatusTone] {
  if (state === null || state === undefined) return ['未开始', 'muted']
  const game = asRecord(asRecord(state).game)
  const phase = text(game.phase)
  if (game.active === true) return [phase ? `进行中 · ${phase}` : '进行中', 'ok']
  return [phase ? `已结束 · ${phase}` : '已结束', 'warn']
}

export function turnStatus(status: string): [string, StatusTone] {
  return TURN_STATUS[status] ?? [status || '未知', 'muted']
}
export function requestStatus(status: string): [string, StatusTone] {
  return REQUEST_STATUS[status] ?? [status || '未完成', 'muted']
}

/** 只显示可读时间；已提交事件没有墙钟时间，交由调用方改用 tick/序号。 */
export function timeLabel(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function dateTimeLabel(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${timeLabel(value)}`
}

export function durationLabel(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}

export function tokenLabel(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '未提供'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

export function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** 紧凑单行 JSON，用于列表摘要；完整内容在详情中阅读。 */
export function inlineJson(value: unknown, max = 160): string {
  if (value === null || value === undefined) return '无'
  if (typeof value === 'string') return truncate(value, max)
  try {
    return truncate(JSON.stringify(value), max)
  } catch {
    return '无法序列化'
  }
}

export function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export interface Segment {
  type: 'speech' | 'narration'
  text: string
}

/** 表达正文：NPC 发布用有序 segments，玩家发布用 text / narration 两个字段。 */
export function expressionSegments(value: unknown): Segment[] {
  const data = asRecord(value)
  const segments = asArray(data.segments)
    .map(asRecord)
    .filter(
      item =>
        (item.type === 'speech' || item.type === 'narration') && typeof item.text === 'string' && item.text.trim(),
    )
    .map(item => ({ type: item.type as Segment['type'], text: item.text as string }))
  if (segments.length) return segments
  return [
    ...(text(data.narration).trim() ? [{ type: 'narration' as const, text: text(data.narration) }] : []),
    ...(text(data.text).trim() ? [{ type: 'speech' as const, text: text(data.text) }] : []),
  ]
}

/** 单行摘要：旁白加括号，与对白区分。 */
export function segmentsText(segments: Segment[]): string {
  return segments
    .map(segment => (segment.type === 'narration' ? `（${segment.text.trim()}）` : segment.text.trim()))
    .join(' ')
}

/** 就近取首个非空显示文本。观察内容是对象时优先取常见的人读字段。 */
export function readable(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const record = asRecord(value)
  for (const key of [
    'text',
    'content',
    'description',
    'resultDescription',
    'summary',
    'label',
    'proposition',
    'message',
    'narration',
  ]) {
    const found = record[key]
    if (typeof found === 'string' && found.trim()) return found
  }
  const nested = asRecord(record.value)
  if (Object.keys(nested).length) return readable(nested)
  return Object.keys(record).length ? JSON.stringify(record) : ''
}
