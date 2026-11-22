import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isJsonObject } from '@perspectra/sdk/contracts'
import { gameplayOperationList } from '../official-pack-metadata.ts'
import { LensSimulation } from '../simulation/simulation.ts'
import { runEditorAgent } from './assistant.ts'
import { buildSource } from './export.ts'
import { manifest, manifestFile, packPath, EditConflict } from './project.ts'
import { acquireSourceLock, writeAtomic } from './source-files.ts'

const blank = `module.exports = {
  id: 'pack-interactions',
  version: '1',
  dataVersion: 1,
  requiredServices: [],
  configSchema: { type: 'object', properties: {}, additionalProperties: false },
  operations: [],
}
`

function current(root: string) {
  const declaration = manifest(root).scripts?.gameplay
  const path = declaration?.entry ?? 'scripts/gameplay.cjs',
    file = packPath(root, path)
  return {
    path,
    enabled: !!declaration,
    source: existsSync(file) ? readFileSync(file, 'utf8') : null,
    config: declaration?.config ?? {},
  }
}
export function interactionScript(root: string) {
  const base = current(root)
  let operations: ReturnType<typeof gameplayOperationList> = [],
    error = ''
  try {
    if (base.source !== null) operations = gameplayOperationList(base.source, base.path)
  } catch (e) {
    error = (e as Error).message
  }
  return { base, source: base.source ?? blank, operations, error }
}

export function draftInteraction(root: string, body: Record<string, unknown>) {
  const { id, label, source } = body
  if (typeof id !== 'string' || !/^[a-z][a-z0-9.:-]{0,159}$/.test(id) || !/[.:]/.test(id))
    throw new TypeError('请填写带命名空间的操作 ID，例如 porch:listen')
  if (typeof label !== 'string' || !label.trim() || typeof source !== 'string')
    throw new TypeError('请填写交互名称和当前源码')
  const path = current(root).path
  if (gameplayOperationList(source, path).some(o => o.id === id)) throw new TypeError('操作 ID 已存在：' + id)
  const name = JSON.stringify(label.trim())
  const next =
    source.trimEnd() +
    `

module.exports = {
  ...module.exports,
  operations: [...module.exports.operations, {
    id: ${JSON.stringify(id)},
    argumentSchema: { type: 'object', properties: {}, additionalProperties: false },
    resultSchema: { type: 'object', properties: {}, additionalProperties: false },
    // 返回当前行动者可见的选项；返回 [] 可隐藏这项交互。
    offer: ({ actorId }) => [{ id: ${JSON.stringify(id)}, label: ${name}, targetId: actorId, parameters: {} }],
    // 在此核对执行条件，通过 effects 提交需要追踪的状态或观察。
    resolve: () => ({ status: 'accepted', outcome: {}, effects: [] }),
    npc: { whenToUse: ${name}, formatResult: () => ${name} },
    ui: { label: ${name}, group: '日常互动', targetKind: 'self' },
  }],
}
`
  return { source: next, operations: gameplayOperationList(next, path) }
}

function register(root: string, path: string, config: Record<string, unknown>) {
  const raw = JSON.parse(readFileSync(packPath(root, manifestFile), 'utf8'))
  const old = raw.scripts?.gameplay
  if (old?.entry === path && isDeepStrictEqual(old.config ?? {}, config) && raw.assetFiles.includes(path)) return
  raw.scripts = {
    ...raw.scripts,
    gameplay: { entry: path, ...(Object.keys(config).length || old?.config ? { config } : {}) },
  }
  if (!raw.assetFiles.includes(path)) raw.assetFiles.push(path)
  writeAtomic(root, manifestFile, JSON.stringify(raw, null, 2) + '\n')
}

export async function saveInteractionScript(sourceRoot: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const root = realpathSync(sourceRoot),
    source = body.source,
    config = body.config
  if (typeof source !== 'string' || !isJsonObject(config) || !body.base)
    throw new TypeError('保存需要脚本源码、包配置和读取时的 base')
  const release = acquireSourceLock(root)
  try {
    const before = current(root),
      desired = { ...before, enabled: true, source, config }
    if (!isDeepStrictEqual(before, body.base)) {
      if (isDeepStrictEqual(before, desired) && (body.base as { path?: string }).path === before.path)
        return interactionScript(root)
      throw new EditConflict(before.path, body.base, before, desired)
    }
    gameplayOperationList(source, before.path)
    const temp = mkdtempSync(join(tmpdir(), 'perspectra-interactions-'))
    try {
      await buildSource(root, temp, undefined, stage => {
        writeAtomic(stage, before.path, source)
        register(stage, before.path, config)
      })
      signal?.throwIfAborted()
      // Registration in an actual fresh world also checks operation IDs, services, schemas and competing handlers.
      const sim = await LensSimulation.open(temp)
      await sim.close()
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
    signal?.throwIfAborted()
    const latest = current(root)
    if (!isDeepStrictEqual(before, latest)) throw new EditConflict(before.path, before, latest, desired)
    if (before.source !== source) writeAtomic(root, before.path, source)
    try {
      register(root, before.path, config)
    } catch (e) {
      if (before.source !== source) {
        if (before.source === null) rmSync(packPath(root, before.path))
        else writeAtomic(root, before.path, before.source)
      }
      throw e
    }
    return interactionScript(root)
  } finally {
    release()
  }
}

export async function assistInteractionScript(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  run = runEditorAgent,
) {
  const { provider, prompt, source } = body
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择本机创作助手')
  if (typeof source !== 'string' || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000)
    throw new TypeError('请填写当前源码和修改要求')
  const path = current(root).path
  const reply = await run(
    provider,
    [
      '按作者要求修改这个世界包的 CommonJS 玩法脚本，仅返回完整的同步 JavaScript 源码。只声明作者需要的操作，保留其他已有定义和标识。module.exports.operations 各项有带命名空间的 id、argumentSchema、resultSchema、offer、resolve，可含 npc、ui。offer 只读已授权的视图，resolve 返回 {status:"accepted",outcome,effects} 或 {status:"rejected",rejection:{code,message}}。需要改变事实时使用正式效果。禁止外部依赖。',
      JSON.stringify({ source, request: prompt, config: body.config ?? {} }),
    ].join('\n'),
    signal,
  )
  signal?.throwIfAborted()
  const next = reply
    .trim()
    .replace(/^\x60\x60\x60(?:javascript|js)?\s*\n/i, '')
    .replace(/\n\x60\x60\x60$/, '')
  return { source: next, operations: gameplayOperationList(next, path) }
}
