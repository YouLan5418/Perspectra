import type { RpgSource } from '../../../host/src/editor/rpg.ts'
export function newRpgCharacter(config: RpgSource): RpgSource['characters'][string] {
  return {
    stats: Object.fromEntries(config.stats.map(s => [s.key, s.key === 'hp' ? 30 : 6])),
    attack: 1,
    defense: 0,
    speed: 12,
    skills: [],
    slots: [],
  }
}
