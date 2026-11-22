import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { listenOnSafePort } from '../safe-port.ts'
import { headers } from '../runtime/http-server.ts'
import { servePageAsset } from '../runtime/creator-assets.ts'
import { previewRpg } from './rpg-play.ts'
import { previewActivityPage, previewInteractions } from './activity-page-preview.ts'
import { editorCommand } from './commands.ts'
import { EditConflict } from './project.ts'
import { worldRecords } from './world-records.ts'
import { createWorld } from './workspace.ts'
// Editor writes carry both the base and the proposed row, each with metadata, JSON Schema and JSON-escaped Markdown.
const MAXIMUM_EDITOR_BODY_BYTES = 8 * 1024 * 1024
const TOKEN = /^[a-f0-9]{64}$/

export interface EditorServer {
  readonly packPath: string
  /** The page address, with the token in its fragment so it never reaches a request line. */
  readonly url: string
  /** Time of the last authorized request, so an unattended CLI server can leave. */
  lastActivity(): number
  waitForEditorIdle(): Promise<void>
  close(): Promise<void>
}
export interface EditorServerOptions {
  readonly home?: boolean
  readonly picker?: boolean
  readonly editingAllowed?: () => boolean
  /** Built page files; defaults to the packaged or repository build. */
  readonly assets?: URL | null
}

export function editorAssetDirectory(): URL | null {
  const directory = new URL(
    import.meta.url.endsWith('.mjs') ? './editor-assets/' : '../../../launcher/dist-editor/',
    import.meta.url,
  )
  return existsSync(directory) ? directory : null
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response, 'application/json; charset=utf-8')
  response.statusCode = status
  response.end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maximumBytes) throw new Error('请求内容过大。')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求内容无效。')
  return value as Record<string, unknown>
}

export async function startEditorServer(packPath: string, options: EditorServerOptions = {}): Promise<EditorServer> {
  const root = resolve(packPath)
  const assets = options.assets === undefined ? editorAssetDirectory() : options.assets
  const token = randomBytes(32).toString('hex')
  let activity = Date.now()
  let closing: Promise<void> | undefined
  const editorWork = new Map<Promise<unknown>, AbortController>()
  const previews = new Map<string, Awaited<ReturnType<typeof previewActivityPage>>>()
  const workspaces = new Map<string, string>()
  if (!options.home) workspaces.set('', root)
  async function workbench(body: Record<string, unknown>, signal: AbortSignal) {
    if (body.operation === 'workspace-select' && options.picker) {
      if (typeof body.directory !== 'string' || !body.directory.trim()) throw new TypeError('请输入源包目录')
      if (body.create === true) await createWorld(body.directory, body)
      const directory = realpathSync(body.directory)
      worldRecords(directory)
      for (const [key, path] of workspaces) if (path === directory) return { workspace: key }
      const key = randomBytes(12).toString('hex')
      workspaces.set(key, directory)
      return { workspace: key }
    }
    const path = workspaces.get(String(body.workspace ?? ''))
    if (body.operation === 'workspace-status') return { opened: !!path, picker: !!options.picker }
    if (!path) throw new TypeError('请先打开作品')
    if (options.editingAllowed && !options.editingAllowed() && body.operation !== 'records')
      throw new Error('游戏正在启动或运行，请结束游戏后再编辑。')
    if (
      body.operation === 'activity-page-preview' ||
      body.operation === 'rpg-preview' ||
      body.operation === 'interaction-preview'
    ) {
      const open =
        body.operation === 'interaction-preview'
          ? previewInteractions
          : body.operation === 'rpg-preview'
            ? previewRpg
            : previewActivityPage
      const preview = await open(path, body, signal)
      const previous = previews.get(path)
      previews.set(path, preview)
      await previous?.close()
      return { url: preview.url, started: preview.started }
    }
    return editorCommand(path, body, undefined, signal)
  }

  function authorized(request: IncomingMessage): boolean {
    const given = request.headers['x-editor-token']
    return typeof given === 'string' && TOKEN.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(token))
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (path === '/api/editor') {
        if (!authorized(request)) return json(response, 401, { error: '编辑器令牌无效' })
        if (request.method !== 'POST') return json(response, 405, { error: '需要 POST 请求' })
        activity = Date.now()
        try {
          const body = await readBody(request, MAXIMUM_EDITOR_BODY_BYTES)
          if (closing || response.destroyed) throw new Error('工作台已关闭')
          // A model may run while a human edits. Its final save rechecks the fields it read.
          const controller = new AbortController()
          const cancel = () => controller.abort()
          response.once('close', cancel)
          const task = workbench(body, controller.signal)
          editorWork.set(task, controller)
          try {
            return json(response, 200, await task)
          } finally {
            response.off('close', cancel)
            editorWork.delete(task)
          }
        } catch (error) {
          if (error instanceof EditConflict) return json(response, 409, error.details())
          return json(response, 400, { error: (error as Error).message })
        }
      }
      if (servePageAsset(request, response, assets, '/editor', '包编辑器')) return
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
    url: `http://127.0.0.1:${port}/editor/#token=${token}`,
    lastActivity: () => activity,
    async waitForEditorIdle() {
      await Promise.allSettled(editorWork.keys())
    },
    close() {
      closing ??= (async () => {
        for (const controller of editorWork.values()) controller.abort()
        server.closeAllConnections()
        await new Promise<void>(done => server.close(() => done()))
        await Promise.allSettled(editorWork.keys())
        await Promise.all([...previews.values()].map(p => p.close()))
      })()
      return closing
    },
  }
}
