import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
  mkdirSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual as same } from 'node:util'
import { parseWorldPackDocumentsSourceV2 } from '@perspectra/world-pack'
import { acceptsVariableValue, knowledgeEquality, type WorldVariable } from '@perspectra/world-pack/editor-fields'
import { readKnowledgeCondition } from '@perspectra/world-pack/editor-knowledge'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { KnowledgeSelection } from '../official-pack-metadata.ts'
import { manifest, packPath, EditConflict } from './project.ts'
import { ruleCatalog } from './rule-source.ts'
import { worldRecords } from './world-records.ts'
import { runEditorAgent } from './assistant.ts'
import type { EditorGraph } from './activity-graph.ts'

type Delivery = { constant: boolean; keywords: string[]; priority: number; when?: WorldJsonObject }
export interface KnowledgeRow {
  documentId: string
  usage: 'world_context' | 'portrayal'
  audience: 'public' | 'character_private'
  characterIds: string[]
  text: string
  delivery: Delivery | null
}
interface Change {
  base: KnowledgeRow | null
  row: KnowledgeRow
}
interface Draft {
  changes: Change[]
  budget?: { base: number; value: number }
}
const draftFile = 'creator-knowledge.json',
  configFile = 'knowledge.json',
  defaultBudget = 8000
