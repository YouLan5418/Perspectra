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

  it('accepts the context projection switch alongside the other playtest flags', () => {
    expect(parsePlaytestLaunchArguments(['--lean-prompt'])).toEqual({ provider: 'ollama', leanPrompt: true })
    expect(parsePlaytestLaunchArguments(['--pack', 'p.json', '--lean-prompt']))
      .toMatchObject({ packPath: 'p.json', leanPrompt: true })
  })

  it.each([
    ['--unknown'],
    ['--pack'],
    ['--pack', '--deepseek'],
    ['--pack', 'a', '--pack', 'b'],
    ['--data-dir', 'a', '--data-dir', 'b'],
    ['--lean-prompt', '--lean-prompt'],
  ])('rejects an unsupported or ambiguous command line %#', (...args) => {
    expect(() => parsePlaytestLaunchArguments(args)).toThrow()
  })
})
