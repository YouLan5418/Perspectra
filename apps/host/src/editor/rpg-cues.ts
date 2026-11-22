import type { RpgSource } from './rpg.ts'

type Named = { id: string; name: string }
export function cueOptionLabel(row: Named, options: Named[]) {
  return options.some(o => o.id !== row.id && o.name === row.name) ? row.name + ' · ' + row.id : row.name
}
export type CueMap = NonNullable<RpgSource['maps']>[number]
export type RpgCue = NonNullable<CueMap['scripted']>[number]
export const cueTriggers = {
  enter: '首次进入',
  encounter: '开战',
  turn: '指定回合',
  'enemy-defeated': '击败全部敌人',
} as const

export function cueCandidates(
  config: RpgSource,
  map: CueMap,
  characters: Named[],
  player: string,
  selection: Partial<RpgCue>,
) {
  const battle = !!map.enemies?.length
  const actors = characters.filter(c => c.id !== player && Object.hasOwn(config.characters, c.id))
  const triggers = (Object.keys(cueTriggers) as RpgCue['when'][]).filter(k => battle || k === 'enter')
  const learned = actors.some(c => c.id === selection.characterId)
    ? (config.characters[selection.characterId!]?.skills ?? [])
    : []
  const skills =
    battle && (selection.when === 'encounter' || selection.when === 'turn')
      ? (config.skills ?? []).filter(s => learned.includes(s.id)).map(({ id, name, target }) => ({ id, name, target }))
      : []
  const enemies =
    skills.find(s => s.id === selection.skill)?.target === 'opponent'
      ? [...new Set(map.enemies)].map(id => ({ id, name: config.enemies?.[id]?.name ?? id }))
      : []
  return { actors, triggers, skills, enemies }
}

export function cueFlow(config: RpgSource, map: CueMap, characters: Named[], player: string) {
  const rows = map.scripted ?? []
  return rows
    .map((cue, index) => {
      const actor = characters.find(c => c.id === cue.characterId)
      const skill = config.skills?.find(s => s.id === cue.skill)
      const choices = cueCandidates(config, map, characters, player, cue)
      const enemy = choices.enemies.find(e => e.id === cue.target)
      const earlier = rows.findIndex(
        c => c.when === 'turn' && c.characterId === cue.characterId && c.round === cue.round,
      )
      const warning =
        cue.characterId === player
          ? '玩家角色不会自动执行演出'
          : cue.when === 'turn' && earlier < index
            ? '同一角色同一回合只执行第一条演出'
            : cue.target && skill?.target !== 'opponent'
              ? '此技能作用于己方，请改用自动目标'
              : ''
      return {
        index,
        when: cue.when,
        round: cue.round,
        actor: actor ? cueOptionLabel(actor, choices.actors) : cue.characterId,
        skill: skill ? cueOptionLabel(skill, choices.skills) : cue.skill,
        target: enemy ? cueOptionLabel(enemy, choices.enemies) : cue.target,
        say: cue.say,
        warning,
      }
    })
    .sort((a, b) => {
      const stages = Object.keys(cueTriggers)
      return stages.indexOf(a.when) - stages.indexOf(b.when) || (a.round ?? 0) - (b.round ?? 0) || a.index - b.index
    })
}
