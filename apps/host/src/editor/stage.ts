import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { configCandidates, configObject, type ConfigObject } from '@perspectra/world-pack/editor-config'
import { ACTIVITY_MANAGEMENT_OPERATIONS } from '@perspectra/sdk/contracts'
import { stageConfig } from '../runtime/pack-frontend.ts'
import { readPackComponents } from '../runtime/pack-components.ts'
import { packActivityCatalog } from '../runtime/activity-page-catalog.ts'
import { withDraftActivities } from './activity-pages.ts'
import { EditConflict, packPath, readProject } from './project.ts'
import { acquireSourceLock, writeAtomic } from './source-files.ts'
import { worldRecords } from './world-records.ts'
import { stageSchema, componentsSchema } from './stage-schema.ts'
import { assetTarget, stageArtFiles } from './stage-art.ts'

function stageKind(kind: unknown): 'stage' | 'components' {
  if (kind === undefined || kind === 'stage') return 'stage'
  if (kind === 'components') return 'components'
  throw new TypeError('未知舞台配置')
}
function readConfig(root: string, kind: 'stage' | 'components') {
  const file = 'frontend/' + kind + '.json',
    path = packPath(root, file)
  const config: ConfigObject = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : kind === 'stage'
      ? { characters: {} }
      : { version: 1, components: {} }
  return { file, config }
}
export async function stageBook(source: string, body: Record<string, unknown> = {}) {
  const root = realpathSync(source),
    kind = stageKind(body.kind)
  const menus =
    kind === 'stage'
      ? withDraftActivities(root, await packActivityCatalog(root), readProject(root))
      : new Map<never, never>()
  const records = worldRecords(root).records
  const options = (kind: 'character' | 'location') =>
    records.filter(r => r.kind === kind).map(({ id, name }) => ({ id, name }))
  const characters = options('character'),
    locations = options('location'),
    files = stageArtFiles(root)
  const { file, config } = readConfig(root, kind)
  const warnings: string[] = []
  const components =
    kind === 'components'
      ? readPackComponents(
          existsSync(packPath(root, file)) ? readFileSync(packPath(root, file)) : Buffer.from(JSON.stringify(config)),
          m => warnings.push(m),
        )
      : undefined
  return {
    kind,
    file,
    config,
    schema: kind === 'stage' ? stageSchema : componentsSchema,
    characters,
    locations,
    items: [],
    player: String(records.find(r => r.kind === 'slot')?.values.characterId ?? ''),
    customPage: existsSync(packPath(root, 'frontend/index.html')),
    warnings,
    ...(warnings.length ? { usableLayout: { version: 1, components: components ?? {} } as ConfigObject } : {}),
    activityMenus: [...menus].map(([id, m]) => ({
      id,
      name: m.title,
      operations: m.operations
        .filter(op => op.id.startsWith('activity:') && !ACTIVITY_MANAGEMENT_OPERATIONS.has(op.id.slice(9)))
        .map(op => ({ id: op.id.slice(9), name: op.label })),
    })),
    files,
    images: files
      .filter(path => path.startsWith('frontend/portraits/') && /\.(?:png|webp)$/iu.test(path))
      .map(path => path.slice(9)),
    cover: assetTarget('cover', '', files).path,
    portraits: Object.fromEntries(characters.map(c => [c.id, assetTarget('portrait', c.id, files).path])),
    backgrounds: Object.fromEntries(locations.map(c => [c.id, assetTarget('background', c.id, files).path])),
  }
}
export async function stageCandidates(source: string, body: Record<string, unknown>) {
  if (!Array.isArray(body.path) || !body.path.every(p => typeof p === 'string')) throw new TypeError('需要字段路径数组')
  const b = await stageBook(source, body)
  return {
    options:
      configCandidates(b.kind, configObject(body.config ?? b.config), b, body.path, body.dictionary === true) ?? null,
  }
}
export async function saveStage(source: string, body: Record<string, unknown>) {
  const root = realpathSync(source),
    release = acquireSourceLock(root)
  try {
    const book = await stageBook(root, body)
    if (!isDeepStrictEqual(body.base, book.config))
      throw new EditConflict(book.file, body.base, book.config, body.config)
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))
      throw new TypeError('需要舞台配置对象')
    const config = body.config as ConfigObject
    let bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n')
    if (book.kind === 'components') {
      if (bytes.length > 8192) bytes = Buffer.from(JSON.stringify(config))
      readPackComponents(bytes, message => {
        throw new TypeError(message)
      })
    } else {
      const stage = stageConfig(bytes, path => book.images.includes(path))
      for (const id of Object.keys(stage.characters))
        if (!book.characters.some(c => c.id === id)) throw new TypeError('舞台角色不存在：' + id)
      if (
        stage.autoplay &&
        !book.activityMenus
          .find(a => a.id === stage.autoplay!.activity)
          ?.operations.some(op => op.id === stage.autoplay!.operation)
      )
        throw new TypeError('开场活动中找不到推进操作')
    }
    writeAtomic(root, book.file, bytes)
    return { ...book, config, warnings: [], usableLayout: undefined }
  } finally {
    release()
  }
}
