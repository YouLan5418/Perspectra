import { OFFICIAL_RPG_ID, OFFICIAL_RPG_VERSION } from './index.ts'

export interface RpgStat {
  key: string
  label: string
  /** Where the stat is visible; changes are allowed anywhere. */
  locations?: string[]
}
export interface RpgCharacter {
  stats: Record<string, number>
  attack: number
  defense: number
  speed: number
  skills: string[]
  slots: string[]
}
export interface RpgSkill {
  id: string
  name: string
  kind: 'damage' | 'heal'
  scope: 'one' | 'all'
  power: number
  cost: Record<string, number>
}
export interface RpgEquipment {
  slot: string
  attack: number
  defense: number
  speed: number
}
export interface RpgEnemy {
  name: string
  hp: number
  attack: number
  defense: number
  speed: number
  skills: string[]
  strategy: 'lowest-hp' | 'random'
  lines: { encounter?: string; defeated?: string }
}
export interface RpgExit {
  to: string
  requires?: { holds: string }
  lockedReason?: string
}
export interface RpgScripted {
  when: 'enter' | 'encounter' | 'turn' | 'enemy-defeated'
  /** Battle round (1-based); required for `turn`, not allowed otherwise. */
  round?: number
  characterId: string
  say?: string
  skill?: string
  target?: string
}
export interface RpgMap {
  locationId: string
  narration: { first: string; again?: string }
  enemies?: string[]
  engage?: 'on-enter' | 'optional'
  drops?: string[]
  chest?: string
  exits?: RpgExit[]
  scripted?: RpgScripted[]
}
export interface RpgConfig {
  plugin: { id: string; version: string }
  stats: RpgStat[]
  characters: Record<string, RpgCharacter>
  skills: RpgSkill[]
  equipment: Record<string, RpgEquipment>
  consumables: Record<string, { restore: Record<string, number> }>
  rest?: { label: string; locations: string[]; restore: 'full' }
  enemies: Record<string, RpgEnemy>
  vault?: string
  maps: RpgMap[]
  defeat?: { to: string; restore: Record<string, number> }
  /** `stay`: the party stays; `back`: teleport to `defeat.to` like a defeat, without the defeat restore. */
  retreat: 'stay' | 'back'
  party?: { leader: string; lockDuringBattle: boolean }
}
export interface RpgPackIds {
  characterIds: string[]
  locationIds: string[]
  entityIds: string[]
}

/** Host limits for one status module: 64 statuses in all, `rpg-<key>-max` must fit a 41-character status key. */
export const MAX_RPG_STATS = 31
const STAT_KEY = /^[a-z][a-z0-9-]{0,32}$/u

type Json = Record<string, unknown>
const fail = (path: string, problem: string): never => {
  throw new TypeError(`${path}：${problem}`)
}
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown, path: string): Json => (isObject(value) ? value : fail(path, '需要是对象'))
const list = (value: unknown, path: string): unknown[] => (Array.isArray(value) ? value : fail(path, '需要是数组'))
const text = (value: unknown, path: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fail(path, '需要是非空字符串')
const count = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000
    ? value
    : fail(path, '需要是 0 到 100000 的整数')
const only = (value: Json, path: string, keys: readonly string[]) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path ? `${path}.${key}` : key, '不认识的字段')
}
const oneOf = <T extends string>(value: unknown, path: string, options: readonly T[]): T =>
  typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fail(path, `不认识的取值 ${JSON.stringify(value)}，可选 ${options.join('、')}`)

