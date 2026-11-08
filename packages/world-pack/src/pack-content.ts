import type { CompiledWorldPackV5 } from './contracts.ts'

/** The pack facts a content generator reads; the same shape as the plugin SDK's ContentPackFacts. */
export interface PackContentFacts {
  characterIds: string[]
  locationIds: string[]
  entityIds: string[]
  entityLocations: Record<string, string | null>
  playerId?: string
  names: Record<string, string>
}

/** The part of a plugin's content generator that finding and parsing its config file needs. */
export interface PackContentGenerator<Generated = unknown> {
  readonly id: string
  readonly version: string
  readonly configFile: string
  generate(config: unknown, pack: PackContentFacts): Generated
}

export function packContentFacts(pack: CompiledWorldPackV5): PackContentFacts {
  const { characters, locations, entities, playerSlots } = pack.content
  const player = playerSlots[0]?.characterId
  return {
    characterIds: characters.map(character => character.characterId),
    locationIds: locations.map(location => location.locationId),
    entityIds: entities.map(entity => entity.entityId),
    entityLocations: Object.fromEntries(entities.map(entity => [entity.entityId, entity.locationId])),
    ...(player === undefined ? {} : { playerId: player }),
    names: Object.fromEntries([
      ...characters.map(character => [character.characterId, character.displayName]),
      ...locations.map(location => [location.locationId, location.name]),
    ]),
  }
}

type Declared = { plugin?: { id?: unknown; version?: unknown } } | null
const declaredPlugin = (raw: Declared) =>
  typeof raw?.plugin?.id === 'string' && typeof raw.plugin.version === 'string'
    ? `${raw.plugin.id} ${raw.plugin.version}`
    : undefined

/**
 * Run every generator whose config file the pack registers in assetFiles, in the generators' order. A config file
 * names the generator it was written for in `plugin: { id, version }`; a root JSON asset that names one no generator
 * serves stops the pack, while any other asset stays an ordinary asset. Errors are the author's: they name the file
 * and, for bad config, the JSON path.
 */
export function generatePackContent<G extends PackContentGenerator>(
  pack: CompiledWorldPackV5,
  generators: readonly G[],
  read: (file: string) => string,
): { generator: G; config: unknown; generated: ReturnType<G['generate']> }[] {
  const ids = new Set<string>(),
    files = new Set<string>()
  for (const generator of generators) {
    if (ids.has(generator.id)) throw new TypeError(`内容生成插件 ${generator.id} 重复提供`)
    if (files.has(generator.configFile))
      throw new TypeError(`两个内容生成插件都读取 ${generator.configFile}，当前组合无法决定用哪一个`)
    ids.add(generator.id)
    files.add(generator.configFile)
  }
  for (const asset of pack.assets) {
    if (asset.path.includes('/') || !asset.path.endsWith('.json') || files.has(asset.path)) continue
    const text = read(asset.path)
    let raw: Declared
    try {
      raw = JSON.parse(text)
    } catch {
      continue
    }
    const wanted = declaredPlugin(raw)
    if (wanted) throw new Error(`这个包的 ${asset.path} 需要插件 ${wanted}，当前组合没有提供`)
  }
  const results: { generator: G; config: unknown; generated: ReturnType<G['generate']> }[] = []
  for (const generator of generators) {
    const file = generator.configFile
    if (!pack.assets.some(asset => asset.path === file)) continue
    let raw: Declared
    try {
      raw = JSON.parse(read(file))
    } catch (error) {
      throw new TypeError(`${file} 无法读取：${(error as Error).message}`, { cause: error })
    }
    const wanted = declaredPlugin(raw)
    if (!wanted)
      throw new TypeError(
        `${file} 缺少 plugin 字段：需要写明所用插件的 id 和 version，例如 ${generator.id} ${generator.version}`,
      )
    if (wanted !== `${generator.id} ${generator.version}`)
      throw new Error(`${file} 需要插件 ${wanted}，当前程序提供 ${generator.id} ${generator.version}`)
    let generated: ReturnType<G['generate']>
    try {
      generated = generator.generate(raw, packContentFacts(pack)) as ReturnType<G['generate']>
    } catch (error) {
      throw new TypeError(`${file} 的 ${(error as Error).message}`, { cause: error })
    }
    results.push({ generator, config: raw, generated })
  }
  return results
}
