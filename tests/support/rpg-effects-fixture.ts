import example from '../../examples/rpg-effects/effects.json' with { type: 'json' }
/** An opt-in demonstration; it never changes the balance of an existing example pack. */
export function addRpgEffectsExample(config: Record<string, any>): void {
  for (const map of config.maps) map.scripted = []
  delete config.characters['character:cheng']
  const { combatStatuses, skills } = structuredClone(example)
  config.combatStatuses = { ...config.combatStatuses, ...combatStatuses }
  config.skills.push(...skills)
  config.characters['character:player'].skills.push(...skills.map(skill => skill.id))
}
