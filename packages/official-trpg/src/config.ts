import type { ContentPackFacts } from '@harness-world/plugin-sdk'

/** What a pack's trpg.json names in `plugin`; a world records it with the generated content. */
export const OFFICIAL_TRPG_ID = 'official-trpg'
export const OFFICIAL_TRPG_VERSION = '1'

export interface TrpgStat {
  key: string
  label: string
  /** A card's value stays within 0..max; a card starts at max unless `characters` says otherwise. */
  max: number
}
export interface TrpgSkill {
  key: string
  label: string
  /** The default modifier added to a check's roll. */
  modifier: number
}
export interface TrpgContent {
  kind: 'place' | 'item' | 'npc'
  name: string
  description: string
  /** The name of a `place` in the same scenario. */
  location?: string
  /** false: only the host knows it. */
  public: boolean
}
export interface TrpgScenario {
  id: string
  title: string
  opening: string
  /** Only the host knows the truth and the endings. */
  truth: string
  endings: string[]
  content: TrpgContent[]
}
export interface TrpgConfig {
  plugin: { id: typeof OFFICIAL_TRPG_ID; version: typeof OFFICIAL_TRPG_VERSION }
  sheet: { stats: TrpgStat[]; skills: TrpgSkill[]; dice: string }
  /** Per AI character, card values that differ from the sheet's defaults. */
  characters?: Record<string, { stats?: Record<string, number>; skills?: Record<string, number> }>
  /** AI characters who may host; absent means any participating AI character. */
  hosts?: string[]
  scenarios?: TrpgScenario[]
  /** Preset themes. With neither scenarios nor themes, the player types a theme when setting up. */
  themes?: string[]
}

// The dice grammar of official-dice's parseDice, copied because official packages do not import each other:
// count 1–20 or omitted, sides 2–1000, modifier ±1000, no leading zeros. tests/host/trpg-dice-agreement.test.ts
// keeps the two in step.
const DICE = /^([1-9]\d?)?d([1-9]\d{0,3})(?:[+-]([1-9]\d{0,3}))?$/u
export function isDiceExpression(expression: unknown): boolean {
  const match = typeof expression === 'string' ? DICE.exec(expression) : null
  if (!match) return false
  const count = match[1] === undefined ? 1 : Number(match[1]),
    sides = Number(match[2]),
    modifier = match[3] === undefined ? 0 : Number(match[3])
  return count <= 20 && sides >= 2 && sides <= 1000 && modifier <= 1000
}

const KEY = /^[a-z][a-z-]{0,31}$/u
const SCENARIO_ID = /^[a-z][a-z0-9-]{0,31}$/u
const MODIFIER = 100

type Json = Record<string, unknown>
const fail = (path: string, problem: string): never => {
  throw new TypeError(`${path}：${problem}`)
}
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const record = (value: unknown, path: string): Json => (isObject(value) ? value : fail(path, '需要是对象'))
const list = (value: unknown, path: string, min: number, max: number): unknown[] =>
  Array.isArray(value) && value.length >= min && value.length <= max
    ? value
    : fail(path, `需要是 ${min} 到 ${max} 项的数组`)
const text = (value: unknown, path: string, max: number): string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value
    : fail(path, `需要是 1 到 ${max} 字的非空字符串`)
const integer = (value: unknown, path: string, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fail(path, `需要是 ${min} 到 ${max} 的整数`)
const only = (value: Json, path: string, keys: readonly string[]) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path ? `${path}.${key}` : key, '不认识的字段')
}
const unique = (values: string[], path: (i: number) => string, what: string) =>
  values.forEach((value, i) => {
    if (values.indexOf(value) !== i) fail(path(i), `${what} ${value} 重复`)
  })

