/** Activity-local author numbers. No world variable addresses or executable expressions. */
export interface RpgValueDefinition {
  label: string
  initial: number
  min: number
  max: number
}
export interface RpgResourceDefinition extends RpgValueDefinition {
  onHpLoss?: number
  onZeroStatus?: string
}
export interface RpgBattleValues {
  shared: Record<string, RpgValueDefinition>
  attributes: Record<string, RpgValueDefinition>
  resources: Record<string, RpgResourceDefinition>
}
export interface RpgInitialValues {
  attributes?: Record<string, number>
  resources?: Record<string, number>
}
export type RpgValueRef =
  | { scope: 'shared'; key: string }
  | { scope: 'actor' | 'target'; kind: 'attribute' | 'resource'; key: string }
export interface RpgValueAdjustment {
  value: RpgValueRef
  multiplier: number
}
export interface RpgValueRequirement {
  value: RpgValueRef
  atLeast: number
}
export interface RpgValueState {
  shared: Record<string, number>
  units: Record<string, Record<string, number>>
}
export interface RpgValueDisplay {
  key: string
  label: string
  value: number
  min: number
  max: number
}
export interface RpgValuesProjection {
  shared: RpgValueDisplay[]
  units: { unitId: string; attributes: RpgValueDisplay[]; resources: RpgValueDisplay[] }[]
}
export const EMPTY_BATTLE_VALUES: RpgBattleValues = { shared: {}, attributes: {}, resources: {} }
export const clampValue = (value: number, def: RpgValueDefinition) => Math.min(def.max, Math.max(def.min, value))
export function initialBattleValues(
  defs: RpgBattleValues,
  units: readonly { id: string; values?: RpgInitialValues }[],
): RpgValueState {
  return {
    shared: Object.fromEntries(Object.entries(defs.shared).map(([key, def]) => [key, def.initial])),
    units: Object.fromEntries(
      units.map(unit => [
        unit.id,
        Object.fromEntries(
          Object.entries(defs.resources).map(([key, def]) => [key, unit.values?.resources?.[key] ?? def.initial]),
        ),
      ]),
    ),
  }
}
/** The same eligibility calculation is used by the rule and the authorized battle projection. */
export function valueSkillProblem(
  skill: { resourceCost?: Record<string, number>; requires?: RpgValueRequirement[] },
  defs: RpgBattleValues,
  resources: Record<string, number>,
  read: (ref: RpgValueRef) => number,
): string | undefined {
  for (const [key, cost] of Object.entries(skill.resourceCost ?? {}))
    if ((resources[key] ?? 0) < cost) return `${defs.resources[key]!.label}不足`
  for (const requirement of skill.requires ?? [])
    if (read(requirement.value) < requirement.atLeast) return '战斗数值条件不满足'
}
export function adjustedAmount(
  amount: number,
  adjustments: readonly RpgValueAdjustment[] | undefined,
  read: (ref: RpgValueRef) => number,
): number {
  return Math.min(
    9999,
    Math.max(1, amount + (adjustments ?? []).reduce((sum, row) => sum + read(row.value) * row.multiplier, 0)),
  )
}
