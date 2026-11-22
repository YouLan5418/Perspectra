import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  parseWorldVariable,
  type WorldVariableDefinition as EditorVariable,
  type WorldVariable,
} from '@perspectra/world-pack/editor-fields'
import { baseStatusFields, basePacingEvents } from '../official-pack-metadata.ts'
import { manifest, packPath } from './project.ts'
import type { EventGrant, PackTimeThreshold, Witness } from '@perspectra/sdk'

export interface RuleRow {
  id: string
  type: string
  location: string
  observation: string
  round?: number
  when?: { crossesPackTime: PackTimeThreshold }
  trigger?: 'hard' | 'paced'
  duringActivity?: boolean
  audience?: Witness | { anyOf: Witness[] }
  wakeCharacters?: string[]
  sceneNotices?: { locations: string[]; text?: string; fromOperation?: string }[]
  set: { key: string; value: boolean }
}
export interface PaceRow {
  id: string
  intensity: 'low' | 'medium' | 'high'
}
export interface RuleEdits {
  variables: EditorVariable[]
  events: RuleRow[]
  pacing: PaceRow[]
  grants?: EventGrant[]
}
export const rulesFile = 'creator-rules.json'
export const freshEdits = (): RuleEdits => ({ variables: [], events: [], pacing: [] })
export function ruleEdits(root: string): RuleEdits {
  const file = packPath(root, rulesFile)
  if (!existsSync(file)) return freshEdits()
  const data = JSON.parse(readFileSync(file, 'utf8')) as RuleEdits
  if (!data || !Array.isArray(data.variables) || !Array.isArray(data.events) || !Array.isArray(data.pacing))
    throw new TypeError('规则草稿格式无效')
  return { ...data, variables: data.variables.map(parseWorldVariable) }
}
function byKey<T>(first: readonly T[], second: readonly T[], key: (v: T) => string): T[] {
  return [...new Map([...first, ...second].map(row => [key(row), row])).values()]
}
const statusFile = 'scripts/status.js',
  paceFile = 'scripts/pacing.js',
  eventFile = 'world-events.json'
const marker = '\n// Perspectra creator declarations\n;{\nconst records = '
const defaultStatus =
  'globalThis.statusScript = {definition:{statuses:[],operations:[]},initialize(ids){return {public:{},characters:Object.fromEntries(ids.map(id=>[id,{}]))}}}\n'
const defaultPace =
  'globalThis.pacingScript = {definition:{cycleRounds:8,chance:1,cooldownRounds:{low:0,medium:0,high:0},recoveryRounds:0}}\n'
