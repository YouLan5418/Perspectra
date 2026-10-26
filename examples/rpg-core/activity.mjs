import { readFileSync } from 'node:fs'

// RPG Core author tool: validates authored battle data and emits an ordinary pack activity script.
export function activitySource(config) {
  const bounded = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 100
  if (!config || !text(config.title) || config.title.length > 80 || !text(config.playerId) ||
    !text(config.outcomeStatus) || !config.reward || !text(config.reward.key) || !bounded(config.reward.amount, 0, 10000) ||
    !bounded(config.potions, 0, 99) || !Array.isArray(config.units) || config.units.length < 2 || config.units.length > 16 ||
    !Array.isArray(config.skills) || !config.skills.length || config.skills.length > 64)
    throw new TypeError('RPG_CONFIG_INVALID: expected bounded units, skills and rewards')
  const skillIds = new Set(), skillNames = new Set(), unitIds = new Set(), unitNames = new Set(), characters = new Set()
  for (const skill of config.skills) {
    if (!text(skill.id) || !text(skill.name) || skillIds.has(skill.id) || skillNames.has(skill.name) ||
      !['damage', 'heal'].includes(skill.kind) || !['one', 'all'].includes(skill.scope) ||
      !bounded(skill.power, 1, 100) || !bounded(skill.mp, 0, 100) ||
      (skill.poison !== undefined && (skill.kind !== 'damage' || !bounded(skill.poison.damage, 1, 50) || !bounded(skill.poison.turns, 1, 10))))
      throw new TypeError('RPG_CONFIG_INVALID: invalid or duplicate skill')
    skillIds.add(skill.id); skillNames.add(skill.name)
  }
  for (const unit of config.units) {
    if (!text(unit.id) || !text(unit.name) || unitIds.has(unit.id) || unitNames.has(unit.name) ||
      !['party', 'enemy'].includes(unit.team) || !bounded(unit.hp, 1, 1000) || !bounded(unit.mp, 0, 100) ||
      !bounded(unit.attack, 0, 100) || !bounded(unit.defense, 0, 100) || !bounded(unit.speed, 1, 100) ||
      !Array.isArray(unit.skills) || !unit.skills.length || new Set(unit.skills).size !== unit.skills.length || unit.skills.some(id => !skillIds.has(id)) ||
      (unit.team === 'party' ? !text(unit.characterId) || characters.has(unit.characterId) : unit.characterId !== undefined))
      throw new TypeError('RPG_CONFIG_INVALID: invalid unit, character binding or skill reference')
    unitIds.add(unit.id); unitNames.add(unit.name)
    if (unit.characterId) characters.add(unit.characterId)
  }
  const first = config.units.toSorted((a, b) => b.speed - a.speed)[0]
  if (!characters.has(config.playerId) || characters.size > 9 || !config.units.some(u => u.team === 'enemy') || !first.characterId)
    throw new TypeError('RPG_CONFIG_INVALID: bind a player, enemies and a character acting first')
  // Read the rules as bytes rather than Function#toString, so loaders and transpilers cannot change the output.
  return `${readFileSync(new URL('./battle-runtime.js', import.meta.url), 'utf8')}installActivity(${JSON.stringify(config)});`
}
