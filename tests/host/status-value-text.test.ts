import { expect, it } from 'vitest'
import { statusValueText } from '../../apps/host/src/runtime/gameplay-projection.ts'

// Real-model play 2026-11-08: the status bar showed 队伍 ["character:cheng"], 已开的门 [...] and 装备 {}.
const names = new Map([
  ['character:cheng', '澄'],
  ['location:ruin-1', '遗迹一层'],
  ['location:ruin-2', '遗迹二层'],
  ['entity:iron-sword', '铁剑'],
])

it('names pack ids and reads lists, pairs, objects and empties as a player would', () => {
  expect(statusValueText(['character:cheng'], names)).toBe('澄')
  expect(statusValueText([['location:ruin-1', 'location:ruin-2']], names)).toBe('遗迹一层 → 遗迹二层')
  expect(statusValueText({ weapon: 'entity:iron-sword' }, names)).toBe('weapon：铁剑')
  expect(statusValueText({}, names)).toBe('无')
  expect(statusValueText([], names)).toBe('无')
})

it('leaves plain values and unknown strings as they are', () => {
  expect(statusValueText(40, names)).toBe('40')
  expect(statusValueText(true, names)).toBe('是')
  expect(statusValueText(null, names)).toBe('空')
  expect(statusValueText('深夜', names)).toBe('深夜')
  expect(statusValueText(['a', 'b', 'c'], names)).toBe('a、b、c')
})
