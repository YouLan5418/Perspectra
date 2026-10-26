import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
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
  'bgm',
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
/** A box on the base portrait, as fractions of its width and height: [left, top, width, height]. */
export type StageBox = readonly [number, number, number, number]
/** One expression layer. A path is a layer the size of the base image; an image or a sheet cell is a patch
 * placed at `at`, or at the character's face box when `at` is left out. */
export type StageExpression =
  | string
  | { readonly image: string; readonly at?: StageBox }
  | { readonly sheet: string; readonly cell: number; readonly at?: StageBox }
/** How the default stage draws one character. Paths are relative to frontend/ and lie under portraits/.
 * `framing` puts the head top and waist (fractions of the image height) where the stage wants them. */
export interface StageCharacter {
  readonly framing?: { readonly top: number; readonly waist: number }
  readonly face?: StageBox
  readonly sheets?: Readonly<
    Record<string, { readonly image: string; readonly columns: number; readonly rows: number }>
  >
  readonly expressions?: Readonly<Record<string, StageExpression>>
  readonly defaultExpression?: string
  readonly poses?: Readonly<Record<string, string>>
}
export interface StageConfig {
  readonly characters: Readonly<Record<string, StageCharacter>>
}
const STAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/u
function stageConfig(bytes: Buffer, has: (path: string) => boolean): StageConfig {
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
  const only = (value: Record<string, unknown>, keys: string[], where: string) => {
    const extra = Object.keys(value).find(key => !keys.includes(key))
    if (extra !== undefined) fail(where + ' 不认识 ' + extra)
  }
  const image = (value: unknown, where: string): string => {
    if (
      typeof value !== 'string' ||
      !/^portraits\/(?:[^/]+\/)*[^/]+\.(?:png|webp)$/iu.test(value) ||
      value.includes('..')
    )
      fail(where + ' 需要 portraits/ 下的 PNG 或 WebP 路径')
    if (!has(value as string)) fail(where + ' 引用的图片不存在：' + value)
    return value as string
  }
  const box = (value: unknown, where: string): StageBox => {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !value.every(n => typeof n === 'number' && n >= 0 && n <= 1) ||
      value[2] <= 0 ||
      value[3] <= 0 ||
      value[0] + value[2] > 1 ||
      value[1] + value[3] > 1
    )
      fail(where + ' 需要 [左, 上, 宽, 高]，都是 0–1 的比例且不超出图片')
    return value as unknown as StageBox
  }
  const name = (value: string, where: string) => {
    if (!STAGE_NAME.test(value)) fail(where + ' 的名字只能用小写字母、数字、- 和 _：' + value)
  }
  if (!object(data)) fail('需要一个对象')
  only(data as Record<string, unknown>, ['characters'], '顶层')
  if (!object((data as Record<string, unknown>).characters)) fail('需要 characters 对象')
  const characters: Record<string, StageCharacter> = {}
  for (const [id, value] of Object.entries((data as { characters: Record<string, unknown> }).characters)) {
    if (!/^character:[^\s]{1,200}$/u.test(id)) fail('角色 ID 无效：' + id)
    if (!object(value)) fail(id + ' 需要一个对象')
    const entry = value as Record<string, unknown>
    only(entry, ['framing', 'face', 'sheets', 'expressions', 'defaultExpression', 'poses'], id)
    const character: {
      framing?: { top: number; waist: number }
      face?: StageBox
      sheets?: Record<string, { image: string; columns: number; rows: number }>
      expressions?: Record<string, StageExpression>
      defaultExpression?: string
      poses?: Record<string, string>
    } = {}
    if (entry.framing !== undefined) {
      const framing = entry.framing
      if (!object(framing) || Object.keys(framing).sort().join(',') !== 'top,waist')
        fail(id + ' 的 framing 需要 top 和 waist')
      const { top, waist } = framing as { top: unknown; waist: unknown }
      if (typeof top !== 'number' || typeof waist !== 'number' || !(top >= 0 && top < waist && waist <= 1))
        fail(id + ' 的 framing 需要 0 ≤ top < waist ≤ 1')
      character.framing = { top: top as number, waist: waist as number }
    }
    if (entry.face !== undefined) character.face = box(entry.face, id + ' 的 face')
    if (entry.sheets !== undefined) {
      if (!object(entry.sheets)) fail(id + ' 的 sheets 需要对象')
      character.sheets = {}
      for (const [key, sheet] of Object.entries(entry.sheets as Record<string, unknown>)) {
        name(key, id + ' 的拼合图')
        const where = id + ' 的拼合图 ' + key
        const spec = typeof sheet === 'string' ? { image: sheet } : sheet
        if (!object(spec)) fail(where + ' 需要路径或 { image, columns, rows }')
        only(spec as Record<string, unknown>, ['image', 'columns', 'rows'], where)
        const { columns = 4, rows = 4 } = spec as { columns?: unknown; rows?: unknown }
        if (![columns, rows].every(n => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 16))
          fail(where + ' 的行列数需要是 1–16 的整数')
        character.sheets[key] = {
          image: image((spec as { image?: unknown }).image, where),
          columns: columns as number,
          rows: rows as number,
        }
      }
    }
    if (entry.expressions !== undefined) {
      if (!object(entry.expressions)) fail(id + ' 的 expressions 需要对象')
      character.expressions = {}
      for (const [key, layer] of Object.entries(entry.expressions as Record<string, unknown>)) {
        name(key, id + ' 的表情')
        const where = id + ' 的表情 ' + key
        if (typeof layer === 'string') {
          character.expressions[key] = image(layer, where)
          continue
        }
        if (!object(layer)) fail(where + ' 需要路径、{ image, at? } 或 { sheet, cell, at? }')
        const patch = layer as Record<string, unknown>
        const at = patch.at === undefined ? undefined : box(patch.at, where + ' 的 at')
        if (at === undefined && character.face === undefined && entry.face === undefined)
          fail(where + ' 是贴片，需要 at 或角色的 face')
        if ('sheet' in patch) {
          only(patch, ['sheet', 'cell', 'at'], where)
          const sheet = character.sheets?.[String(patch.sheet)]
          if (!sheet) fail(where + ' 引用的拼合图不存在：' + String(patch.sheet))
          if (
            !Number.isInteger(patch.cell) ||
            (patch.cell as number) < 0 ||
            (patch.cell as number) >= sheet!.columns * sheet!.rows
          )
            fail(where + ' 的 cell 超出拼合图的格子数')
          character.expressions[key] = { sheet: String(patch.sheet), cell: patch.cell as number, ...(at ? { at } : {}) }
        } else {
          only(patch, ['image', 'at'], where)
          character.expressions[key] = { image: image(patch.image, where), ...(at ? { at } : {}) }
        }
      }
    }
    if (entry.defaultExpression !== undefined) {
      if (typeof entry.defaultExpression !== 'string' || !character.expressions?.[entry.defaultExpression])
        fail(id + ' 的 defaultExpression 需要是已声明的表情')
      character.defaultExpression = entry.defaultExpression as string
    }
    if (entry.poses !== undefined) {
      if (!object(entry.poses)) fail(id + ' 的 poses 需要对象')
      character.poses = {}
      for (const [key, pose] of Object.entries(entry.poses as Record<string, unknown>)) {
        name(key, id + ' 的姿势')
        character.poses[key] = image(pose, id + ' 的姿势 ' + key)
      }
    }
    characters[id] = character
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
    stage =
      staging === undefined ? undefined : stageConfig(staging.bytes, path => assets.has('/frontend/custom/' + path))
  // Static stage artwork and styles need no executable page or capability manifest.
  if (
    !entry &&
    [...assets.keys()].every(
      path =>
        path === '/frontend/custom/theme.css' ||
        path === '/frontend/custom/stage.json' ||
        /^\/frontend\/custom\/(portraits|backgrounds)\/(?:[^/]+\/)*[^/]+\.(png|webp|jpe?g)$/i.test(path),
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
/** Where a creator marked one portrait's head top, waist and face. */
export interface StageMarks {
  readonly framing: { readonly top: number; readonly waist: number }
  readonly face?: StageBox
}
/**
 * Writes one character's marks into the pack's frontend/stage.json, keeping everything else in the file, and
 * returns the checked result. Only packs on the default stage have one; the file is replaced whole.
 */
export async function saveStageMarks(
  packPath: string,
  web: PackWeb,
  characterId: string,
  marks: StageMarks,
): Promise<StageConfig> {
  if (web.page) throw new TypeError('这个包使用自己的页面，不读取 stage.json。')
  const file = resolve(packPath, 'frontend', 'stage.json')
  let data: { characters: Record<string, Record<string, unknown>> } = { characters: {} }
  try {
    data = JSON.parse(await readFile(file, 'utf8')) as typeof data
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const { face: _face, framing: _framing, ...rest } = data.characters?.[characterId] ?? {}
  const next = {
    ...data,
    characters: {
      ...data.characters,
      [characterId]: { framing: marks.framing, ...(marks.face ? { face: marks.face } : {}), ...rest },
    },
  }
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n')
  let stage: StageConfig
  try {
    stage = stageConfig(bytes, path => web.assets.has('/frontend/custom/' + path))
  } catch (error: unknown) {
    // A mark the file cannot take is the creator's to fix, not a host failure.
    throw new TypeError(error instanceof Error ? error.message : String(error))
  }
  await writeFile(file + '.tmp', bytes)
  await rename(file + '.tmp', file)
  return stage
}
