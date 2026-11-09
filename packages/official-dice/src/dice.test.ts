import { expect, it } from 'vitest'
import { check, parseDice, rollDice } from './dice.ts'

const sequence = (values: number[]) => () => {
  const value = values.shift()
  if (value === undefined) throw new Error('exhausted')
  return value
}

it.each([
  ['d20', { count: 1, sides: 20, modifier: 0 }],
  ['1d20+2', { count: 1, sides: 20, modifier: 2 }],
  ['2d6-1', { count: 2, sides: 6, modifier: -1 }],
  ['d100', { count: 1, sides: 100, modifier: 0 }],
  ['20d1000+1000', { count: 20, sides: 1000, modifier: 1000 }],
  ['d2-1000', { count: 1, sides: 2, modifier: -1000 }],
])('parses %s', (expression, parsed) => {
  expect(parseDice(expression)).toEqual(parsed)
})

it.each([
  '',
  '20',
  'd',
  'd1',
  '0d6',
  '21d6',
  'd1001',
  'd20+1001',
  'd20-1001',
  '1d20+',
  ' d20',
  'D20',
  '1.5d6',
  'd06',
  'd20+02',
  '2d6+1+1',
  2,
  null,
])('rejects %j', expression => {
  expect(() => parseDice(expression as string)).toThrow(TypeError)
})

it('rolls each die from one recorded draw and adds the modifier', () => {
  expect(rollDice('2d6+1', sequence([0.5, 0.0]))).toEqual({ expression: '2d6+1', dice: [4, 1], modifier: 1, total: 6 })
  expect(rollDice('d20', sequence([0.999999]))).toEqual({ expression: 'd20', dice: [20], modifier: 0, total: 20 })
})

it('rejects a draw outside [0, 1)', () => {
  expect(() => rollDice('d6', sequence([1]))).toThrow(TypeError)
})

it('succeeds when the total meets the difficulty', () => {
  const roll = { expression: 'd20', dice: [12], modifier: 0, total: 12 }
  expect(check(roll, 12)).toEqual({ success: true, margin: 0 })
  expect(check(roll, 13)).toEqual({ success: false, margin: -1 })
})
