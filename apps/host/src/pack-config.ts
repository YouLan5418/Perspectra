import { readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, realpathSync, openSync, closeSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type WorldJsonObject } from '@perspectra/sdk/contracts'
import {
  compileWorldPackSource,
  selectedPluginConfig,
  validatePackAuthoring,
  PACK_CONFIG_BYTE_LIMIT,
} from '@perspectra/world-pack'
import type { HostPluginSettings } from './host-plugin-settings.ts'
import { authoringValidators, packValidationCatalog } from './pack-validation.ts'
import { GameplayScript } from './official-bundle.ts'

export interface PackConfigEntry {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly schema: WorldJsonObject
  readonly text: string
}
export interface PackConfigDocument {
  readonly packHash: string
  readonly entries: readonly PackConfigEntry[]
  readonly validation: string
}
const inside = (root: string, file: string) => {
  const rel = relative(realpathSync(root), realpathSync(file))
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel))
    throw new TypeError('PACK_CONFIG_PATH_INVALID')
  return file
}
async function inspect(packPath: string, settings: readonly HostPluginSettings[]) {
  const pack = await compileWorldPackSource(packPath, [])
  const catalog = await packValidationCatalog(pack, settings)
  return { pack, catalog }
}
function readAsset(packPath: string, file: string) {
  const text = readFileSync(inside(packPath, join(packPath, file)), 'utf8')
  if (Buffer.byteLength(text) > PACK_CONFIG_BYTE_LIMIT) throw new TypeError(file + ': config exceeds 1 MiB')
  return text
}
export async function readPackConfiguration(
  packPath: string,
  settings: readonly HostPluginSettings[],
): Promise<PackConfigDocument> {
  const { pack, catalog } = await inspect(packPath, settings)
  const entries: PackConfigEntry[] = []
  for (const id of Object.keys(pack.plugins ?? {})) {
    const descriptor = catalog.find(plugin => plugin.id === id)
    if (!descriptor) throw new TypeError(id + ': selected plugin is missing')
    const file = selectedPluginConfig(pack, descriptor)
    if (!file || !descriptor.configSchema) continue
    entries.push({
      id,
      title: id,
      path: file,
      schema: structuredClone(descriptor.configSchema) as WorldJsonObject,
      text: readAsset(packPath, file),
    })
  }
  if (pack.scripts?.gameplay) {
    const script = new GameplayScript(readAsset(packPath, pack.scripts.gameplay.entry))
    try {
      entries.push({
        id: 'scripts/gameplay',
        title: script.definition.id,
        path: 'worldpack.source.json#/scripts/gameplay/config',
        schema: structuredClone(script.definition.configSchema) as WorldJsonObject,
        text: JSON.stringify(pack.scripts.gameplay.config ?? {}, null, 2),
      })
    } finally {
      script.close()
    }
  }
  let validation = ''
  try {
    validatePackAuthoring(pack, file => readAsset(packPath, file), {
      content: catalog,
      ...authoringValidators(packPath),
    })
  } catch (error) {
    validation = error instanceof Error ? error.message : 'Pack validation failed'
  }
  return { packHash: pack.packHash, entries, validation }
}

/** Save exactly one declared config, after full pure validation; never alter a running world or its save. */
export async function savePackConfiguration(
  packPath: string,
  settings: readonly HostPluginSettings[],
  input: { id: string; packHash: string; value: unknown },
  assertWritable: () => void,
): Promise<void> {
  assertWritable()
  const lockPath = join(realpathSync(packPath), '.perspectra-config.lock')
  let lock: number
  try {
    lock = openSync(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        '源包配置正在被其他编辑保存，请稍后重新载入；若先前进程已退出，请移除包内 .perspectra-config.lock 后重试。',
      )
    throw error
  }
  try {
    const { pack, catalog } = await inspect(packPath, settings)
    if (pack.packHash !== input.packHash) throw new TypeError('源包已被其他编辑修改，请重新载入配置。')
    if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value))
      throw new TypeError('配置须为 JSON 对象。')
    const content = JSON.stringify(input.value, null, 2) + '\n'
    if (Buffer.byteLength(content) > PACK_CONFIG_BYTE_LIMIT) throw new TypeError('配置超过 1 MiB。')
    let file: string, serialized: string
    let proposed = structuredClone(pack)
    if (input.id === 'scripts/gameplay') {
      if (!proposed.scripts?.gameplay) throw new TypeError('包内玩法脚本未启用。')
      proposed = {
        ...proposed,
        scripts: {
          ...proposed.scripts,
          gameplay: { ...proposed.scripts.gameplay, config: input.value as WorldJsonObject },
        },
      }
      file = 'worldpack.source.json'
      const source = JSON.parse(readAsset(packPath, file))
      source.scripts.gameplay.config = input.value
      serialized = JSON.stringify(source, null, 2) + '\n'
    } else {
      const descriptor = catalog.find(plugin => plugin.id === input.id)
      if (!descriptor || !Object.hasOwn(pack.plugins ?? {}, input.id) || !descriptor.configSchema)
        throw new TypeError('该配置不属于当前启用的玩法。')
      const selected = selectedPluginConfig(pack, descriptor)
      if (!selected || !pack.assets.some(asset => asset.path === selected))
        throw new TypeError('配置文件未登记在包内资产中。')
      file = selected
      serialized = content
    }
    validatePackAuthoring(
      proposed,
      name => (name === file && file !== 'worldpack.source.json' ? serialized : readAsset(packPath, name)),
      { content: catalog, ...authoringValidators(packPath) },
    )
    const target = inside(packPath, join(packPath, file))
    // The source path is selected by the server, not by the renderer. Keep the rename on the same filesystem.
    const temporary = join(dirname(target), '.config-' + randomUUID() + '.tmp')
    assertWritable()
    try {
      writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, target)
    } finally {
      rmSync(temporary, { force: true })
    }
  } finally {
    closeSync(lock)
    unlinkSync(lockPath)
  }
}
