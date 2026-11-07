import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import Ajv from 'ajv'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { RequestInspector, type ChatCallObservation } from '@harness-world/provider-chat'
import { createRoleProviders } from '../../packages/official-llm/src/role-providers.ts'
import { gatewayTurnCall } from '../../packages/official-llm/src/gateway-turn-call.ts'
import { playSettings } from '../../desktop/play-settings.ts'

// Controlled request replay. Saved observations are selected by their original owner; no world is opened for writing.
const deepseek = process.argv.includes('--deepseek')
// --go-direct skips the local gateway and calls OpenCode Go itself, to separate gateway from channel effects.
const goDirect = process.argv.includes('--go-direct')
if (deepseek && goDirect) throw new Error('choose one upstream')
const endpoint = new URL(
  deepseek
    ? 'https://api.deepseek.com/chat/completions'
    : goDirect
      ? 'https://opencode.ai/zen/go/v1/chat/completions'
      : 'http://127.0.0.1:3495/v1/chat/completions',
)
// The gateway lists several Go models; --model= picks one of them to separate channel effects from model effects.
const gatewayModel = process.argv.find(arg => arg.startsWith('--model='))?.slice('--model='.length)
if (deepseek && gatewayModel) throw new Error('--model applies only to Go')
if (gatewayModel !== undefined && !(goDirect ? /^[\w.-]+$/ : /^opencode-go\/[\w.-]+$/).test(gatewayModel))
  throw new Error('unexpected Go model')
const model = deepseek
  ? 'deepseek-flash'
  : (gatewayModel ?? (goDirect ? 'glm-5.3-flash' : 'opencode-go/glm-5.3-flash'))
