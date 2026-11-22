import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { InspectedRequest } from '@perspectra/providers/chat'
import { WorldHostRuntime } from '../runtime/world-runtime.ts'
import { assignPackRolePresets, packPreset, packRolePresets } from '../model-presets.ts'
import { buildSource } from './export.ts'
import { presetBook } from './presets.ts'

function describe(request: InspectedRequest, baseName: string) {
  const origin = request.preset?.origin
  return {
    status: request.status,
    scope: origin?.scope ?? null,
    name: origin?.scope === 'base' ? baseName : (origin?.name ?? '来源未记录'),
    generation: request.body?.generation ?? null,
    omitted: request.omitted ?? null,
    messages: request.messages.flatMap((m, index) =>
      m.source.source === 'preset' || m.source.source.startsWith('preset:')
        ? [
            {
              position: m.source.position ?? 'prompt',
              order: index + 1,
              role: m.role,
              name: m.source.name,
              content: m.content,
            },
          ]
        : [],
    ),
  }
}
export async function playPresets(source: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const { text, assigned } = body
  if (typeof text !== 'string' || !text.trim() || text.length > 2000 || typeof assigned !== 'boolean')
    throw new TypeError('请填写 1–2000 字的玩家发言并指定是否在试玩中分配随包预设')
  const temp = mkdtempSync(join(tmpdir(), 'perspectra-preset-play-')),
    stage = join(temp, 'source')
  let runtime: WorldHostRuntime | undefined
  try {
    mkdirSync(stage)
    await buildSource(realpathSync(source), stage)
    const book = presetBook(stage)
    if (body.expected !== undefined && !book.rows.some(row => isDeepStrictEqual(body.expected, row)))
      throw new TypeError('预设已发生变化，请刷新后重新核对')
    const recommended = await packPreset(stage),
      bundle = assigned ? await packRolePresets(stage) : undefined
    const baseName = book.rows.some(r => r.scope === 'pack') ? '包推荐' : '宿主默认'
    const model = { protocol: 'openai' as const, endpoint: 'http://invalid.invalid', model: 'preset-preview' }
    const calls = new Map<string, number>()
    signal?.throwIfAborted()
    runtime = await WorldHostRuntime.create({
      packPath: stage,
      dataDirectory: join(temp, 'game'),
      models: { default: { decision: model, memory: model }, characters: {} },
      timeoutMs: 10000,
      preset: recommended,
      presetBaseSource: { mode: 'pack', layers: [{ name: baseName, value: recommended }] },
      ...(bundle ? { presetMapping: assignPackRolePresets({}, bundle, randomUUID) } : {}),
      plugins: {
        llmTransport: {
          id: 'preset-preview',
          version: '1',
          open: async () => ({
            model: model.model,
            schemaMode: 'native',
            send: async (id, _call, signal) => {
              signal.throwIfAborted()
              calls.set(id, (calls.get(id) ?? 0) + 1)
              return { value: { decision: 'abstain' } }
            },
          }),
        },
      },
    })
    runtime.requestInspection(true)
    signal?.throwIfAborted()
    calls.clear()
    const state = await runtime.submit(text)
    signal?.throwIfAborted()
    if (state.error) throw new Error('预设试玩未完成：' + state.error)
    const grouped = new Map<string, ReturnType<typeof describe>[]>()
    let offset = 0
    for (;;) {
      const page = runtime.creatorRecords({ kind: 'request', offset, limit: 100 })
      if (page.storageError) throw new Error('角色请求采集失败')
      for (const item of page.items) {
        const request = runtime.creatorRecords({ recordId: item.id }).record?.data as InspectedRequest | undefined
        if (!request) throw new Error('请求记录不完整')
        const list = grouped.get(item.characterId) ?? []
        list.push(describe(request, baseName))
        grouped.set(item.characterId, list)
      }
      if (!page.hasMore) break
      offset = page.nextOffset
    }
    const actors = book.characters.map(c => {
      const reports = grouped.get(c.id) ?? []
      if (reports.length !== (calls.get(c.id) ?? 0)) throw new Error('请求采集数量与实际发送不一致：' + c.id)
      return { ...c, requests: reports }
    })
    return { assigned, text, actors, notice: state.notice ?? null }
  } finally {
    try {
      await runtime?.close()
    } finally {
      rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
}
