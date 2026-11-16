import type { RpgCombatStatus, RpgEffect, RpgSkill, RpgVitalEffect } from './config.ts'

/** Old declarations and new effect lists share one deterministic interpreter. */
export function skillEffects(skill: RpgSkill): readonly RpgEffect[] {
  return [
    ...(skill.kind === 'effect'
      ? []
      : [{ kind: skill.kind, amount: skill.power, ...(skill.element ? { element: skill.element } : {}) } as RpgEffect]),
    ...(skill.inflicts ? [{ kind: 'status', status: skill.inflicts } as const] : []),
    ...(skill.effects ?? []),
  ]
}
export function periodicEffect(status: RpgCombatStatus): RpgVitalEffect {
  return (
    status.tick ?? { kind: 'damage', amount: status.damage!, ...(status.element ? { element: status.element } : {}) }
  )
}
export function skillTargetSide(skill: RpgSkill): 'party' | 'enemy' {
  return skill.kind === 'effect' ? skill.target! : skill.kind === 'heal' ? 'party' : 'enemy'
}
export function onlyHealing(skill: RpgSkill): boolean {
  return skillEffects(skill).every(effect => effect.kind === 'heal')
}
