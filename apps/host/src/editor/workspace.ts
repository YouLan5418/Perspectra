import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { validateInstalledPack } from '../pack-validation.ts'
import { packPreset } from '../model-presets.ts'
import { environmentRoleModels, runtimeRoleModels } from '../model-connections.ts'
import { WorldHostRuntime } from '../runtime/world-runtime.ts'
import { buildSource } from './export.ts'
import { fields, recordKind, referenceCandidates, type Values } from '@perspectra/world-pack/editor-fields'
import { saveRecord, worldRecords } from './world-records.ts'
import { runEditorAgent } from './assistant.ts'

function required(value: unknown, label: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError('请填写' + label)
  return value.trim()
}
export async function createWorld(destination: string, body: Record<string, unknown>) {
  const title = required(body.title, '作品名称'),
    player = required(body.player, '玩家名'),
    companion = required(body.companion, '同行角色名'),
    location = required(body.location, '开局地点')
  const target = resolve(required(destination, '新作品目录', 4096))
  if (existsSync(target)) throw new TypeError('新作品目录已存在，请换一个目录')
  const temp = mkdtempSync(join(realpathSync(dirname(target)), '.perspectra-new-')),
    source = join(temp, 'source')
  try {
    const template = fileURLToPath(
      new URL(
        import.meta.url.endsWith('.mjs')
          ? '../skills/perspectra-creator/scripts/create-world.mjs'
          : '../../../../skills/perspectra-creator/scripts/create-world.mjs',
        import.meta.url,
      ),
    )
    execFileSync(process.execPath, [template, source, 'pack:world-' + randomUUID(), title], {
      windowsHide: true,
      stdio: 'pipe',
    })
    for (const row of worldRecords(source).records) {
      if (row.kind === 'character' || row.kind === 'location') {
        const values =
          row.kind === 'location'
            ? { name: location }
            : { displayName: row.id === 'character:player' ? player : companion }
        saveRecord(source, { kind: row.kind, id: row.id, base: row.values, values })
      }
    }
    await validateInstalledPack(source, [])
    if (existsSync(target)) throw new TypeError('新作品目录已存在')
    renameSync(source, target)
    return { directory: target, packId: worldRecords(target).packId }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
export async function previewOpening(root: string, body: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const line = required(body.text, '玩家发言', 2000)
  const models = process.env.PERSPECTRA_ROLE_MODELS
    ? runtimeRoleModels(
        JSON.parse(process.env.PERSPECTRA_ROLE_MODELS),
        JSON.parse(process.env.PERSPECTRA_MODEL_KEYS || '{}'),
      )
    : environmentRoleModels(process.env)
  const temp = mkdtempSync(join(tmpdir(), 'perspectra-opening-'))
  let runtime: WorldHostRuntime | undefined
  const cancel = () => {
    void runtime?.close().catch(() => {})
  }
  try {
    const source = join(temp, 'pack')
    mkdirSync(source)
    await buildSource(realpathSync(root), source)
    signal?.throwIfAborted()
    runtime = await WorldHostRuntime.create({
      packPath: source,
      dataDirectory: join(temp, 'game'),
      models,
      timeoutMs: 60000,
      preset: await packPreset(source),
    })
    signal?.throwIfAborted()
    signal?.addEventListener('abort', cancel, { once: true })
    const state = await runtime.submit(line)
    signal?.throwIfAborted()
    return {
      transcript: state.transcript.map(r => ({
        speaker: r.speaker,
        speakerId: r.speakerId,
        player: r.player,
        text: r.text,
      })),
      notice: state.notice,
      error: state.error,
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    try {
      await runtime?.close()
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
export async function assistRecord(
  root: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  run = runEditorAgent,
) {
  const provider = body.provider,
    kind = recordKind(body.kind),
    prompt = required(body.prompt, '创作要求', 4000)
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'dsh') throw new TypeError('请选择创作助手')
  const { records } = worldRecords(root),
    row = records.find(r => r.kind === kind && r.id === body.id)
  if (!row) throw new TypeError('请先保存这条记录')
  if (
    body.expected !== undefined &&
    (!body.expected ||
      typeof body.expected !== 'object' ||
      fields[kind].some(f => JSON.stringify((body.expected as Values)[f.key]) !== JSON.stringify(row.values[f.key])))
  )
    throw new TypeError('这条记录刚有更新，请重新选中后再交给助手。')
  const candidates = Object.fromEntries(
    fields[kind]
      .filter(f => f.reference)
      .map(f => [f.key, referenceCandidates(records, kind, f.key).map(r => ({ id: r.id, name: r.name }))]),
  )
  const reply = await run(
    provider,
    [
      '为 Perspectra 创作者修改选中的记录。只输出 JSON 对象，以 fields 中的 key 为键，仅返回要改的字段和值。引用必须使用候选 ID。',
      JSON.stringify({ record: row, fields: fields[kind], candidates, request: prompt }),
    ].join('\n'),
    signal,
  )
  signal?.throwIfAborted()
  const data = JSON.parse(
    reply
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/i, '')
      .replace(/\s*\x60\x60\x60$/, ''),
  ) as Values
  const result = saveRecord(root, { kind, id: row.id, base: row.values, values: data, withUndo: true })
  return { ...result, undo: result.undo! }
}
