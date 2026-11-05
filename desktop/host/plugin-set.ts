import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginSetRecord {
  readonly seams: Readonly<Record<string, readonly { readonly id: string; readonly version: string }[]>>
}

const FILE = 'plugin-set.json'
const LABELS: Readonly<Record<string, string>> = {
  scheduler: '角色调度',
  knowledge: '设定知识',
  status: '状态规则',
  activities: '活动规则',
  communication: '通信规则',
  autonomy: '自主策略',
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

/** One line per module that differs. The first time a save opens there is nothing to compare with. */
export function pluginSetChanges(previous: PluginSetRecord | undefined, current: PluginSetRecord): string[] {
  if (!previous) return []
  return Object.keys({ ...previous.seams, ...current.seams }).flatMap(seam => {
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
}

/** What this save last ran with. A missing or damaged record only means there is nothing to compare. */
export function readPluginSet(directory: string): PluginSetRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, FILE), 'utf8')) as PluginSetRecord
    if (!value || typeof value.seams !== 'object' || value.seams === null) return undefined
    for (const entries of Object.values(value.seams))
      if (!Array.isArray(entries) || entries.some(entry => typeof entry?.id !== 'string')) return undefined
    return value
  } catch {
    return undefined
  }
}

export function writePluginSet(directory: string, record: PluginSetRecord): void {
  const path = join(directory, FILE)
  writeFileSync(path + '.tmp', JSON.stringify(record))
  renameSync(path + '.tmp', path)
}
