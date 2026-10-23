import type { InspectorSnapshot } from '@harness-world/provider-chat'
import { creatorRecordsQuery, type CreatorRecordsQuery, type CreatorRecordsSnapshot } from './creator-records.ts'
import { creatorHistoryQuery, type CreatorHistoryQuery, type CreatorHistorySnapshot } from './creator-history.ts'
import {
  creatorInspectionQuery,
  type CreatorInspectionQuery,
  type CreatorInspectionSnapshot,
} from './creator-inspection.ts'
import { frontendAsset, type FrontendPolicy } from './frontend-server.ts'
import { creatorAsset, creatorAssetDirectory } from './creator-assets.ts'
import { projectPlayerView, FrontendActions } from './frontend-adapter.ts'
import { FRONTEND_CAPABILITIES } from './pack-frontend.ts'
import {
  playerViewPatch,
  frontendActionRequest,
  frontendSpeechInput,
  stagePreferences,
  type FrontendHostServices,
  type FrontendSpeechAudio,
} from '@harness-world/frontend'
import { HOST_ACTIVITY_PAGE } from './host-page.ts'
import type { ActivityRequest } from './pack-activity.ts'
import type { KnownStatus, PlayerTruthStatus } from './pack-status.ts'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PackWeb, StageBox, StageConfig, StageMarks } from './pack-frontend.ts'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { ActionAffordance } from '@harness-world/kernel'

export interface HostState {
  readonly busy: boolean
  /** Public permission to submit another player input, cancelling only unfinished NPC work. */
  readonly canInterrupt?: boolean
  /** Only roles outside the player's scene are still processing; acting cancels their unfinished work. */
  readonly background?: boolean
  /** Names of roles in the player's scene whose activation is running; off-scene roles are never named. */
  readonly responders?: readonly string[]
  readonly paused: boolean
  readonly playerFeedback?: { phase: string; message: string }
  readonly phaseLabel: string
  readonly notice: string
  readonly error: boolean
  readonly transcript: readonly {
    readonly seq: number
    readonly speaker: string
    readonly speakerId?: import('@harness-world/contracts').CharacterId
    readonly text: string
    readonly player: boolean
    readonly segments?: readonly import('@harness-world/contracts').ExpressionSegment[]
    /** A round the player let pass; the text is empty and a frontend shows what it likes, or nothing. */
    readonly pause?: true
  }[]
  /** Items the player can see: held, here, or with someone present. */
  readonly items?: readonly {
    readonly id: string
    readonly name: string
    readonly kind: string
    readonly where: 'held' | 'here' | 'with'
    readonly holderId?: string
    readonly holderName?: string
  }[]
  /** The player may let a round pass now (`host:wait`). */
  readonly canWait?: boolean
  readonly world: {
    readonly title: string
    readonly playerName: string
    readonly npcNames: readonly string[]
    readonly currentScene?: {
      readonly locationId?: string
      /** Seq of the latest change to the player's place or company; the stage waits for the reader to get there. */
      readonly changedAt?: number
      readonly locationName: string
      readonly presentNpcNames: readonly string[]
      readonly recipients?: readonly { readonly id: string; readonly name: string }[]
    }
  }
  /** Names only for references already exposed in current player options. */
  readonly actionNames?: Readonly<Record<string, string>>
  /** Per interaction binding ID, the action name its author gave in the pack. */
  readonly actionLabels?: Readonly<Record<string, string>>
  /** Per interaction definition ID, the inputs that name a character in the actor's scene. */
  readonly characterArguments?: Readonly<Record<string, readonly string[]>>
  readonly availableActions?: readonly ActionAffordance[]
  /** Only the player's own known status values, never the true ones; holderName is the holder's display name and
   * `self` marks the player's own statuses by ID. */
  readonly statusBar?: readonly (KnownStatus & {
    readonly holderName?: string
    readonly self?: boolean
    readonly pinned?: true
  })[]
  /** True values only for statuses the author declared `playerTruth`; the frontend decides whether to show them. */
  readonly statusTruth?: readonly (PlayerTruthStatus & { readonly holderName?: string; readonly self?: boolean })[]
  readonly memoryMaintenance?: WorldJsonObject
  readonly activity?: WorldJsonObject
  readonly activities?: readonly WorldJsonObject[]
  readonly tailRound?: {
    readonly candidateIds?: readonly string[]
    readonly candidateIndex?: number
    readonly id: string | null
    readonly worldVersion: string
    readonly canRegenerate: boolean
    readonly regenerating: boolean
  }
  readonly playerSettings?: {
    inputCharacters: number
    reading: import('../play-settings.ts').ReadingPreferences
    audio?: import('../play-settings.ts').AudioPreferences
    appearance?: 'system' | 'light' | 'dark'
  }
  readonly debug: Record<string, unknown>
}

