import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PLAYTEST_PAGE } from './playtest-page.ts'

export interface PlaytestState {
  readonly busy: boolean
  readonly paused: boolean
  readonly phaseLabel: string
  readonly notice: string
  readonly error: boolean
  readonly transcript: readonly { readonly seq: number; readonly speaker: string; readonly text: string; readonly player: boolean }[]
  readonly world: { readonly title: string; readonly playerName: string; readonly npcNames: readonly string[] }
  readonly debug: Record<string, unknown>
}

export interface PlaytestRuntime {
  state(): Promise<PlaytestState>
  submit(text: string): Promise<PlaytestState>
  pause(): Promise<PlaytestState>
  resume(): Promise<PlaytestState>
  close(): Promise<void>
}

export class PlaytestBusyError extends Error {}

async function runtimeCall(work: () => Promise<PlaytestState>): Promise<PlaytestState> {
  try {
    return await work()
  } catch (error: unknown) {
    if (error instanceof PlaytestBusyError) throw error
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

function headers(response: ServerResponse, contentType: string): void {
  response.setHeader('content-type', contentType)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('content-security-policy', "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
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
  const text = record.text.trim()
  if (text.length === 0 || text.length > 2_000) throw new RangeError('请输入 1 至 2000 个字符')
  return text
}

export function createPlaytestServer(runtime: PlaytestRuntime, token: string): Server {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new TypeError('playtest token must be 32 random bytes in hexadecimal')
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/') {
        headers(response, 'text/html; charset=utf-8')
        response.end(PLAYTEST_PAGE)
        return
      }
      if (!authorized(request, token)) {
        json(response, 401, { error: '本机试玩令牌无效，请使用启动时输出的完整地址。' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, await runtimeCall(() => runtime.state()))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/submit') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new TypeError('请求必须是 JSON')
        const text = submittedText(await body(request))
        json(response, 200, await runtimeCall(() => runtime.submit(text)))
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
      const busy = error instanceof PlaytestBusyError
      json(response, validation ? 400 : busy ? 409 : 500, {
        error: validation || busy ? error.message : '试玩请求失败，请查看本机终端日志。',
      })
    }
  })
}
