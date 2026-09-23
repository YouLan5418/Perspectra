import { describe, expect, it } from 'vitest'
import { parsePlaytestLaunchArguments } from './playtest-launch.ts'

describe('creator playtest launch arguments', () => {
  it('accepts provider, v5 source directory, and data directory in any order', () => {
    expect(parsePlaytestLaunchArguments([])).toEqual({ provider: 'ollama' })
    expect(parsePlaytestLaunchArguments([
      '--pack', 'world-source', '--deepseek', '--data-dir', 'world-data',
    ])).toEqual({
      provider: 'deepseek', packPath: 'world-source', dataDirectory: 'world-data',
    })
  })

  it.each([
    ['--unknown'],
    ['--pack'],
    ['--pack', '--deepseek'],
    ['--pack', 'a', '--pack', 'b'],
    ['--data-dir', 'a', '--data-dir', 'b'],
    ['--lean-prompt'],
    ['--interactions', 'legacy.json'],
    ['--action-groups'],
    ['--recall-keyword', 'legacy'],
  ])('rejects an unsupported or ambiguous command line %#', (...args) => {
    expect(() => parsePlaytestLaunchArguments(args)).toThrow()
  })
})