export interface HostAction {
  readonly actionType: 'move' | 'interact'
  readonly parameters: WorldJsonObject
}

/** A line said in the same turn as an action: the speak parameters, and whether it comes before or after. */
export interface PlayerLine {
  readonly speech: WorldJsonObject
  readonly order: 'before' | 'after'
}

/** A world action as the text input a round records, so regenerating it replays the same operation. */
export function actionText(action: HostAction): string {
  const id = (action.parameters.definitionRef as WorldJsonObject | undefined)?.id
  if (action.actionType === 'interact' && typeof id === 'string' && id.startsWith('status:')) {
    const target = action.parameters.targetRef as WorldJsonObject | undefined
    const item = target?.kind === 'entity' ? '@' + String(target.id) : ''
    return '/status ' + id.slice('status:'.length) + item + ' ' + JSON.stringify(action.parameters.arguments ?? {})
  }
  return '/act ' + action.actionType + ' ' + JSON.stringify(action.parameters)
}

/** The player's option to let a round pass without saying or doing anything. */
export const WAIT_ACTION: HostAction = {
  actionType: 'interact',
  parameters: { definitionRef: { id: 'host:wait', version: 1 } },
}
export const isWait = (action: HostAction): boolean =>
  action.actionType === 'interact' &&
  (action.parameters.definitionRef as WorldJsonObject | undefined)?.id === 'host:wait'

export interface HostRuntime {
  creatorMeta?(): { title: string; storyline: string; characters: { id: string; name: string }[] }
  /** Writes a creator's portrait marks into the pack's stage.json and returns the checked whole. */
  saveStageMarks?(characterId: string, marks: StageMarks): Promise<StageConfig>
  saveNode?(title: string): Promise<{ id: string; title: string }>
  selectCandidate?(tailId: string, candidateId: string, requestId: string): Promise<HostState>
  regenerate?(tailId: string, requestId: string): Promise<HostState>
  cancelRegeneration?(): Promise<HostState>
  requestInspection?(enabled?: boolean): InspectorSnapshot
  creatorInspection?(query?: CreatorInspectionQuery): CreatorInspectionSnapshot
  creatorRecords?(query?: CreatorRecordsQuery): CreatorRecordsSnapshot
  creatorHistory?(query?: CreatorHistoryQuery): CreatorHistorySnapshot
  state(): Promise<HostState>
  submit(text: string): Promise<HostState>
  perform?(action: HostAction, line?: PlayerLine): Promise<HostState>
  activityAction?(request: ActivityRequest): Promise<HostState>
  escape?(): Promise<HostState>
  refreshMemory?(): Promise<HostState>
  cancelMemory?(): Promise<HostState>
  pause(): Promise<HostState>
  resume(): Promise<HostState>
  close(): Promise<void>
}

export class HostBusyError extends Error {}

async function runtimeCall(work: () => Promise<HostState>): Promise<HostState> {
  try {
    return await work()
  } catch (error: unknown) {
    if (
      error instanceof HostBusyError ||
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof SyntaxError
    )
      throw error
    throw new Error('host runtime failure', { cause: error })
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers['x-playtest-token']
  if (typeof supplied !== 'string') return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function headers(response: ServerResponse, contentType: string, customPage = false, embedded = false): void {
  response.setHeader('content-type', contentType)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', embedded ? 'SAMEORIGIN' : 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  const policy = customPage
    ? "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    : "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  response.setHeader(
    'content-security-policy',
    embedded ? policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : policy,
  )
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response, 'application/json; charset=utf-8')
  response.statusCode = status
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage, maximumBytes = 8192): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maximumBytes) throw new RangeError('请求内容过长')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? null : JSON.parse(text)
}

function submittedText(value: unknown, maximumCharacters = 2000): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('请求格式无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.text !== 'string') throw new TypeError('请求必须只包含 text')
  // The composer is multiline for editing, while protocol strings deliberately exclude controls. This
  // local presentation adapter turns visual line breaks and pasted tabs into ordinary word boundaries;
  // the World boundary remains strict and still receives a control-free string.
  const text = record.text.replace(/[\t\r\n]+/gu, ' ').trim()
  if (text.length === 0 || text.length > maximumCharacters)
    throw new RangeError(`请输入 1 至 ${maximumCharacters} 个字符`)
  return text
}

