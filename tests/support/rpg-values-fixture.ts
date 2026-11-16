import { addRpgMvExample } from './rpg-mv-fixture.ts'
import example from '../../examples/rpg-values/effects.json' with { type: 'json' }
/** Opt-in numerical lab; baseline official worlds keep their balance. */
export function addRpgValuesExample(config: Record<string, any>): void {
  addRpgMvExample(config)
  const { battleValues, combatStatuses, skills } = structuredClone(example)
  config.battleValues = battleValues
  Object.assign(config.combatStatuses, combatStatuses)
  config.skills.push(...skills)
  config.characters['character:player'].skills.push(...skills.map(skill => skill.id))
  config.enemies.golem.battleValues = { attributes: { 'heat-resist': 25 } }
  config.enemies.golem.hp = 100
}
