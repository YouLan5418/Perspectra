import { createHash } from 'node:crypto'
import type { RulesInstance, SeamProvider, StatusModuleSource } from '@harness-world/plugin-sdk'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import type { RpgMechanism } from '../official-bundle.ts'
import { lockedPackAsset } from './pack-modules.ts'

const CONFIG = 'rpg.json'

/** What the RPG mechanism generates for one pack; the pack itself carries only rpg.json. */
export interface RpgContent {
  readonly activities: { key: string; source: string }[]
  readonly module: { declaration: object; source: string }
  readonly rules: SeamProvider<RulesInstance>
  /** sha256 of the plugin id, version and every generated source; a save keeps the one it was created with. */
  readonly contentHash: string
}

/** Generate a pack's RPG content when it registers rpg.json in assetFiles; otherwise there is none. */
export function loadRpgContent(
  packPath: string,
  pack: CompiledWorldPackV5,
  rpg: RpgMechanism | undefined,
): RpgContent | undefined {
  if (!pack.assets.some(asset => asset.path === CONFIG)) return undefined
  let raw: { plugin?: { id?: unknown; version?: unknown } } | null
  try {
    raw = JSON.parse(lockedPackAsset(packPath, pack, CONFIG))
  } catch (error) {
    throw new TypeError(`rpg.json 无法读取：${(error as Error).message}`, { cause: error })
  }
  const wanted = `${String(raw?.plugin?.id)} ${String(raw?.plugin?.version)}`
  if (!rpg) throw new Error(`这个包需要 RPG 插件 ${wanted}，当前组合没有提供`)
  if (raw?.plugin?.id !== rpg.id || raw.plugin.version !== rpg.version)
    throw new Error(`rpg.json 需要 RPG 插件 ${wanted}，当前程序提供 ${rpg.id} ${rpg.version}`)
  const { characters, locations, entities, playerSlots } = pack.content
  let config: ReturnType<RpgMechanism['parseConfig']>
  try {
    config = rpg.parseConfig(raw, {
      characterIds: characters.map(character => character.characterId),
      locationIds: locations.map(location => location.locationId),
      entityIds: entities.map(entity => entity.entityId),
      entityLocations: Object.fromEntries(entities.map(entity => [entity.entityId, entity.locationId])),
    })
  } catch (error) {
    throw new TypeError(`rpg.json 的 ${(error as Error).message}`, { cause: error })
  }
  const names = Object.fromEntries([
    ...characters.map(character => [character.characterId, character.displayName]),
    ...locations.map(location => [location.locationId, location.name]),
  ])
  const player = playerSlots[0]?.characterId
  const activities = rpg.mapActivities(config, { ...(player === undefined ? {} : { playerId: player }), names })
  const module = rpg.statusModule(config)
  const contentHash =
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify({ plugin: { id: rpg.id, version: rpg.version }, module, activities }))
      .digest('hex')
  return { activities, module, rules: rpg.rules(config), contentHash }
}

/** The generated status module as a status mechanism receives it, for a caller that opens status without PackModules. */
export function rpgStatusModuleSource(rpg: RpgContent): StatusModuleSource {
  const { id, characters } = rpg.module.declaration as { id: string; characters: string[] }
  return { id, source: rpg.module.source, characters: [...characters], unavailableCapabilities: [] }
}

/** A save opens only with the generated content it was created with; a save with no record yet takes the current. */
export function assertSavedRpgContent(saved: string | undefined, current: string): void {
  if (saved !== undefined && saved !== current)
    throw new Error(`RPG 插件生成的规则与存档不一致（存档 ${saved}，当前 ${current}）`)
}
