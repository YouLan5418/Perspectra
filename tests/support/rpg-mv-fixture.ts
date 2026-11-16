import example from '../../examples/rpg-mv/effects.json' with { type: 'json' }
/** Explicit opt-in lab; no existing pack balance changes. */
export function addRpgMvExample(config: Record<string, any>): void {
  for (const map of config.maps) map.scripted = []
  delete config.characters['character:cheng']
  const { combatStatuses, skills } = structuredClone(example)
  config.combatStatuses = combatStatuses
  config.skills.push(...skills)
  config.characters['character:player'].skills.push(
    ...skills.filter(skill => skill.id !== 'enemy-strike').map(skill => skill.id),
  )
  config.enemies.golem.skills = ['enemy-strike']
}
