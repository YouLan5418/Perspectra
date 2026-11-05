import type { PacingIntensity } from '@harness-world/plugin-sdk'

export interface PacingDefinition {
  readonly cycleRounds: number
  readonly chance: number
  readonly cooldownRounds: Readonly<Record<PacingIntensity, number>>
  readonly recoveryRounds: number
  readonly stagnation?: {
    readonly afterRounds: number
    readonly progress: { readonly statuses: readonly string[]; readonly activities: readonly string[] }
    readonly maxChance: number
    readonly maxTensionBoost: number
  }
  readonly activities: Readonly<Record<string, PacingIntensity>>
  readonly beats: Readonly<Record<string, PacingIntensity>>
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`节奏配置 ${field} 必须是对象`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, field: string, required: string[], optional: string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`节奏配置 ${field} 缺少字段 ${key}`)
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`节奏配置 ${field} 有未知字段 ${key}`)
}
function rounds(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 100_000)
    throw new TypeError(`节奏配置 ${field} 必须是不小于 ${minimum} 的整数`)
  return value
}
function share(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new TypeError(`节奏配置 ${field} 必须在 0 到 1 之间`)
  return value
}
function names(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item))
    throw new TypeError(`节奏配置 ${field} 必须是字符串列表`)
  return value as string[]
}
function intensities(value: unknown, field: string): Record<string, PacingIntensity> {
  const result: Record<string, PacingIntensity> = {}
  for (const [key, entry] of Object.entries(object(value ?? {}, field))) {
    const row = object(entry, `${field}.${key}`)
    exact(row, `${field}.${key}`, ['intensity'])
    if (row.intensity !== 'low' && row.intensity !== 'medium' && row.intensity !== 'high')
      throw new TypeError(`节奏配置 ${field}.${key}.intensity 必须是 low、medium 或 high`)
    result[key] = row.intensity
  }
  return result
}

/** The author's pacing configuration. A mistake refuses to open and names the field. */
export function parsePacingDefinition(value: unknown): PacingDefinition {
  const root = object(value, 'definition')
  exact(
    root,
    'definition',
    ['cycleRounds', 'chance', 'cooldownRounds', 'recoveryRounds'],
    ['stagnation', 'activities', 'beats'],
  )
  const cooldown = object(root.cooldownRounds, 'cooldownRounds')
  exact(cooldown, 'cooldownRounds', ['low', 'medium', 'high'])
  const chance = share(root.chance, 'chance')
  let stagnation: PacingDefinition['stagnation']
  if (root.stagnation !== undefined) {
    const row = object(root.stagnation, 'stagnation')
    exact(row, 'stagnation', ['afterRounds', 'progress', 'maxChance', 'maxTensionBoost'])
    const progress = object(row.progress, 'stagnation.progress')
    exact(progress, 'stagnation.progress', ['statuses', 'activities'])
    const maxChance = share(row.maxChance, 'stagnation.maxChance')
    if (maxChance < chance) throw new TypeError('节奏配置 stagnation.maxChance 不能小于 chance')
    stagnation = {
      afterRounds: rounds(row.afterRounds, 'stagnation.afterRounds', 1),
      progress: {
        statuses: names(progress.statuses, 'stagnation.progress.statuses'),
        activities: names(progress.activities, 'stagnation.progress.activities'),
      },
      maxChance,
      maxTensionBoost: share(row.maxTensionBoost, 'stagnation.maxTensionBoost'),
    }
  }
  return {
    cycleRounds: rounds(root.cycleRounds, 'cycleRounds', 2),
    chance,
    cooldownRounds: {
      low: rounds(cooldown.low, 'cooldownRounds.low', 0),
      medium: rounds(cooldown.medium, 'cooldownRounds.medium', 0),
      high: rounds(cooldown.high, 'cooldownRounds.high', 0),
    },
    recoveryRounds: rounds(root.recoveryRounds, 'recoveryRounds', 0),
    ...(stagnation === undefined ? {} : { stagnation }),
    activities: intensities(root.activities, 'activities'),
    beats: intensities(root.beats, 'beats'),
  }
}
