import type { InspectorSnapshot } from '../../packages/provider-chat/src/request-inspector.ts'
import { frontendAsset, type FrontendPolicy } from './playtest-frontend-assets.ts'
import { projectPlayerView, playerViewPatch, frontendActionRequest, FrontendActions } from '../../packages/frontend/src/player-view.ts'
import { FRONTEND_CAPABILITIES } from './playtest-pack-web.ts'
import { HOST_ACTIVITY_PAGE } from './playtest-host-page.ts'
import type { ActivityRequest } from './pack-activity.ts'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PackWeb } from './playtest-pack-web.ts'
import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { ActionAffordance } from '@harness-world/kernel'

export interface PlaytestState {
  readonly busy: boolean
  readonly paused: boolean
  readonly phaseLabel: string
  readonly notice: string
  readonly error: boolean
  readonly transcript: readonly { readonly seq: number; readonly speaker: string; readonly text: string; readonly player: boolean; readonly segments?: readonly import('@harness-world/contracts').ExpressionSegment[] }[]
  readonly world: { readonly title: string; readonly playerName: string; readonly npcNames: readonly string[];
    readonly currentScene?: { readonly locationName: string; readonly presentNpcNames: readonly string[] } }
  /** Names only for references already exposed in current player options. */
  readonly actionNames?: Readonly<Record<string, string>>
  readonly availableActions?: readonly ActionAffordance[]
  readonly packVariables?: { readonly public: WorldJsonObject; readonly private: WorldJsonObject }
  readonly memoryMaintenance?: WorldJsonObject
  readonly activity?: WorldJsonObject
  readonly tailRound?: { readonly candidateIds?: readonly string[]; readonly candidateIndex?: number; readonly id: string | null; readonly worldVersion: string; readonly canRegenerate: boolean; readonly regenerating: boolean }
  readonly debug: Record<string, unknown>
}

export interface PlaytestAction {
  readonly actionType: 'move' | 'interact'
  readonly parameters: WorldJsonObject
}


export interface PlaytestRuntime {
  selectCandidate?(tailId: string, candidateId: string, requestId: string): Promise<PlaytestState>
  regenerate?(tailId: string, requestId: string): Promise<PlaytestState>
  cancelRegeneration?(): Promise<PlaytestState>
  requestInspection?(enabled?: boolean): InspectorSnapshot
  state(): Promise<PlaytestState>
  submit(text: string): Promise<PlaytestState>
  perform?(action: PlaytestAction): Promise<PlaytestState>
  activityAction?(request: ActivityRequest): Promise<PlaytestState>
  escape?(): Promise<PlaytestState>
  refreshMemory?(): Promise<PlaytestState>
  cancelMemory?(): Promise<PlaytestState>
  pause(): Promise<PlaytestState>
  resume(): Promise<PlaytestState>
  close(): Promise<void>
}

export class PlaytestBusyError extends Error {}

async function runtimeCall(work: () => Promise<PlaytestState>): Promise<PlaytestState> {
  try {
    return await work()
  } catch (error: unknown) {
    if (error instanceof PlaytestBusyError || error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) throw error
    throw new Error('playtest runtime failure', { cause: error })
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers['x-playtest-token']
  if (typeof supplied !== 'string') return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function headers(response: ServerResponse, contentType: string, customPage = false, embedded = false): void {
  response.setHeader('content-type', contentType)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', embedded ? 'SAMEORIGIN' : 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  const policy = customPage
    ? "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    : "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  response.setHeader('content-security-policy', embedded ? policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : policy)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response, 'application/json; charset=utf-8')
  response.statusCode = status
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 8_192) throw new RangeError('请求内容过长')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? null : JSON.parse(text)
}

function submittedText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('请求格式无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.text !== 'string') throw new TypeError('请求必须只包含 text')
  // The composer is multiline for editing, while protocol strings deliberately exclude controls. This
  // local presentation adapter turns visual line breaks and pasted tabs into ordinary word boundaries;
  // the World boundary remains strict and still receives a control-free string.
  const text = record.text.replace(/[\t\r\n]+/gu, ' ').trim()
  if (text.length === 0 || text.length > 2_000) throw new RangeError('请输入 1 至 2000 个字符')
  return text
}

function submittedAction(value: unknown): PlaytestAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('操作格式无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'actionType,parameters'
    || (record.actionType !== 'move' && record.actionType !== 'interact')
    || record.parameters === null || typeof record.parameters !== 'object' || Array.isArray(record.parameters)) {
    throw new TypeError('操作必须包含 actionType 与 parameters')
  }
  canonicalizeWorldJson(record.parameters as WorldJsonObject)
  return { actionType: record.actionType, parameters: record.parameters as WorldJsonObject }
}

