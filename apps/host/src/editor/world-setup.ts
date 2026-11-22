import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  configCandidates,
  configObject,
  type ConfigObject,
  type ConfigRecords,
  type SetupKind,
} from '@perspectra/world-pack/editor-config'
import { setupSchemas } from './world-setup-schema.ts'
import { EditConflict, manifest, manifestFile, packPath } from './project.ts'
import { acquireSourceLock, writeAtomic } from './source-files.ts'
import { worldRecords } from './world-records.ts'
import { buildSource } from './export.ts'
const read = (root: string, file: string): ConfigObject => JSON.parse(readFileSync(packPath(root, file), 'utf8'))
const print = (v: unknown) => JSON.stringify(v, null, 2) + '\n'
function kindOf(v: unknown): SetupKind {
  if (typeof v !== 'string' || !Object.hasOwn(setupSchemas, v)) throw new TypeError('请选择世界、人物设定、认知或记忆')
  return v as SetupKind
}
function sourceRow(root: string, kind: SetupKind, character: unknown) {
  const m = manifest(root)
  if (kind === 'world') {
    const document = read(root, m.worldFile)
    return { file: m.worldFile, document, data: document, index: -1, register: false }
  }
  const list = kind === 'portrayal' ? m.characterFiles : kind === 'memory' ? m.memoryFiles : m.cognitionFiles
  const sources = list.map(file => ({ file, document: read(root, file) }))
  for (const { file, document } of sources) {
    if (!Array.isArray(document.characters)) throw new TypeError('角色列表无效：' + file)
    const index = document.characters.findIndex(r => configObject(r).characterId === character)
    if (index >= 0) {
      const row = configObject(document.characters[index])
      return { file, document, index, data: kind === 'portrayal' ? configObject(row.portrayal) : row, register: false }
    }
  }
  if (kind === 'portrayal') throw new TypeError('请选择已有角色')
  const data: ConfigObject = kind === 'memory' ? { profile: 'standard' } : {}
  if (sources[0]) return { ...sources[0], index: -1, data, register: false }
  let file = 'creator-' + kind + '.json'
  for (let i = 2; existsSync(packPath(root, file)); i++) file = 'creator-' + kind + '-' + i + '.json'
  return {
    file,
    document: { schemaVersion: kind === 'memory' ? 'worldpack-memory/v2' : 'worldpack-cognition/v2', characters: [] },
    index: -1,
    data,
    register: true,
  }
}
function selectedFields(data: ConfigObject, kind: SetupKind): ConfigObject {
  return Object.fromEntries(Object.entries(data).filter(([key]) => Object.hasOwn(setupSchemas[kind].properties!, key)))
}
export function worldSetup(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    kind = kindOf(body.kind ?? 'world'),
    { records } = worldRecords(root)
  const named = (type: string) => records.filter(r => r.kind === type).map(({ id, name }) => ({ id, name }))
  const characters = named('character')
  if (kind !== 'world' && !characters.some(c => c.id === body.character)) throw new TypeError('请选择已有角色')
  const row = sourceRow(root, kind, body.character)
  const refs: ConfigRecords = {
    characters,
    items: named('item'),
    locations: named('location'),
    player: String(records.find(r => r.kind === 'slot')?.values.characterId ?? ''),
    markdown: [...manifest(root).markdownFiles],
  }
  if (kind === 'cognition') {
    const portrayal = sourceRow(root, 'portrayal', body.character).data
    refs.portrayalTerms = [portrayal.drives, portrayal.principles].flatMap(rows =>
      Array.isArray(rows) ? rows.map(configObject).map(r => ({ id: String(r.key), name: String(r.text) })) : [],
    )
  }
  return { kind, file: row.file, config: selectedFields(row.data, kind), schema: setupSchemas[kind], records: refs }
}
export function setupCandidates(root: string, body: Record<string, unknown>) {
  const b = worldSetup(root, body)
  if (!Array.isArray(body.path) || !body.path.every(k => typeof k === 'string')) throw new TypeError('需要字段路径数组')
  return { options: configCandidates(b.kind, configObject(body.config ?? b.config), b.records, body.path) ?? null }
}
export async function saveSetup(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    kind = kindOf(body.kind),
    release = acquireSourceLock(root)
  try {
    const book = worldSetup(root, body),
      row = sourceRow(root, kind, body.character),
      config = configObject(body.config)
    if (config !== body.config || Object.keys(config).some(k => !Object.hasOwn(book.schema.properties!, k)))
      throw new TypeError('设置内容或字段无效')
    if (book.file !== body.file || !isDeepStrictEqual(book.config, body.base))
      throw new EditConflict(book.file, body.base, book.config, config)
    const original = row.document
    const next = { ...row.data }
    for (const key of Object.keys(book.schema.properties!)) delete next[key]
    Object.assign(next, config)
    const doc: ConfigObject = kind === 'world' ? next : structuredClone(original)
    if (kind !== 'world') {
      const rows = doc.characters
      if (!Array.isArray(rows)) throw new TypeError('角色列表无效')
      if (kind === 'portrayal') rows[row.index] = { ...configObject(rows[row.index]), portrayal: next }
      else if (row.index >= 0) rows[row.index] = next
      else rows.push({ ...next, characterId: String(body.character) })
    }
    const manifestBefore = row.register ? read(root, manifestFile) : undefined
    const manifestAfter = manifestBefore && { ...manifestBefore, [kind + 'Files']: [row.file] }
    const data = print(doc),
      stage = mkdtempSync(join(tmpdir(), 'perspectra-setup-'))
    try {
      await buildSource(root, stage, undefined, target => {
        writeAtomic(target, row.file, data)
        if (manifestAfter)
          writeAtomic(target, manifestFile, print({ ...read(target, manifestFile), [kind + 'Files']: [row.file] }))
      })
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
    const latest = sourceRow(root, kind, body.character)
    if (
      latest.file !== row.file ||
      latest.register !== row.register ||
      !isDeepStrictEqual(original, latest.document) ||
      (manifestBefore && !isDeepStrictEqual(manifestBefore, read(root, manifestFile)))
    )
      throw new EditConflict(row.file, body.base, selectedFields(latest.data, kind), config)
    writeAtomic(root, row.file, data)
    if (manifestAfter)
      try {
        writeAtomic(root, manifestFile, print(manifestAfter))
      } catch (e) {
        rmSync(packPath(root, row.file))
        throw e
      }
    return worldSetup(root, body)
  } finally {
    release()
  }
}
