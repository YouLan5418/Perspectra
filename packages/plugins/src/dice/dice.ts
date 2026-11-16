import type { DiceRoll } from '@perspectra/sdk'

// `d20`, `1d20+2`, `2d6-1`, `d100`: count 1–20 or omitted, sides 2–1000, modifier ±1000, no leading zeros.
const EXPRESSION = /^([1-9]\d?)?d([1-9]\d{0,3})(?:([+-])([1-9]\d{0,3}))?$/u

export function parseDice(expression: string): { count: number; sides: number; modifier: number } {
  const match = typeof expression === 'string' ? EXPRESSION.exec(expression) : null
  const count = match?.[1] === undefined ? 1 : Number(match[1]),
    sides = Number(match?.[2]),
    modifier = match?.[4] === undefined ? 0 : Number(match[4]) * (match[3] === '-' ? -1 : 1)
  if (!match || count > 20 || sides < 2 || sides > 1000 || Math.abs(modifier) > 1000)
    throw new TypeError('骰子表达式无效：' + String(expression))
  return { count, sides, modifier }
}

/** One recorded draw per die: face = 1 + floor(draw × sides). */
export function rollDice(expression: string, random: () => number): DiceRoll {
  const { count, sides, modifier } = parseDice(expression)
  const dice = Array.from({ length: count }, () => {
    const draw = random()
    if (typeof draw !== 'number' || !(draw >= 0 && draw < 1)) throw new TypeError('骰子随机数无效')
    return 1 + Math.floor(draw * sides)
  })
  return { expression, dice, modifier, total: dice.reduce((sum, face) => sum + face, modifier) }
}

/** Meets or beats the difficulty to succeed; the margin is how far above or below. */
export function check(roll: DiceRoll, difficulty: number): { success: boolean; margin: number } {
  const margin = roll.total - difficulty
  return { success: margin >= 0, margin }
}
