import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headers } from './http-server.ts'

export function creatorAssetDirectory(): URL | null {
  const directory = new URL(
    import.meta.url.endsWith('.mjs') ? './creator-assets/' : '../../apps/launcher/dist-creator/',
    import.meta.url,
  )
  return existsSync(directory) ? directory : null
}

/** Public build files only. Private creator data still requires the host token. */
export function creatorAsset(request: IncomingMessage, response: ServerResponse, directory: URL | null): boolean {
  const rawPath = (request.url ?? '/').split('?')[0]!
  if (request.method !== 'GET' || (rawPath !== '/creator' && !rawPath.startsWith('/creator/'))) return false
  headers(response, 'text/plain; charset=utf-8', true)
  const missing = () => {
    response.statusCode = 404
    response.end('资源不存在')
    return true
  }
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return missing()
  }
  if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.'))
    return missing()
  if (path === '/creator') {
    response.statusCode = 301
    response.setHeader('location', '/creator/')
    response.end()
    return true
  }
  const asset =
    path === '/creator/' ? 'index.html' : path.startsWith('/creator/assets/') ? path.slice('/creator/'.length) : ''
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  }
  const contentType = types[extname(asset)]
  if (!asset || !contentType) return missing()
  if (!directory) {
    response.statusCode = 503
    response.end('创作者页面未构建，请先构建启动器。')
    return true
  }
  try {
    const root = realpathSync(fileURLToPath(directory)),
      target = realpathSync(resolve(root, asset))
    const within = relative(root, target)
    if (
      !within ||
      within === '..' ||
      within.startsWith('../') ||
      within.startsWith('..\\') ||
      isAbsolute(within) ||
      !statSync(target).isFile()
    )
      return missing()
    headers(response, contentType, true)
    response.end(readFileSync(target))
    return true
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return missing()
    throw error
  }
}
