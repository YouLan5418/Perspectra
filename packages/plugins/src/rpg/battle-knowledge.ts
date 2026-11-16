import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import type { MapBattleConfig } from './battle.ts'

/** A participant knows their learned abilities and the declared public battle rules.
 * Do not include another unit's loadout, enemy strategy, world truth or future cues. */
export function battleKnowledge(
  config: Pick<MapBattleConfig, 'characters' | 'skills' | 'combatStatuses' | 'battleValues'>,
  actorId: string,
): WorldJsonObject {
  const learned = new Set(config.characters[actorId]?.skills ?? [])
  const skills = config.skills.filter(skill => learned.has(skill.id))
  const statuses = new Set(
    skills.flatMap(skill => skill.effects.flatMap(effect => (effect.kind === 'status' ? [effect.status] : []))),
  )
  for (const resource of Object.values(config.battleValues?.resources ?? {}))
    if (resource.onZeroStatus) statuses.add(resource.onZeroStatus)
  // Parsed configuration is JSON. Copy its selected fields so no definition references enter state.
  return structuredClone({
    skills,
    combatStatuses: Object.fromEntries(
      [...statuses].flatMap(id => (config.combatStatuses[id] ? [[id, config.combatStatuses[id]]] : [])),
    ),
    ...(config.battleValues ? { battleValues: config.battleValues } : {}),
    resultNote:
      '这些是你已学技能的规则说明，不是已经发生的效果；行动仍须等待正式裁定。当前生命、魔力、状态与活动内数值以 game.public 为准。',
  }) as unknown as WorldJsonObject
}
