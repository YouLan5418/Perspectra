import { readFileSync } from 'node:fs'
import type { RpgConfig } from './config.ts'

/** Host limit for one pack module script. */
const MODULE_SOURCE_LIMIT = 64 * 1024

export const RPG_MODULE_ID = 'rpg'

// The rules are plain script bytes shipped beside this file; the generator appends the config, never re-serialises code.
const rules = readFileSync(new URL('./runtime/status-rules.js', import.meta.url), 'utf8')

export interface RpgStatusModule {
  /** One entry of the pack's plugins.json `modules`. */
  declaration: { id: string; entry: string; characters: string[]; capabilities: [] }
  /** Contents of `plugins/rpg.js`. */
  source: string
}

/** Public status listing the doors someone has unlocked, by {@link doorId}. */
export const UNLOCKED_STATUS = 'rpg-unlocked'
/** A locked exit's stable id: where it leads from and to. */
export const doorId = (from: string, to: string) => `${from}>${to}`

/** Every exit that needs a key: unlocked once someone holding the key uses it at the door, then open to anyone. */
export function lockedDoors(config: RpgConfig): { id: string; from: string; key: string }[] {
  return config.maps.flatMap(map =>
    (map.exits ?? []).flatMap(exit =>
      exit.requires ? [{ id: doorId(map.locationId, exit.to), from: map.locationId, key: exit.requires.holds }] : [],
    ),
  )
}

/** The pack module that holds RPG stats, rest, consumables, equipment, the party and unlocked doors. Operations
 * surface as `status:rpg-<op>`; with `party` set it adds `join` and `leave` and the public status `rpg-party`; with a
 * keyed exit it adds `unlock` and the public status `rpg-unlocked`. */
export function generateStatusModule(config: RpgConfig): RpgStatusModule {
  const used = {
    stats: config.stats,
    characters: Object.fromEntries(
      Object.entries(config.characters).map(([id, c]) => [id, { stats: c.stats, slots: c.slots }]),
    ),
    equipment: config.equipment,
    consumables: config.consumables,
    ...(config.rest ? { rest: config.rest } : {}),
    ...(config.party ? { party: config.party } : {}),
    doors: lockedDoors(config),
  }
  const source = `${rules}\ninstall(${JSON.stringify(used)})\n`
  if (Buffer.byteLength(source) > MODULE_SOURCE_LIMIT) throw new RangeError('rpg 状态模块脚本超过 64 KiB')
  return {
    declaration: {
      id: RPG_MODULE_ID,
      entry: `plugins/${RPG_MODULE_ID}.js`,
      characters: Object.keys(config.characters),
      capabilities: [],
    },
    source,
  }
}
