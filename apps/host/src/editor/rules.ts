import { checkKnowledgeVariable } from './knowledge.ts'
import { writeAtomic } from './source-files.ts'
import { eventOptions, checkNoticeOperations } from './event-options.ts'
import { conditionReferences } from './activity-graph.ts'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parseEventBook, type EventGrant } from '@perspectra/sdk'
import {
  parseWorldVariable,
  variableCandidates,
  eventVariables,
  type EditorVariable,
} from '@perspectra/world-pack/editor-fields'
import { readProject, packPath, EditConflict, validateReferences, type EditorProject } from './project.ts'
import { worldRecords } from './world-records.ts'
import { ruleEdits, ruleSources, rulesFile, type RuleRow, type PaceRow } from './rule-source.ts'
import { runEditorAgent } from './assistant.ts'

export function ruleCandidates(project: EditorProject, field: unknown, activity?: unknown) {
  const { variables, events } = project.rules
  if (field === 'pacing')
    return events.map(e => ({
      id: e.id,
      label: e.observation,
      eligible: e.trigger === 'paced',
      reason: e.trigger === 'paced' ? '' : '此处需要节奏触发的事件',
    }))
  if (field === 'event-set') return eventVariables(variables)
  if (field !== 'effect' && field !== 'condition') throw new TypeError('未知引用位置')
  const graph = project.graphs.find(g => g.key === activity)
  if (!graph) throw new TypeError('请指定当前活动')
  return variableCandidates(variables, graph.variables ?? [], graph.key, field)
}
export function ruleReferences(project: EditorProject, kind: unknown, id: unknown, activity?: unknown) {
  const found: {
    section: 'activity' | 'event' | 'pacing'
    id: string
    choice?: string
    field: string
    label: string
  }[] = []
  if (kind === 'local' || kind === 'world') {
    for (const g of project.graphs) {
      if (kind === 'local' && g.key !== activity) continue
      for (const c of g.choices)
        for (const { use, field, label } of [
          ...conditionReferences(c.condition),
          { use: c.effect, field: 'effect', label: '结果赋值' },
          { use: c.ruling?.target, field: 'ruling', label: '操作裁定' },
        ]) {
          if (use?.kind === kind && use.ref === id)
            found.push({
              section: 'activity',
              id: g.key,
              choice: c.id,
              field,
              label: [g.title, c.label, label].join(' › '),
            })
        }
    }
    if (kind === 'world')
      for (const e of project.rules.events) {
        const clock = (e.when as { crossesPackTime?: { dayKey: string; slotKey: string } } | undefined)?.crossesPackTime
        if (e.set.key === id) found.push({ section: 'event', id: e.id, field: 'set', label: e.id + ' › 写入状态' })
        if (clock && (clock.dayKey === id || clock.slotKey === id))
          found.push({ section: 'event', id: e.id, field: 'when', label: e.id + ' › 日历条件' })
      }
  } else if (kind === 'event') {
    if (project.rules.pacing.some(p => p.id === id))
      found.push({ section: 'pacing', id: String(id), field: 'id', label: '节奏配置 › ' + id })
  } else throw new TypeError('未知引用类型')
  return found
}
function replace<T>(rows: T[], row: T, match: (value: T) => boolean) {
  const i = rows.findIndex(match)
  if (i === -1) rows.push(row)
  else rows[i] = row
}
function baseRecord(project: EditorProject, kind: unknown, id: unknown) {
  if (kind === 'variable') {
    const v = project.rules.variables.find(r => r.key === id)
    if (v && !v.editable) throw new TypeError('此变量由源脚本声明，请在源脚本修改定义')
    return v ? parseWorldVariable(v) : null
  }
  if (kind !== 'event' && kind !== 'pacing') throw new TypeError('未知规则类型')
  return project.rules[kind === 'event' ? 'events' : 'pacing'].find(r => r.id === id) ?? null
}
export function saveRule(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    lock = packPath(root, '.perspectra-editor-save.lock'),
    temp = packPath(root, rulesFile + '.' + randomUUID() + '.tmp')
  const fd = openSync(lock, 'wx')
  try {
    const project = readProject(root),
      edits = ruleEdits(root)
    const { kind, base } = body
    const row = body.row as RuleRow & EditorVariable & PaceRow
    if (!row || typeof row !== 'object' || (kind === 'grants' && !Array.isArray(row)))
      throw new TypeError('缺少规则内容')
    const id = kind === 'grants' ? 'grants' : kind === 'variable' ? row.key : row.id
    const current =
      kind === 'grants' ? (ruleSources(root, edits).eventBook.grants ?? []) : baseRecord(project, kind, id)
    if (!isDeepStrictEqual(current, kind === 'variable' && base ? parseWorldVariable(base) : base))
      throw new EditConflict(String(id), base, current, row)
    if (kind === 'grants') edits.grants = body.row as EventGrant[]
    else if (kind === 'variable') replace(edits.variables, parseWorldVariable(row), v => v.key === id)
    else if (kind === 'event') replace(edits.events, row, v => v.id === id)
    else {
      if (typeof id !== 'string' || !['low', 'medium', 'high'].includes(row.intensity))
        throw new TypeError('请选择事件及其强度')
      replace(edits.pacing, { id, intensity: row.intensity }, v => v.id === id)
    }
    const data = ruleSources(root, edits)
    if (kind === 'variable') checkKnowledgeVariable(root, id, data.variables)
    const { records } = worldRecords(root)
    const ids = (k: string) => records.filter(r => r.kind === k).map(r => r.id)
    parseEventBook(
      { ...data.eventBook, rules: data.events },
      {
        locationIds: ids('location'),
        characterIds: ids('character'),
        entityIds: ids('item'),
        names: {},
        entityLocations: {},
        playerId: records.find(r => r.kind === 'slot')?.values.characterId as string,
      },
    )
    for (const e of data.events) {
      const clock = e.when?.crossesPackTime
      if (clock) {
        const day = data.variables.find(v => v.key === clock.dayKey && !v.activities && v.type === 'number')
        const period = data.variables.find(v => v.key === clock.slotKey && !v.activities && v.type === 'string')
        if (!day || !period) throw new TypeError(e.id + ' › 日历条件需要包级数字天数与文字时段')
        if (period.options && clock.slots.some(slot => !period.options!.includes(slot)))
          throw new TypeError(e.id + ' › 时段不在变量枚举中')
      }
      if (!eventVariables(data.variables).some(v => v.key === e.set.key))
        throw new TypeError(e.id + ' › 写入状态：需要包级公共布尔变量 ' + e.set.key)
    }
    for (const p of data.pacing)
      if (!data.events.some(e => e.id === p.id && e.trigger === 'paced'))
        throw new TypeError(p.id + ' › 节奏配置：此处需要节奏触发的事件')
    for (const g of data.eventBook.grants ?? [])
      if (g.effect && !eventVariables(data.variables).some(v => v.key === g.effect!.key))
        throw new TypeError(g.plugin + ' › 订阅写入状态需要包级公共布尔变量 ' + g.effect.key)
    for (const graph of project.graphs) validateReferences(graph, { ...project, rules: data })
    if (kind === 'grants' && data.eventText && !ruleEdits(root).grants) {
      // An imported book already has a destination; edit just grants and read the file again on every save.
      const original = JSON.parse(data.eventText)
      writeAtomic(
        root,
        'world-events.json',
        JSON.stringify({ ...original, grants: data.eventBook.grants }, null, 2) + '\n',
      )
      return { variables: data.variables, events: data.events, pacing: data.pacing }
    }
    writeFileSync(temp, JSON.stringify(edits, null, 2) + '\n', { flag: 'wx' })
    renameSync(temp, packPath(root, rulesFile))
    return { variables: data.variables, events: data.events, pacing: data.pacing }
  } finally {
    closeSync(fd)
    rmSync(temp, { force: true })
    rmSync(lock, { force: true })
  }
}
export async function assistRule(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  run = runEditorAgent,
) {
  const { provider, prompt, kind, id } = body
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择本机助手')
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new TypeError('请填写创作要求')
  const project = readProject(root),
    current = baseRecord(project, kind, id)
  if (
    !current ||
    !isDeepStrictEqual(current, kind === 'variable' && body.base ? parseWorldVariable(body.base) : body.base)
  )
    throw new TypeError('请先保存或刷新所选规则')
  const records = worldRecords(root)
    .records.filter(r => r.kind === 'character' || r.kind === 'location' || r.kind === 'item')
    .map(r => ({ id: r.id, kind: r.kind, name: r.name, controller: r.values.controllerClass }))
  const reply = await run(
    provider,
    '只返回 JSON 字段补丁，保留稳定标识。事件写入只选 eventVariables，节奏只选 eligible 事件。\n' +
      JSON.stringify({
        kind,
        current,
        records,
        eventVariables: ruleCandidates(project, 'event-set'),
        pacing: ruleCandidates(project, 'pacing'),
        ...(kind === 'event' ? { eventOptions: await eventOptions(root) } : {}),
        request: prompt,
      }),
    signal,
  )
  signal?.throwIfAborted()
  const patch = JSON.parse(
    reply
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/i, '')
      .replace(/\s*\x60\x60\x60$/, ''),
  )
  const row = { ...current, ...patch }
  if ((kind === 'variable' ? row.key : row.id) !== id) throw new TypeError('不能更换稳定标识')
  const change = { kind, base: current, row }
  await checkNoticeOperations(root, change)
  return saveRule(root, change)
}
