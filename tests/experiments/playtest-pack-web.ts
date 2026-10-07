import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

export const FRONTEND_CAPABILITIES = ['view', 'history', 'speak', 'perform', 'subscribe', 'resources'] as const
export interface FrontendManifest { apiVersion: 1; capabilities: string[] }
export interface PackWebAsset { readonly bytes: Buffer; readonly contentType: string }
export interface PackWeb { readonly page: Buffer; readonly assets: ReadonlyMap<string, PackWebAsset>; readonly manifest: FrontendManifest; readonly digest: string }
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
}
/** Only this pack's explicit frontend/ tree is served. Legacy token-bearing web/ pages are not loaded. */
export async function loadPackWeb(packPath: string): Promise<PackWeb | undefined> {
  const root = resolve(packPath, 'frontend')
  try { await lstat(root) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const packRoot = await realpath(resolve(packPath))
  if ((await lstat(root)).isSymbolicLink() || relative(packRoot, await realpath(root)) !== 'frontend') throw new Error('前端目录不能链接到世界包之外。')
  const assets = new Map<string, PackWebAsset>()
  let total = 0, count = 0
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const file = join(directory, name), info = await lstat(file)
      if (info.isSymbolicLink()) throw new Error('前端资源不支持符号链接。')
      if (info.isDirectory()) { await visit(file); continue }
      const path = relative(root, file).split(sep).join('/')
      if (!info.isFile() || !mime[extname(path).toLowerCase()]) throw new Error('前端资源格式不支持。')
      if (++count > 100 || info.size > 8 * 1024 * 1024 || (total += info.size) > 16 * 1024 * 1024) throw new Error('前端资源数量或大小超出实验限制。')
      const bytes = await readFile(file)
      if (bytes.length !== info.size) throw new Error('前端文件在载入过程中变化。')
      assets.set('/frontend/custom/' + path, { bytes, contentType: mime[extname(path).toLowerCase()]! })
    }
  }
  await visit(root)
  const entry = assets.get('/frontend/custom/index.html'), source = assets.get('/frontend/custom/manifest.json')
  if (!entry || !source) throw new Error('frontend/ 必须包含 index.html 与 manifest.json。')
  const data = JSON.parse(source.bytes.toString('utf8')) as Record<string, unknown>
  if (!data || data.apiVersion !== 1 || !Array.isArray(data.capabilities) || data.capabilities.some(c => typeof c !== 'string')
    || Object.keys(data).sort().join(',') !== 'apiVersion,capabilities') throw new Error('前端 manifest 需要 apiVersion: 1 和 capabilities。')
  const capabilities = data.capabilities.filter((c): c is string => typeof c === 'string' && FRONTEND_CAPABILITIES.includes(c as typeof FRONTEND_CAPABILITIES[number]))
  const digestHash=createHash('sha256')
  for(const path of [...assets.keys()].sort()) { const asset=assets.get(path)!; digestHash.update(JSON.stringify([path,asset.bytes.length])); digestHash.update(asset.bytes) }
  const digest=digestHash.digest('hex')
  return { page: entry.bytes, assets, digest, manifest: { apiVersion: 1, capabilities: [...new Set(capabilities)] } }
}
