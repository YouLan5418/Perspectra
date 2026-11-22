import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import {
  parseWorldPackCharactersSourceV3,
  parseWorldPackLocationsSource,
  parseWorldPackEntitiesSourceV2,
  parseWorldPackScenesSourceV2,
  parseWorldPackPlayerSlotsSource,
} from '@perspectra/world-pack'
import { locked, writeAtomic } from './source-files.ts'
import { presetReferences } from './presets.ts'
import { EditConflict, manifest, manifestFile, packPath } from './project.ts'
import {
  fields,
  kinds,
  openingLocationIssues,
  openScenesByLocation,
  sceneBindingIssues,
  recordKind,
  referenceCandidates,
  referencesTo,
  type RecordKind,
  type Values,
  type WorldRecord,
} from '@perspectra/world-pack/editor-fields'

const layouts = {
  character: {
    files: 'characterFiles',
    list: 'characters',
    id: 'characterId',
    parse: parseWorldPackCharactersSourceV3,
  },
  location: { files: 'locationFiles', list: 'locations', id: 'locationId', parse: parseWorldPackLocationsSource },
  item: { files: 'entityFiles', list: 'entities', id: 'entityId', parse: parseWorldPackEntitiesSourceV2 },
  scene: { files: 'sceneFiles', list: 'scenes', id: 'sceneId', parse: parseWorldPackScenesSourceV2 },
  slot: { files: 'playerSlotFiles', list: 'playerSlots', id: 'slotId', parse: parseWorldPackPlayerSlotsSource },
} as const
type Row = Record<string, unknown>
function read(root: string, file: string): Row {
  return JSON.parse(readFileSync(packPath(root, file), 'utf8')) as Row
}
function value(row: Row, key: string) {
  const [parent, child] = key.split('.')
  return child ? (row[parent!] as Row | undefined)?.[child] : row[key]
}
function toRecord(kind: RecordKind, file: string, row: Row): WorldRecord {
  const id = String(row[layouts[kind].id])
  const values = Object.fromEntries(fields[kind].map(f => [f.key, value(row, f.key) ?? (f.many ? [] : '')])) as Values
  if (kind === 'character') values.controllerClass = String(row.controllerClass)
  return { kind, file, id, name: String(row.displayName ?? row.name ?? id), values }
}
export function worldRecords(source: string) {
  const root = realpathSync(source),
    m = manifest(root),
    records: WorldRecord[] = []
  for (const kind of kinds) {
    const layout = layouts[kind]
    for (const file of m[layout.files]) {
      const doc = read(root, file)
      layout.parse(doc, file)
      for (const raw of doc[layout.list] as Row[]) records.push(toRecord(kind, file, raw))
    }
  }
  for (const r of records) {
    if (r.kind === 'scene')
      r.name = records.find(v => v.kind === 'location' && v.id === r.values.locationId)?.name ?? r.id
    if (r.kind === 'slot')
      r.name = records.find(v => v.kind === 'character' && v.id === r.values.characterId)?.name ?? r.id
  }
  return {
    packId: m.packId,
    title: String(read(root, m.worldFile).title),
    enabledPlugins: Object.keys(m.plugins ?? {}),
    records,
    openingLocationIssues: openingLocationIssues(records),
    sceneBindingIssues: sceneBindingIssues(records),
  }
}
export function queryRecords(root: string, body: Record<string, unknown>) {
  const { records } = worldRecords(root),
    kind = recordKind(body.kind)
  if (body.operation === 'references') return referencesTo(records, kind, String(body.id))
  return referenceCandidates(records, kind, String(body.field)).map(({ id, name }) => ({ id, name }))
}
function valuesObject(input: unknown): Values {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('字段必须是对象')
  return input as Values
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function put(row: Row, k: string, v: string | string[]) {
  const [parent, child] = k.split('.')
  if (child) {
    const nested = { ...(row[parent!] as Row | undefined) }
    if (v === '') delete nested[child]
    else nested[child] = v
    if (Object.keys(nested).length) row[parent!] = nested
    else delete row[parent!]
  } else if (v === '') delete row[k]
  else row[k] = v
}
function atomicJson(root: string, file: string, doc: Row) {
  writeAtomic(root, file, JSON.stringify(doc, null, 2) + '\n')
}
/** Promote the new player before changing the slot, then release the previous manual roles. */
function writePlayerSelection(
  root: string,
  records: WorldRecord[],
  slotFile: string,
  slotDoc: Row,
  playerId: string,
  changed: boolean,
) {
  const actors = records.filter(r => r.kind === 'character')
  const player = actors.find(r => r.id === playerId)
  if (!player) throw new TypeError('请选择已有角色')
  const promote = player.values.controllerClass !== 'manual'
  if (changed || promote) {
    const plugins = manifest(root).plugins
    const autonomy = plugins?.['official-autonomy']
    if (autonomy) {
      const config = read(root, autonomy.config ?? 'autonomy.json')
      if (Array.isArray(config.characters) && config.characters.some(r => r?.characterId === playerId))
        throw new TypeError('请先在角色自主机会中移除将由玩家控制的角色：' + player.name)
    }
    const trpg = plugins?.['official-trpg']
    if (trpg) {
      const config = read(root, trpg.config ?? 'trpg.json')
      const bindings = []
      if (config.characters && typeof config.characters === 'object' && Object.hasOwn(config.characters, playerId))
        bindings.push('AI 角色卡')
      if (Array.isArray(config.hosts) && config.hosts.includes(playerId)) bindings.push('主持人')
      if (bindings.length) throw new TypeError('请先在 TRPG 中移除' + player.name + '的' + bindings.join('和') + '设置')
    }
    const refs = presetReferences(root, playerId)
    if (refs.length) throw new TypeError('请先移除角色的随包预设引用：' + refs.map(r => r.label).join('、'))
  }
  const written: { file: string; previous: Buffer }[] = []
  function write(file: string, doc: Row) {
    const previous = readFileSync(packPath(root, file))
    atomicJson(root, file, doc)
    written.push({ file, previous })
  }
  function setRoles(file: string, ids: Set<string>, role: 'manual' | 'scripted') {
    const doc = read(root, file)
    for (const row of doc.characters as Row[]) if (ids.has(String(row.characterId))) row.controllerClass = role
    layouts.character.parse(doc, file)
    write(file, doc)
  }
  try {
    if (promote) setRoles(player.file, new Set([playerId]), 'manual')
    if (changed) write(slotFile, slotDoc)
    const demote = actors.filter(r => r.id !== playerId && r.values.controllerClass === 'manual')
    for (const file of new Set(demote.map(r => r.file))) {
      setRoles(file, new Set(demote.filter(r => r.file === file).map(r => r.id)), 'scripted')
    }
  } catch (error) {
    for (const { file, previous } of written.reverse()) writeAtomic(root, file, previous)
    throw error
  }
}

/** Lock across files so reference and player eligibility checks see the same author edits. */
export function saveRecord(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source)
  return locked(root, () => saveRecordLocked(root, body))
}
export function saveLocationOpening(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source)
  return locked(root, () => {
    const { locationId, sceneId, participantIds } = body
    const { records } = worldRecords(root)
    if (typeof locationId !== 'string' || !records.some(r => r.kind === 'location' && r.id === locationId))
      throw new TypeError('请选择已有地点')
    if (!Array.isArray(participantIds) || participantIds.some(id => typeof id !== 'string'))
      throw new TypeError('请从角色列表中选择开局参与角色')
    const scenes = openScenesByLocation(records).get(locationId) ?? []
    if (scenes.length > 1)
      throw new TypeError('此地点绑定多个未关闭场景，请先修正场景配置：' + scenes.map(s => s.id).join('、'))
    const scene = scenes[0]
    if (sceneId !== (scene?.id ?? null))
      throw new EditConflict('地点的互动场景', sceneId, scene?.id ?? null, participantIds)
    if (scene) {
      const base = valuesObject(body.base)
      for (const key of ['locationId', 'lifecycle', 'participantIds']) {
        if (!same(base[key], scene.values[key]))
          throw new EditConflict(scene.id + '/' + key, base[key], scene.values[key], participantIds)
      }
    } else if (body.base !== null) throw new TypeError('新场景的 base 必须为 null')
    if (!participantIds.length && scene?.values.lifecycle !== 'active') return { scene: scene ?? null }
    const result = saveRecordLocked(root, {
      kind: 'scene',
      id: scene?.id,
      base: scene?.values ?? null,
      values: { locationId, participantIds, lifecycle: participantIds.length ? 'active' : 'created' },
    })
    return { scene: result.saved }
  })
}
function saveRecordLocked(root: string, body: Record<string, unknown>) {
  const kind = recordKind(body.kind),
    layout = layouts[kind]
  const create = body.base === null,
    base = create ? null : valuesObject(body.base),
    values = { ...valuesObject(body.values) }
  const prefix = kind === 'item' ? 'entity' : kind
  const id = body.id ?? (create ? prefix + ':' + randomUUID() : undefined)
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('缺少记录标识')
  if (kind === 'character' && Object.hasOwn(values, 'controllerClass')) {
    // Round-tripping a previously read record may include this read-only source value.
    if (values.controllerClass !== (create ? 'scripted' : base?.controllerClass))
      throw new TypeError('请在「玩家开局」选择玩家角色')
    delete values.controllerClass
  }
  if (Object.keys(values).some(k => !fields[kind].some(f => f.key === k))) throw new TypeError('包含不可编辑的字段')
  try {
    const m = manifest(root),
      { records } = worldRecords(root),
      current = records.find(r => r.kind === kind && r.id === id)
    if (create === !!current) throw new EditConflict(id, base, current?.values ?? null, values)
    if (create && kind === 'slot') throw new TypeError('每个包只有一个玩家开局，请修改已有玩家槽')
    const existingFile = current?.file ?? m[layout.files][0]
    if (!existingFile && kind !== 'item') throw new TypeError('源清单没有对应文档')
    const file = existingFile ?? 'entities-' + randomUUID() + '.json'
    const doc = existingFile ? read(root, file) : { schemaVersion: 'worldpack-entities/v2', entities: [] }
    const rows = doc[layout.list] as Row[]
    const row = current
      ? rows.find(x => x[layout.id] === id)!
      : { [layout.id]: id, ...(kind === 'character' ? { controllerClass: 'scripted' } : {}) }
    const changes: { field: string; before: string | string[] | null; after: string | string[] }[] = []
    for (const [key, next] of Object.entries(values)) {
      const field = fields[kind].find(f => f.key === key)!
      if (field.many ? !Array.isArray(next) || next.some(v => typeof v !== 'string') : typeof next !== 'string')
        throw new TypeError('请检查' + field.label)
      if (!create && !Object.hasOwn(base!, key)) throw new TypeError('缺少编辑前的值：' + field.label)
      if (!create && same(base![key], next)) continue
      const now = current?.values[key] ?? null
      if (!create && !same(now, base![key]) && !same(now, next))
        throw new EditConflict(id + '/' + key, base![key], now, next)
      if (same(now, next)) continue
      if (field.reference) {
        const allowed = new Set(referenceCandidates(records, kind, key).map(v => v.id))
        for (const ref of Array.isArray(next) ? next : next ? [next] : [])
          if (!allowed.has(ref)) throw new TypeError(field.label + '：不适用的引用 ' + ref)
      }
      put(row, key, next)
      changes.push({ field: key, before: now, after: next })
    }
    if (create) rows.push(row)
    if (kind === 'scene' && row.lifecycle === 'active') {
      const other = records.find(
        r =>
          r.kind === 'scene' &&
          r.id !== id &&
          r.values.lifecycle === 'active' &&
          (r.values.participantIds as string[]).some(
            x => Array.isArray(row.participantIds) && row.participantIds.includes(x),
          ),
      )
      if (other) throw new TypeError('角色已在另一个启用的场景中：' + other.name)
    }
    layout.parse(doc, file)
    if (kind === 'slot') writePlayerSelection(root, records, file, doc, String(row.characterId), changes.length > 0)
    else if (changes.length || create) atomicJson(root, file, doc)
    if (!existingFile) {
      try {
        const sourceManifest = read(root, manifestFile)
        sourceManifest[layout.files] = [file]
        atomicJson(root, manifestFile, sourceManifest)
      } catch (err) {
        rmSync(packPath(root, file), { force: true })
        throw err
      }
    }
    const saved = toRecord(kind, file, row)
    const undo =
      body.withUndo === true && current
        ? {
            kind,
            id,
            base: saved.values,
            values: Object.fromEntries(changes.map(c => [c.field, current.values[c.field]!])),
          }
        : undefined
    return { saved, changes, undo }
  } catch (error) {
    if (error instanceof EditConflict && base) error.recordCandidate = { base, values }
    throw error
  }
}
