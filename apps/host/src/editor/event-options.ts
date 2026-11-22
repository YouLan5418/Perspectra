import { compileWorldPackSource, type CompiledWorldPackV5 } from '@perspectra/world-pack'
import { MissingCapabilityError } from '../host-capabilities.ts'
import { officialPackContent, officialPackPlugins, statusAuthorFields } from '../official-pack-metadata.ts'
import { PackModules } from '../runtime/pack-modules.ts'
import { loadStatusSource } from '../runtime/status-source.ts'
import { loadPackContent, type PackContent } from '../runtime/pack-content.ts'
import { ruleSources, type RuleRow } from './rule-source.ts'
import { worldRecords } from './world-records.ts'
import { manifest } from './project.ts'
import { eventVariables } from '@perspectra/world-pack/editor-fields'
export function editorStatusOperations(root: string, pack: CompiledWorldPackV5, content: PackContent | undefined) {
  let modules: PackModules | undefined,
    warning = ''
  try {
    modules = PackModules.load(root, pack, undefined, content?.statusModules)
  } catch (e) {
    if (!(e instanceof MissingCapabilityError)) throw e
    warning = '部分模块操作需要宿主能力：' + e.capability
  }
  return { ...statusAuthorFields(loadStatusSource(root, pack, modules?.sources)), warning }
}
export async function eventOptions(root: string) {
  const pack = await compileWorldPackSource(root, []),
    content = loadPackContent(root, pack, officialPackContent, officialPackPlugins)
  try {
    const { variables, events, eventBook } = ruleSources(root),
      { operations, warning } = editorStatusOperations(root, pack, content)
    const all = worldRecords(root).records,
      player = all.find(r => r.kind === 'slot')?.values.characterId
    const choices = (kind: string) => all.filter(r => r.kind === kind).map(({ id, name }) => ({ id, name }))
    const grants = eventBook.grants ?? []
    return {
      grants,
      plugins: [...new Set([...Object.keys(pack.plugins ?? {}), ...grants.map(g => g.plugin)])],
      locations: choices('location'),
      items: choices('item'),
      actors: choices('character').filter(r => r.id !== player),
      types: [...new Set([...events.map(r => r.type), ...grants.map(g => g.type)])],
      writes: eventVariables(variables),
      days: variables.filter(v => !v.activities && v.type === 'number'),
      periods: variables.filter(v => !v.activities && v.type === 'string'),
      clocks: events.flatMap(e => (e.when ? [e.when.crossesPackTime] : [])),
      operations,
      warning,
    }
  } finally {
    content?.close()
  }
}
export async function checkNoticeOperations(root: string, body: Record<string, unknown>) {
  if (body.kind !== 'event') return
  const previous = (body.base as RuleRow | null)?.sceneNotices ?? []
  const selected =
    (body.row as RuleRow | undefined)?.sceneNotices?.flatMap(n => (n.fromOperation ? [n.fromOperation] : [])) ?? []
  if (!selected.length) return
  const { operations, warning } = await eventOptions(root)
  for (const id of selected)
    if (!operations.some(op => op.id === id) && !(warning && previous.some(n => n.fromOperation === id)))
      throw new TypeError('找不到通知来源操作：' + id)
}
export function eventReferences(root: string, kind: unknown, id: unknown) {
  if (typeof id !== 'string' || (kind !== 'character' && kind !== 'location')) throw new TypeError('请选择角色或地点')
  return ruleSources(root).events.flatMap(e => {
    const fields =
      kind === 'character'
        ? e.wakeCharacters?.includes(id)
          ? ['唤醒角色']
          : []
        : [
            ...(e.location === id ? ['发生地点'] : []),
            ...(e.sceneNotices?.some(n => n.locations.includes(id)) ? ['通知地点'] : []),
          ]
    return fields.length ? [{ section: 'rules' as const, id: e.id, label: e.id + ' › ' + fields.join('、') }] : []
  })
}
export async function validateExportedEvents(root: string) {
  if (!manifest(root).plugins?.['official-world-events']) return
  const { events, eventBook, variables } = ruleSources(root)
  const status = (key: string, type: string) => variables.some(v => v.key === key && v.type === type && !v.activities)
  for (const key of [
    ...events.map(e => e.set.key),
    ...(eventBook.grants ?? []).flatMap(g => (g.effect ? [g.effect.key] : [])),
  ])
    if (!status(key, 'boolean')) throw new TypeError('世界事件写入状态不存在：' + key)
  for (const e of events) {
    const c = e.when?.crossesPackTime
    if (c && (!status(c.dayKey, 'number') || !status(c.slotKey, 'string')))
      throw new TypeError(e.id + ' › 日历变量不存在或类型不匹配')
  }
  const sources = events.flatMap(e => e.sceneNotices?.flatMap(n => (n.fromOperation ? [n.fromOperation] : [])) ?? [])
  if (sources.length) {
    const { operations, warning } = await eventOptions(root)
    if (!warning)
      for (const id of sources)
        if (!operations.some(op => op.id === id)) throw new TypeError('找不到通知来源操作：' + id)
  }
}
