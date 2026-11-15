import configSchema from './config-schema.json' with { type: 'json' }
import { ConfigInputError } from './config.ts'
import type { ContentGenerator, ContentPackFacts } from '@harness-world/plugin-sdk'
import { nativeGameplay } from '@harness-world/plugin-sdk'
import { createTrpgActivityHooks } from './activity.ts'
import {
  OFFICIAL_TRPG_DATA_VERSION,
  OFFICIAL_TRPG_ID,
  OFFICIAL_TRPG_SUPPORTED_DATA_VERSIONS,
  OFFICIAL_TRPG_VERSION,
  parseTrpgConfig,
} from './config.ts'

/** 跑团原生活动的唯一标识。 */
export const TRPG_ACTIVITY_KEY = 'trpg'

const TRPG_CONFIG_LIMIT = 256 * 1024

function resolvedActivityConfig(raw: unknown, pack: ContentPackFacts) {
  const config = parseTrpgConfig(raw, pack)
  if (pack.playerId === undefined) throw new ConfigInputError('/playerId', '跑团需要包里有玩家角色')
  const names = Object.fromEntries(pack.characterIds.map(id => [id, pack.names[id] ?? id]))
  const activityConfig = { ...config, playerId: pack.playerId, names }
  if (Buffer.byteLength(JSON.stringify(activityConfig)) > TRPG_CONFIG_LIMIT)
    throw new ConfigInputError('/', '跑团活动配置超过 256 KiB')
  return activityConfig
}

/** 将包内 trpg.json 解析为原生 TypeScript 跑团活动，不再生成或拼接脚本文本。 */
export const officialTrpgContent: ContentGenerator = {
  id: OFFICIAL_TRPG_ID,
  version: OFFICIAL_TRPG_VERSION,
  configFile: 'trpg.json',
  dataVersion: OFFICIAL_TRPG_DATA_VERSION,
  supportedDataVersions: OFFICIAL_TRPG_SUPPORTED_DATA_VERSIONS,
  requiredPlugins: ['official-dice'],
  configSchema,
  validateConfig(raw, pack) {
    try {
      resolvedActivityConfig(raw, pack)
      return []
    } catch (error) {
      if (error instanceof ConfigInputError) return [{ path: error.path, message: error.message }]
      throw error
    }
  },
  generate(raw, pack) {
    const activityConfig = resolvedActivityConfig(raw, pack)
    const activities = [{ key: TRPG_ACTIVITY_KEY, activity: createTrpgActivityHooks(activityConfig) }]
    return {
      gameplayConfig: {},
      activities,
      gameplay: [
        nativeGameplay({
          id: OFFICIAL_TRPG_ID,
          version: OFFICIAL_TRPG_VERSION,
          dataVersion: OFFICIAL_TRPG_DATA_VERSION,
          supportedDataVersions: OFFICIAL_TRPG_SUPPORTED_DATA_VERSIONS,
          requiredServices: ['dice'],
          activities,
        }),
      ],
    }
  },
}
