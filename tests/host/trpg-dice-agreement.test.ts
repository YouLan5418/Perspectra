import { expect, it } from 'vitest'
import { parseDice } from '@perspectra/plugins/dice'
import { isDiceExpression } from '@perspectra/plugins/trpg'

// Official packages do not import each other, so official-trpg checks `sheet.dice` with its own copy of the dice
// grammar. A config that passes must roll; one that fails must be one the dice would refuse.
const expressions = [
  'd20',
  'd100',
  '1d20',
  '1d20+2',
  '2d6-1',
  '20d1000+1000',
  'd2-1000',
  '9d9+9',
  '10d10-10',
  'd1000',
  '',
  '20',
  'd',
  'd1',
  'd0',
  '0d6',
  '00d6',
  '01d6',
  '21d6',
  '99d6',
  'd1001',
  'd9999',
  'd06',
  'd20+0',
  'd20-0',
  'd20+02',
  'd20+1001',
  'd20-1001',
  'd20+9999',
  '1d20+',
  ' d20',
  'd20 ',
  'D20',
  '1.5d6',
  '2d6+1+1',
  'd20*2',
  '+d20',
]

it.each(expressions)('official-trpg and official-dice agree on %j', expression => {
  let rolls = true
  try {
    parseDice(expression)
  } catch {
    rolls = false
  }
  expect(isDiceExpression(expression)).toBe(rolls)
})