function json(root: string, name: string) {
  return JSON.parse(readFileSync(packPath(root, name), 'utf8').replace(/^\uFEFF/, ''))
}
function readDraft(root: string): Draft {
  return existsSync(packPath(root, draftFile)) ? json(root, draftFile) : { changes: [] }
}
function sourceBook(root: string) {
  const m = manifest(root)
  const config = m.assetFiles.includes(configFile)
    ? json(root, configFile)
    : { maximumCharacters: defaultBudget, entries: [] }
  const docs = m.documentFiles.flatMap(file =>
    parseWorldPackDocumentsSourceV2(json(root, file), file).documents.map(doc => ({ ...doc, file })),
  )
  const texts = new Map<string, string>()
  const records = docs.flatMap((doc): KnowledgeRow[] => {
    if (
      (doc.usage !== 'world_context' && doc.usage !== 'portrayal') ||
      (doc.audience !== 'public' && doc.audience !== 'character_private')
    )
      return []
    if (!m.markdownFiles.includes(doc.contentRef)) throw new TypeError('正文未在清单登记：' + doc.contentRef)
    if (!texts.has(doc.contentRef)) texts.set(doc.contentRef, readFileSync(packPath(root, doc.contentRef), 'utf8'))
    return [
      {
        documentId: doc.documentId,
        usage: doc.usage,
        audience: doc.audience,
        characterIds: [...doc.characterIds],
        text: texts.get(doc.contentRef)!,
        delivery: null,
      },
    ]
  })
  const parsed = KnowledgeSelection.parse(config, {
    documents: docs,
    markdown: [...texts].map(([path, text]) => ({ path, text: compiledText(text) })),
  })
  const deliveries = new Map(parsed.entries.map(({ documentId, ...entry }) => [documentId, entry]))
  for (const row of records) row.delivery = deliveries.get(row.documentId) ?? null
  return { m, docs, config: parsed, records }
}
type SourceBook = ReturnType<typeof sourceBook>
export const compiledText = (text: string) => text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
function combined(source: SourceBook, draft: Draft) {
  const rows = new Map(source.records.map(row => [row.documentId, row]))
  for (const { base, row } of draft.changes) {
    if (!same(rows.get(row.documentId) ?? null, base))
      throw new TypeError('源知识文档在草稿创建后被修改，请核对 ' + row.documentId + ' 与 ' + draftFile)
    rows.set(row.documentId, row)
  }
  if (draft.budget && draft.budget.base !== source.config.maximumCharacters)
    throw new TypeError('知识预算在源文件中已更改')
  return {
    rows: [...rows.values()],
    maximumCharacters: (draft.budget?.value ?? source.config.maximumCharacters) as number,
  }
}
export function knowledgeCandidates(root: string) {
  const { records } = worldRecords(root)
  return {
    readers: records
      .filter(r => r.kind === 'character')
      .map(r => ({ id: r.id, name: r.name, scripted: r.values.controllerClass === 'scripted' })),
    variables: ruleCatalog(root).variables,
  }
}
export function knowledgeBook(source: string) {
  const root = realpathSync(source),
    book = sourceBook(root)
  return { ...combined(book, readDraft(root)), candidates: knowledgeCandidates(root) }
}
function checkCondition(row: KnowledgeRow, variables: WorldVariable[]) {
  const schema = row.delivery?.when
  for (const t of readKnowledgeCondition(schema)?.terms ?? []) {
    if (t.path.length !== 2 || t.path[0] !== 'public') continue
    const v = variables.find(v => v.key === t.path[1])
    // A composed expression may also refer to a native plugin field supplied by the full Host catalog.
    if (!v) continue
    if (
      t.comparison !== 'known' &&
      (['eq', 'ne'].includes(t.comparison) ? !acceptsVariableValue(v, t.value) : v.type !== 'number')
    )
      throw new TypeError(row.documentId + ' › 知识条件：变量不存在或值不匹配 ' + t.path[1])
  }
}
export function checkKnowledgeVariable(root: string, key: string, variables: WorldVariable[]) {
  for (const row of combined(sourceBook(root), readDraft(root)).rows)
    if (readKnowledgeCondition(row.delivery?.when)?.terms.some(t => t.path[0] === 'public' && t.path[1] === key))
      checkCondition(row, variables)
}
function encodeConfig(maximumCharacters: number, entries: unknown[]) {
  const data = { maximumCharacters, entries },
    limit = 1024 * 1024
  const readable = JSON.stringify(data, null, 2) + '\n'
  if (Buffer.byteLength(readable) <= limit) return readable
  const compact = JSON.stringify(data)
  if (Buffer.byteLength(compact) > limit) throw new TypeError('knowledge.json 超过 1 MiB')
  return compact
}
function checkBook(root: string, book: SourceBook, draft: Draft) {
  const { rows, maximumCharacters } = combined(book, draft),
    { readers, variables } = knowledgeCandidates(root)
  const entries = rows.flatMap(row => (row.delivery ? [{ ...row.delivery, documentId: row.documentId }] : []))
  if (draft.budget || draft.changes.some(c => !same(c.base?.delivery ?? null, c.row.delivery)))
    encodeConfig(maximumCharacters, entries)
  KnowledgeSelection.parse(
    { maximumCharacters, entries },
    {
      documents: rows.map(r => ({ ...r, contentRef: r.documentId })),
      markdown: rows.map(r => ({ path: r.documentId, text: compiledText(r.text) })),
    },
  )
  for (const { row, base } of draft.changes) {
    if (
      Object.keys(row).some(
        k => !['documentId', 'usage', 'audience', 'characterIds', 'text', 'delivery'].includes(k),
      ) ||
      !['world_context', 'portrayal'].includes(row.usage) ||
      !['public', 'character_private'].includes(row.audience) ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      compiledText(row.text).includes('\r') ||
      Buffer.byteLength(row.text) > 256 * 1024 ||
      (row.delivery !== null &&
        (!row.delivery ||
          typeof row.delivery !== 'object' ||
          Array.isArray(row.delivery) ||
          Object.hasOwn(row.delivery, 'documentId')))
    )
      throw new TypeError('请检查知识用途、读者范围、正文和投放配置')
    if (
      !base &&
      (!/^document:[a-z][a-z0-9-]{0,63}$/.test(row.documentId) || book.docs.some(d => d.documentId === row.documentId))
    )
      throw new TypeError('新知识的 ID 须唯一，格式为 document:lamp-note')
    if (!Array.isArray(row.characterIds) || row.characterIds.some(id => !readers.some(r => r.id === id)))
      throw new TypeError('读者必须是包内角色')
    parseWorldPackDocumentsSourceV2({
      schemaVersion: 'worldpack-documents/v2',
      documents: [
        {
          documentId: row.documentId,
          usage: row.usage,
          audience: row.audience,
          characterIds: row.characterIds,
          contentRef: 'entry.md',
        },
      ],
    })
    if (!same(row.delivery?.when, base?.delivery?.when)) checkCondition(row, variables)
  }
  if (
    !book.m.assetFiles.includes(configFile) &&
    existsSync(packPath(root, configFile)) &&
    (entries.length || draft.budget)
  )
    throw new TypeError('发现未登记的 knowledge.json，请先核对源清单')
}
export function checkKnowledgeActivities(root: string, graphs: readonly EditorGraph[]) {
  for (const row of combined(sourceBook(root), readDraft(root)).rows) {
    for (const t of readKnowledgeCondition(row.delivery?.when)?.terms ?? []) {
      if (!t.activity || t.path.length !== 5 || t.path[1] !== 'game' || t.path[3] !== 'variables') continue
      const graph = graphs.find(g => g.key === t.activity)
      if (!graph) continue
      const v = graph.variables?.find(v => v.key === t.path.at(-1))
      if (
        !v ||
        v.scope === 'internal' ||
        (v.scope === 'shared' ? 'public' : 'private') !== t.path[2] ||
        (t.comparison !== 'known' &&
          (['eq', 'ne'].includes(t.comparison) ? !acceptsVariableValue(v, t.value) : v.type !== 'number'))
      )
        throw new TypeError(row.documentId + ' › 知识条件使用了活动变量 ' + graph.key + ' › ' + t.path.at(-1))
    }
  }
}
export function knowledgeReferences(root: string, kind: unknown, id: unknown, activity?: unknown) {
  if (
    typeof id !== 'string' ||
    !id ||
    !['world', 'character', 'location', 'item', 'activity', 'local'].includes(String(kind))
  )
    throw new TypeError('请选择变量、角色、地点、物品或活动')
  return combined(sourceBook(root), readDraft(root))
    .rows.filter(r => {
      if (kind === 'character' && r.audience === 'character_private' && r.characterIds.includes(id)) return true
      return readKnowledgeCondition(r.delivery?.when)?.terms.some(t => {
        if (kind === 'world')
          return (
            (t.path[0] === 'public' && t.path[1] === id) ||
            (t.path[0] === 'knownStatus' && t.path[2] === 'key' && t.value === id)
          )
        if (kind === 'activity' && t.activity === id) return true
        if (kind === 'local') return typeof activity === 'string' && t.activity === activity && t.path.at(-1) === id
        if (kind === 'character' && t.path[0] === 'characters' && t.path[1] === id) return true
        if (t.value !== id) return false
        if (kind === 'character' && t.path[0] === 'stimulus' && t.path[3] === 'actorId') return true
        if (kind === 'character')
          return (
            (t.path.length === 1 && t.path[0] === 'characterId') ||
            (t.path[0] === 'scene' && t.path[1] === 'people' && t.path[3] === 'characterId') ||
            (t.path[0] === 'items' && t.path[3] === 'holderId') ||
            (t.path[0] === 'activity' &&
              (t.path[1] === 'participants' || (t.path[1] === 'game' && t.path[2] === 'turn')))
          )
        if (kind === 'location')
          return (
            (t.path.length === 1 && t.path[0] === 'locationId') || (t.path[0] === 'items' && t.path[3] === 'locationId')
          )
        if (kind === 'item') return t.path[0] === 'items' && t.path.at(-1) === 'entityId'
        return t.path[0] === 'activity' && t.path[1] === 'activityKey'
      })
    })
    .map(r => ({
      section: 'knowledge' as const,
      id: r.documentId,
      field: kind === 'character' && r.characterIds.includes(id) ? 'characterIds' : 'when',
      label: r.documentId + ' › ' + (kind === 'character' && r.characterIds.includes(id) ? '指定读者' : '投放条件'),
    }))
}
function mergeRow(base: KnowledgeRow | null, local: KnowledgeRow, current: KnowledgeRow | null): KnowledgeRow {
  if (same(local, current) || same(base, current)) return local
  if (!base || !current || base.documentId !== local.documentId)
    throw new EditConflict(local.documentId, base, current, local)
  const joined = { ...current },
    collisions: string[] = []
  function merge<T>(field: string, b: T, l: T, r: T) {
    if (same(b, l)) return r
    if (!same(b, r) && !same(l, r)) collisions.push(field)
    return l
  }
  for (const key of ['usage', 'audience', 'characterIds', 'text'] as const)
    Object.assign(joined, { [key]: merge(key, base[key], local[key], current[key]) })
  if (base.delivery && local.delivery && current.delivery) {
    const delivery = { ...current.delivery }
    for (const key of ['constant', 'keywords', 'priority', 'when'] as const) {
      const v = merge('delivery.' + key, base.delivery[key], local.delivery[key], current.delivery[key])
      if (v === undefined) delete delivery[key]
      else Object.assign(delivery, { [key]: v })
    }
    joined.delivery = delivery
  } else joined.delivery = merge('delivery', base.delivery, local.delivery, current.delivery)
  if (collisions.length) throw new EditConflict(local.documentId + '/' + collisions.join(', '), base, current, joined)
  return joined
}
export function saveKnowledge(source: string, body: Record<string, unknown>, nativePublicKey?: string) {
  const root = realpathSync(source),
    file = packPath(root, draftFile),
    lock = packPath(root, '.perspectra-editor-save.lock'),
    temp = packPath(root, draftFile + '.' + randomUUID() + '.tmp')
  const fd = openSync(lock, 'wx')
  try {
    const book = sourceBook(root),
      draft = readDraft(root),
      current = combined(book, draft)
    let undo: { base: KnowledgeRow; row: KnowledgeRow } | undefined
    if (body.operation === 'knowledge-budget') {
      if (body.base !== current.maximumCharacters && body.maximumCharacters !== current.maximumCharacters)
        throw new EditConflict('maximumCharacters', body.base, current.maximumCharacters, body.maximumCharacters)
      if (body.maximumCharacters === book.config.maximumCharacters) delete draft.budget
      else draft.budget = { base: book.config.maximumCharacters, value: body.maximumCharacters as number }
    } else {
      let row = body.row as KnowledgeRow
      if (!row || typeof row.documentId !== 'string') throw new TypeError('缺少知识 ID')
      const old = current.rows.find(r => r.documentId === row.documentId) ?? null
      if (
        !Object.hasOwn(body, 'base') ||
        Object.keys(row).some(k => !['documentId', 'usage', 'audience', 'characterIds', 'text', 'delivery'].includes(k))
      )
        throw new TypeError('请提交条目的原值和有效字段')
      row = mergeRow(body.base as KnowledgeRow | null, row, old)
      const equality = knowledgeEquality(row.delivery?.when)
      if (
        equality &&
        !same(old?.delivery?.when, row.delivery?.when) &&
        equality.key !== nativePublicKey &&
        !ruleCatalog(root).variables.some(v => v.key === equality.key)
      )
        throw new TypeError('知识条件：找不到公共变量 ' + equality.key)
      if (body.withUndo === true && old && !same(old, row)) undo = { base: row, row: old }
      const change = draft.changes.find(c => c.row.documentId === row.documentId)
      if (change) change.row = row
      else draft.changes.push({ base: old, row })
      draft.changes = draft.changes.filter(c => !same(c.row, c.base))
    }
    checkBook(root, book, draft)
    writeFileSync(temp, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' })
    renameSync(temp, file)
    return { ...combined(book, draft), ...(undo ? { undo } : {}) }
  } finally {
    closeSync(fd)
    rmSync(temp, { force: true })
    rmSync(lock, { force: true })
  }
}
type RawManifest = { documentFiles?: string[]; markdownFiles?: string[] }
export function materializeKnowledge(root: string, target: string, raw: RawManifest, assets: Set<string>) {
  const draft = readDraft(root)
  if (!draft.changes.length && !draft.budget) return
  const book = sourceBook(root)
  checkBook(root, book, draft)
  const { rows, maximumCharacters } = combined(book, draft)
  const documents = new Map<string, { schemaVersion: string; documents: Record<string, unknown>[] }>()
  const used = new Set([...book.m.documentFiles, ...book.m.markdownFiles, ...assets].map(f => f.toLowerCase()))
  function unused(prefix: string, extension: string) {
    let n = 0,
      name: string
    do {
      name = prefix + (n ? '-' + n : '') + extension
      n++
    } while (used.has(name.toLowerCase()) || existsSync(packPath(root, name)) || existsSync(packPath(target, name)))
    used.add(name.toLowerCase())
    return name
  }
  const backgrounds = new Set(
    book.m.characterFiles.flatMap(f =>
      json(root, f).characters.map(
        (c: { portrayal?: { backgroundTextRef?: string } }) => c.portrayal?.backgroundTextRef,
      ),
    ),
  )
  for (const { row, base } of draft.changes) {
    const doc = book.docs.find(d => d.documentId === row.documentId)
    const textChanged = row.text !== base?.text
    let contentRef = doc?.contentRef
    if (
      !contentRef ||
      (textChanged &&
        (book.docs.some(d => d.documentId !== row.documentId && d.contentRef === contentRef) ||
          backgrounds.has(contentRef)))
    ) {
      contentRef = unused(
        'knowledge-' +
          (row.documentId.startsWith('document:') ? row.documentId.slice(9) : 'entry')
            .replace(/[^a-z0-9-]/gi, '-')
            .slice(0, 64),
        '.md',
      )
      raw.markdownFiles = [...(raw.markdownFiles ?? []), contentRef]
    }
    if (textChanged) {
      const path = packPath(target, contentRef)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, row.text)
    }
    if (
      !doc ||
      doc.contentRef !== contentRef ||
      row.usage !== base?.usage ||
      row.audience !== base?.audience ||
      !same(base?.characterIds, row.characterIds)
    ) {
      const file = doc?.file ?? raw.documentFiles?.[0] ?? unused('knowledge-documents', '.json')
      if (!raw.documentFiles?.includes(file)) raw.documentFiles = [...(raw.documentFiles ?? []), file]
      const data =
        documents.get(file) ??
        (book.m.documentFiles.includes(file)
          ? json(root, file)
          : { schemaVersion: 'worldpack-documents/v2', documents: [] })
      const previous = data.documents.find((d: Record<string, unknown>) => d.documentId === row.documentId)
      const entry = previous ?? {}
      Object.assign(entry, { documentId: row.documentId, usage: row.usage, audience: row.audience, contentRef })
      if (row.characterIds.length || previous?.characterIds) entry.characterIds = row.characterIds
      if (!previous) data.documents.push(entry)
      documents.set(file, data)
    }
  }
  for (const [file, data] of documents) writeFileSync(packPath(target, file), JSON.stringify(data, null, 2) + '\n')
  if (draft.budget || draft.changes.some(c => !same(c.base?.delivery ?? null, c.row.delivery))) {
    const byId = new Map(
      rows.filter(r => r.delivery).map(r => [r.documentId, { documentId: r.documentId, ...r.delivery! }]),
    )
    const entries = book.config.entries.flatMap((e: { documentId: string }) => {
      const next = byId.get(e.documentId)
      byId.delete(e.documentId)
      return next ? [next] : []
    })
    writeFileSync(packPath(target, configFile), encodeConfig(maximumCharacters, [...entries, ...byId.values()]))
    assets.add(configFile)
  }
}
export async function assistKnowledge(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  run = runEditorAgent,
) {
  const { provider, prompt } = body
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择本机创作助手')
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new TypeError('请填写创作要求')
  const book = knowledgeBook(root),
    row = book.rows.find(r => r.documentId === body.documentId)
  if (!row || !same(row, body.base)) throw new TypeError('请先保存并刷新这条知识')
  const { knowledgeFields, saveKnowledgeRequest } = await import('./knowledge-fields.ts')
  const reply = await run(
    provider,
    '根据创作者要求修改选中的知识条目。仅返回 JSON 字段补丁。保留无关字段、稳定 ID 和读者权限，除非作者明确要求修改受众。可用 condition:{match:one/all/any,terms:[{path,comparison,value,activity?}]} 从候选中配置读者已知条件，比较方式 eq/ne/gt/gte/lt/lte/known。\n' +
      JSON.stringify({
        row,
        candidates: book.candidates,
        fields: (await knowledgeFields(root)).fields,
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
  if (!patch || Array.isArray(patch) || typeof patch !== 'object' || Object.hasOwn(patch, 'documentId'))
    throw new TypeError('助手须返回不含 ID 的字段补丁')
  // This is a partial patch; nested delivery edits retain unrelated conditions and keywords.
  const { condition, ...changes } = patch
  const next = {
    ...row,
    ...changes,
    ...(patch.delivery && typeof patch.delivery === 'object'
      ? { delivery: { ...row.delivery, ...patch.delivery } }
      : {}),
  }
  return saveKnowledgeRequest(root, { base: row, row: next, condition, withUndo: true })
}
