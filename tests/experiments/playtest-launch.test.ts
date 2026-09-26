import { describe, expect, it } from 'vitest'
import { parsePlaytestLaunchArguments } from './playtest-launch.ts'

describe('creator playtest launch arguments', () => {
  it('accepts provider, v5 source directory, and data directory in any order', () => {
    expect(parsePlaytestLaunchArguments([])).toEqual({ provider: 'ollama' })
    expect(parsePlaytestLaunchArguments(['--jev-shadow', 'items.json'])).toEqual({ provider: 'ollama', shadowConfigPath: 'items.json' })
    expect(parsePlaytestLaunchArguments([
      '--pack', 'world-source', '--deepseek', '--data-dir', 'world-data',
    ])).toEqual({
      provider: 'deepseek', packPath: 'world-source', dataDirectory: 'world-data',
    })
  })

  it.each([
    ['--jev-shadow'],
    ['--jev-shadow', 'a', '--jev-shadow', 'b'],
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
