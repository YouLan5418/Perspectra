import { describe, expect, it } from 'vitest'
import { parsePlaytestLaunchArguments } from './playtest-launch.ts'

describe('creator playtest launch arguments', () => {
  it('accepts provider, compiled Pack, and durable data directory in any order', () => {
    expect(parsePlaytestLaunchArguments([])).toEqual({ provider: 'ollama' })
    expect(parsePlaytestLaunchArguments([
      '--pack', 'world.worldpack.json', '--deepseek', '--data-dir', 'world-data',
    ])).toEqual({
      provider: 'deepseek', packPath: 'world.worldpack.json', dataDirectory: 'world-data',
    })
  })

  it.each([
    ['--unknown'],
    ['--pack'],
    ['--pack', '--deepseek'],
    ['--pack', 'a', '--pack', 'b'],
    ['--data-dir', 'a', '--data-dir', 'b'],
  ])('rejects an unsupported or ambiguous command line %#', (...args) => {
    expect(() => parsePlaytestLaunchArguments(args)).toThrow()
  })
})
