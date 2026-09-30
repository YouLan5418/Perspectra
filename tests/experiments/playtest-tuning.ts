/** Per-launch prototype limits. They do not change the compiled World Pack or saved facts. */
export interface PlaytestTuning {
  readonly maximumWaves: number
  readonly maximumNpcCalls: number
  readonly maximumCallsPerCharacter: number
  readonly reactionDeadlineSeconds: number
  readonly recentObservations: number
  readonly recentSelfObservations: number
}

export const DEFAULT_PLAYTEST_TUNING: PlaytestTuning = {
  maximumWaves: 3, maximumNpcCalls: 8, maximumCallsPerCharacter: 2, reactionDeadlineSeconds: 30,
  recentObservations: 16, recentSelfObservations: 8,
}

const bounds: Record<keyof PlaytestTuning, readonly [number, number]> = {
  maximumWaves: [1, 10],
  maximumNpcCalls: [2, 40],
  maximumCallsPerCharacter: [1, 10],
  reactionDeadlineSeconds: [5, 300],
  recentObservations: [1, 100],
  recentSelfObservations: [0, 50],
}

export function parsePlaytestTuning(value: unknown): PlaytestTuning {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('运行参数无效。')
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !(key in bounds))) throw new TypeError('存在未知运行参数。')
  const result = {} as Record<keyof PlaytestTuning, number>
  for (const key of Object.keys(bounds) as (keyof PlaytestTuning)[]) {
    const candidate = object[key]
    const [minimum, maximum] = bounds[key]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
      throw new TypeError(`运行参数 ${key} 必须是 ${minimum}–${maximum} 的整数。`)
    }
    result[key] = candidate
  }
  return result
}