function suffix(file: string, rows: EditorVariable[] | PaceRow[]) {
  const body =
    file === statusFile
      ? `const script = statusScript
const original = script.initialize
script.definition.statuses = [...script.definition.statuses, ...records.map(v=>({
  key:v.key,label:v.label,type:v.type,owner:'public',alwaysKnown:v.alwaysKnown!==false,
  ...(v.options ? {schema:{type:'string',enum:v.options}} : {})
}))]
script.initialize = function(...args) {
  const state = original.apply(this,args)
  return {...state,public:{...state.public,...Object.fromEntries(records.map(v=>[v.key,v.initial]))}}
}`
      : `const definition=pacingScript.definition
definition.events={...definition.events,...Object.fromEntries(records.map(row=>[row.id,{intensity:row.intensity}]))}`
  return marker + JSON.stringify(rows) + '\n' + body + '\n}\n'
}
function split<T extends EditorVariable | PaceRow>(file: string, text: string) {
  const start = [...text.matchAll(/\r?\n\/\/ Perspectra creator declarations\r?\n;\{\r?\nconst records = /g)].at(
    -1,
  )?.index
  if (start !== undefined) {
    const normalized = text.slice(start).replaceAll('\r\n', '\n')
    try {
      const rows = JSON.parse(normalized.slice(marker.length).split('\n', 1)[0]!) as T[]
      if (Array.isArray(rows) && normalized === suffix(file, rows as EditorVariable[])) {
        const original = text.slice(0, start)
        return { original, rows }
      }
    } catch {
      /* Hand edits make the entire script author-owned. */
    }
  }
  return { original: text, rows: [] as T[] }
}
function selected(root: string, file: string, plugin: string) {
  const m = manifest(root)
  return m.assetFiles.includes(file) && m.plugins?.[plugin] ? readFileSync(packPath(root, file), 'utf8') : ''
}
export function ruleSources(root: string, edits = ruleEdits(root)) {
  const status = split<EditorVariable>(statusFile, selected(root, statusFile, 'pack-scripts'))
  const pace = split<PaceRow>(paceFile, selected(root, paceFile, 'official-pacing'))
  const eventText = selected(root, eventFile, 'official-world-events')
  const eventBook = (eventText ? JSON.parse(eventText) : { rules: [] }) as { rules: RuleRow[]; grants?: EventGrant[] }
  if (edits.grants) eventBook.grants = edits.grants
  const definitions = status.original ? baseStatusFields(status.original) : []
  const inherited: WorldVariable[] = definitions.flatMap(v => {
    if (v.owner !== 'public' || (v.type !== 'number' && v.type !== 'string' && v.type !== 'boolean')) return []
    const options = v.schema?.enum
    const choices =
      Array.isArray(options) && options.every(s => typeof s === 'string') ? (options as string[]) : undefined
    const simple =
      Object.keys(v.schema ?? {}).every(k => k === 'type' || k === 'enum') && (options === undefined || !!choices)
    return [
      {
        key: v.key,
        label: v.label,
        type: v.type,
        initial: choices?.[0] ?? (v.type === 'number' ? 0 : v.type === 'boolean' ? false : ''),
        ...(choices ? { options: choices } : {}),
        editable: false,
        readable: v.alwaysKnown === true,
        writable: simple,
        ...(v.activities ? { activities: v.activities } : {}),
      },
    ]
  })
  const managed = byKey(status.rows, edits.variables, v => v.key).map(parseWorldVariable)
  if (managed.length + definitions.length > 64) throw new TypeError('基础状态声明最多 64 项')
  if (managed.some(v => definitions.some(d => d.key === v.key))) throw new TypeError('变量键已由原脚本声明')
  const variables: WorldVariable[] = [
    ...inherited,
    ...managed.map(v => ({ ...v, editable: true, readable: v.alwaysKnown !== false, writable: true })),
  ]
  const originalPacing = pace.original ? basePacingEvents(pace.original) : []
  const managedPacing = byKey(pace.rows, edits.pacing, v => v.id)
  const pacing = byKey(originalPacing, managedPacing, v => v.id)
  const events = byKey(eventBook.rules, edits.events, v => v.id)
  return { variables, events, pacing, managed, managedPacing, status, pace, eventBook, eventText }
}
export function ruleCatalog(root: string, edits = ruleEdits(root)) {
  const { variables, events, pacing } = ruleSources(root, edits)
  return { variables, events, pacing }
}
export function materializeRules(
  root: string,
  target: string,
  assets: Set<string>,
  raw: { plugins?: Record<string, unknown> },
  edits: RuleEdits,
) {
  if (!(edits.variables.length || edits.pacing.length || edits.events.length || edits.grants)) return
  const s = ruleSources(root, edits)
  function write(file: string, plugin: string, source: string) {
    const path = packPath(root, file)
    if (existsSync(path) && (!assets.has(file) || !raw.plugins?.[plugin]))
      throw new TypeError('已有未启用的源文件，请先在清单中核对并启用：' + file)
    if (
      plugin === 'pack-scripts' &&
      !raw.plugins?.[plugin] &&
      [...assets].some(f => f === 'plugins.json' || f === 'scripts/activity.js' || f.startsWith('scripts/activities/'))
    )
      throw new TypeError('请先核对并启用包内已有活动脚本')
    raw.plugins = { ...raw.plugins, [plugin]: raw.plugins?.[plugin] ?? {} }
    const out = packPath(target, file)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, source)
    assets.add(file)
  }
  if (edits.variables.length)
    write(statusFile, 'pack-scripts', (s.status.original || defaultStatus) + suffix(statusFile, s.managed))
  if (edits.pacing.length)
    write(paceFile, 'official-pacing', (s.pace.original || defaultPace) + suffix(paceFile, s.managedPacing))
  if (edits.events.length || edits.grants)
    write(eventFile, 'official-world-events', JSON.stringify({ ...s.eventBook, rules: s.events }, null, 2) + '\n')
}
