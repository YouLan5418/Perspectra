import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual as same } from 'node:util'
import { parseWorldPackCharactersSourceV3, parseWorldPackPlayerSlotsSource } from '@perspectra/world-pack'
import { presetSampleMessages } from '@perspectra/providers/chat/preset-macros'
import {
  processPresetText,
  callablePresetCharacters,
  checkBundled,
  parsePackRolePresets,
  rolePreset,
  type RolePreset,
} from '../model-presets.ts'
import { EditConflict } from './edit-conflict.ts'
import { manifest, packPath } from './project.ts'
import { runEditorAgent } from './assistant.ts'

export type PresetScope = 'pack' | 'character' | 'group'
export type PresetRow = { scope: PresetScope; id: string; preset: RolePreset; members?: string[] }
type Edit = { base: PresetRow | null; row: PresetRow | null }
const recommendedFile = 'model-preset.json',
  bundleFile = 'role-presets.json',
  draftFile = 'creator-presets.json'
const read = (root: string, file: string): unknown => JSON.parse(readFileSync(packPath(root, file), 'utf8'))
const key = (r: PresetRow) => r.scope + '/' + r.id
export function presetCandidates(source: string) {
  const root = realpathSync(source),
    m = manifest(root)
  const characters = m.characterFiles.flatMap(f => parseWorldPackCharactersSourceV3(read(root, f), f).characters)
  const slots = m.playerSlotFiles.flatMap(f => parseWorldPackPlayerSlotsSource(read(root, f), f).playerSlots)
  return callablePresetCharacters(characters, slots[0]?.characterId)
}
function parseRow(value: unknown): PresetRow | null {
  if (value === null) return null
  const r = value as PresetRow
  if (
    !r ||
    !['pack', 'character', 'group'].includes(r.scope) ||
    Object.keys(r).some(k => !['scope', 'id', 'preset', ...(r.scope === 'group' ? ['members'] : [])].includes(k)) ||
    typeof r.id !== 'string' ||
    (r.scope === 'pack' ? r.id !== '' : !r.id.trim() || r.id.trim() !== r.id)
  )
    throw new TypeError('请指定有效的包推荐、角色 ID 或角色组名')
  const preset = rolePreset(r.preset)
  if (r.scope === 'group') {
    const group = parsePackRolePresets({ groups: [{ name: r.id, preset, members: r.members }] }).groups[0]!
    return { scope: r.scope, id: group.name, preset, members: group.members }
  }
  return { scope: r.scope, id: r.id, preset }
}
function sourceRows(root: string) {
  const rows: PresetRow[] = []
  if (existsSync(packPath(root, recommendedFile)))
    rows.push({ scope: 'pack', id: '', preset: rolePreset(read(root, recommendedFile)) })
  if (existsSync(packPath(root, bundleFile))) {
    const b = parsePackRolePresets(read(root, bundleFile))
    for (const [id, preset] of Object.entries(b.characters)) rows.push({ scope: 'character', id, preset })
    for (const g of b.groups) rows.push({ scope: 'group', id: g.name, preset: g.preset, members: g.members })
  }
  return rows
}
function snapshot(root: string) {
  const source = sourceRows(root),
    rows = new Map(source.map(r => [key(r), r]))
  if (
    Object.entries(manifest(root)).some(
      ([k, v]) =>
        (k.endsWith('Files') && Array.isArray(v) && v.includes(draftFile)) || (k.endsWith('File') && v === draftFile),
    )
  )
    throw new TypeError(draftFile + ' 已被源清单用作游戏资源，请为该资源更名')
  const edits: Edit[] = existsSync(packPath(root, draftFile)) ? (read(root, draftFile) as Edit[]) : []
  if (!Array.isArray(edits)) throw new TypeError('预设草稿格式无效')
  for (const edit of edits) {
    const base = parseRow(edit.base),
      row = parseRow(edit.row),
      r = row ?? base
    if (!r || (row && base && key(row) !== key(base))) throw new TypeError('预设草稿引用无效')
    if (!same(rows.get(key(r)) ?? null, base))
      throw new TypeError('源预设在草稿建立后发生变化，请核对 ' + key(r) + ' 与 ' + draftFile)
    if (row) rows.set(key(row), row)
    else rows.delete(key(r))
  }
  return { source, rows, edits }
}
function bundle(rows: PresetRow[]) {
  const characters = Object.fromEntries(rows.filter(r => r.scope === 'character').map(r => [r.id, r.preset]))
  const groups = rows.filter(r => r.scope === 'group').map(r => ({ name: r.id, preset: r.preset, members: r.members! }))
  return groups.length || Object.keys(characters).length ? parsePackRolePresets({ characters, groups }) : undefined
}
function orderedPresets(rows: PresetRow[]) {
  return rows.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}
