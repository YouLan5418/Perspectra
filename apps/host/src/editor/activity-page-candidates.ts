import { readFileSync, realpathSync } from 'node:fs'
import type { PlayerView } from '@perspectra/frontend'
import type { PageField, PageStep } from '../runtime/activity-page-rules.ts'
import { activityAssetPath } from '../runtime/activity-pages.ts'
import { readPageElements } from '../runtime/activity-page-elements.ts'
import { packPath, readProject } from './project.ts'
import { packActivityCatalog } from '../runtime/activity-page-catalog.ts'
import { withDraftActivities } from './activity-pages.ts'
import { openPageTrial } from './activity-page-preview.ts'

export interface PageFieldChoice {
  field: PageField
  label: string
  type: 'boolean' | 'number' | 'string'
  options?: string[]
}
function projectedFields(view: PlayerView) {
  const choices: PageFieldChoice[] = []
  const labels: Record<string, string> = { units: '参战单位', hp: '生命', maxHp: '生命上限', round: '回合' }
  function visit(source: 'stage' | 'public' | 'personal', value: unknown, path: PageStep[], label: string) {
    if (!value || typeof value !== 'object' || path.length >= 32) return
    if (Array.isArray(value)) {
      const counts = { id: new Map<string, number>(), key: new Map<string, number>() }
      for (const row of value) {
        for (const by of ['id', 'key'] as const) {
          const id = row?.[by]
          if (typeof id === 'string') counts[by].set(id, (counts[by].get(id) ?? 0) + 1)
        }
      }
      for (const row of value) {
        if (!row || typeof row !== 'object') continue
        const by = (['id', 'key'] as const).find(k => counts[k].get(row[k]) === 1)
        if (by) visit(source, row, [...path, { by, is: row[by] }], label + ' / ' + (row.name || row.label || row[by]))
      }
      return
    }
    const obj = value as Record<string, unknown>
    for (const [key, v] of Object.entries(obj)) {
      const next = [...path, key],
        caption = label + ' / ' + (Object.hasOwn(labels, key) ? labels[key] : key),
        type = typeof v
      if (type === 'number' || type === 'string' || type === 'boolean') {
        choices.push({ field: { source, path: next }, label: caption, type })
        const maxKey = 'max' + key[0]?.toUpperCase() + key.slice(1)
        if (type === 'number' && typeof obj[maxKey] === 'number')
          choices.push({
            field: { source, path: next, relativeTo: maxKey },
            label: caption + '（百分比）',
            type: 'number',
          })
      } else visit(source, v, next, caption)
    }
  }
  visit('stage', view.activityStage?.payload, [], '舞台')
  visit('public', view.activity?.public, [], '活动共享')
  visit('personal', view.activity?.private, [], '玩家本人')
  return choices
}
export async function activityPageCandidates(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const root = realpathSync(source),
    key = body.key
  if (typeof key !== 'string' || !key) throw new TypeError('请选择活动')
  const targets = body.html
    ? readPageElements(readFileSync(packPath(root, 'frontend/' + activityAssetPath(body.html, 'html')), 'utf8')).targets
    : []
  const project = readProject(root),
    graph = project.graphs.find(g => g.key === key)
  const menu = graph
    ? { phases: ['choice'], operations: graph.choices.map(c => ({ id: 'activity:' + c.id, label: c.label })) }
    : withDraftActivities(root, await packActivityCatalog(root), project).get(key)
  if (!menu) throw new TypeError('找不到当前活动')
  const fields: PageFieldChoice[] = [
    {
      field: { source: 'phase' },
      label: '活动阶段',
      type: 'string',
      ...(menu.phases.length ? { options: [...menu.phases] } : {}),
    },
  ]
  for (const v of graph?.variables ?? []) {
    if (v.scope === 'internal') continue
    fields.push({
      field: { source: v.scope === 'shared' ? 'public' : 'personal', path: ['variables', v.key] },
      label: (v.scope === 'shared' ? '活动共享 · ' : '玩家本人 · ') + v.label,
      type: v.type,
      ...(v.options ? { options: v.options } : {}),
    })
  }
  for (const v of project.rules.variables)
    if (v.readable)
      fields.push({
        field: { source: 'world', key: v.key },
        label: '世界状态 · ' + v.label,
        type: v.type,
        ...(v.options ? { options: v.options } : {}),
      })
  for (const item of project.items)
    fields.push({ field: { source: 'held', key: item.id }, label: '玩家持有 · ' + item.name, type: 'boolean' })
  const ops = new Map(menu.operations.map(o => [o.id, o.label]))
  for (const l of project.locations) ops.set('move:' + l.id, '前往 · ' + l.name)
  let sampled = false
  if (body.trial === true) {
    const { sim, view } = await openPageTrial(root, body, signal)
    try {
      if (view.activity?.key === key) {
        sampled = true
        fields.push(...projectedFields(view))
        fields[0]!.options = [...new Set([...(fields[0]!.options ?? []), view.activity.phase])]
        for (const o of view.actions)
          if (o.kind === 'activity' && o.target?.kind === 'activity' && o.target.id === key) {
            const id = (o.action.parameters.definitionRef as { id?: string })?.id
            if (id) ops.set(id, o.label)
          }
      }
      for (const v of view.statusBar ?? [])
        if (v.current && v.holderId === null && ['string', 'number', 'boolean'].includes(typeof v.value))
          fields.push({
            field: { source: 'world', key: v.key },
            label: '世界状态 · ' + v.label,
            type: typeof v.value as PageFieldChoice['type'],
          })
    } finally {
      await sim.close()
    }
  }
  const operations = Array.from(ops, ([id, label]) => ({ id, label }))
  for (const o of operations)
    fields.push({ field: { source: 'available', key: o.id }, label: '操作可用 · ' + o.label, type: 'boolean' })
  const unique = new Map<string, PageFieldChoice>()
  for (const choice of fields) {
    const id = JSON.stringify(choice.field)
    if (!unique.has(id)) unique.set(id, choice)
  }
  return { targets, fields: [...unique.values()], operations, sampled }
}