export function parseRpgConfig(value: unknown, pack: RpgPackIds): RpgConfig {
  const root = record(value, '(根)')
  only(root, '', [
    'plugin',
    'stats',
    'characters',
    'skills',
    'equipment',
    'consumables',
    'rest',
    'enemies',
    'vault',
    'maps',
    'defeat',
    'retreat',
    'party',
  ])
  const known = (ids: readonly string[], id: unknown, path: string, what: string): string => {
    const name = text(id, path)
    return ids.includes(name) ? name : fail(path, `未知${what} ${name}`)
  }
  const character = (id: unknown, path: string) => known(pack.characterIds, id, path, '角色')
  const location = (id: unknown, path: string) => known(pack.locationIds, id, path, '地点')
  const entity = (id: unknown, path: string) => known(pack.entityIds, id, path, '物品')

  const plugin = record(root.plugin, 'plugin')
  only(plugin, 'plugin', ['id', 'version'])
  if (plugin.id !== OFFICIAL_RPG_ID) fail('plugin.id', `需要是 ${OFFICIAL_RPG_ID}`)
  if (plugin.version !== OFFICIAL_RPG_VERSION) fail('plugin.version', `需要是 ${OFFICIAL_RPG_VERSION}`)

  const statRows = list(root.stats, 'stats')
  if (statRows.length > MAX_RPG_STATS) fail('stats', `最多 ${MAX_RPG_STATS} 项属性，超出宿主的状态数量上限`)
  const stats = statRows.map((row, i): RpgStat => {
    const path = `stats[${i}]`
    const stat = record(row, path)
    only(stat, path, ['key', 'label', 'locations'])
    const key = text(stat.key, `${path}.key`)
    if (!STAT_KEY.test(key))
      fail(`${path}.key`, `属性键 ${key} 需要是小写字母开头的小写字母、数字、连字符，至多 33 字符`)
    const label = text(stat.label, `${path}.label`)
    if (label.length > 36) fail(`${path}.label`, '显示名称至多 36 字')
    const locations =
      stat.locations === undefined
        ? undefined
        : list(stat.locations, `${path}.locations`).map((id, j) => location(id, `${path}.locations[${j}]`))
    if (locations?.length === 0) fail(`${path}.locations`, '不能为空数组')
    return { key, label, ...(locations ? { locations } : {}) }
  })
  if (new Set(stats.map(s => s.key)).size !== stats.length) fail('stats', '属性键重复')
  const statKeys = stats.map(s => s.key)
  const statKey = (id: unknown, path: string) => known(statKeys, id, path, '属性')
  const amounts = (value: unknown, path: string, every: boolean): Record<string, number> => {
    const row = record(value, path)
    const out: Record<string, number> = {}
    for (const [key, amount] of Object.entries(row))
      out[statKey(key, `${path}.${key}`)] = count(amount, `${path}.${key}`)
    if (every) for (const key of statKeys) if (!(key in out)) fail(path, `缺少属性 ${key}`)
    return out
  }

  const skills = list(root.skills ?? [], 'skills').map((row, i): RpgSkill => {
    const path = `skills[${i}]`
    const skill = record(row, path)
    only(skill, path, ['id', 'name', 'kind', 'scope', 'power', 'cost'])
    return {
      id: text(skill.id, `${path}.id`),
      name: text(skill.name, `${path}.name`),
      kind: oneOf(skill.kind, `${path}.kind`, ['damage', 'heal']),
      scope: oneOf(skill.scope ?? 'one', `${path}.scope`, ['one', 'all']),
      power: count(skill.power, `${path}.power`),
      cost: amounts(skill.cost ?? {}, `${path}.cost`, false),
    }
  })
  const skillIds = skills.map(s => s.id)
  if (new Set(skillIds).size !== skillIds.length) fail('skills', '技能 ID 重复')
  const skill = (id: unknown, path: string) => known(skillIds, id, path, '技能')

  const characters: Record<string, RpgCharacter> = {}
  for (const [id, row] of Object.entries(record(root.characters, 'characters'))) {
    const path = `characters.${id}`
    character(id, path)
    const c = record(row, path)
    only(c, path, ['stats', 'attack', 'defense', 'speed', 'skills', 'slots'])
    characters[id] = {
      stats: amounts(c.stats, `${path}.stats`, true),
      attack: count(c.attack, `${path}.attack`),
      defense: count(c.defense, `${path}.defense`),
      speed: count(c.speed, `${path}.speed`),
      skills: list(c.skills ?? [], `${path}.skills`).map((s, i) => skill(s, `${path}.skills[${i}]`)),
      slots: list(c.slots ?? [], `${path}.slots`).map((s, i) => text(s, `${path}.slots[${i}]`)),
    }
  }

  const equipment: Record<string, RpgEquipment> = {}
  for (const [id, row] of Object.entries(record(root.equipment ?? {}, 'equipment'))) {
    const path = `equipment.${id}`
    entity(id, path)
    const e = record(row, path)
    only(e, path, ['slot', 'attack', 'defense', 'speed'])
    equipment[id] = {
      slot: text(e.slot, `${path}.slot`),
      attack: count(e.attack ?? 0, `${path}.attack`),
      defense: count(e.defense ?? 0, `${path}.defense`),
      speed: count(e.speed ?? 0, `${path}.speed`),
    }
  }

  const consumables: Record<string, { restore: Record<string, number> }> = {}
  for (const [id, row] of Object.entries(record(root.consumables ?? {}, 'consumables'))) {
    const path = `consumables.${id}`
    entity(id, path)
    const c = record(row, path)
    only(c, path, ['restore'])
    consumables[id] = { restore: amounts(c.restore, `${path}.restore`, false) }
  }

  let rest: RpgConfig['rest']
  if (root.rest !== undefined) {
    const r = record(root.rest, 'rest')
    only(r, 'rest', ['label', 'locations', 'restore'])
    const label = text(r.label, 'rest.label')
    if (label.length > 36) fail('rest.label', '显示名称至多 36 字')
    const locations = list(r.locations, 'rest.locations').map((id, i) => location(id, `rest.locations[${i}]`))
    if (!locations.length) fail('rest.locations', '不能为空数组')
    rest = { label, locations, restore: oneOf(r.restore, 'rest.restore', ['full']) }
  }

  const enemies: Record<string, RpgEnemy> = {}
  for (const [id, row] of Object.entries(record(root.enemies ?? {}, 'enemies'))) {
    const path = `enemies.${id}`
    text(id, path)
    const e = record(row, path)
    only(e, path, ['name', 'hp', 'attack', 'defense', 'speed', 'skills', 'strategy', 'lines'])
    const lines = record(e.lines ?? {}, `${path}.lines`)
    only(lines, `${path}.lines`, ['encounter', 'defeated'])
    enemies[id] = {
      name: text(e.name, `${path}.name`),
      hp: count(e.hp, `${path}.hp`),
      attack: count(e.attack, `${path}.attack`),
      defense: count(e.defense, `${path}.defense`),
      speed: count(e.speed, `${path}.speed`),
      skills: list(e.skills, `${path}.skills`).map((s, i) => skill(s, `${path}.skills[${i}]`)),
      strategy: oneOf(e.strategy ?? 'lowest-hp', `${path}.strategy`, ['lowest-hp', 'random']),
      lines: {
        ...(lines.encounter === undefined ? {} : { encounter: text(lines.encounter, `${path}.lines.encounter`) }),
        ...(lines.defeated === undefined ? {} : { defeated: text(lines.defeated, `${path}.lines.defeated`) }),
      },
    }
  }
  const enemyIds = Object.keys(enemies)

  const vault = root.vault === undefined ? undefined : location(root.vault, 'vault')

  const maps = list(root.maps ?? [], 'maps').map((row, i): RpgMap => {
    const path = `maps[${i}]`
    const m = record(row, path)
    only(m, path, ['locationId', 'narration', 'enemies', 'engage', 'drops', 'chest', 'exits', 'scripted'])
    const narration = record(m.narration, `${path}.narration`)
    only(narration, `${path}.narration`, ['first', 'again'])
    const mapEnemies =
      m.enemies === undefined
        ? undefined
        : list(m.enemies, `${path}.enemies`).map((id, j) => known(enemyIds, id, `${path}.enemies[${j}]`, '敌人'))
    return {
      locationId: location(m.locationId, `${path}.locationId`),
      narration: {
        first: text(narration.first, `${path}.narration.first`),
        ...(narration.again === undefined ? {} : { again: text(narration.again, `${path}.narration.again`) }),
      },
      ...(mapEnemies ? { enemies: mapEnemies } : {}),
      ...(m.engage === undefined ? {} : { engage: oneOf(m.engage, `${path}.engage`, ['on-enter', 'optional']) }),
      ...(m.drops === undefined
        ? {}
        : { drops: list(m.drops, `${path}.drops`).map((id, j) => entity(id, `${path}.drops[${j}]`)) }),
      ...(m.chest === undefined ? {} : { chest: entity(m.chest, `${path}.chest`) }),
      ...(m.exits === undefined
        ? {}
        : {
            exits: list(m.exits, `${path}.exits`).map((exitRow, j): RpgExit => {
              const p = `${path}.exits[${j}]`
              const x = record(exitRow, p)
              only(x, p, ['to', 'requires', 'lockedReason'])
              let requires: RpgExit['requires']
              if (x.requires !== undefined) {
                const r = record(x.requires, `${p}.requires`)
                only(r, `${p}.requires`, ['holds'])
                requires = { holds: entity(r.holds, `${p}.requires.holds`) }
              }
              return {
                to: location(x.to, `${p}.to`),
                ...(requires ? { requires } : {}),
                ...(x.lockedReason === undefined ? {} : { lockedReason: text(x.lockedReason, `${p}.lockedReason`) }),
              }
            }),
          }),
      ...(m.scripted === undefined
        ? {}
        : {
            scripted: list(m.scripted, `${path}.scripted`).map((sRow, j): RpgScripted => {
              const p = `${path}.scripted[${j}]`
              const s = record(sRow, p)
              only(s, p, ['when', 'round', 'characterId', 'say', 'skill', 'target'])
              if (s.say === undefined && s.skill === undefined) fail(p, '需要 say 或 skill')
              const id = character(s.characterId, `${p}.characterId`)
              if (!(id in characters)) fail(`${p}.characterId`, `角色 ${id} 没有在 characters 中配置`)
              const useSkill = s.skill === undefined ? undefined : skill(s.skill, `${p}.skill`)
              if (useSkill !== undefined && !characters[id]!.skills.includes(useSkill))
                fail(`${p}.skill`, `角色 ${id} 没有技能 ${useSkill}`)
              const target =
                s.target === undefined ? undefined : known(mapEnemies ?? [], s.target, `${p}.target`, '敌人')
              const when = oneOf(s.when, `${p}.when`, ['enter', 'encounter', 'turn', 'enemy-defeated'])
              if (when === 'turn') {
                if (typeof s.round !== 'number' || !Number.isInteger(s.round) || s.round < 1)
                  fail(`${p}.round`, 'when 为 turn 时需要正整数 round')
              } else if (s.round !== undefined) fail(`${p}.round`, '只有 when 为 turn 时才能写 round')
              return {
                when,
                ...(when === 'turn' ? { round: s.round as number } : {}),
                characterId: id,
                ...(s.say === undefined ? {} : { say: text(s.say, `${p}.say`) }),
                ...(useSkill === undefined ? {} : { skill: useSkill }),
                ...(target === undefined ? {} : { target }),
              }
            }),
          }),
    }
  })
  const mapIds = maps.map(m => m.locationId)
  const duplicate = mapIds.findIndex((id, i) => mapIds.indexOf(id) !== i)
  if (duplicate >= 0) fail(`maps[${duplicate}].locationId`, `地点 ${mapIds[duplicate]} 已经配置过地图`)

  let defeat: RpgConfig['defeat']
  if (root.defeat !== undefined) {
    const d = record(root.defeat, 'defeat')
    only(d, 'defeat', ['to', 'restore'])
    defeat = { to: location(d.to, 'defeat.to'), restore: amounts(d.restore ?? {}, 'defeat.restore', false) }
  }

  let party: RpgConfig['party']
  if (root.party !== undefined) {
    const p = record(root.party, 'party')
    only(p, 'party', ['leader', 'lockDuringBattle'])
    const leader = character(p.leader, 'party.leader')
    if (!(leader in characters)) fail('party.leader', `角色 ${leader} 没有在 characters 中配置`)
    if (p.lockDuringBattle !== undefined && typeof p.lockDuringBattle !== 'boolean')
      fail('party.lockDuringBattle', '需要是布尔值')
    party = { leader, lockDuringBattle: p.lockDuringBattle !== false }
  }

  return {
    plugin: { id: OFFICIAL_RPG_ID, version: OFFICIAL_RPG_VERSION },
    stats,
    characters,
    skills,
    equipment,
    consumables,
    ...(rest ? { rest } : {}),
    enemies,
    ...(vault ? { vault } : {}),
    maps,
    ...(defeat ? { defeat } : {}),
    retreat: oneOf(root.retreat ?? 'stay', 'retreat', ['stay', 'back']),
    ...(party ? { party } : {}),
  }
}
