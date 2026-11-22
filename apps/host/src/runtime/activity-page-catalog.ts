import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ActivityStateRules } from '@perspectra/core'
import type { PackContent } from './pack-content.ts'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@perspectra/world-pack'
import { officialPackContent, officialPackPlugins, readActivityDefinition } from '../official-pack-metadata.ts'
import { loadActivitySource } from './activity-source.ts'
import { loadPackWeb } from './pack-frontend.ts'
import { activityPagesFile, type ActivityPage } from './activity-pages.ts'

import { readPageElements } from './activity-page-elements.ts'

export interface ActivityMenu {
  title: string
  operations: { id: string; label: string }[]
  phases: readonly string[]
}
export function readActivityMenus(root: string, pack: CompiledWorldPackV5, content: PackContent | undefined) {
  const menus = new Map<string, ActivityMenu>()
  for (const entry of loadActivitySource(root, pack, content?.activities)?.entries ?? []) {
    const native = 'activity' in entry
    const phases = native ? entry.activity.phases : undefined
    const rules = new ActivityStateRules(
      native ? entry.activity.definition : readActivityDefinition(entry),
      pack.content.playerSlots[0]?.characterId ?? '',
      entry.key,
      phases,
    )
    const operations = rules.operations.map(o => ({ id: 'activity:' + o.id, label: o.label }))
    if (rules.handoff) operations.push({ id: 'host:activity-handoff', label: rules.handoff.label })
    menus.set(entry.key, { title: rules.title, phases: phases ?? [], operations })
  }
  for (const d of content?.gameplay ?? [])
    for (const a of d.activities ?? []) {
      menus.set(a.key, {
        title: a.title,
        phases: a.behavior?.phases ?? [],
        operations: a.operations.map(o => ({ id: 'activity:' + o.id, label: o.label })),
      })
    }
  return menus
}
export async function packActivityCatalog(root: string) {
  const pack = await compileWorldPackSource(root, [])
  const { loadPackContent } = await import('./pack-content.ts')
  const content = loadPackContent(root, pack, officialPackContent, officialPackPlugins)
  try {
    return readActivityMenus(root, pack, content)
  } finally {
    content?.close()
  }
}
export function checkPageOperations(
  page: ActivityPage,
  menu: ActivityMenu,
  layout: ReturnType<typeof readPageElements>,
) {
  const ids = new Set(menu.operations.map(o => o.id))
  const overridden = new Set(page.elements?.filter(el => el.operation).map(el => el.id))
  for (const button of layout.buttons) {
    if ((!button.id || !overridden.has(button.id)) && !ids.has(button.operation))
      throw new TypeError('活动中找不到 HTML 按钮操作：' + button.operation)
  }
  for (const el of page.elements ?? []) {
    const selected = [
      el.operation,
      ...(el.rules ?? []).map(r => (r.field.source === 'available' ? r.field.key : undefined)),
    ]
    for (const op of selected) if (op && !ids.has(op)) throw new TypeError('活动中找不到操作：' + op)
  }
}
// CLI authoring validation reads static frontend assets without instantiating gameplay.
export async function loadBoundFrontend(root: string) {
  if (
    ![activityPagesFile, 'frontend/stage.json', 'frontend/components.json'].some(file => existsSync(join(root, file)))
  )
    return undefined
  return loadPackWeb(root)
}
export async function validateExportedPages(root: string) {
  const frontend = await loadBoundFrontend(root)
  if (!frontend) return
  const stage = frontend.stage
  if (stage && Object.keys(stage.characters).length) {
    const pack = await compileWorldPackSource(root, [])
    const ids = new Set<string>(pack.content.characters.map(c => c.characterId))
    for (const id of Object.keys(stage.characters)) if (!ids.has(id)) throw new TypeError('舞台角色不存在：' + id)
  }
  const entries = Object.entries(frontend.activityPages ?? {})
  if (!entries.length && !stage?.autoplay) return
  const menus = await packActivityCatalog(root)
  if (
    stage?.autoplay &&
    !menus.get(stage.autoplay.activity)?.operations.some(op => op.id === 'activity:' + stage.autoplay!.operation)
  )
    throw new TypeError('开场活动中找不到推进操作')
  for (const [key, page] of entries) {
    const menu = menus.get(key)
    if (!menu) throw new TypeError('页面绑定的活动不存在：' + key)
    const html = frontend.assets.get('/frontend/custom/' + page.html)!.bytes.toString('utf8')
    checkPageOperations(page, menu, readPageElements(html))
  }
}
