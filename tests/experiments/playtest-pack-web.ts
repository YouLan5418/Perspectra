import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

export interface PackWebAsset {
  readonly bytes: Buffer
  readonly contentType: string
}
export interface PackWeb {
  readonly page: Buffer
  readonly assets: ReadonlyMap<string, PackWebAsset>
}

const mime: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
const maxFileBytes = 8 * 1024 * 1024
const maxTotalBytes = 16 * 1024 * 1024
const maxFiles = 100

/** A local web/ directory changes presentation without changing the authoritative world-pack hash. */
export async function loadPackWeb(packPath: string): Promise<PackWeb | undefined> {
  const root = resolve(packPath, 'web')
  const entry = join(root, 'index.html')
  try {
    if (!(await lstat(entry)).isFile()) throw new Error('web/index.html 必须是普通文件。')
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const actualRoot = await realpath(root)
  const packRoot = await realpath(resolve(packPath))
  if (relative(packRoot, actualRoot) !== 'web') throw new Error('包内网页目录不能链接到世界包之外。')
  const assets = new Map<string, PackWebAsset>()
  let page: Buffer | undefined
  let files = 0
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const full = join(directory, name)
      const info = await lstat(full)
      if (info.isSymbolicLink()) throw new Error('包内网页不支持符号链接。')
      if (info.isDirectory()) { await visit(full); continue }
      if (!info.isFile()) throw new Error('包内网页只支持普通文件。')
      const path = relative(actualRoot, full).split(sep).join('/')
      const extension = extname(path).toLowerCase()
      if (path !== 'index.html' && mime[extension] === undefined) {
        throw new Error(`网页素材格式暂不支持：${path}`)
      }
      files += 1
      if (files > maxFiles || info.size > maxFileBytes || (totalBytes += info.size) > maxTotalBytes) {
        throw new Error('包内网页超出文件数量或大小限制。')
      }
      const bytes = await readFile(full)
      if (bytes.length !== info.size) throw new Error(`网页素材在启动时发生变化：${path}`)
      if (path === 'index.html') page = bytes
      else assets.set(`/web/${path}`, { bytes, contentType: mime[extension]! })
    }
  }
  await visit(actualRoot)
  if (!page) throw new Error('世界包网页入口不可读取。')
  return { page, assets }
}
