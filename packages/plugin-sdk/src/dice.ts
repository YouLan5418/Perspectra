import type { SeamProvider } from './world.ts'

/** One roll: each die's face, the expression's modifier, and their sum. */
export interface DiceRoll {
  readonly expression: string
  readonly dice: number[]
  readonly modifier: number
  readonly total: number
}
/** Turns an expression such as `1d20+2` into a roll. `random` is recorded by the core and returns [0, 1); use it
 * for every draw so a replay, a branch or a regenerated round rolls the same faces. */
export interface DiceInstance {
  roll(expression: string, random: () => number): DiceRoll
  close?(): void | Promise<void>
}

export interface DiceSlotApi {
  register(provider: SeamProvider<DiceInstance>): () => void
  readonly current: SeamProvider<DiceInstance> | undefined
}
