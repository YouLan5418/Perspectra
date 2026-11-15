import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SavedPluginDataState {
  readonly key: string
  readonly type: string
  readonly owner: string
}

export interface SavedPluginDataActivity {
  readonly key: string
  readonly phases?: readonly string[]
}

export interface SavedPluginDataRecord {
  readonly pluginVersion: string
  readonly dataVersion: number
  readonly statuses: readonly SavedPluginDataState[]
  readonly activities: readonly SavedPluginDataActivity[]
  /** 配置、数据版本与插件标识的规范化摘要，用于诊断与尾部重生成候选环境比较。 */
  readonly digest: string
}

export interface PluginSetRecord {
  readonly seams: Readonly<Record<string, readonly { readonly id: string; readonly version: string }[]>>
  /** 每个生效玩法内容插件的持久数据兼容记录，替代旧版锁死源码文本的 generatedContent。 */
  readonly gameplayData?: Readonly<Record<string, SavedPluginDataRecord>>
  /** 仅用于识别未发布旧实验存档的字段，不再写入新存档。 */
  readonly generatedContent?: Readonly<Record<string, string>>
}

export const PLUGIN_SET_FILE = 'plugin-set.json'
const LABELS: Readonly<Record<string, string>> = {
  scheduler: '角色调度',
  wakeups: '唤醒来源',
  knowledge: '设定知识',
  status: '状态规则',
  activities: '活动规则',
  communication: '通信规则',
  autonomy: '自主策略',
  pacing: '剧情节奏',
  characterLoop: '角色执行循环',
  memory: '长期记忆',
  llm: '模型通道',
  decisions: '角色决策',
  rules: '世界规则',
}

const named = (entries: PluginSetRecord['seams'][string] | undefined, seam: string) => {
  if (!entries?.length) return '无'
  const contexts = seam === 'decisions' ? entries.filter(entry => entry.id.startsWith('official-context-')) : []
  const others = entries.filter(entry => !contexts.includes(entry)).map(entry => `${entry.id} ${entry.version}`)
  return [...(contexts.length ? [`上下文扩充（${contexts.length}项）`] : []), ...others].join('、')
}

function validSavedDataRecord(value: unknown): value is SavedPluginDataRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    typeof record.pluginVersion !== 'string' ||
    !Number.isInteger(record.dataVersion) ||
    (record.dataVersion as number) < 1 ||
    typeof record.digest !== 'string' ||
    !Array.isArray(record.statuses) ||
    !Array.isArray(record.activities)
  ) {
    return false
  }
  const validStatuses = record.statuses.every(
    item =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as { key?: unknown }).key === 'string' &&
      typeof (item as { type?: unknown }).type === 'string' &&
      typeof (item as { owner?: unknown }).owner === 'string',
  )
  const validActivities = record.activities.every(
    item =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as { key?: unknown }).key === 'string' &&
      ((item as { phases?: unknown }).phases === undefined ||
        (Array.isArray((item as { phases?: unknown }).phases) &&
          (item as { phases: unknown[] }).phases.every(phase => typeof phase === 'string'))),
  )
  return validStatuses && validActivities
}

/** One line per module that differs. The first time a save opens there is nothing to compare with. */
export function pluginSetChanges(previous: PluginSetRecord | undefined, current: PluginSetRecord): string[] {
  if (!previous) return []
  const seamChanges = Object.keys({ ...previous.seams, ...current.seams }).flatMap(seam => {
    if (
      JSON.stringify((previous.seams[seam] ?? []).map(entry => [entry.id, entry.version])) ===
      JSON.stringify((current.seams[seam] ?? []).map(entry => [entry.id, entry.version]))
    )
      return []
    const before = named(previous.seams[seam], seam),
      after = named(current.seams[seam], seam)
    if (before === after && seam === 'decisions') return ['角色决策：上下文扩充组合已调整']
    return [`${LABELS[seam] ?? seam}：${before} → ${after}`]
  })
  const dataChanges = Object.keys({ ...previous.gameplayData, ...current.gameplayData }).flatMap(id => {
    const before = previous.gameplayData?.[id]
    const after = current.gameplayData?.[id]
    if (!before || !after || before.digest === after.digest) return []
    return [`玩法内容：${id} 已按兼容声明载入更新`]
  })
  return [...seamChanges, ...dataChanges]
}

/** A missing record is a fresh save; damaged compatibility authority must never bypass checks. */
export function readPluginSet(directory: string): PluginSetRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, PLUGIN_SET_FILE), 'utf8')) as PluginSetRecord
    if (!value || typeof value.seams !== 'object' || value.seams === null) throw new TypeError('invalid seams')
    if (
      value.generatedContent !== undefined &&
      (typeof value.generatedContent !== 'object' ||
        value.generatedContent === null ||
        Array.isArray(value.generatedContent) ||
        Object.values(value.generatedContent).some(hash => typeof hash !== 'string'))
    )
      throw new TypeError('invalid generated content')
    if (
      value.gameplayData !== undefined &&
      (typeof value.gameplayData !== 'object' ||
        value.gameplayData === null ||
        Array.isArray(value.gameplayData) ||
        Object.values(value.gameplayData).some(record => !validSavedDataRecord(record)))
    )
      throw new TypeError('invalid gameplay data')
    for (const entries of Object.values(value.seams))
      if (!Array.isArray(entries) || entries.some(entry => typeof entry?.id !== 'string'))
        throw new TypeError('invalid seam entries')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('存档的 plugin-set.json 插件数据兼容记录损坏，无法安全读档。', { cause: error })
  }
}

export function writePluginSet(directory: string, record: PluginSetRecord): void {
  const path = join(directory, PLUGIN_SET_FILE)
  writeFileSync(path + '.tmp', JSON.stringify(record))
  renameSync(path + '.tmp', path)
}