export function parseTrpgConfig(value: unknown, pack: ContentPackFacts): TrpgConfig {
  const root = record(value, '(根)')
  only(root, '', ['plugin', 'sheet', 'characters', 'hosts', 'scenarios', 'themes'])

  const plugin = record(root.plugin, 'plugin')
  only(plugin, 'plugin', ['id', 'version'])
  if (plugin.id !== OFFICIAL_TRPG_ID) fail('plugin.id', `需要是 ${OFFICIAL_TRPG_ID}`)
  if (plugin.version !== OFFICIAL_TRPG_VERSION) fail('plugin.version', `需要是 ${OFFICIAL_TRPG_VERSION}`)

  const aiCharacters = pack.characterIds.filter(id => id !== pack.playerId)
  const aiCharacter = (id: string, path: string) =>
    aiCharacters.includes(id)
      ? id
      : fail(path, id === pack.playerId ? `${id} 是玩家，这里只能写 AI 角色` : `未知角色 ${id}`)

  const sheet = record(root.sheet, 'sheet')
  only(sheet, 'sheet', ['stats', 'skills', 'dice'])
  const key = (row: Json, path: string) => {
    const name = text(row.key, `${path}.key`, 32)
    return KEY.test(name) ? name : fail(`${path}.key`, `键 ${name} 需要是小写字母开头的小写字母和连字符，至多 32 字符`)
  }
  const stats = list(sheet.stats, 'sheet.stats', 1, 8).map((value, i): TrpgStat => {
    const path = `sheet.stats[${i}]`
    const row = record(value, path)
    only(row, path, ['key', 'label', 'max'])
    return {
      key: key(row, path),
      label: text(row.label, `${path}.label`, 36),
      max: integer(row.max, `${path}.max`, 1, 1000),
    }
  })
  if (new Set(stats.map(s => s.key)).size !== stats.length) fail('sheet.stats', '数值键重复')
  const skills = list(sheet.skills, 'sheet.skills', 1, 12).map((value, i): TrpgSkill => {
    const path = `sheet.skills[${i}]`
    const row = record(value, path)
    only(row, path, ['key', 'label', 'modifier'])
    return {
      key: key(row, path),
      label: text(row.label, `${path}.label`, 36),
      modifier: integer(row.modifier, `${path}.modifier`, -MODIFIER, MODIFIER),
    }
  })
  if (new Set(skills.map(s => s.key)).size !== skills.length) fail('sheet.skills', '技能键重复')
  if (!isDiceExpression(sheet.dice))
    fail(
      'sheet.dice',
      `骰子写法 ${JSON.stringify(sheet.dice)} 无效，例如 d20、d100、2d6+1（1–20 个 2–1000 面骰，修正 ±1000）`,
    )
  const dice = sheet.dice as string

  const config: TrpgConfig = {
    plugin: { id: OFFICIAL_TRPG_ID, version: OFFICIAL_TRPG_VERSION },
    sheet: { stats, skills, dice },
  }

  if (root.characters !== undefined)
    config.characters = Object.fromEntries(
      Object.entries(record(root.characters, 'characters')).map(([id, value]) => {
        const path = `characters.${id}`
        aiCharacter(id, path)
        const row = record(value, path)
        only(row, path, ['stats', 'skills'])
        const card: { stats?: Record<string, number>; skills?: Record<string, number> } = {}
        if (row.stats !== undefined)
          card.stats = Object.fromEntries(
            Object.entries(record(row.stats, `${path}.stats`)).map(([stat, amount]) => {
              const max =
                stats.find(s => s.key === stat)?.max ?? fail(`${path}.stats.${stat}`, `模板里没有数值 ${stat}`)
              return [stat, integer(amount, `${path}.stats.${stat}`, 0, max)]
            }),
          )
        if (row.skills !== undefined)
          card.skills = Object.fromEntries(
            Object.entries(record(row.skills, `${path}.skills`)).map(([skill, amount]) => {
              if (!skills.some(s => s.key === skill)) fail(`${path}.skills.${skill}`, `模板里没有技能 ${skill}`)
              return [skill, integer(amount, `${path}.skills.${skill}`, -MODIFIER, MODIFIER)]
            }),
          )
        return [id, card]
      }),
    )

  if (root.hosts !== undefined) {
    const hosts = list(root.hosts, 'hosts', 1, 8).map((id, i) =>
      aiCharacter(text(id, `hosts[${i}]`, 200), `hosts[${i}]`),
    )
    unique(hosts, i => `hosts[${i}]`, '主持人')
    config.hosts = hosts
  }

  if (root.scenarios !== undefined) {
    const scenarios = list(root.scenarios, 'scenarios', 1, 16).map((value, i): TrpgScenario => {
      const path = `scenarios[${i}]`
      const row = record(value, path)
      only(row, path, ['id', 'title', 'opening', 'truth', 'endings', 'content'])
      const id = text(row.id, `${path}.id`, 32)
      if (!SCENARIO_ID.test(id)) fail(`${path}.id`, `剧本 ID ${id} 需要是小写字母开头的小写字母、数字和连字符`)
      const endings = list(row.endings, `${path}.endings`, 1, 8).map((ending, j) =>
        text(ending, `${path}.endings[${j}]`, 300),
      )
      const content = list(row.content, `${path}.content`, 0, 40).map((item, j): TrpgContent => {
        const at = `${path}.content[${j}]`
        const entry = record(item, at)
        only(entry, at, ['kind', 'name', 'description', 'location', 'public'])
        if (entry.kind !== 'place' && entry.kind !== 'item' && entry.kind !== 'npc')
          fail(`${at}.kind`, `不认识的取值 ${JSON.stringify(entry.kind)}，可选 place、item、npc`)
        if (typeof entry.public !== 'boolean') fail(`${at}.public`, '需要是 true 或 false')
        return {
          kind: entry.kind as TrpgContent['kind'],
          name: text(entry.name, `${at}.name`, 40),
          description: text(entry.description, `${at}.description`, 500),
          ...(entry.location === undefined ? {} : { location: text(entry.location, `${at}.location`, 40) }),
          public: entry.public as boolean,
        }
      })
      unique(
        content.map(c => c.name),
        j => `${path}.content[${j}].name`,
        '局内内容',
      )
      const places = content.filter(c => c.kind === 'place').map(c => c.name)
      content.forEach((c, j) => {
        if (c.location !== undefined && !places.includes(c.location))
          fail(`${path}.content[${j}].location`, `剧本里没有地点 ${c.location}`)
      })
      return {
        id,
        title: text(row.title, `${path}.title`, 80),
        opening: text(row.opening, `${path}.opening`, 2000),
        truth: text(row.truth, `${path}.truth`, 2000),
        endings,
        content,
      }
    })
    unique(
      scenarios.map(s => s.id),
      i => `scenarios[${i}].id`,
      '剧本 ID',
    )
    config.scenarios = scenarios
  }

  if (root.themes !== undefined) {
    const themes = list(root.themes, 'themes', 1, 16).map((theme, i) => text(theme, `themes[${i}]`, 200))
    unique(themes, i => `themes[${i}]`, '题目')
    config.themes = themes
  }
  return config
}
