import type { RpgCombatModifiers, RpgCombatStatus, RpgSkill } from './config.ts'

/** MV-inspired design, implemented locally: ordered effects, centralized parameters, explicit lifecycle.
 * Reference and license: docs/superpowers/plans/2026-11-15-rpg-mv-design.md. No MV runtime code imported. */
export function skillTargetSide(skill: RpgSkill, actorTeam: 'party' | 'enemy' = 'party'): 'party' | 'enemy' {
  return skill.target === 'opponent' ? (actorTeam === 'party' ? 'enemy' : 'party') : actorTeam
}
export function onlyHealing(skill: RpgSkill): boolean {
  return skill.effects.every(effect => effect.kind === 'heal')
}
export function combatAttributes(
  base: { attack: number; defense: number; fireResistance: number },
  modifiers: readonly RpgCombatModifiers[],
) {
  const result = { ...base }
  for (const modifier of modifiers)
    for (const key of ['attack', 'defense', 'fireResistance'] as const) result[key] += modifier[key] ?? 0
  return {
    attack: Math.max(0, Math.min(9999, result.attack)),
    defense: Math.max(0, Math.min(9999, result.defense)),
    fireResistance: Math.max(0, Math.min(75, result.fireResistance)),
  }
}
export function damageAfterMitigation(
  amount: number,
  attack: number,
  defense: number,
  fireResistance: number,
  element: 'fire' | undefined,
  guarded: boolean,
  periodic = false,
): number {
  const raw = periodic ? amount : Math.max(1, amount + attack - defense)
  const resisted = Math.max(1, Math.floor((raw * (100 - (element === 'fire' ? fireResistance : 0))) / 100))
  return !periodic && guarded ? Math.ceil(resisted / 2) : resisted
}
export function activeModifiers(
  unitId: string,
  conditions: readonly { unitId: string; statusId: string }[],
  definitions: Readonly<Record<string, RpgCombatStatus>>,
): RpgCombatModifiers[] {
  return conditions
    .filter(row => row.unitId === unitId)
    .flatMap(row => (definitions[row.statusId]?.modifiers ? [definitions[row.statusId]!.modifiers!] : []))
}
