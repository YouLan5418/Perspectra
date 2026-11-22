import { realpathSync } from 'node:fs'
import { conditionReferences } from './activity-graph.ts'
import { readProject } from './project.ts'
import { knowledgeReferences } from './knowledge.ts'
import { pageBindings } from './activity-pages.ts'
import { itemActions } from './item-actions.ts'
import { rpgBook } from './rpg.ts'

export interface ItemUse {
  section: 'location' | 'gameplay' | 'activity' | 'pages' | 'rules' | 'item' | 'knowledge'
  id: string
  field: string
  label: string
  choice?: string
}
function holds(audience: unknown, id: string): boolean {
  if (!audience || typeof audience !== 'object') return false
  if ('holds' in audience) return audience.holds === id
  return 'anyOf' in audience && Array.isArray(audience.anyOf) && audience.anyOf.some(a => holds(a, id))
}
export function itemUses(source: string, id: unknown) {
  const root = realpathSync(source),
    book = rpgBook(root),
    item = book.items.find(i => i.id === id)
  if (!item) throw new TypeError('请选择已有物品')
  const uses: ItemUse[] = [],
    project = readProject(root)
  uses.push(...knowledgeReferences(root, 'item', item.id))
  const place = (id: string) => book.locations.find(l => l.id === id)?.name ?? id
  if (item.location)
    uses.push({
      section: 'location',
      id: item.location,
      field: 'locationId',
      label: '起始地点 · ' + place(item.location),
    })
  const config = book.enabled ? book.config : null
  for (const map of config?.maps ?? []) {
    const add = (field: string, label: string) =>
      uses.push({ section: 'gameplay', id: map.locationId, field, label: place(map.locationId) + ' · ' + label })
    if (map.drops?.includes(item.id)) add('drops/' + item.id, '战斗胜利掉落')
    if (map.chest === item.id) add('chest', '宝箱物品')
    for (const exit of map.exits ?? [])
      if (exit.requires?.holds === item.id) add('exit/' + exit.to, '开锁后通往' + place(exit.to))
  }
  for (const [kind, label] of [
    ['equipment', '装备'],
    ['consumables', '消耗品'],
  ] as const)
    if (Object.hasOwn(config?.[kind] ?? {}, item.id))
      uses.push({ section: 'item', id: item.id, field: kind, label: 'RPG · ' + label })
  for (const g of project.graphs)
    for (const choice of g.choices)
      for (const { use, field, label } of conditionReferences(choice.condition))
        if (use.kind === 'held' && use.ref === item.id)
          uses.push({
            section: 'activity',
            id: g.key,
            field,
            choice: choice.id,
            label: g.title + ' › ' + choice.label + ' · 玩家持有' + (field === 'condition' ? '' : ' · ' + label),
          })
  for (const event of project.rules.events)
    if (holds(event.audience, item.id))
      uses.push({ section: 'rules', id: event.id, field: 'audience', label: event.id + ' · 持有人可观察事件' })
  for (const [key, page] of Object.entries(pageBindings(root)))
    for (const el of page.elements ?? [])
      if (el.rules?.some(r => r.field.source === 'held' && r.field.key === item.id))
        uses.push({ section: 'pages', id: key, field: el.id, label: key + ' › ' + el.id + ' · 页面持有条件' })
  return { item, uses, actions: itemActions(root, item.id) }
}
