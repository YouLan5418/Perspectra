import { readFileSync } from 'node:fs'
import type { RpgConfig } from './config.ts'

/** Host limit for one activity script. */
const ACTIVITY_SOURCE_LIMIT = 256 * 1024
const ACTIVITY_KEY = /^[a-z][a-z0-9-]{0,40}$/u

// The rules are plain script bytes shipped beside this file; the generator appends the map's config, never re-serialises code.
const rules = readFileSync(new URL('./runtime/map-battle.js', import.meta.url), 'utf8')

export interface MapActivityOptions {
  /** The pack's player character; defaults to `party.leader`. */
  playerId?: string
  /** Display names of characters and locations, used in titles and battle text. */
  names?: Record<string, string>
}

/** `rpg-map-<location id without location:>`, the key of the map's activity under scripts/activities. */
export const mapActivityKey = (locationId: string) => 'rpg-map-' + locationId.replace(/^location:/u, '')

/**
 * One activity per map. It starts when the player arrives with every configured companion present, plays the
 * narration, then the scripted lines for entering, the encounter and the battle, and ends.
 */
export function generateMapActivities(
  config: RpgConfig,
  options: MapActivityOptions = {},
): { key: string; source: string }[] {
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
      // A second enemy of the same kind gets its own id and name, so targets stay unambiguous.
      return { ...enemy, id: n ? `${id}-${n + 1}` : id, name: n ? `${enemy.name}${n + 1}` : enemy.name }
    })
    const used = new Set([
      ...Object.values(config.characters).flatMap(c => c.skills),
      ...enemies.flatMap(e => e.skills),
    ])
    const install = {
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
      stats: config.stats.map(({ key: statKey, label }) => ({ key: statKey, label })),
      characters: config.characters,
      skills: config.skills.filter(s => used.has(s.id)),
      equipment: config.equipment,
      ...(config.defeat ? { defeat: config.defeat } : {}),
      retreat: config.retreat,
      lockDuringBattle: config.party?.lockDuringBattle ?? true,
    }
    const source = `${rules}\ninstallMap(${JSON.stringify(install)})\n`
    if (Buffer.byteLength(source) > ACTIVITY_SOURCE_LIMIT)
      throw new RangeError(`maps[${i}]：生成的地图活动脚本超过 256 KiB`)
    return { key, source }
  })
}
