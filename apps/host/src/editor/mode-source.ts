import { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import type { PackPluginDescriptor } from '@perspectra/world-pack'
import { acquireSourceLock, writeAtomic } from './source-files.ts'
import { buildSource } from './export.ts'
import { EditConflict, manifest, manifestFile, packPath } from './project.ts'
import type { ConfigObject } from '@perspectra/world-pack/editor-config'
import { worldRecords } from './world-records.ts'
export function pluginBook(source: string, plugin: PackPluginDescriptor) {
  const root = realpathSync(source),
    m = manifest(root),
    selection = m.plugins?.[plugin.id],
    file = selection?.config ?? plugin.configFile!
  const path = packPath(root, file),
    configExists = existsSync(path)
  const records = worldRecords(root).records
  return {
    file,
    enabled: !!selection,
    configExists,
    schema: plugin.configSchema,
    config: configExists ? (JSON.parse(readFileSync(path, 'utf8')) as ConfigObject) : null,
    player: String(records.find(r => r.kind === 'slot')?.values.characterId ?? ''),
    characters: records.filter(r => r.kind === 'character').map(({ id, name }) => ({ id, name })),
    locations: records.filter(r => r.kind === 'location').map(({ id, name }) => ({ id, name })),
    items: records.filter(r => r.kind === 'item').map(({ id, name }) => ({ id, name })),
  }
}

const print = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
function enableInManifest(root: string, file: string, descriptor: PackPluginDescriptor) {
  const m = JSON.parse(readFileSync(packPath(root, manifestFile), 'utf8'))
  m.plugins ??= {}
  for (const id of [...(descriptor.requiredPlugins ?? []), descriptor.id]) m.plugins[id] ??= {}
  if (!m.assetFiles.includes(file)) m.assetFiles.push(file)
  writeAtomic(root, manifestFile, print(m))
}
export async function saveModeSource<
  T extends { file: string; enabled: boolean; configExists: boolean; config: unknown },
>(
  source: string,
  body: Record<string, unknown>,
  descriptor: PackPluginDescriptor,
  read: (root: string) => T | Promise<T>,
  initial: (book: T) => unknown,
  enable: boolean,
  validate?: (config: unknown, book: T) => void,
) {
  const root = realpathSync(source),
    release = acquireSourceLock(root)
  try {
    const book = await read(root)
    if (enable && book.enabled) return book
    if (!enable && !book.enabled) throw new TypeError('请先启用玩法：' + descriptor.id)
    if (!enable && (body.file !== book.file || !isDeepStrictEqual(book.config, body.base)))
      throw new EditConflict(book.file, body.base, book.config, body.config)
    const create = enable && !book.configExists
    const config = enable ? (create ? initial(book) : book.config) : body.config
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('需要玩法配置对象')
    validate?.(config, book)
    let data = enable && !create ? readFileSync(packPath(root, book.file), 'utf8') : print(config)
    if ((!enable || create) && Buffer.byteLength(data) > 1024 * 1024) data = JSON.stringify(config)

    const stage = mkdtempSync(join(tmpdir(), 'perspectra-mode-edit-'))
    try {
      await buildSource(root, stage, undefined, target => {
        writeAtomic(target, book.file, data)
        if (enable) enableInManifest(target, book.file, descriptor)
      })
    } finally {
      rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
    const latest = await read(root)
    if (
      book.file !== latest.file ||
      book.enabled !== latest.enabled ||
      book.configExists !== latest.configExists ||
      !isDeepStrictEqual(book.config, latest.config)
    )
      throw new EditConflict(book.file, book.config, latest.config, config)
    validate?.(config, latest)
    if (create || !enable) writeAtomic(root, book.file, data)
    if (enable) {
      try {
        enableInManifest(root, book.file, descriptor)
      } catch (e) {
        if (create) rmSync(packPath(root, book.file))
        throw e
      }
    }
    return await read(root)
  } finally {
    release()
  }
}
