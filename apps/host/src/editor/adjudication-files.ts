import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { variableKey } from '@perspectra/world-pack/editor-fields'
import { ActivityStateRules } from '@perspectra/core'
import { Script } from 'node:vm'
import { SCRIPT_SOURCE_LIMIT } from '@perspectra/sdk/contracts'
import { readActivityDefinition } from '../official-pack-metadata.ts'
import { EditConflict, packPath, manifest, readProject } from './project.ts'
import { parseRuleSource, type RuleDeclaration } from './adjudication.ts'
import { editorKey } from './activity-graph.ts'
import { runEditorAgent } from './assistant.ts'

export const rulingFolder = 'scripts/adjudications'
function rulePath(key: unknown) {
  return rulingFolder + '/' + editorKey(variableKey(key)) + '.js'
}
export function scriptEntries(root: string) {
  const path = packPath(root, rulingFolder)
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(file => {
      const key = file.slice(0, -3)
      const source = readFileSync(packPath(root, rulingFolder + '/' + file), 'utf8')
      let declaration: RuleDeclaration | undefined, error: string | undefined
      try {
        rulePath(key)
        declaration = parseRuleSource(key, source).declaration
      } catch (e) {
        error = (e as Error).message
      }
      return {
        key,
        path: rulingFolder + '/' + file,
        ...(declaration ? { declaration } : {}),
        ...(error ? { error } : {}),
      }
    })
}
export function readRulingScript(source: string, key: unknown) {
  const root = realpathSync(source),
    path = rulePath(key)
  return { path, source: readFileSync(packPath(root, path), 'utf8') }
}
function existingActivity(root: string, key: unknown) {
  const id = editorKey(key),
    m = manifest(root)
  const paths = m.assetFiles.filter(
    f => f === 'scripts/activities/' + id + '.js' || (id === 'default' && f === 'scripts/activity.js'),
  )
  if (paths.length !== 1 || !readProject(root).scripts.includes(id)) throw new TypeError('请选择包内已有的手写活动脚本')
  return { key: id, path: paths[0]!, enabled: !!m.plugins?.['pack-scripts'] }
}
function inspectActivity(ref: ReturnType<typeof existingActivity>, source: string) {
  if (Buffer.byteLength(source) > SCRIPT_SOURCE_LIMIT) throw new TypeError('活动脚本过大')
  if (!ref.enabled) {
    new Script(source, { filename: ref.path })
    return []
  }
  const definition = readActivityDefinition({ key: ref.key, entry: ref.path, source })
  return new ActivityStateRules(definition, '', ref.key).operations
}
export function readHandActivity(source: string, key: unknown) {
  const root = realpathSync(source),
    ref = existingActivity(root, key),
    code = readFileSync(packPath(root, ref.path), 'utf8')
  try {
    return { ...ref, source: code, operations: inspectActivity(ref, code) }
  } catch (e) {
    return { ...ref, source: code, operations: [], error: (e as Error).message }
  }
}
export function saveRulingScript(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    key = editorKey(body.key)
  const hand = body.kind === 'activity' ? existingActivity(root, key) : undefined
  const path = hand?.path ?? rulePath(key)
  if (typeof body.source !== 'string' || (body.base !== null && typeof body.base !== 'string'))
    throw new TypeError('填写脚本源码与上次读取的 base')
  const info = hand
    ? { operations: inspectActivity(hand, body.source) }
    : { declaration: parseRuleSource(key, body.source).declaration }
  const target = packPath(root, path),
    lock = packPath(root, '.perspectra-editor-save.lock')
  if (!hand) mkdirSync(packPath(root, rulingFolder), { recursive: true })
  const temp = packPath(root, path + '.' + randomUUID() + '.tmp')
  const fd = openSync(lock, 'wx')
  try {
    if (hand) existingActivity(root, key)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null
    if (current !== body.base && current !== body.source) throw new EditConflict(path, body.base, current, body.source)
    if (current !== body.source) {
      writeFileSync(temp, body.source, { flag: 'wx' })
      renameSync(temp, target)
    }
    return { key, path, ...info, source: body.source }
  } finally {
    closeSync(fd)
    rmSync(temp, { force: true })
    rmSync(lock, { force: true })
  }
}
export async function assistRulingScript(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  run = runEditorAgent,
) {
  const { provider, prompt, source } = body
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择本机助手')
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || typeof source !== 'string')
    throw new TypeError('请填写源码和创作要求')
  const key = editorKey(variableKey(body.key))
  const hand = body.kind === 'activity' ? existingActivity(realpathSync(root), key) : undefined
  const reply = await run(
    provider,
    [
      hand
        ? '返回修改后的完整活动 JavaScript，只输出源码。保留 globalThis.activityScript 的声明、操作参数、初始化、策略、裁定和调度契约。只改变作者要求的部分。'
        : '根据作者要求返回完整的 JavaScript 裁定脚本，不加 Markdown。首行为 // @perspectra-rule 加 JSON 对象，含 title、type（number/string/boolean）、parameters 数组。每项参数有 key、label、type、initial，可选 options。随后 export default function(value, parameters) 返回 {value:同类型的新标量} 或 {rejectReason:玩家可读文字}。不使用外部依赖和异步操作。请沿用仍适用的参数键。',
      JSON.stringify({ key, source, request: prompt }),
    ].join('\n'),
    signal,
  )
  signal?.throwIfAborted()
  const next = reply
    .trim()
    .replace(/^\x60\x60\x60(?:javascript|js)?\s*\n/i, '')
    .replace(/\n\x60\x60\x60$/, '')
  return hand
    ? { source: next, operations: inspectActivity(hand, next) }
    : { source: next, declaration: parseRuleSource(key, next).declaration }
}
