import { readFileSync } from 'node:fs'
import type { ContentGenerator } from '@harness-world/plugin-sdk'
import { OFFICIAL_TRPG_ID, OFFICIAL_TRPG_VERSION, parseTrpgConfig } from './config.ts'

/** The key of the generated activity under scripts/activities. */
export const TRPG_ACTIVITY_KEY = 'trpg'

/** Host limit for one activity script. */
const ACTIVITY_SOURCE_LIMIT = 256 * 1024

// The rules are plain script bytes shipped beside this file; the generator appends the config, never re-serialises code.
const rules = readFileSync(new URL('./runtime/trpg.js', import.meta.url), 'utf8')

/** What a pack's trpg.json becomes: one TRPG activity. */
export const officialTrpgContent: ContentGenerator = {
  id: OFFICIAL_TRPG_ID,
  version: OFFICIAL_TRPG_VERSION,
  configFile: 'trpg.json',
  generate(raw, pack) {
    const config = parseTrpgConfig(raw, pack)
    if (pack.playerId === undefined) throw new TypeError('trpg.json：跑团需要包里有玩家角色')
    const names = Object.fromEntries(pack.characterIds.map(id => [id, pack.names[id] ?? id]))
    const install = { ...config, playerId: pack.playerId, names }
    const source = `${rules}\ninstallTrpg(${JSON.stringify(install)})\n`
    if (Buffer.byteLength(source) > ACTIVITY_SOURCE_LIMIT)
      throw new RangeError('trpg.json：生成的跑团活动脚本超过 256 KiB')
    return { activities: [{ key: TRPG_ACTIVITY_KEY, source }] }
  },
}
