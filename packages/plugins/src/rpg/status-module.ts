import type { StatusTruth, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { GeneratedStatusModule, StatusModuleHooks } from '@perspectra/sdk'
import type { RpgConfig } from './config.ts'
import {
  EQUIPMENT_STATUS,
  PARTY_STATUS,
  RPG_MODULE_ID,
  SPENT_ITEM_SUFFIX,
  UNLOCKED_STATUS,
  isDoorUnlocked,
  isSpentItem,
  lockedDoors,
  maxStatKey,
  partyUpdateEffects,
  readPartyList,
  readUnlockedList,
  slotWearing,
  stalePartyMembers,
  statKey,
  wornEquipment,
  type RpgItemSnapshot,
} from './state.ts'

export { RPG_MODULE_ID, UNLOCKED_STATUS, lockedDoors }

export type RpgStatusModule = GeneratedStatusModule

interface RpgPlaceInput {
  readonly locationId?: string | null
  readonly items?: readonly RpgItemSnapshot[]
}

interface RpgWorldInput {
  readonly locationId?: string | null
  readonly characterIds?: readonly string[]
  readonly items?: {
    readonly current?: readonly RpgItemSnapshot[]
  }
}

interface RpgKnownView {
  readonly public?: WorldJsonObject
  readonly self?: WorldJsonObject
}

const NO_INPUT_SCHEMA: WorldJsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

/** 构造原生 TypeScript RPG 状态模块：管理角色属性、休息、消耗品、装备槽、锁门开启与队伍进出。 */
export function generateStatusModule(config: RpgConfig): RpgStatusModule {
  const stats = config.stats
  const statLabel = (key: string): string => stats.find(stat => stat.key === key)?.label ?? key
  const consumables = Object.keys(config.consumables)
  const equipment = Object.keys(config.equipment)
  const party = config.party
  const doors = lockedDoors(config)
  const keys = [...new Set(doors.map(door => door.key))]

  const statuses: WorldJsonObject[] = stats.flatMap(stat => {
    const where = stat.locations ? { locations: [...stat.locations] } : {}
    return [
      { key: statKey(stat.key), label: stat.label, type: 'number', owner: 'character', bar: true, ...where },
      { key: maxStatKey(stat.key), label: `${stat.label}上限`, type: 'number', owner: 'character', ...where },
    ]
  })
  statuses.push({
    key: EQUIPMENT_STATUS,
    label: '装备',
    type: 'object',
    owner: 'character',
    schema: { type: 'object', maxProperties: 8, additionalProperties: { type: 'string', maxLength: 100 } },
  })
  if (party) {
    statuses.push({
      key: PARTY_STATUS,
      label: '队伍',
      type: 'array',
      owner: 'public',
      schema: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 100 } },
    })
  }
  if (doors.length) {
    const placeSchema = { type: 'string', maxLength: 200 }
    statuses.push({
      key: UNLOCKED_STATUS,
      label: '已开的门',
      type: 'array',
      owner: 'public',
      schema: {
        type: 'array',
        maxItems: 64,
        items: { type: 'array', minItems: 2, maxItems: 2, items: placeSchema },
      },
    })
  }

  const actions: WorldJsonObject[] = []
  if (config.rest) actions.push({ id: 'rest', label: config.rest.label, schema: NO_INPUT_SCHEMA })
  if (consumables.length)
    actions.push({ id: 'use', label: '使用{item}', targets: consumables, schema: NO_INPUT_SCHEMA })
  if (equipment.length) {
    actions.push({ id: 'equip', label: '装备{item}', targets: equipment, schema: NO_INPUT_SCHEMA })
    actions.push({ id: 'unequip', label: '卸下{item}', targets: equipment, schema: NO_INPUT_SCHEMA })
  }
  if (keys.length) actions.push({ id: 'unlock', label: '用{item}开锁', targets: keys, schema: NO_INPUT_SCHEMA })
  if (party) {
    actions.push({ id: 'join', label: '加入队伍', schema: NO_INPUT_SCHEMA })
    actions.push({ id: 'leave', label: '离开队伍', schema: NO_INPUT_SCHEMA })
  }

  const canRest = (locationId: string | null | undefined): boolean =>
    Boolean(config.rest && typeof locationId === 'string' && config.rest.locations.includes(locationId))
  const slotsOf = (actorId: string): readonly string[] => config.characters[actorId]?.slots ?? []

  const module: StatusModuleHooks = {
    definition: { statuses, actions },

    initialize(characterIds) {
      const own = (id: string): WorldJsonObject => {
        const base = config.characters[id]?.stats ?? {}
        const row: Record<string, WorldJsonObject | number> = { [EQUIPMENT_STATUS]: {} }
        for (const stat of stats) {
          const initial = base[stat.key] ?? 0
          row[statKey(stat.key)] = initial
          row[maxStatKey(stat.key)] = initial
        }
        return row
      }
      const shared: WorldJsonObject = {
        ...(party ? { [PARTY_STATUS]: [] } : {}),
        ...(doors.length ? { [UNLOCKED_STATUS]: [] } : {}),
      }
      return {
        public: shared,
        characters: Object.fromEntries(characterIds.map(id => [id, own(id)])),
      }
    },

    policy(knownRaw, actorId, placeRaw) {
      const known = knownRaw as unknown as RpgKnownView
      const place = placeRaw as unknown as RpgPlaceInput
      const items = place.items ?? []
      const mine = items.filter(item => item.holderId === actorId)
      const self = known.self
      const targets: Record<string, string[]> = {}
      const operations: string[] = []

      if (canRest(place.locationId)) operations.push('rest')

      const usable = mine
        .filter(item => consumables.includes(item.entityId) && !isSpentItem(item))
        .map(item => item.entityId)
      if (usable.length) {
        operations.push('use')
        targets.use = usable
      }

      const equippable = mine
        .filter(item => {
          const piece = config.equipment[item.entityId]
          return piece !== undefined && slotsOf(actorId).includes(piece.slot)
        })
        .map(item => item.entityId)
      const free = equippable.filter(id => !slotWearing(self, id))
      if (free.length) {
        operations.push('equip')
        targets.equip = free
      }

      const wornGear = equipment.filter(id => Boolean(slotWearing(self, id)))
      if (wornGear.length) {
        operations.push('unequip')
        targets.unequip = wornGear
      }

      const seenOpen = known.public?.[UNLOCKED_STATUS]
      const unlocking = mine
        .filter(item =>
          doors.some(
            door => door.key === item.entityId && door.from === place.locationId && !isDoorUnlocked(seenOpen, door),
          ),
        )
        .map(item => item.entityId)
      if (unlocking.length) {
        operations.push('unlock')
        targets.unlock = unlocking
      }

      if (party && actorId !== party.leader) {
        const listed = readPartyList(known.public).includes(actorId)
        operations.push(...(listed ? ['leave', 'join'] : ['join']))
      }

      return { operations, targets }
    },

    resolve(truth, actorId, operation, _parameters, worldRaw, targetId) {
      const world = worldRaw as unknown as RpgWorldInput
      const presentIds = world.characterIds ?? []
      const stale = stalePartyMembers(party, truth, actorId, presentIds)
      const remaining = readPartyList(truth.public).filter(id => !stale.includes(id))
      const result = operate(truth, actorId, operation, world, targetId, remaining)
      if (
        typeof result.rejectReason === 'string' ||
        !stale.length ||
        (Array.isArray(result.changes) &&
          result.changes.some(change => (change as { key?: unknown }).key === PARTY_STATUS))
      ) {
        return result
      }
      const cleanup = partyUpdateEffects(remaining, presentIds, actorId)
      const existingChanges = Array.isArray(result.changes) ? result.changes : []
      const existingReveals = Array.isArray(result.reveals) ? result.reveals : []
      return {
        ...result,
        changes: [...existingChanges, ...cleanup.changes],
        reveals: [...existingReveals, ...cleanup.reveals],
      }
    },
  }

  function operate(
    truth: StatusTruth,
    actorId: string,
    operation: string,
    world: RpgWorldInput,
    targetId: string | null,
    members: readonly string[],
  ): WorldJsonObject {
    const own = (truth.characters[actorId] ?? {}) as WorldJsonObject
    const presentIds = world.characterIds ?? []
    const reject = (rejectReason: string): WorldJsonObject => ({ rejectReason })

    if (operation === 'rest') {
      if (!canRest(world.locationId)) return reject('这里不能休息。')
      const changes = stats
        .filter(stat => Number(own[statKey(stat.key)] ?? 0) < Number(own[maxStatKey(stat.key)] ?? 0))
        .map(stat => ({
          holderId: actorId,
          key: statKey(stat.key),
          value: Number(own[maxStatKey(stat.key)] ?? 0),
        }))
      return { changes, reveals: [], description: '睡了一觉，精神恢复了。', audience: 'scene' }
    }

    const currentItems = world.items?.current ?? []
    const item = targetId === null ? undefined : currentItems.find(entry => entry.entityId === targetId)

    if (operation === 'use') {
      const consumable = targetId === null ? undefined : config.consumables[targetId]
      if (!consumable || targetId === null) return reject('这件东西不能这样用。')
      if (!item || item.holderId !== actorId) return reject('你手里没有这件东西。')
      if (isSpentItem(item)) return reject('已经用完了。')
      const name = item.name || item.kind || targetId
      const restore = consumable.restore
      const changes = Object.keys(restore).map(key => ({
        holderId: actorId,
        key: statKey(key),
        value: Math.min(Number(own[maxStatKey(key)] ?? 0), Number(own[statKey(key)] ?? 0) + restore[key]!),
      }))
      const effect = Object.keys(restore)
        .map(key => `${statLabel(key)}恢复了`)
        .join('，')
      return {
        changes,
        reveals: [],
        items: [{ entityId: targetId, kind: `${name}${SPENT_ITEM_SUFFIX}` }],
        description: `使用了${name}${effect ? `，${effect}` : ''}。`,
        audience: 'scene',
      }
    }

    if (operation === 'equip') {
      const gear = targetId === null ? undefined : config.equipment[targetId]
      if (!gear || targetId === null) return reject('这件东西不能装备。')
      if (!item || item.holderId !== actorId) return reject('你手里没有这件东西。')
      if (!slotsOf(actorId).includes(gear.slot)) return reject('你没有可以装备它的位置。')
      if (slotWearing(own, targetId)) return reject('已经装备着了。')
      const worn = wornEquipment(own)
      if (worn[gear.slot]) return reject('这个位置已经装备了别的东西，需要先卸下。')
      return {
        changes: [{ holderId: actorId, key: EQUIPMENT_STATUS, value: { ...worn, [gear.slot]: targetId } }],
        reveals: [],
        description: `装备了${item.name || item.kind || targetId}。`,
        audience: 'scene',
      }
    }

    if (operation === 'unequip') {
      const slot = slotWearing(own, targetId)
      if (!slot) return reject('并没有装备着它。')
      const next = { ...wornEquipment(own) }
      delete next[slot]
      return {
        changes: [{ holderId: actorId, key: EQUIPMENT_STATUS, value: next }],
        reveals: [],
        description: `卸下了${item ? item.name || item.kind || '装备' : '装备'}。`,
        audience: 'scene',
      }
    }

    if (operation === 'unlock') {
      if (!item || item.holderId !== actorId || targetId === null) return reject('你手里没有这把钥匙。')
      const open = readUnlockedList(truth.public)
      const here = doors.filter(door => door.key === targetId && door.from === world.locationId)
      if (!here.length) return reject('这里没有它能打开的锁。')
      const name = item.name || item.kind || targetId
      const still = here.filter(door => !isDoorUnlocked(open, door))
      const reveals = [...new Set([actorId, ...presentIds])].map(observerId => ({
        observerId,
        holderId: null,
        key: UNLOCKED_STATUS,
      }))
      if (!still.length) return { changes: [], reveals, description: '锁已经开着了。', audience: 'self' }
      return {
        changes: [
          { holderId: null, key: UNLOCKED_STATUS, value: [...open, ...still.map(door => [door.from, door.to])] },
        ],
        reveals,
        description: `用${name}打开了门锁。`,
        audience: 'scene',
      }
    }

    if (party && operation === 'join') {
      if (actorId === party.leader) return reject('你就是队长。')
      if (!presentIds.includes(party.leader)) return reject('队长不在这里。')
      if (members.includes(actorId))
        return {
          ...partyUpdateEffects(members, presentIds, actorId),
          description: '已经在队伍里了。',
          audience: 'self',
        }
      return {
        ...partyUpdateEffects([...members, actorId], presentIds, actorId),
        description: '加入了队伍。',
        audience: 'scene',
      }
    }

    if (party && operation === 'leave') {
      if (!readPartyList(truth.public).includes(actorId))
        return {
          ...partyUpdateEffects(members, presentIds, actorId),
          description: '已经不在队伍里了。',
          audience: 'self',
        }
      const rest = members.filter(id => id !== actorId)
      return { ...partyUpdateEffects(rest, presentIds, actorId), description: '离开了队伍。', audience: 'scene' }
    }

    return reject('没有这个操作。')
  }

  return {
    declaration: {
      id: RPG_MODULE_ID,
      characters: Object.keys(config.characters),
      capabilities: [],
    },
    module,
  }
}