const apiKey = deepseek || goDirect ? process.env.PERSPECTRA_CACHE_TEST_API_KEY : undefined
delete process.env.PERSPECTRA_CACHE_TEST_API_KEY
if ((deepseek || goDirect) && !apiKey) throw new Error('experiment credential is not configured')
const sessionMode = deepseek ? 'deepseek-user' : 'opencode-go'
const output = resolve(process.argv[2] ?? 'output/character-cache-live-' + Date.now())
const runId = randomUUID()
const exactRepeat = process.argv.includes('--exact-repeat')
const splitContext = process.argv.includes('--split-context')
if (exactRepeat && splitContext) throw new Error('choose one experiment variant')
const turns = exactRepeat ? 3 : 4
type Role = 'A' | 'B'
const historySave = process.argv.find(arg => arg.startsWith('--history-save='))?.slice('--history-save='.length)
interface SavedRole {
  actorId: string
  frames: { context: WorldJsonObject; asOfSeq: number; observations: number; selfPublications: number }[]
  stableHistoryEntries: number
}
function loadHistorySave(directory: string): Record<Role, SavedRole> {
  const db = new DatabaseSync(resolve(directory, 'world.sqlite'), { readOnly: true })
  try {
    if (Number(db.prepare('SELECT COUNT(DISTINCT address_key) n FROM events').get()!.n) !== 1)
      throw new Error('experiment requires one saved branch')
    const head = Number(db.prepare('SELECT MAX(seq) n FROM events').get()!.n)
    const player = db
      .prepare(
        "SELECT seq FROM events WHERE event_type='character.speak' AND json_extract(data_json,'$.characterId')='character:player' ORDER BY seq",
      )
      .all()
    if (player.length < 4) throw new Error('saved play must contain at least four player publications')
    const cutoffs = [...player.slice(-4, -1).map(row => Number(row.seq) - 1), head]
    return Object.fromEntries(
      (['A', 'B'] as const).map((role, index) => {
        const actorId = ['character:deepseek', 'character:gpt'][index]!
        const created = db
          .prepare(
            "SELECT data_json FROM events WHERE event_type='character.created' AND json_extract(data_json,'$.characterId')=? ORDER BY seq LIMIT 1",
          )
          .get(actorId)
        if (!created) throw new Error('saved role missing: ' + actorId)
        const initial = JSON.parse(String(created.data_json)) as WorldJsonObject
        const character = Object.fromEntries(
          ['characterId', 'name', 'portrayal', 'pronouns']
            .filter(key => initial[key] !== undefined)
            .map(key => [key, initial[key]!]),
        )
        const observed = db
          .prepare(
            "SELECT seq,data_json FROM events WHERE event_type='observation.upsert' AND json_extract(data_json,'$.value.observerId')=? ORDER BY seq",
          )
          .all(actorId)
        const own = db
          .prepare(
            "SELECT seq,data_json FROM events WHERE event_type='character.speak' AND json_extract(data_json,'$.characterId')=? ORDER BY seq",
          )
          .all(actorId)
        const frames = cutoffs.map((asOfSeq, frame) => {
          const byId = new Map<string, WorldJsonObject>()
          for (const row of observed.filter(row => Number(row.seq) <= asOfSeq)) {
            const data = JSON.parse(String(row.data_json)) as { id: string; value: WorldJsonObject }
            if (data.value.observerId !== actorId) throw new Error('observation owner mismatch')
            byId.set(data.id, { sourceSeq: Number(row.seq), value: data.value })
          }
          const selfObservations = own
            .filter(row => Number(row.seq) <= asOfSeq)
            .map(row => ({ sourceSeq: Number(row.seq), content: JSON.parse(String(row.data_json)) as WorldJsonObject }))
          const move = db
            .prepare(
              "SELECT data_json FROM events WHERE event_type='character.moved' AND json_extract(data_json,'$.characterId')=? AND seq<=? ORDER BY seq DESC LIMIT 1",
            )
            .get(actorId, asOfSeq)
          const locationId = move
            ? (JSON.parse(String(move.data_json)) as WorldJsonObject).toLocationId
            : initial.locationId
          const context: WorldJsonObject = {
            character,
            publicationCharacters: 200,
            observations: [...byId.values()],
            selfObservations,
            locationId: locationId ?? null,
            scene: { people: [{ characterId: actorId }] },
            affordances: [],
            stimulus: {
              text:
                '第' +
                (frame + 1) +
                '次回忆提问：请只根据你已经知道的经历，用不超过80字回顾最近值得记住的一件事；不要尝试行动，不要把别人的发言当作已证实的事实。',
            },
          }
          return { context, asOfSeq, observations: byId.size, selfPublications: selfObservations.length }
        })
        const histories = frames.map(
          frame =>
            JSON.parse(
              gatewayTurnCall({ context: frame.context, canPerform: false, continuation: false }).messages.find(
                message => message.role === 'user',
              )!.content,
            ).context.history as WorldJsonObject[],
        )
        let stableHistoryEntries = 0
        while (
          stableHistoryEntries < histories[0]!.length &&
          histories.every(
            history =>
              JSON.stringify(history[stableHistoryEntries]) === JSON.stringify(histories[0]![stableHistoryEntries]),
          )
        )
          stableHistoryEntries++
        return [role, { actorId, frames, stableHistoryEntries }]
      }),
    ) as Record<Role, SavedRole>
  } finally {
    db.close()
  }
}
const savedHistory = historySave ? loadHistorySave(historySave) : undefined
const actorFor = (role: Role) => savedHistory?.[role].actorId ?? 'cache:' + role
type RawUsage = {
  prompt_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  opencode?: {
    billing_source?: string
    allowance?: number
    list_cost?: number
    tokens?: { input?: number; output?: number; cache_read?: number; cache_write_5m?: number; cache_write_1h?: number }
  }
}
interface Sample {
  arm: string
  mode: 'passive' | 'opencode-go' | 'deepseek-user'
  order: 'sequential' | 'interleaved'
  role: Role
  turn: number
  actorId?: string
  asOfSeq?: number
  sessionId?: string
  httpStatus?: number
  rawUsage?: RawUsage
  returnedModel?: string
  observation?: ChatCallObservation
  response?: unknown
  protocolValid?: boolean
  ownMarkerSeen?: boolean
  otherMarkerSeen?: boolean
  error?: string
  upstreamError?: string
}
const rows: Sample[] = []
const ajv = new Ajv({ strict: false, allErrors: true })
await mkdir(output, { recursive: true })
await writeFile(
  resolve(output, 'config.json'),
  JSON.stringify(
    {
      runId,
      endpoint: endpoint.href,
      model,
      turns,
      plannedCalls: exactRepeat ? 12 : splitContext ? 16 : 32,
      exactRepeat,
      splitContext,
      thinkingLevel: 'off',
      maxOutputTokens: 512,
      intervalMs: 1500,
      fixture: exactRepeat
        ? '64 synthetic authorized observations, identical requests'
        : '64 synthetic authorized observations, append-only input history, no generated reply replay',
      ...(savedHistory
        ? {
            historySave,
            fixture: 'Saved authorized observations and own publications, full chronological history',
            savedRoles: Object.fromEntries(
              Object.entries(savedHistory).map(([role, value]) => [
                role,
                {
                  actorId: value.actorId,
                  stableHistoryEntries: value.stableHistoryEntries,
                  frames: value.frames.map(({ context: _context, ...counts }) => counts),
                },
              ]),
            ),
          }
        : {}),
    },
    null,
    2,
  ),
  { flag: 'wx' },
)

