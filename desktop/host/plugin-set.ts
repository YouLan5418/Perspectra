import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginSetRecord {
  readonly seams: Readonly<Record<string, readonly { readonly id: string; readonly version: string }[]>>
}

const FILE = 'plugin-set.json'
const LABELS: Readonly<Record<string, string>> = {
  scheduler: '角色调度',
  memory: '长期记忆',
  llm: '模型通道',
  decisions: '角色决策',
  rules: '世界规则',
}

const named = (entries: PluginSetRecord['seams'][string] | undefined) =>
  entries?.length ? entries.map(entry => `${entry.id} ${entry.version}`).join('、') : '无'

/** One line per module that differs. The first time a save opens there is nothing to compare with. */
export function pluginSetChanges(previous: PluginSetRecord | undefined, current: PluginSetRecord): string[] {
  if (!previous) return []
  return Object.keys({ ...previous.seams, ...current.seams }).flatMap(seam => {
    const before = named(previous.seams[seam]),
      after = named(current.seams[seam])
    return before === after ? [] : [`${LABELS[seam] ?? seam}：${before} → ${after}`]
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