function submittedAction(value: unknown): HostAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('操作格式无效')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'actionType,parameters' ||
    (record.actionType !== 'move' && record.actionType !== 'interact') ||
    record.parameters === null ||
    typeof record.parameters !== 'object' ||
    Array.isArray(record.parameters)
  ) {
    throw new TypeError('操作必须包含 actionType 与 parameters')
  }
  canonicalizeWorldJson(record.parameters as WorldJsonObject)
  return { actionType: record.actionType, parameters: record.parameters as WorldJsonObject }
}

export function createHostServer(
  runtime: HostRuntime,
  token: string,
  packWeb?: PackWeb,
  policy: FrontendPolicy = { mode: 'sandbox', origin: '', revision: 0 },
  services: FrontendHostServices = {},
  creatorDirectory: URL | null = creatorAssetDirectory(),
): Server {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new TypeError('playtest token must be 32 random bytes in hexadecimal')
  const frontendActions = new FrontendActions(runtime)
  let subscriptions = 0
  // Marks saved from the creator page reach the next stage that opens, without restarting the game.
  let stage = packWeb?.stage
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const origin = 'http://' + request.headers.host
      if (!/^127\.0\.0\.1:[0-9]+$/.test(request.headers.host ?? '')) {
        json(response, 400, { error: '仅允许本机访问' })
        return
      }
      if (
        request.headers.origin !== undefined &&
        request.headers.origin !== origin &&
        url.pathname.startsWith('/api/')
      ) {
        json(response, 403, { error: 'Core 接口仅供同源宿主调用' })
        return
      }
      if (creatorAsset(request, response, creatorDirectory)) return
      if (request.method === 'GET' && url.pathname === '/') {
        headers(response, 'text/html; charset=utf-8')
        response.setHeader(
          'content-security-policy',
          String(response.getHeader('content-security-policy')) +
            '; frame-src ' +
            origin +
            '/frontend/' +
            (policy.mode === 'trusted' ? ' ' + policy.origin + '/frontend/' : ''),
        )
        response.end(HOST_ACTIVITY_PAGE)
        return
      }
      if (frontendAsset(request, response, packWeb, origin, 'sandbox')) return
      if (url.pathname.startsWith('/frontend-api/')) {
        if (request.headers.origin !== undefined && request.headers.origin !== origin) {
          json(response, 403, { error: '公开接口仅供同源宿主桥调用' })
          return
        }
        if (!authorized(request, token)) {
          json(response, 401, { error: '宿主令牌无效' })
          return
        }
        if (request.method === 'GET' && url.pathname === '/frontend-api/v1/init') {
          const plain = url.searchParams.get('template') === 'default'
          const useDefault = plain || !packWeb?.page
          const capabilities = useDefault ? [...FRONTEND_CAPABILITIES] : [...packWeb!.manifest.capabilities]
          if (!useDefault && policy.mode === 'trusted') capabilities.push('external-network', 'browser-storage')
          if (!runtime.regenerate && capabilities.includes('regenerate'))
            capabilities.splice(capabilities.indexOf('regenerate'), 1)
          if (!runtime.perform)
            capabilities.splice(capabilities.indexOf('perform'), capabilities.includes('perform') ? 1 : 0)
          if (!services.synthesizeSpeech && capabilities.includes('speech'))
            capabilities.splice(capabilities.indexOf('speech'), 1)
          json(response, 200, {
            apiVersion: 1,
            frontend: useDefault ? 'default' : 'custom',
            frontendMode: useDefault ? 'sandbox' : policy.mode,
            frontendOrigin: useDefault || policy.mode !== 'trusted' ? '' : policy.origin,
            ...(packWeb?.theme && !plain ? { theme: true } : {}),
            ...(useDefault
              ? {
                  canSave: !!runtime.saveNode,
                  ...(plain || !stage ? {} : { stageConfig: stage }),
                  stageAssets: plain
                    ? []
                    : [...(packWeb?.assets.keys() ?? [])].filter(path =>
                        /^\/frontend\/custom\/(portraits|backgrounds)\/[^/]+\.(png|webp|jpe?g)$/i.test(path),
                      ),
                }
              : {}),
            capabilities,
            view: projectPlayerView(await runtime.state()),
          })
          return
        }
        if (request.method === 'GET' && url.pathname === '/frontend-api/v1/view') {
          json(response, 200, projectPlayerView(await runtime.state()))
          return
        }
        if (request.method === 'POST' && url.pathname === '/frontend-api/v1/speech') {
          if (!services.synthesizeSpeech) {
            json(response, 404, { error: '语音合成未安装' })
            return
          }
          if (request.headers['content-type']?.split(';')[0] !== 'application/json')
            throw new TypeError('请求必须是 JSON')
          const value = await body(request, 100_000)
          const input = frontendSpeechInput(projectPlayerView(await runtime.state()), value)
          const controller = new AbortController(),
            abort = () => controller.abort()
          response.once('close', abort)
          let audio: FrontendSpeechAudio
          try {
            audio = await services.synthesizeSpeech(input, controller.signal)
          } catch {
            if (!response.destroyed) json(response, 502, { error: '语音合成未完成，可继续无声阅读' })
            return
          } finally {
            response.off('close', abort)
          }
          if (response.destroyed) return
          // Candidate replacement must not deliver audio for a now-unavailable paragraph.
          const latest = projectPlayerView(await runtime.state())
          let current: typeof input | undefined
          try {
            current = frontendSpeechInput(latest, value)
          } catch (error) {
            if (!(error instanceof TypeError)) throw error
          }
          if (JSON.stringify(current) !== JSON.stringify(input)) {
            json(response, 409, { error: '语音段落已变化，请按当前阅读内容重新请求' })
            return
          }
          if (
            !audio ||
            !['audio/mpeg', 'audio/ogg', 'audio/wav'].includes(audio.contentType) ||
            !(audio.bytes instanceof Uint8Array) ||
            !audio.bytes.byteLength ||
            audio.bytes.byteLength > 32 * 1024 * 1024
          ) {
            json(response, 502, { error: '语音适配器未返回有效音频' })
            return
          }
          headers(response, audio.contentType)
          response.end(audio.bytes)
          return
        }
        if (request.method === 'POST' && url.pathname === '/frontend-api/v1/action') {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json')
            throw new TypeError('请求必须是 JSON')
          const inputCharacters = (await runtime.state()).playerSettings?.inputCharacters ?? 2000
          const action = frontendActionRequest(
            await body(request, Math.max(8192, inputCharacters * 6 + 2048)),
            inputCharacters,
          )
          try {
            json(response, 200, await frontendActions.perform(action))
          } catch (error: unknown) {
            const invalid = error instanceof TypeError || error instanceof RangeError
            json(response, invalid ? 400 : error instanceof HostBusyError ? 409 : 500, {
              error: invalid ? error.message : '操作未完成；请查询公开视图，同一 actionId 可重试',
            })
          }
          return
        }
        if (request.method === 'POST' && url.pathname === '/frontend-api/v1/resource') {
          const value = (await body(request)) as Record<string, unknown> | null
          if (
            !value ||
            Object.keys(value).join(',') !== 'path' ||
            typeof value.path !== 'string' ||
            !/^[a-zA-Z0-9_\-./\u4e00-\u9fff ]{1,512}$/.test(value.path) ||
            value.path.split('/').some(p => p === '.' || p === '..' || !p)
          )
            throw new TypeError('包资源路径无效')
          const path = '/frontend/custom/' + value.path
          if (!packWeb?.assets.has(path)) {
            json(response, 404, { error: '包资源不存在' })
            return
          }
          json(response, 200, { url: path })
          return
        }
        if (request.method === 'GET' && url.pathname === '/frontend-api/v1/events') {
          if (subscriptions >= 8) {
            json(response, 429, { error: '订阅数量达到上限' })
            return
          }
          subscriptions++
          headers(response, 'text/event-stream; charset=utf-8')
          response.setHeader('connection', 'keep-alive')
          response.flushHeaders()
          let previous: ReturnType<typeof projectPlayerView> | undefined,
            reading = false,
            policyRevision = policy.revision
          const update = async () => {
            if (reading || response.destroyed) return
            reading = true
            try {
              if (policyRevision !== policy.revision) {
                policyRevision = policy.revision
                response.write('data: ' + JSON.stringify({ type: 'frontend-policy', mode: policy.mode }) + '\n\n')
              }
              const next = projectPlayerView(await runtime.state())
              const changes = previous ? playerViewPatch(previous, next) : null
              if (!response.destroyed && (!previous || changes))
                response.write(
                  'data: ' +
                    JSON.stringify(previous ? { type: 'view-patch', changes } : { type: 'snapshot', view: next }) +
                    '\n\n',
                )
              previous = next
            } catch {
              if (!response.destroyed) response.end()
            } finally {
              reading = false
            }
          }
          const timer = setInterval(() => {
            void update()
          }, 500)
          response.once('close', () => {
            clearInterval(timer)
            subscriptions--
          })
          void update()
          return
        }
        json(response, 404, { error: 'Frontend API 不支持此操作或版本' })
        return
      }
      if (!authorized(request, token)) {
        json(response, 401, { error: '本机试玩令牌无效，请使用启动时输出的完整地址。' })
        return
      }
      if (url.pathname === '/api/request-inspector' && (request.method === 'GET' || request.method === 'POST')) {
        if (!runtime.requestInspection) {
          json(response, 404, { error: '检查器不可用' })
          return
        }
        if (request.method === 'GET') json(response, 200, runtime.requestInspection())
        else {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json')
            throw new TypeError('请求必须是 JSON')
          const value = (await body(request)) as { enabled?: unknown }
          if (!value || typeof value.enabled !== 'boolean') throw new TypeError('检查器开关无效')
          json(response, 200, runtime.requestInspection(value.enabled))
        }
        return
      }
      if (url.pathname === '/api/creator-meta' && request.method === 'GET') {
        if (!runtime.creatorMeta) {
          json(response, 501, { error: '创作者元信息不可用' })
          return
        }
        json(response, 200, runtime.creatorMeta())
        return
      }
      if (url.pathname === '/api/creator-stage' && request.method === 'GET') {
        json(response, 200, {
          editable: !!packWeb && !packWeb.page && !!runtime.saveStageMarks,
          stage: stage ?? null,
          portraits: [...(packWeb?.assets.keys() ?? [])]
            .filter(path => /^\/frontend\/custom\/portraits\/(?:[^/]+\/)*[^/]+\.(png|webp)$/i.test(path))
            .map(path => path.slice('/frontend/custom/'.length)),
        })
        return
      }
      if (url.pathname === '/api/creator-stage' && request.method === 'POST') {
        if (!packWeb || packWeb.page || !runtime.saveStageMarks) {
          json(response, 404, { error: '这个包没有可标记的默认舞台立绘' })
          return
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new TypeError('请求必须是 JSON')
        const value = (await body(request)) as Record<string, unknown> | null
        if (
          !value ||
          typeof value.characterId !== 'string' ||
          !value.framing ||
          typeof value.framing !== 'object' ||
          Object.keys(value).some(key => !['characterId', 'framing', 'face'].includes(key))
        )
          throw new TypeError('标记需要 characterId、framing，可选 face')
        stage = await runtime.saveStageMarks(value.characterId, {
          framing: value.framing as StageMarks['framing'],
          ...(value.face === undefined ? {} : { face: value.face as StageBox }),
        })
        json(response, 200, { editable: true, stage })
        return
      }
      if (url.pathname === '/api/creator-debug' && request.method === 'GET') {
        if (!runtime.creatorInspection) {
          json(response, 404, { error: '创作者调试不可用' })
          return
        }
        if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1))
          throw new TypeError('调试查询字段不能重复')
        json(response, 200, runtime.creatorInspection(creatorInspectionQuery(Object.fromEntries(url.searchParams))))
        return
      }
      if (['/api/creator-records', '/api/creator-history'].includes(url.pathname) && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1))
          throw new TypeError('查询字段不能重复')
        const query = Object.fromEntries(url.searchParams)
        if (url.pathname === '/api/creator-records' && runtime.creatorRecords)
          json(response, 200, runtime.creatorRecords(creatorRecordsQuery(query)))
        else if (url.pathname === '/api/creator-history' && runtime.creatorHistory)
          json(response, 200, runtime.creatorHistory(creatorHistoryQuery(query)))
        else json(response, 404, { error: '创作者查询不可用' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, await runtimeCall(() => runtime.state()))
        return
      }
      // The default stage's settings, kept beyond this session where a launcher runs the game.
      if (request.method === 'POST' && url.pathname === '/api/stage-preferences') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new TypeError('请求必须是 JSON')
        const preferences = stagePreferences(await body(request))
        services.saveStagePreferences?.(preferences)
        json(response, 200, { saved: services.saveStagePreferences !== undefined })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/story-save') {
        if (!runtime.saveNode) {
          json(response, 501, { error: '此运行时不支持保存进度' })
          return
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new TypeError('请求必须是 JSON')
        const value = (await body(request)) as { title?: unknown } | null
        if (
          !value ||
          Array.isArray(value) ||
          Object.keys(value).join(',') !== 'title' ||
          typeof value.title !== 'string'
        )
          throw new TypeError('请求必须只包含 title')
        if (value.title.length > 80) throw new RangeError('节点名称不能超过 80 个字符')
        const now = new Date()
        const title =
          value.title.trim() ||
          `保存于 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const node = await runtime.saveNode(title)
        json(response, 200, { node: { id: node.id, title: node.title } })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/regenerate') {
        if (!runtime.regenerate) {
          json(response, 404, { error: '重新生成不可用' })
          return
        }
        const value = (await body(request)) as { tailId?: unknown; requestId?: unknown }
        if (
          !value ||
          Object.keys(value).sort().join(',') !== 'requestId,tailId' ||
          typeof value.tailId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(value.tailId) ||
          typeof value.requestId !== 'string' ||
          !/^[a-zA-Z0-9:-]{1,100}$/.test(value.requestId)
        )
          throw new TypeError('重新生成请求无效')
        json(
          response,
          200,
          await runtimeCall(() => runtime.regenerate!(value.tailId as string, value.requestId as string)),
        )
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/regenerate/cancel') {
        if (!runtime.cancelRegeneration) {
          json(response, 404, { error: '重新生成不可用' })
          return
        }
        json(response, 200, await runtime.cancelRegeneration())
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/submit') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new TypeError('请求必须是 JSON')
        const inputCharacters = (await runtime.state()).playerSettings?.inputCharacters ?? 2000
        const text = submittedText(await body(request, Math.max(8192, inputCharacters * 6 + 2048)), inputCharacters)
        json(response, 200, await runtimeCall(() => runtime.submit(text)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/perform') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new TypeError('请求必须是 JSON')
        if (runtime.perform === undefined) {
          json(response, 404, { error: '接口不存在' })
          return
        }
        const action = submittedAction(await body(request))
        json(response, 200, await runtimeCall(() => runtime.perform!(action)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/memory/refresh') {
        if (runtime.refreshMemory === undefined) {
          json(response, 404, { error: '接口不存在' })
          return
        }
        json(response, 200, await runtimeCall(() => runtime.refreshMemory!()))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/memory/cancel') {
        if (runtime.cancelMemory === undefined) {
          json(response, 404, { error: '接口不存在' })
          return
        }
        json(response, 200, await runtimeCall(() => runtime.cancelMemory!()))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/escape') {
        if (runtime.escape === undefined) {
          json(response, 404, { error: '接口不存在' })
          return
        }
        json(response, 200, await runtimeCall(() => runtime.escape!()))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/activity') {
        if (runtime.activityAction === undefined) {
          json(response, 404, { error: '接口不存在' })
          return
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json')
          throw new TypeError('请求必须是 JSON')
        const value = await body(request)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('活动请求无效')
        const r = value as Record<string, unknown>
        if (
          Object.keys(r)
            .filter(key => key !== 'activityKey')
            .sort()
            .join(',') !== 'activityId,operation,parameters,requestId,revision' ||
          (r.activityKey !== undefined &&
            (typeof r.activityKey !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/u.test(r.activityKey))) ||
          !(r.activityId === null || typeof r.activityId === 'string') ||
          !Number.isSafeInteger(r.revision) ||
          Number(r.revision) < 0 ||
          typeof r.operation !== 'string' ||
          typeof r.requestId !== 'string' ||
          !/^[a-zA-Z0-9:-]{1,100}$/u.test(r.requestId) ||
          !r.parameters ||
          typeof r.parameters !== 'object' ||
          Array.isArray(r.parameters)
        )
          throw new TypeError('活动请求字段无效')
        json(response, 200, await runtimeCall(() => runtime.activityAction!(r as unknown as ActivityRequest)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/pause') {
        json(response, 200, await runtimeCall(() => runtime.pause()))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/resume') {
        json(response, 200, await runtimeCall(() => runtime.resume()))
        return
      }
      json(response, 404, { error: '接口不存在' })
    } catch (error: unknown) {
      const validation = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
      const busy = error instanceof HostBusyError
      json(response, validation ? 400 : busy ? 409 : 500, {
        error: validation || busy ? error.message : '试玩请求失败，请查看本机终端日志。',
      })
    }
  })
}