const originalFetch = globalThis.fetch
let current: Sample | undefined
const capture: { task?: Promise<void> } = {}
const finishCapture = () => capture.task ?? Promise.resolve()
globalThis.fetch = async (input, init) => {
  const sample = current
  if (!sample) throw new Error('untracked experiment request')
  const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) throw new Error('unexpected endpoint')
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const sessionId = headers.get('x-opencode-session')
  if (sessionId) sample.sessionId = sessionId
  const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  if (typeof requestBody?.user_id === 'string') sample.sessionId = requestBody.user_id
  // Only authorized content and schema, never authentication headers or credentials.
  await appendFile(
    resolve(output, 'requests.jsonl'),
    JSON.stringify({
      arm: sample.arm,
      role: sample.role,
      turn: sample.turn,
      actorId: sample.actorId,
      asOfSeq: sample.asOfSeq,
      sessionId: sample.sessionId ?? null,
      messages: requestBody?.messages,
      tools: requestBody?.tools,
    }) + '\n',
  )
  const response = await originalFetch(input, init)
  sample.httpStatus = response.status
  // Error bodies are provider messages, kept short so a failed arm says why; no request content is echoed.
  if (!response.ok) sample.upstreamError = (await response.clone().text()).slice(0, 300)
  capture.task = response
    .clone()
    .text()
    .then(text => {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue
        try {
          const chunk = JSON.parse(line.slice(6)) as { usage?: RawUsage; model?: string }
          if (chunk.usage) sample.rawUsage = chunk.usage
          if (chunk.model) sample.returnedModel = chunk.model
        } catch {
          /* SSE completion sentinel is not JSON. */
        }
      }
    })
  return response
}

