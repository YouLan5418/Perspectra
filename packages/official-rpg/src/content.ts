import type { ContentGenerator } from '@harness-world/plugin-sdk'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities } from './map-activity.ts'
import { OFFICIAL_RPG_ID, OFFICIAL_RPG_VERSION } from './plugin.ts'
import { createRpgRules } from './rules.ts'
import { generateStatusModule } from './status-module.ts'

/** What a pack's rpg.json becomes: one status module for stats, skills, items and battles, one activity per map, and
 * the rules layer for locked exits and the following party. */
export const officialRpgContent: ContentGenerator = {
  id: OFFICIAL_RPG_ID,
  version: OFFICIAL_RPG_VERSION,
  configFile: 'rpg.json',
  generate(raw, pack) {
    const config = parseRpgConfig(raw, pack)
    return {
      statusModules: [generateStatusModule(config)],
      activities: generateMapActivities(config, {
        ...(pack.playerId === undefined ? {} : { playerId: pack.playerId }),
        names: pack.names,
      }),
      rules: createRpgRules(config),
    }
  },
}
