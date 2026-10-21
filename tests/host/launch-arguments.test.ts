import { describe, expect, it } from 'vitest'
import { parseHostLaunchArguments } from '../../desktop/host/launch-arguments.ts'
import { DEFAULT_RUNTIME_TUNING } from '../../desktop/host/runtime-tuning.ts'

describe('creator playtest launch arguments', () => {
  it('accepts provider, v5 source directory, and data directory in any order', () => {
    expect(parseHostLaunchArguments([])).toEqual({ provider: 'local', memoryCore: true })
    expect(parseHostLaunchArguments(['--jev-shadow', 'items.json'])).toEqual({ provider: 'local', memoryCore: true, shadowConfigPath: 'items.json' })
    expect(parseHostLaunchArguments([
      '--pack', 'world-source', '--ollama', '--memory-native', '--data-dir', 'world-data',
    ])).toEqual({
      provider: 'ollama', packPath: 'world-source', dataDirectory: 'world-data',
    })
    expect(parseHostLaunchArguments(['--deepseek', '--memory-native'])).toEqual({ provider: 'deepseek' })
    expect(parseHostLaunchArguments(['--tuning', JSON.stringify(DEFAULT_RUNTIME_TUNING)])).toEqual({
      provider: 'local', memoryCore: true, tuning: DEFAULT_RUNTIME_TUNING,
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
    ['--tuning', '{}'],
    ['--tuning', JSON.stringify({ ...DEFAULT_RUNTIME_TUNING, maximumNpcCalls: 0 })],
    ['--lean-prompt'],
    ['--interactions', 'legacy.json'],
    ['--action-groups'],
    ['--recall-keyword', 'legacy'],
    ['--ollama'],
    ['--deepseek', '--memory-core'],
    ['--memory-core', '--memory-native'],
  ])('rejects an unsupported or ambiguous command line %#', (...args) => {
    expect(() => parseHostLaunchArguments(args)).toThrow()
  })
})
