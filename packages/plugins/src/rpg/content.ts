import { battleKnowledge } from './battle-knowledge.ts'
import { officialRpgBattleView } from './battle-view.ts'
import configSchema from './config-schema.json' with { type: 'json' }
import { ConfigInputError } from './config.ts'
import type { ContentGenerator } from '@perspectra/sdk'
import { nativeGameplay } from '@perspectra/sdk'
import type { WorldJsonObject, StatusTruth } from '@perspectra/sdk/contracts'
import { parseRpgConfig } from './config.ts'
import { generateMapActivities } from './map-activity.ts'
import {
  OFFICIAL_RPG_DATA_VERSION,
  OFFICIAL_RPG_ID,
  OFFICIAL_RPG_SUPPORTED_DATA_VERSIONS,
  OFFICIAL_RPG_VERSION,
} from './plugin.ts'
import { PARTY_STATUS, UNLOCKED_STATUS } from './state.ts'
import { generateStatusModule } from './status-module.ts'

/** 将包内 rpg.json 解析为原生状态模块、每张地图一个原生活动以及锁门／金库／队伍随行规则层。 */
export const officialRpgContent: ContentGenerator = {
  id: OFFICIAL_RPG_ID,
  version: OFFICIAL_RPG_VERSION,
  configFile: 'rpg.json',
  dataVersion: OFFICIAL_RPG_DATA_VERSION,
  supportedDataVersions: OFFICIAL_RPG_SUPPORTED_DATA_VERSIONS,
  requiredPlugins: ['official-dice'],
  configSchema,
  validateConfig(raw, pack) {
    try {
      parseRpgConfig(raw, pack)
      return []
    } catch (error) {
      if (error instanceof ConfigInputError) return [{ path: error.path, message: error.message }]
      throw error
    }
  },
  generate(raw, pack) {
    const config = parseRpgConfig(raw, pack)
    const status = generateStatusModule(config)
    const activities = generateMapActivities(config, {
      ...(pack.playerId === undefined ? {} : { playerId: pack.playerId }),
      names: pack.names,
    })
    const definition = nativeGameplay({
      id: OFFICIAL_RPG_ID,
      version: OFFICIAL_RPG_VERSION,
      dataVersion: OFFICIAL_RPG_DATA_VERSION,
      supportedDataVersions: OFFICIAL_RPG_SUPPORTED_DATA_VERSIONS,
      status,
      activities,
    })
    const gameplay = {
      ...definition,
      projectState: ({ actorId, state }: Parameters<NonNullable<typeof definition.projectState>>[0]) =>
        ({
          ...state,
          battleKnowledge: battleKnowledge(config, actorId),
        }) as unknown as WorldJsonObject,
      playerView: ({
        playerId,
        activities: scoped = [],
      }: import('@perspectra/sdk').GameplayPlayerViewInput<WorldJsonObject>) => {
        for (const activity of scoped) {
          const entry = activities.find(entry => entry.key === activity.activityKey)
          if (!entry) continue
          const view = officialRpgBattleView(
            entry.activity,
            activity,
            playerId,
            Array.isArray(activity.presentParticipants) ? (activity.presentParticipants as string[]) : [playerId],
          )
          if (view)
            return {
              stage: {
                renderer: 'official-rpg.battle',
                activityKey: view.activityKey,
                activityId: view.activityId,
                revision: view.revision,
                payload: view as unknown as WorldJsonObject,
              },
            }
        }
        return {}
      },
      physicalEffects: { characters: Object.keys(config.characters), entities: pack.entityIds },
      restrictions: [
        {
          id: 'official-rpg:vault',
          operations: ['move'],
          check: ({ parameters }: { parameters: WorldJsonObject }) =>
            parameters.locationId === config.vault
              ? { code: 'RPG_VAULT_INACCESSIBLE', message: '这条路现在走不通。' }
              : undefined,
        },
        {
          id: 'official-rpg:exits',
          showBlocked: true,
          operations: ['move'],
          check: ({
            parameters,
            state,
            world,
          }: {
            parameters: WorldJsonObject
            state: Readonly<WorldJsonObject>
            world?: Readonly<WorldJsonObject>
          }) => {
            const to = parameters.locationId
            const exits = config.maps
              .flatMap(map => (map.exits ?? []).map(exit => ({ from: map.locationId, exit })))
              .filter(row => row.exit.to === to)
            const local = exits.filter(row => row.from === world?.locationId),
              applicable = local.length ? local : exits
            const unlocked = (state as unknown as StatusTruth).public?.[UNLOCKED_STATUS]
            if (
              applicable.length &&
              !applicable.some(
                row =>
                  !row.exit.requires ||
                  (Array.isArray(unlocked) &&
                    unlocked.some(pair => Array.isArray(pair) && pair[0] === row.from && pair[1] === to)),
              )
            )
              return { code: 'RPG_EXIT_LOCKED', message: applicable[0]!.exit.lockedReason ?? '这条路现在走不通。' }
            return undefined
          },
        },
      ],
      afterAction: (value: Parameters<NonNullable<typeof definition.afterAction>>[0]) => {
        if (
          value.operationId !== 'move' ||
          value.actorId !== config.party?.leader ||
          value.beforeWorld?.locationId === value.candidateWorld?.locationId
        )
          return []
        const party = (value.before as unknown as StatusTruth).public[PARTY_STATUS]
        const characters = value.beforeWorld?.characters as Record<string, WorldJsonObject> | undefined
        return (Array.isArray(party) ? party : [])
          .filter(
            (id): id is string =>
              typeof id === 'string' &&
              id !== value.actorId &&
              characters?.[id]?.locationId === value.beforeWorld?.locationId &&
              characters?.[id]?.lifecycle === 'active',
          )
          .map(id => ({
            kind: 'event' as const,
            event: {
              eventType: 'character.moved',
              eventVersion: 1,
              data: {
                characterId: id,
                fromLocationId: value.beforeWorld!.locationId!,
                toLocationId: value.candidateWorld!.locationId!,
              },
            },
          }))
      },
    }
    return {
      gameplayConfig: {},
      gameplay: [gameplay],
      statusModules: [status],
      activities,
    }
  },
}
