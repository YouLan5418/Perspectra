import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { EditConflict, packPath } from './project.ts'
import { locked, writeAtomic } from './source-files.ts'
import { worldRecords } from './world-records.ts'

const extensions = {
  cover: ['webp', 'png', 'jpg', 'jpeg'],
  portrait: ['png', 'webp'],
  background: ['jpg', 'png', 'webp', 'jpeg'],
}
const maxImport = 4 * 1024 * 1024
export function stageArtFiles(root: string) {
  const files: string[] = []
  function visit(dir: string) {
    const folder = packPath(root, dir)
    if (!existsSync(folder)) return
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = dir + '/' + entry.name
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.(?:png|webp|jpe?g)$/iu.test(path)) files.push(path)
    }
  }
  visit('frontend/portraits')
  visit('frontend/backgrounds')
  for (const ext of extensions.cover) if (existsSync(packPath(root, 'cover.' + ext))) files.push('cover.' + ext)
  return files.sort()
}
export function assetTarget(kind: keyof typeof extensions, id: string, files: string[]) {
  const stem =
    kind === 'cover'
      ? 'cover'
      : 'frontend/' + (kind === 'portrait' ? 'portraits/' : 'backgrounds/') + id.replace(/^[^:]+:/u, '')
  return { stem, path: extensions[kind].map(ext => stem + '.' + ext).find(path => files.includes(path)) ?? null }
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function stageArtPreview(root: string, path: unknown) {
  if (typeof path !== 'string' || !stageArtFiles(root).includes(path)) throw new TypeError('请选择已登记的舞台图片')
  const file = packPath(root, path)
  if (statSync(file).size > 64 * 1024 * 1024) throw new TypeError('图片超过 64 MiB')
  const bytes = readFileSync(file),
    ext = extname(path).slice(1).toLowerCase()
  return {
    path,
    base: digest(bytes),
    data: 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + bytes.toString('base64'),
  }
}
function imageExtension(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png'
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  throw new TypeError('请选择 PNG、JPEG 或 WebP 图片')
}
export function importStageArt(root: string, body: Record<string, unknown>) {
  if (typeof body.base64 !== 'string' || !body.base64 || body.base64.length > Math.ceil(maxImport / 3) * 4)
    throw new TypeError('每次可导入最多 4 MiB 的图片')
  const bytes = Buffer.from(body.base64, 'base64')
  if (bytes.length > maxImport || bytes.toString('base64') !== body.base64) throw new TypeError('图片数据无效')
  const ext = imageExtension(bytes),
    kind = body.kind
  return locked(root, () => {
    const files = stageArtFiles(root)
    let path: string
    if (kind === 'layer') {
      if (
        typeof body.name !== 'string' ||
        !/^(?:[^\\/:*?"<>|\p{Cc}]+\/)*[^\\/:*?"<>|\p{Cc}]+\.(?:png|webp)$/iu.test(body.name) ||
        body.name.includes('..') ||
        extname(body.name).slice(1).toLowerCase() !== ext
      )
        throw new TypeError('请为图层填写 portraits/ 下的 PNG 或 WebP 文件名')
      path = 'frontend/portraits/' + body.name
    } else {
      if (kind !== 'cover' && kind !== 'portrait' && kind !== 'background') throw new TypeError('未知素材类型')
      const id = typeof body.id === 'string' ? body.id : ''
      if (
        kind !== 'cover' &&
        !worldRecords(root).records.some(
          r => r.id === id && r.kind === (kind === 'portrait' ? 'character' : 'location'),
        )
      )
        throw new TypeError('请选择包内角色或地点')
      const { stem, path: active } = assetTarget(kind, id, files)
      if (kind !== 'cover' && /[\\/:*?"<>|\p{Cc}]/u.test(id.replace(/^[^:]+:/u, '')))
        throw new TypeError('记录标识无法用于舞台文件名')
      if (!extensions[kind].includes(ext)) throw new TypeError('立绘底图需要 PNG 或 WebP')
      if (active && extname(active).slice(1).replace('jpeg', 'jpg') !== ext)
        throw new TypeError('此处已使用 ' + active + '，替换时请选择相同格式')
      path = active ?? stem + '.' + ext
    }
    const file = packPath(root, path),
      current = existsSync(file) ? readFileSync(file) : null
    if (current?.equals(bytes)) return { path }
    if ((current ? digest(current) : null) !== (body.base ?? null))
      throw new EditConflict(path, body.base ?? null, current ? digest(current) : null, '替换图片')
    writeAtomic(root, path, bytes)
    return { path }
  })
}
