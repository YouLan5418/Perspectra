import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

export const FRONTEND_CAPABILITIES = [
  'view',
  'history',
  'speak',
  'perform',
  'regenerate',
  'subscribe',
  'resources',
  'speech',
] as const
export const FRONTEND_RESOURCE_LIMITS = {
  files: 2048,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
} as const
export interface FrontendManifest {
  apiVersion: 1
  capabilities: string[]
}
export interface PackWebAsset {
  readonly bytes: Buffer
  readonly contentType: string
}
export interface PackWeb {
  /** The pack's own page; absent when the pack only restyles the default stage with theme.css. */
  readonly page?: Buffer
  /** Load frontend/theme.css after the default stage's own styles. */
  readonly theme: boolean
  readonly assets: ReadonlyMap<string, PackWebAsset>
  readonly manifest: FrontendManifest
  readonly digest: string
  /** frontend/stage.json, checked at load: how the default stage frames each character's portrait. */
  readonly stage?: StageConfig
}
/** Per character, where the head top and the waist sit in its portrait, as fractions of the image height. The
 * default stage scales each portrait so heads line up and everything below the waist falls behind the dialogue. */
export interface StageConfig {
  readonly characters: Readonly<Record<string, { readonly framing?: { readonly top: number; readonly waist: number } }>>
}
function stageConfig(bytes: Buffer): StageConfig {
  const fail = (why: string): never => {
    throw new Error('frontend/stage.json 无效：' + why)
  }
  let data: unknown
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('不是 JSON')
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(data) || Object.keys(data).some(key => key !== 'characters') || !object(data.characters))
    fail('只支持 { "characters": { … } }')
  const characters: Record<string, { framing?: { top: number; waist: number } }> = {}
  for (const [id, value] of Object.entries((data as { characters: Record<string, unknown> }).characters)) {
    if (!/^character:[^\s]{1,200}$/u.test(id)) fail('角色 ID 无效：' + id)
    if (!object(value) || Object.keys(value).some(key => key !== 'framing')) fail(id + ' 只支持 framing')
    const framing = (value as { framing?: unknown }).framing
    if (framing === undefined) {
      characters[id] = {}
      continue
    }
    if (!object(framing) || Object.keys(framing).sort().join(',') !== 'top,waist')
      fail(id + ' 的 framing 需要 top 和 waist')
    const { top, waist } = framing as { top: unknown; waist: unknown }
    if (typeof top !== 'number' || typeof waist !== 'number' || !(top >= 0 && top < waist && waist <= 1))
      fail(id + ' 的 framing 需要 0 ≤ top < waist ≤ 1')
    characters[id] = { framing: { top: top as number, waist: waist as number } }
  }
  return { characters }
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}
/** Only this pack's explicit frontend/ tree is served. Legacy token-bearing web/ pages are not loaded. */
export async function loadPackWeb(packPath: string): Promise<PackWeb | undefined> {
  const root = resolve(packPath, 'frontend')
  try {
    await lstat(root)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const packRoot = await realpath(resolve(packPath))
  if ((await lstat(root)).isSymbolicLink() || relative(packRoot, await realpath(root)) !== 'frontend')
    throw new Error('前端目录不能链接到世界包之外。')
  const assets = new Map<string, PackWebAsset>()
  let total = 0,
    count = 0
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const file = join(directory, name),
        info = await lstat(file)
      if (info.isSymbolicLink()) throw new Error('前端资源不支持符号链接。')
      if (info.isDirectory()) {
        await visit(file)
        continue
      }
      const path = relative(root, file).split(sep).join('/')
      if (!info.isFile() || !mime[extname(path).toLowerCase()]) throw new Error('前端资源格式不支持。')
      if (
        ++count > FRONTEND_RESOURCE_LIMITS.files ||
        info.size > FRONTEND_RESOURCE_LIMITS.fileBytes ||
        (total += info.size) > FRONTEND_RESOURCE_LIMITS.totalBytes
      )
        throw new Error('前端资源超出限制：最多 2048 个文件、单文件 64 MiB、合计 512 MiB。')
      const bytes = await readFile(file)
      if (bytes.length !== info.size) throw new Error('前端文件在载入过程中变化。')
      assets.set('/frontend/custom/' + path, { bytes, contentType: mime[extname(path).toLowerCase()]! })
    }
  }
  await visit(root)
  const entry = assets.get('/frontend/custom/index.html'),
    source = assets.get('/frontend/custom/manifest.json')
  const digestHash = createHash('sha256')
  for (const path of [...assets.keys()].sort()) {
    const asset = assets.get(path)!
    digestHash.update(JSON.stringify([path, asset.bytes.length]))
    digestHash.update(asset.bytes)
  }
  const digest = digestHash.digest('hex')
  const staging = assets.get('/frontend/custom/stage.json'),
    stage = staging === undefined ? undefined : stageConfig(staging.bytes)
  // Static stage artwork and styles need no executable page or capability manifest.
  if (
    !entry &&
    [...assets.keys()].every(
      path =>
        path === '/frontend/custom/theme.css' ||
        path === '/frontend/custom/stage.json' ||
        /^\/frontend\/custom\/(portraits|backgrounds)\/[^/]+\.(png|webp|jpe?g)$/i.test(path),
    )
  )
    return {
      theme: assets.has('/frontend/custom/theme.css'),
      assets,
      digest,
      manifest: { apiVersion: 1, capabilities: [] },
      ...(stage === undefined ? {} : { stage }),
    }
  if (!entry || !source)
    throw new Error(
      'frontend/ 必须包含 index.html 与 manifest.json；默认舞台可只放 theme.css、stage.json、portraits/ 和 backgrounds/。',
    )
  const data = JSON.parse(source.bytes.toString('utf8')) as Record<string, unknown>
  if (
    !data ||
    data.apiVersion !== 1 ||
    !Array.isArray(data.capabilities) ||
    data.capabilities.some(c => typeof c !== 'string') ||
    Object.keys(data).sort().join(',') !== 'apiVersion,capabilities'
  )
    throw new Error('前端 manifest 需要 apiVersion: 1 和 capabilities。')
  const capabilities = data.capabilities.filter(
    (c): c is string =>
      typeof c === 'string' && FRONTEND_CAPABILITIES.includes(c as (typeof FRONTEND_CAPABILITIES)[number]),
  )
  return {
    page: entry.bytes,
    theme: false,
    assets,
    digest,
    manifest: { apiVersion: 1, capabilities: [...new Set(capabilities)] },
  }
}
