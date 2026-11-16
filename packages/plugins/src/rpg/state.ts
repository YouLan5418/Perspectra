import type { StatusTruth, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { RpgConfig, RpgEquipment, RpgParty } from './config.ts'

export const RPG_MODULE_ID = 'rpg'
export const EQUIPMENT_STATUS = 'rpg-equipment'
export const PARTY_STATUS = 'rpg-party'
export const UNLOCKED_STATUS = 'rpg-unlocked'
export const SPENT_ITEM_SUFFIX = '（已用完）'

/** 地图活动在持久状态中允许出现的全部阶段标识，读档数据兼容校验按此核对。 */
export const RPG_MAP_ACTIVITY_PHASES = [
  'enter',
  'standby',
  'encounter',
  'fighting',
  'aftermath',
  'done',
  'victory',
  'defeat',
  'fled',
  'left',
] as const

export const statKey = (key: string): string => `rpg-${key}`
export const maxStatKey = (key: string): string => `rpg-${key}-max`

export interface RpgLockedDoor {
  readonly from: string
  readonly to: string
  readonly key: string
}

export interface RpgItemSnapshot {
  readonly entityId: string
  readonly name?: string
  readonly kind?: string
  readonly holderId?: string | null
  readonly locationId?: string | null
}

/** 汇总所有需要钥匙开启的锁门（开启后记为世界事实 `[from, to]`，所有人均可通行）。 */
export function lockedDoors(config: RpgConfig): RpgLockedDoor[] {
  return config.maps.flatMap(map =>
    (map.exits ?? []).flatMap(exit =>
      exit.requires ? [{ from: map.locationId, to: exit.to, key: exit.requires.holds }] : [],
    ),
  )
}

export function isDoorUnlocked(list: unknown, door: { readonly from: string; readonly to: string }): boolean {
  if (!Array.isArray(list)) return false
  return list.some(pair => Array.isArray(pair) && pair[0] === door.from && pair[1] === door.to)
}

export function wornEquipment(characterState: WorldJsonObject | undefined): Readonly<Record<string, string>> {
  const raw = characterState?.[EQUIPMENT_STATUS]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries: [string, string][] = []
  for (const [slot, value] of Object.entries(raw)) {
    if (typeof value === 'string') entries.push([slot, value])
  }
  return Object.fromEntries(entries)
}

export function slotWearing(characterState: WorldJsonObject | undefined, entityId: string | null): string | undefined {
  if (!entityId) return undefined
  const worn = wornEquipment(characterState)
  return Object.keys(worn).find(slot => worn[slot] === entityId)
}

export function isSpentItem(item: { readonly kind?: unknown }): boolean {
  return typeof item.kind === 'string' && item.kind.endsWith(SPENT_ITEM_SUFFIX)
}

/** 背包与战斗共同读取的装备属性加成：仅计入槽位上登记且角色此刻实际拿在手里的装备。 */
export function heldEquipmentBonus(
  equipment: Readonly<Record<string, RpgEquipment>>,
  truth: StatusTruth | null | undefined,
  items: readonly RpgItemSnapshot[],
  characterId: string,
): { attack: number; defense: number; fire: number } {
  const bonus = { attack: 0, defense: 0, fire: 0 }
  const own = (truth?.characters[characterId] as WorldJsonObject | undefined) ?? undefined
  const worn = wornEquipment(own)
  for (const entityId of Object.values(worn)) {
    const piece = equipment[entityId]
    const held = items.some(item => item.entityId === entityId && item.holderId === characterId)
    if (piece && held) {
      bonus.attack += piece.attack
      bonus.defense += piece.defense
      bonus.fire += piece.resistances?.fire ?? 0
    }
  }
  return bonus
}

export function readPartyList(publicState: WorldJsonObject | undefined): string[] {
  const raw = publicState?.[PARTY_STATUS]
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

export function readUnlockedList(publicState: WorldJsonObject | undefined): [string, string][] {
  const raw = publicState?.[UNLOCKED_STATUS]
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (pair): pair is [string, string] =>
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string',
  )
}

/** 队伍成员必须既在名单中又与队长同处一地；异地脱节成员在队长或其本人执行状态操作时顺手清理。 */
export function stalePartyMembers(
  party: RpgParty | undefined,
  truth: StatusTruth,
  actorId: string,
  presentIds: readonly string[],
): string[] {
  if (!party) return []
  const listed = readPartyList(truth.public)
  if (actorId === party.leader) return listed.filter(id => !presentIds.includes(id))
  return listed.includes(actorId) && !presentIds.includes(party.leader) ? [actorId] : []
}

export function partyUpdateEffects(
  list: readonly string[],
  presentIds: readonly string[],
  actorId: string,
): {
  readonly changes: { holderId: null; key: string; value: string[] }[]
  readonly reveals: { observerId: string; holderId: null; key: string }[]
} {
  return {
    changes: [{ holderId: null, key: PARTY_STATUS, value: [...list] }],
    reveals: [...new Set([actorId, ...presentIds])].map(observerId => ({
      observerId,
      holderId: null,
      key: PARTY_STATUS,
    })),
  }
}