export function createPlaytestServer(runtime: PlaytestRuntime, token: string, packWeb?: PackWeb, policy: FrontendPolicy = {mode:'sandbox',origin:'',revision:0}): Server {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new TypeError('playtest token must be 32 random bytes in hexadecimal')
  const frontendActions = new FrontendActions(runtime)
  let subscriptions = 0
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const origin = 'http://' + request.headers.host
      if (!/^127\.0\.0\.1:[0-9]+$/.test(request.headers.host ?? '')) { json(response, 400, {error:'仅允许本机访问'}); return }
      if (request.headers.origin !== undefined && request.headers.origin !== origin && url.pathname.startsWith('/api/')) {
        json(response, 403, { error: 'Core 接口仅供同源宿主调用' }); return
      }
      if (request.method === 'GET' && url.pathname === '/') {
        headers(response, 'text/html; charset=utf-8')
        response.setHeader('content-security-policy', String(response.getHeader('content-security-policy')) + '; frame-src ' + origin + '/frontend/' + (policy.mode==='trusted'?' '+policy.origin+'/frontend/':''))
        response.end(HOST_ACTIVITY_PAGE); return
      }
      if(frontendAsset(request,response,packWeb,origin,'sandbox'))return
      if (url.pathname.startsWith('/frontend-api/')) {
        if (request.headers.origin !== undefined && request.headers.origin !== origin) { json(response,403,{error:'公开接口仅供同源宿主桥调用'}); return }
        if (!authorized(request,token)) { json(response,401,{error:'宿主令牌无效'}); return }
        if (request.method === 'GET' && url.pathname === '/frontend-api/v1/init') {
          const useDefault = url.searchParams.get('template') === 'default' || !packWeb
          const capabilities = useDefault ? [...FRONTEND_CAPABILITIES] : [...packWeb!.manifest.capabilities]
          if(!useDefault&&policy.mode==='trusted')capabilities.push('external-network','browser-storage')
          if (!runtime.regenerate && capabilities.includes('regenerate')) capabilities.splice(capabilities.indexOf('regenerate'),1)
          if (!runtime.perform) capabilities.splice(capabilities.indexOf('perform'),capabilities.includes('perform')?1:0)
          json(response,200,{apiVersion:1,frontend:useDefault?'default':'custom',frontendMode:useDefault?'sandbox':policy.mode,frontendOrigin:useDefault||policy.mode!=='trusted'?'':policy.origin,capabilities,view:projectPlayerView(await runtime.state())}); return
        }
        if (request.method === 'GET' && url.pathname === '/frontend-api/v1/view') { json(response,200,projectPlayerView(await runtime.state())); return }
        if (request.method === 'POST' && url.pathname === '/frontend-api/v1/action') {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new TypeError('请求必须是 JSON')
          const action = frontendActionRequest(await body(request))
          try { json(response,200,await frontendActions.perform(action)) }
          catch(error:unknown) {
            const invalid = error instanceof TypeError || error instanceof RangeError
            json(response,invalid?400:error instanceof PlaytestBusyError?409:500,{error:invalid?error.message:'操作未完成；请查询公开视图，同一 actionId 可重试'} )
          }
          return
        }
        if (request.method === 'POST' && url.pathname === '/frontend-api/v1/resource') {
          const value = await body(request) as Record<string,unknown> | null
          if (!value || Object.keys(value).join(',') !== 'path' || typeof value.path !== 'string'
            || !/^[a-zA-Z0-9_\-./\u4e00-\u9fff ]{1,512}$/.test(value.path) || value.path.split('/').some(p=>p==='.'||p==='..'||!p)) throw new TypeError('包资源路径无效')
          const path = '/frontend/custom/' + value.path
          if (!packWeb?.assets.has(path)) { json(response,404,{error:'包资源不存在'}); return }
          json(response,200,{url:path}); return
        }
        if (request.method === 'GET' && url.pathname === '/frontend-api/v1/events') {
          if (subscriptions >= 8) { json(response,429,{error:'订阅数量达到上限'}); return }
          subscriptions++
          headers(response,'text/event-stream; charset=utf-8')
          response.setHeader('connection','keep-alive')
          response.flushHeaders()
          let previous: ReturnType<typeof projectPlayerView> | undefined, reading=false, policyRevision=policy.revision
          const update = async () => {
            if(reading||response.destroyed)return
            reading=true
            try {
              if (policyRevision !== policy.revision) {
                policyRevision=policy.revision
                response.write('data: '+JSON.stringify({type:'frontend-policy',mode:policy.mode})+'\n\n')
              }
              const next = projectPlayerView(await runtime.state())
              const changes = previous ? playerViewPatch(previous,next) : null
              if (!response.destroyed && (!previous || changes)) response.write('data: '+JSON.stringify(previous?{type:'view-patch',changes}:{type:'snapshot',view:next})+'\n\n')
              previous=next
            } catch { if(!response.destroyed)response.end() }
            finally {reading=false}
          }
          const timer=setInterval(()=>{void update()},500)
          response.once('close',()=>{clearInterval(timer);subscriptions--})
          void update(); return
        }
        json(response,404,{error:'Frontend API 不支持此操作或版本'}); return
      }
      if (!authorized(request, token)) {
        json(response, 401, { error: '本机试玩令牌无效，请使用启动时输出的完整地址。' })
        return
      }
      if (url.pathname === '/api/request-inspector' && (request.method === 'GET' || request.method === 'POST')) {
        if (!runtime.requestInspection) { json(response,404,{error:'检查器不可用'}); return }
        if (request.method === 'GET') json(response,200,runtime.requestInspection())
        else {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new TypeError('请求必须是 JSON')
          const value = await body(request) as {enabled?:unknown}
          if (!value || typeof value.enabled !== 'boolean') throw new TypeError('检查器开关无效')
          json(response,200,runtime.requestInspection(value.enabled))
        }
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, await runtimeCall(() => runtime.state()))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/regenerate') {
        if (!runtime.regenerate) { json(response,404,{error:'重新生成不可用'}); return }
        const value = await body(request) as {tailId?:unknown;requestId?:unknown}
        if (!value || Object.keys(value).sort().join(',') !== 'requestId,tailId' || typeof value.tailId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.tailId)
          || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(value.requestId)) throw new TypeError('重新生成请求无效')
        json(response,200,await runtimeCall(() => runtime.regenerate!(value.tailId as string,value.requestId as string))); return
      }
      if (request.method === 'POST' && url.pathname === '/api/regenerate/cancel') {
        if (!runtime.cancelRegeneration) { json(response,404,{error:'重新生成不可用'}); return }
        json(response,200,await runtime.cancelRegeneration()); return
      }
      if (request.method === 'POST' && url.pathname === '/api/submit') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new TypeError('请求必须是 JSON')
        const text = submittedText(await body(request))
        json(response, 200, await runtimeCall(() => runtime.submit(text)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/perform') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new TypeError('请求必须是 JSON')
        if (runtime.perform === undefined) { json(response, 404, { error: '接口不存在' }); return }
        const action = submittedAction(await body(request))
        json(response, 200, await runtimeCall(() => runtime.perform!(action)))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/memory/refresh') {
        if (runtime.refreshMemory === undefined) { json(response, 404, { error: '接口不存在' }); return }
        json(response, 200, await runtimeCall(() => runtime.refreshMemory!())); return
      }
      if (request.method === 'POST' && url.pathname === '/api/memory/cancel') {
        if (runtime.cancelMemory === undefined) { json(response, 404, { error: '接口不存在' }); return }
        json(response, 200, await runtimeCall(() => runtime.cancelMemory!())); return
      }
      if (request.method === 'POST' && url.pathname === '/api/escape') {
        if (runtime.escape === undefined) { json(response, 404, { error: '接口不存在' }); return }
        json(response, 200, await runtimeCall(() => runtime.escape!())); return
      }
      if (request.method === 'POST' && url.pathname === '/api/activity') {
        if (runtime.activityAction === undefined) { json(response, 404, { error: '接口不存在' }); return }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new TypeError('请求必须是 JSON')
        const value = await body(request)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('活动请求无效')
        const r = value as Record<string, unknown>
        if (Object.keys(r).sort().join(',') !== 'activityId,operation,parameters,requestId,revision'
          || !(r.activityId === null || typeof r.activityId === 'string')
          || !Number.isSafeInteger(r.revision) || Number(r.revision) < 0 || typeof r.operation !== 'string'
          || typeof r.requestId !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/u.test(r.requestId)
          || !r.parameters || typeof r.parameters !== 'object' || Array.isArray(r.parameters)) throw new TypeError('活动请求字段无效')
        json(response, 200, await runtimeCall(() => runtime.activityAction!(r as unknown as ActivityRequest))); return
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
      const busy = error instanceof PlaytestBusyError
      json(response, validation ? 400 : busy ? 409 : 500, {
        error: validation || busy ? error.message : '试玩请求失败，请查看本机终端日志。',
      })
    }
  })
}
