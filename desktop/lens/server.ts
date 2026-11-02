import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { listenOnSafePort } from '../safe-port.ts'
import { headers } from '../host/http-server.ts'
import { servePageAsset } from '../host/creator-assets.ts'
import { LensSession, type LensSnapshot } from './session.ts'
import type { LensNpcPlan, LensStart, LensStep } from './simulation.ts'

const MAXIMUM_BODY_BYTES = 1024 * 1024
const TOKEN = /^[a-f0-9]{64}$/

export interface LensServer {
  readonly packPath: string
  /** The page address, with the token in its fragment so it never reaches a request line. */
  readonly url: string
  /** Time of the last authorized request, so an unattended CLI server can leave. */
  lastActivity(): number
  close(): Promise<void>
}
export interface LensServerOptions {
  /** Built page files; defaults to the packaged or repository build. */
  readonly assets?: URL | null
}

export function lensAssetDirectory(): URL | null {
  const directory = new URL(
    import.meta.url.endsWith('.mjs') ? './lens-assets/' : '../../apps/launcher/dist-lens/',
    import.meta.url,
  )
  return existsSync(directory) ? directory : null
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response, 'application/json; charset=utf-8')
  response.statusCode = status
  response.end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAXIMUM_BODY_BYTES) throw new Error('请求内容过大。')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求内容无效。')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label}无效。`)
  return value
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}无效。`)
  return value as Record<string, unknown>
}

function perform(session: LensSession, request: Record<string, unknown>): Promise<LensSnapshot> {
  switch (request.operation) {
    case 'lens-baseline': {
      const baseline = record(request.baseline, '对比基准')
      return session.setBaseline(
        baseline.kind === 'checkpoint'
          ? { kind: 'checkpoint', name: text(baseline.name, '对比点名称') }
          : { kind: 'seen' },
      )
    }
    case 'lens-seen':
      return session.markSeen()
    case 'lens-checkpoint':
      return session.saveCheckpoint(text(request.name, '对比点名称'))
    case 'lens-request-add':
      return session.addRequest(text(request.itemId, '设置项'), text(request.note, '待改说明'))
    case 'lens-request-close':
      return session.closeRequest(text(request.id, '待改条目'))
    case 'lens-restart':
      return session.restart(record(request.start, '推演起点') as LensStart)
    case 'lens-step':
      return session.step(record(request.step, '推演步骤') as unknown as LensStep)
    case 'lens-npc-plans':
      return session.setNpcPlans(record(request.plans, '角色行为') as Record<string, readonly LensNpcPlan[]>)
    case 'lens-scenario':
      return session.runScenario(text(request.name, '推演脚本'))
    default:
      throw new Error('未知的透视操作。')
  }
}

/** A loopback page for one pack source directory. It opens the session on request rather than at start, so a pack
 * that does not compile still gets a page that shows why, and works again once it is fixed. */
export async function startLensServer(packPath: string, options: LensServerOptions = {}): Promise<LensServer> {
  const root = resolve(packPath)
  const assets = options.assets === undefined ? lensAssetDirectory() : options.assets
  const token = randomBytes(32).toString('hex')
  let session: LensSession | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let revision = 0
  let loaded = 0
  let activity = Date.now()
  let closing: Promise<void> | undefined

  // The lens's own files change on every "已看过" and say nothing about the pack.
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name?.split(/[\\/]/)[0] !== '.perspectra-lens') revision++
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = undefined
    })
  } catch {
    // A missing folder has nothing to watch; opening the session reports it, and 重新读取 still works.
  }

  /** One at a time: two tabs must not open two sessions. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work)
    queue = result.catch(() => undefined)
    return result
  }
  async function load(): Promise<LensSnapshot> {
    const seenRevision = revision
    let snapshot: LensSnapshot
    if (session === undefined) {
      session = await LensSession.open(root)
      snapshot = await session.snapshot()
    } else {
      snapshot = await session.reload()
    }
    loaded = seenRevision
    return snapshot
  }

  function authorized(request: IncomingMessage): boolean {
    const given = request.headers['x-lens-token']
    return typeof given === 'string' && TOKEN.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(token))
  }

  const server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '/').split('?')[0]
      if (path === '/api/lens/status' || path === '/api/lens') {
        if (!authorized(request)) return json(response, 401, { error: '透视令牌无效。' })
        activity = Date.now()
        if (path === '/api/lens/status') {
          if (request.method !== 'GET') return json(response, 405, { error: '不支持的请求。' })
          return json(response, 200, { stale: revision !== loaded, watching: watcher !== undefined })
        }
        if (request.method !== 'POST') return json(response, 405, { error: '不支持的请求。' })
        try {
          const body = await readBody(request)
          const snapshot = await enqueue(async () => {
            if (body.operation === 'lens-open') {
              if (session === undefined) return load()
              return session.snapshot()
            }
            if (body.operation === 'lens-reload') return load()
            if (session === undefined) throw new Error('世界包还没有读取成功。')
            return perform(session, body)
          })
          return json(response, 200, snapshot)
        } catch (error) {
          return json(response, 400, { error: (error as Error).message })
        }
      }
      if (servePageAsset(request, response, assets, '/lens', '透视页面')) return
      headers(response, 'text/plain; charset=utf-8')
      response.statusCode = 404
      response.end('资源不存在')
    })().catch(error => {
      if (!response.headersSent) json(response, 500, { error: (error as Error).message })
      else response.destroy()
    })
  })
  const port = await listenOnSafePort(server)

  return {
    packPath: root,
    url: `http://127.0.0.1:${port}/lens/#token=${token}`,
    lastActivity: () => activity,
    close() {
      closing ??= (async () => {
        watcher?.close()
        watcher = undefined
        server.closeAllConnections()
        await new Promise<void>(done => server.close(() => done()))
        // A step still running finishes first; the session then removes its temp copy.
        await queue
        await session?.close()
        session = undefined
      })()
      return closing
    },
  }
}