export function presetBook(source: string) {
  const root = realpathSync(source)
  return { rows: orderedPresets([...snapshot(root).rows.values()]), characters: presetCandidates(root) }
}
export function presetReferences(source: string, id: unknown) {
  if (typeof id !== 'string' || !id) throw new TypeError('请选择角色')
  return [...snapshot(realpathSync(source)).rows.values()]
    .filter(r => (r.scope === 'character' ? r.id === id : r.members?.includes(id)))
    .map(r => ({
      section: 'presets' as const,
      id: key(r),
      label: r.scope === 'group' ? '角色组 › ' + r.id : '角色专属 › ' + r.id,
    }))
}
export async function presetSample(body: Record<string, unknown>, signal?: AbortSignal) {
  const preset = rolePreset(body.preset),
    { stage, target, text } = body
  if (
    (stage !== 'input' && stage !== 'history' && stage !== 'output' && stage !== 'display') ||
    (target !== 'speech' && target !== 'narration') ||
    typeof text !== 'string' ||
    text.length > 64000
  )
    throw new TypeError('预览需指定处理阶段、对白或叙述以及最多 64000 字符的示例')
  const messages = presetSampleMessages(preset),
    [result] = await processPresetText([{ rules: preset.textRules ?? [], stage, target, text, inspect: true }], signal)
  return { messages, result }
}
export function validatePresets(source: string) {
  const book = presetBook(source),
    b = bundle(book.rows)
  if (b) checkBundled(book.characters, b)
  return { valid: true, entries: book.rows.length, characters: book.characters.length }
}
class PresetConflict extends EditConflict {
  constructor(
    field: string,
    base: PresetRow | null,
    current: PresetRow | null,
    proposed: PresetRow | null,
    readonly useCurrent: PresetRow | null,
  ) {
    super(field, base, current, proposed)
  }
  override details() {
    return { ...super.details(), useCurrent: this.useCurrent }
  }
}
function object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
// Merge fields and stable node IDs. A concurrent incompatible reorder is resolved as one order change.
function reconcile(base: PresetRow | null, row: PresetRow | null, current: PresetRow | null): PresetRow | null {
  const fields = new Set<string>()
  function merge(b: unknown, l: unknown, r: unknown, path: string, preferLocal: boolean): unknown {
    if (same(l, b)) return r
    if (same(l, r) || same(b, r)) return l
    if (object(b) && object(l) && object(r)) {
      return Object.fromEntries(
        [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].flatMap(k => {
          const v = merge(b[k], l[k], r[k], path + '.' + k, preferLocal)
          return v === undefined ? [] : [[k, v]]
        }),
      )
    }
    if (
      (path === 'row.preset.nodes' || path === 'row.preset.textRules') &&
      (b === undefined || Array.isArray(b)) &&
      Array.isArray(l) &&
      Array.isArray(r)
    ) {
      type Entry = { id: string }
      const before: Entry[] = b ?? [],
        local: Entry[] = l,
        remote: Entry[] = r
      const index = (entries: Entry[]) => new Map(entries.map(entry => [entry.id, entry]))
      const initial = index(before),
        ours = index(local),
        theirs = index(remote),
        surviving = new Map<string, unknown>()
      for (const id of new Set([...ours.keys(), ...theirs.keys()])) {
        const value = merge(initial.get(id), ours.get(id), theirs.get(id), path + '[' + id + ']', preferLocal)
        if (value !== undefined) surviving.set(id, value)
      }
      const common = (entries: Entry[]) =>
        entries.map(e => e.id).filter(id => initial.has(id) && ours.has(id) && theirs.has(id) && surviving.has(id))
      const order = [
        ...(merge(common(before), common(local), common(remote), path + '.order', preferLocal) as string[]),
      ]
      for (const entries of [remote, local]) {
        let at = order.length
        for (const { id } of [...entries].reverse()) {
          if (!surviving.has(id)) continue
          const existing = order.indexOf(id)
          if (existing < 0) order.splice(at, 0, id)
          else at = existing
        }
      }
      return order.map(id => surviving.get(id))
    }
    fields.add(path)
    return preferLocal ? l : r
  }
  const mine = merge(base, row, current, 'row', true) as PresetRow | null
  if (fields.size)
    throw new PresetConflict(
      [...fields].join(', '),
      base,
      current,
      mine,
      merge(base, row, current, 'row', false) as PresetRow | null,
    )
  return mine
}
export function savePreset(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    base = parseRow(body.base),
    proposed = parseRow(body.row),
    target = base ?? proposed
  if (!target || (base && proposed && key(base) !== key(proposed)))
    throw new TypeError('修改已有预设时请保留范围和标识')
  const id = key(target),
    lock = packPath(root, '.perspectra-editor-save.lock'),
    file = packPath(root, draftFile),
    temp = packPath(root, draftFile + '.' + randomUUID() + '.tmp')
  const fd = openSync(lock, 'wx')
  try {
    const state = snapshot(root),
      current = state.rows.get(id) ?? null
    const row = parseRow(reconcile(base, proposed, current))
    if (row) state.rows.set(id, row)
    else state.rows.delete(id)
    const rows = [...state.rows.values()],
      characters = presetCandidates(root)
    // Validate group uniqueness across the book, while allowing stale native rows to be repaired one at a time.
    bundle(rows)
    const editedBundle = row && bundle([row])
    if (editedBundle) checkBundled(characters, editedBundle)
    if (!same(row, current)) {
      const original = state.source.find(r => key(r) === id) ?? null
      const edits = state.edits.filter(e => key((e.row ?? e.base)!) !== id)
      if (!same(original, row)) edits.push({ base: original, row })
      writeFileSync(temp, JSON.stringify(edits, null, 2) + '\n', { flag: 'wx' })
      renameSync(temp, file)
    }
    return {
      rows: orderedPresets(rows),
      characters,
      ...(body.withUndo === true && !same(current, row) ? { undo: { base: row, row: current } } : {}),
    }
  } finally {
    closeSync(fd)
    rmSync(temp, { force: true })
    rmSync(lock, { force: true })
  }
}
export async function assistPreset(
  source: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  run = runEditorAgent,
) {
  const { provider, prompt } = body
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择创作助手')
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new TypeError('请填写创作要求')
  const base = parseRow(body.base),
    book = presetBook(source)
  if (
    !base ||
    !same(
      book.rows.find(r => key(r) === key(base)),
      base,
    )
  )
    throw new TypeError('请保存并刷新所选预设')
  const availableMembers =
    base.scope === 'group'
      ? book.characters.filter(
          c => !book.rows.some(r => r.scope === 'group' && r.id !== base.id && r.members?.includes(c.id)),
        )
      : undefined
  const reply = await run(
    provider,
    '根据作者要求编辑所选角色文风预设。仅返回原生 RolePreset 顶层字段的 JSON 补丁；要清除字段可填 null。可用字段 prompt/nodes/textRules/temperature/topP/frequencyPenalty/presencePenalty/maxOutputTokens/stop。角色组另可用 members 数组从 availableMembers 选人。保留未修改的节点与规则及其 ID。\n' +
      JSON.stringify({ record: base, availableMembers, request: prompt }),
    signal,
  )
  signal?.throwIfAborted()
  const patch = JSON.parse(
    reply
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/i, '')
      .replace(/\s*\x60\x60\x60$/, ''),
  )
  if (!object(patch)) throw new TypeError('助手须返回预设字段补丁')
  const { members, ...changes } = patch
  if (members !== undefined && base.scope !== 'group') throw new TypeError('仅角色组可以修改成员')
  rolePreset(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? undefined : v])))
  const next = Object.fromEntries(Object.entries({ ...base.preset, ...changes }).filter(([, v]) => v !== null))
  return savePreset(source, {
    base,
    row: { ...base, ...(members !== undefined ? { members } : {}), preset: next },
    withUndo: true,
  })
}
export function materializePresets(root: string, destination: string, assets: Set<string>) {
  const { rows, edits } = snapshot(root),
    values = [...rows.values()],
    roles = bundle(values)
  if (roles) checkBundled(presetCandidates(root), roles)
  for (const [file, changed, value] of [
    [recommendedFile, edits.some(e => (e.row ?? e.base)!.scope === 'pack'), rows.get('pack/')?.preset],
    [bundleFile, edits.some(e => (e.row ?? e.base)!.scope !== 'pack'), roles],
  ] as const) {
    if (!changed) continue
    if (value) writeFileSync(packPath(destination, file), JSON.stringify(value, null, 2) + '\n')
    else {
      rmSync(packPath(destination, file), { force: true })
      assets.delete(file)
    }
  }
}
