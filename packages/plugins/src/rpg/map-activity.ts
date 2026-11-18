import type { GeneratedActivity } from '@perspectra/sdk'
import { createRpgMapBattleHooks } from './battle.ts'
import type { RpgConfig } from './config.ts'

const ACTIVITY_KEY = /^[a-z][a-z0-9-]{0,40}$/u
const MAP_CONFIG_LIMIT = 256 * 1024

export interface MapActivityOptions {
  /** 包内首位玩家角色；未提供时回退到 `party.leader`。 */
  playerId?: string
  /** 角色与地点展示名，用于活动标题和战斗播报。 */
  names?: Record<string, string>
}

/** `rpg-map-<location id without location:>`，地图原生活动的唯一标识。 */
export const mapActivityKey = (locationId: string) => 'rpg-map-' + locationId.replace(/^location:/u, '')

/** 为每张地图构造原生 TypeScript 探索与战斗活动定义，不再拼接脚本文本。 */
export function generateMapActivities(config: RpgConfig, options: MapActivityOptions = {}): GeneratedActivity[] {
  const playerId = options.playerId ?? config.party?.leader
  if (playerId === undefined || !(playerId in config.characters))
    throw new TypeError('characters：需要配置玩家角色的数值（或在 party.leader 指明玩家）')
  const names = options.names ?? {}
  const npcIds = Object.keys(config.characters).filter(id => id !== playerId)
  return config.maps.map((map, i) => {
    const key = mapActivityKey(map.locationId)
    if (!ACTIVITY_KEY.test(key))
      throw new TypeError(
        `maps[${i}].locationId：地点 ID 去掉 location: 后需要是小写字母开头的小写字母、数字、连字符，至多 33 字符`,
      )
    const enemyIds: string[] = []
    const enemies = (map.enemies ?? []).map(id => {
      const n = enemyIds.filter(seen => seen === id).length
      enemyIds.push(id)
      const enemy = config.enemies[id]!
      return { ...enemy, id: n ? `${id}-${n + 1}` : id, name: n ? `${enemy.name}${n + 1}` : enemy.name }
    })
    const used = new Set([
      ...Object.values(config.characters).flatMap(c => c.skills),
      ...enemies.flatMap(e => e.skills),
    ])
    const mapConfig = {
      title: (names[map.locationId] ?? map.locationId).slice(0, 80),
      playerId,
      npcIds,
      names,
      locationId: map.locationId,
      narration: map.narration,
      engage: map.engage ?? 'on-enter',
      enemies,
      drops: map.drops ?? [],
      scripted: map.scripted ?? [],
      stats: config.stats.map(({ key: statId, label }) => ({ key: statId, label })),
      characters: config.characters,
      skills: config.skills.filter(s => used.has(s.id)),
      combatStatuses: config.combatStatuses,
      battleValues: config.battleValues,
      equipment: config.equipment,
      ...(config.defeat ? { defeat: config.defeat } : {}),
      retreat: config.retreat,
      lockDuringBattle: config.party?.lockDuringBattle ?? true,
    }
    if (Buffer.byteLength(JSON.stringify(mapConfig)) > MAP_CONFIG_LIMIT)
      throw new RangeError(`maps[${i}]：地图活动配置超过 256 KiB`)
    // Visibility belongs to the player projection, outside the per-map rule payload budget.
    const activity = createRpgMapBattleHooks({ ...mapConfig, stats: config.stats })
    return { key, activity }
  })
}