const arms = (
  splitContext
    ? [
        { mode: 'passive', order: 'interleaved' },
        { mode: sessionMode, order: 'interleaved' },
      ]
    : exactRepeat
      ? [
          { mode: sessionMode, order: 'sequential' },
          { mode: sessionMode, order: 'interleaved' },
        ]
      : [
          { mode: 'passive', order: 'sequential' },
          { mode: sessionMode, order: 'interleaved' },
          { mode: 'passive', order: 'interleaved' },
          { mode: sessionMode, order: 'sequential' },
        ]
).filter(
  // Direct Go rejects requests without x-opencode-session (400 MissingSessionID), so no passive arm exists there.
  arm => !goDirect || arm.mode !== 'passive',
) as readonly { mode: Sample['mode']; order: 'sequential' | 'interleaved' }[]
const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
try {
  for (const [armIndex, arm] of arms.entries()) {
    const armId = String(armIndex + 1) + '-' + arm.mode + '-' + arm.order
    const markers: Record<Role, string> = {
      A: 'ASTER_' + runId.slice(0, 8) + '_' + armIndex,
      B: 'BIRCH_' + runId.slice(0, 8) + '_' + armIndex,
    }
    const inspector = new RequestInspector()
    const roles = createRoleProviders(
      {
        models: {
          default: {
            decision: {
              protocol: 'openai',
              endpoint: endpoint.href,
              model,
              cacheMode: arm.mode,
              thinkingLevel: 'off',
              ...(apiKey ? { apiKey } : {}),
            },
          },
          characters: {},
        },
        preset: { maxOutputTokens: 512 },
        timeoutMs: 45000,
      },
      playSettings({}),
      (['A', 'B'] as const).map(role => ({ actorId: brandId(actorFor(role), 'CharacterId') })),
      inspector,
      observation => {
        if (current) current.observation = observation
      },
      () => {},
    )
    const schedule: { role: Role; turn: number }[] = []
    if (arm.order === 'sequential') {
      for (const role of ['A', 'B'] as const) for (let turn = 1; turn <= turns; turn++) schedule.push({ role, turn })
    } else {
      for (let turn = 1; turn <= turns; turn++) for (const role of ['A', 'B'] as const) schedule.push({ role, turn })
    }
    let failures = 0
    for (const entry of schedule) {
      const contentTurn = exactRepeat ? 1 : entry.turn
      const sample: Sample = { arm: armId, ...arm, ...entry }
      current = sample
      delete capture.task
      const observations: WorldJsonObject[] = Array.from({ length: 64 }, (_, index) => ({
        sourceSeq: index + 1,
        value: {
          text:
            '第' +
            String(index + 1).padStart(3, '0') +
            '次值班观察：旅店的木窗朝向庭院，廊下放着供客人暂坐的长凳。你在自己的值班时段整理借阅登记，看到纸页上记录着归还日期。前厅告示提醒住客轻声交谈，热水在茶水间自行取用。今天的风从北面吹来，庭院树影缓慢晃动；这些是过去观察，不代表现在有新人物或物品转移。',
        },
      }))
      for (let earlier = 1; earlier < contentTurn; earlier++)
        observations.push({
          sourceSeq: 64 + earlier,
          value: { text: '玩家第' + earlier + '次签到，并请你继续保管自己的档案校验词。' },
        })
      const actorId = actorFor(entry.role)
      const syntheticContext: WorldJsonObject = {
        character: {
          characterId: actorId,
          displayName: entry.role === 'A' ? '林澄' : '陆遥',
          persona: '旅店值班员，平静、友好，不编造动作结果。',
          experiment: runId + '-' + armIndex,
          checkWord: markers[entry.role],
        },
        publicationCharacters: 200,
        observations,
        locationId: 'inn:desk',
        scene: { people: [{ characterId: actorId }, { characterId: 'player' }] },
        affordances: [],
        stimulus: {
          text:
            '玩家第' +
            contentTurn +
            '次签到：请用一句话念出你自己档案里的校验词，然后告诉我这是第几次签到。这里只核对你自己的材料，不要执行行动。',
        },
      }
      const frame = savedHistory?.[entry.role].frames[contentTurn - 1]
      const context: WorldJsonObject = frame
        ? {
            ...frame.context,
            character: { ...(frame.context.character as WorldJsonObject), experiment: runId + '-' + armIndex },
          }
        : syntheticContext
      if (frame) {
        sample.actorId = actorId
        sample.asOfSeq = frame.asOfSeq
      }
      const stableHistoryEntries = savedHistory?.[entry.role].stableHistoryEntries ?? 64
      const prepared = gatewayTurnCall({ context, canPerform: false, continuation: false })
      // Experimental layout only: keep all authorized data, separating the frozen archive from the changing tail.
      const call = splitContext
        ? {
            ...prepared,
            messages: prepared.messages.flatMap(message => {
              if (message.role !== 'user') return [message]
              const original = JSON.parse(message.content) as { context: WorldJsonObject }
              const { character, publicationCharacters, history, ...tail } = original.context
              if (!Array.isArray(history)) throw new Error('expected authorized history')
              return [
                {
                  role: 'user' as const,
                  content:
                    '以下是你的授权角色资料与既有历史，下一条消息补充当前处境与最新刺激：' +
                    JSON.stringify({
                      context: { character, publicationCharacters, history: history.slice(0, stableHistoryEntries) },
                    }),
                },
                {
                  role: 'user' as const,
                  content: JSON.stringify({
                    ...original,
                    context: { ...tail, history: history.slice(stableHistoryEntries) },
                  }),
                },
              ]
            }),
          }
        : prepared
      try {
        const answer = await roles.byCharacter.get(actorId)!.decide(call, AbortSignal.timeout(45000))
        sample.response = answer
        sample.protocolValid = ajv.compile(call.schema)(answer) === true
        const text = JSON.stringify(answer)
        if (!savedHistory) {
          sample.ownMarkerSeen = text.includes(markers[entry.role])
          sample.otherMarkerSeen = text.includes(markers[entry.role === 'A' ? 'B' : 'A'])
        }
      } catch (error) {
        sample.error = error instanceof Error ? error.name : 'unknown failure'
        failures++
      }
      await finishCapture().catch(() => {
        sample.error ??= 'raw usage capture failed'
      })
      rows.push(sample)
      await appendFile(resolve(output, 'samples.jsonl'), JSON.stringify(sample) + '\n')
      console.log(
        JSON.stringify({
          arm: armId,
          role: entry.role,
          turn: entry.turn,
          status: sample.httpStatus,
          input: sample.observation?.usage?.inputTokens,
          read: sample.observation?.usage?.cacheReadTokens,
          rawRead:
            sample.rawUsage?.prompt_cache_hit_tokens ??
            sample.rawUsage?.opencode?.tokens?.cache_read ??
            sample.rawUsage?.prompt_tokens_details?.cached_tokens,
          ms: sample.observation?.durationMs,
          valid: sample.protocolValid,
          ownMarker: sample.ownMarkerSeen,
          error: sample.error,
        }),
      )
      if (failures >= 3) throw new Error('three transport failures in one arm; experiment stopped')
      await wait(1500)
    }
  }
} finally {
  globalThis.fetch = originalFetch
  const summaries = arms.map((arm, index) => {
    const all = rows.filter(row => row.arm.startsWith(String(index + 1) + '-'))
    const warm = all.filter(row => row.turn > 1)
    const sum = (list: Sample[], key: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'uncachedInputTokens') =>
      list.reduce((n, row) => n + (row.observation?.usage?.[key] ?? 0), 0)
    const input = sum(all, 'inputTokens'),
      warmInput = sum(warm, 'inputTokens')
    const sessions = Object.fromEntries(
      (['A', 'B'] as const).map(role => [
        role,
        [...new Set(all.filter(row => row.role === role).map(row => row.sessionId ?? 'absent'))],
      ]),
    )
    return {
      ...arm,
      calls: all.length,
      failures: all.filter(row => row.error).length,
      input,
      read: sum(all, 'cacheReadTokens'),
      write: sum(all, 'cacheWriteTokens'),
      uncached: sum(all, 'uncachedInputTokens'),
      hitRatio: input ? sum(all, 'cacheReadTokens') / input : null,
      warmHitRatio: warmInput ? sum(warm, 'cacheReadTokens') / warmInput : null,
      meanMs: all.reduce((n, row) => n + (row.observation?.durationMs ?? 0), 0) / (all.length || 1),
      formatFailures: all.filter(row => row.protocolValid === false).length,
      markerCheckApplicable: !savedHistory,
      ...(!savedHistory
        ? {
            ownMarkerMissing: all.filter(row => row.ownMarkerSeen === false).length,
            crossRoleMarkerSeen: all.filter(row => row.otherMarkerSeen).length,
          }
        : {}),
      sessions,
    }
  })
  await writeFile(
    resolve(output, 'summary.json'),
    JSON.stringify({ runId, model, endpoint: endpoint.href, samples: rows.length, summaries }, null, 2),
  )
  console.log(JSON.stringify({ output, samples: rows.length, summaries }))
}
