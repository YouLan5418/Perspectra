import type { LensItem, LensSource } from './view.ts'

export const RPG_CONFIG = 'rpg.json'
/** The key of a map's generated activity; the RPG mechanism names it the same way. */
export const rpgMapKey = (locationId: string) => 'rpg-map-' + locationId.replace(/^location:/u, '')

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
/** rpg.json as the author wrote it; the lens only reads it, `worldpack validate` and the host check it. */
export type RpgJson = Json & { maps: Json[] }

const STAT_LABEL = { attack: '攻击', defense: '防御', speed: '速度' } as const

/** The RPG section: every setting of rpg.json, each at the JSON pointer an author edits it at. */
export function rpgLensItems(rpg: RpgJson, name: (id: string) => string): LensItem[] {
  const items: LensItem[] = []
  const add = (item: LensItem) => items.push(item)
  const at = (pointer: string): LensSource => ({ kind: 'json', file: RPG_CONFIG, pointer })
  const skillName = new Map<string, string>(((rpg.skills ?? []) as Json[]).map(skill => [skill.id, skill.name]))
  const enemyName = (id: string) => String(rpg.enemies?.[id]?.name ?? id)
  const statLabel = new Map<string, string>(((rpg.stats ?? []) as Json[]).map(stat => [stat.key, stat.label]))
  const amounts = (values: Json | undefined) =>
    Object.entries(values ?? {}).map(([key, value]) => `${statLabel.get(key) ?? key} ${value}`)
  const skills = (ids: unknown) => ((ids ?? []) as string[]).map(id => skillName.get(id) ?? id)

  add({
    id: 'rpg:settings',
    section: 'rpg',
    title: 'RPG 总设置',
    fields: [
      { key: 'stats', label: '数值', value: ((rpg.stats ?? []) as Json[]).map(stat => stat.label) },
      ...(rpg.rest
        ? [
            { key: 'rest', label: '休息', value: String(rpg.rest.label) },
            { key: 'restPlaces', label: '可休息的地点', value: (rpg.rest.locations as string[]).map(name) },
          ]
        : []),
      ...(rpg.vault ? [{ key: 'vault', label: '宝库', value: name(rpg.vault) }] : []),
      {
        key: 'defeat',
        label: '全灭后',
        value: rpg.defeat ? `回到${name(rpg.defeat.to)}，${amounts(rpg.defeat.restore).join('、')}` : '（未设置）',
      },
      { key: 'retreat', label: '撤退后', value: rpg.retreat === 'stay' ? '留在原地' : name(String(rpg.retreat)) },
      { key: 'leader', label: '队长', value: name(String(rpg.party?.leader ?? '')) },
      { key: 'lockDuringBattle', label: '战斗中锁定队伍', value: rpg.party?.lockDuringBattle === true },
    ],
    source: at(''),
  })
  for (const [id, row] of Object.entries((rpg.characters ?? {}) as Record<string, Json>))
    add({
      id: 'rpg:character/' + id,
      section: 'rpg',
      title: `${name(id)} 的战斗数值`,
      parentId: id,
      fields: [
        { key: 'stats', label: '数值', value: amounts(row.stats) },
        { key: 'attack', label: '攻击', value: row.attack },
        { key: 'defense', label: '防御', value: row.defense },
        { key: 'speed', label: '速度', value: row.speed },
        { key: 'skills', label: '技能', value: skills(row.skills) },
        { key: 'slots', label: '装备栏', value: (row.slots ?? []) as string[] },
      ],
      source: at(`/characters/${id}`),
      links: [id],
    })
  for (const [index, skill] of ((rpg.skills ?? []) as Json[]).entries())
    add({
      id: 'rpg:skill/' + skill.id,
      section: 'rpg',
      title: String(skill.name),
      fields: [
        {
          key: 'kind',
          label: '效果',
          value: skill.kind === 'effect' ? '声明效果' : skill.kind === 'heal' ? '治疗' : '伤害',
        },
        { key: 'scope', label: '目标', value: skill.scope === 'all' ? '全体' : '单体' },
        ...(skill.power === undefined ? [] : [{ key: 'power', label: '威力', value: skill.power }]),
        ...(skill.effects ? [{ key: 'effects', label: '依次结算', value: JSON.stringify(skill.effects) }] : []),
        { key: 'cost', label: '消耗', value: amounts(skill.cost) },
        ...(skill.element === 'fire' ? [{ key: 'element', label: '伤害元素', value: '火焰' }] : []),
        ...(skill.inflicts
          ? [
              {
                key: 'inflicts',
                label: '附加状态',
                value: String(rpg.combatStatuses?.[skill.inflicts]?.name ?? skill.inflicts),
              },
            ]
          : []),
      ],
      source: at(`/skills/${index}`),
      ...(skill.inflicts ? { links: ['rpg:combat-status/' + skill.inflicts] } : {}),
    })
  for (const [id, status] of Object.entries((rpg.combatStatuses ?? {}) as Record<string, Json>))
    add({
      id: 'rpg:combat-status/' + id,
      section: 'rpg',
      title: String(status.name),
      fields: [
        { key: 'turns', label: '持续回合', value: status.turns },
        {
          key: 'tick',
          label: '持有者行动后结算',
          value: JSON.stringify(status.tick ?? { kind: 'damage', amount: status.damage, element: status.element }),
        },
      ],
      source: at(`/combatStatuses/${id}`),
    })
  for (const [id, row] of Object.entries((rpg.equipment ?? {}) as Record<string, Json>))
    add({
      id: 'rpg:equipment/' + id,
      section: 'rpg',
      title: name(id),
      fields: [
        { key: 'slot', label: '装备栏', value: String(row.slot) },
        ...(['attack', 'defense', 'speed'] as const).flatMap(key =>
          row[key] === undefined ? [] : [{ key, label: STAT_LABEL[key], value: row[key] as number }],
        ),
        ...(row.resistances?.fire === undefined
          ? []
          : [{ key: 'fireResistance', label: '火焰抗性', value: `${row.resistances.fire}%` }]),
      ],
      source: at(`/equipment/${id}`),
      links: ['item:' + id],
    })
  for (const [id, row] of Object.entries((rpg.consumables ?? {}) as Record<string, Json>))
    add({
      id: 'rpg:consumable/' + id,
      section: 'rpg',
      title: name(id),
      fields: [{ key: 'restore', label: '恢复', value: amounts(row.restore) }],
      source: at(`/consumables/${id}`),
      links: ['item:' + id],
    })
  for (const [id, row] of Object.entries((rpg.enemies ?? {}) as Record<string, Json>))
    add({
      id: 'rpg:enemy/' + id,
      section: 'rpg',
      title: String(row.name),
      fields: [
        { key: 'hp', label: '生命', value: row.hp },
        { key: 'attack', label: '攻击', value: row.attack },
        { key: 'defense', label: '防御', value: row.defense },
        { key: 'speed', label: '速度', value: row.speed },
        { key: 'skills', label: '技能', value: skills(row.skills) },
        { key: 'strategy', label: '出手方式', value: String(row.strategy) },
        { key: 'encounter', label: '遭遇时的台词', value: String(row.lines?.encounter ?? '') },
        { key: 'defeated', label: '倒下时的台词', value: String(row.lines?.defeated ?? '') },
      ],
      source: at(`/enemies/${id}`),
    })
  for (const [index, map] of rpg.maps.entries()) {
    const id = 'rpg:map/' + map.locationId
    add({
      id,
      section: 'rpg',
      title: `${name(map.locationId)} 的地图设置`,
      fields: [
        { key: 'narration', label: '初到的描述', value: String(map.narration?.first ?? '') },
        { key: 'again', label: '再到的描述', value: String(map.narration?.again ?? '') },
        { key: 'enemies', label: '敌人', value: ((map.enemies ?? []) as string[]).map(enemyName) },
        { key: 'engage', label: '开战方式', value: map.engage === 'optional' ? '玩家选择开战' : '进入即开战' },
        { key: 'drops', label: '掉落', value: ((map.drops ?? []) as string[]).map(name) },
        ...(map.chest ? [{ key: 'chest', label: '宝箱', value: name(map.chest) }] : []),
        {
          key: 'scripted',
          label: '作者写的队友台词与动作',
          value: ((map.scripted ?? []) as Json[]).map(
            line =>
              `${line.when === 'encounter' ? '遭遇时' : '进入时'} ${name(line.characterId)}：${line.say ?? ''}${
                line.skill ? `（用${skillName.get(line.skill) ?? line.skill}）` : ''
              }`,
          ),
        },
      ],
      source: at(`/maps/${index}`),
      links: ['place:' + map.locationId, 'event:' + rpgMapKey(map.locationId)],
    })
    for (const [position, exit] of ((map.exits ?? []) as Json[]).entries())
      add({
        id: `${id}/exit/${exit.to}`,
        section: 'rpg',
        title: `出口：通往${name(exit.to)}`,
        parentId: id,
        fields: [
          { key: 'to', label: '通往', value: name(exit.to) },
          {
            key: 'requires',
            label: '条件',
            value: exit.requires ? `锁着，用${name(exit.requires.holds)}开锁后谁都能过` : '无条件',
          },
          { key: 'lockedReason', label: '不满足时的说法', value: String(exit.lockedReason ?? '') },
        ],
        source: at(`/maps/${index}/exits/${position}`),
      })
  }
  return items
}
