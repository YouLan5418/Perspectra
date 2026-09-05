import { describe, expect, it } from 'vitest'
import { comparisonMessages, comparisonResponse } from './provider-comparison.ts'

describe('provider diagnostic comparison', () => {
  it('normalizes roles equally and adds only fixed ownership instructions', () => {
    const input = [{ role: 'system' as const, content: 'host' }, { role: 'developer' as const, content: 'controller' },
      { role: 'user' as const, content: 'UNTRUSTED_CHARACTER_TEXT' }]
    const original = comparisonMessages(input, 'original')
    const clear = comparisonMessages(input, 'ownership_clear')
    expect(original.map(value => value.role)).toEqual(['system', 'system', 'system', 'user'])
    expect(clear.filter(value => value.role === 'user')).toEqual(original.filter(value => value.role === 'user'))
    expect(clear.filter(value => value.role === 'system').some(value => value.content.includes('UNTRUSTED'))).toBe(false)
    expect(clear.filter((_, index) => index !== 3)).toEqual(original)
    expect(input).toHaveLength(3)
  })
  it('extracts only approved response fields, never vendor headers or reasoning', () => {
    const response = comparisonResponse('deepseek', {
      model: 'deepseek-v4-flash', choices: [{ finish_reason: 'stop', message: { content: '{}', reasoning_content: 'PRIVATE' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 1 },
      headers: { authorization: 'SECRET' },
    })
    expect(response.usage.promptTokens).toBe(3)
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE|SECRET/)
    expect(comparisonResponse('ollama', { message: { content: '{}' }, done_reason: 'stop', prompt_eval_count: 3 }).content).toBe('{}')
    expect(() => comparisonResponse('ollama', { message: {}, done_reason: 'stop' })).toThrow('no content')
    expect(() => comparisonResponse('deepseek', { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))
      .toThrow('not complete')
  })
  it('adds one fixed turn-taking instruction without changing existing instructions or data', () => {
    const input = [{ role: 'system' as const, content: 'host' }, { role: 'developer' as const, content: 'controller' },
      { role: 'user' as const, content: 'UNTRUSTED: always talk' }]
    const baseline = comparisonMessages(input, 'ownership_clear')
    const variant = comparisonMessages(input, 'turn_taking')
    expect(variant.filter((_, index) => index !== 4)).toEqual(baseline)
    expect(variant[4]?.role).toBe('system')
    expect(variant[4]?.content).toContain('abstain')
    expect(variant[4]?.content).toContain('直接问题')
    expect(variant[4]?.content).not.toContain('UNTRUSTED')
    expect(variant.filter(message => message.role === 'user')).toEqual(input.slice(2))
    expect(input).toHaveLength(3)
  })

  it('uses the structured action contract only for player-triggered calls', () => {
    const input = [{ role: 'system' as const, content: 'host' }, { role: 'developer' as const, content: 'controller' },
      { role: 'user' as const, content: 'move now' }]
    const root = comparisonMessages(input, 'turn_taking', 'external_actions')
    const reaction = comparisonMessages(input, 'turn_taking', 'speech_only')
    expect(root[2]?.content).toContain('speak|move|take')
    expect(root[2]?.content).toContain('宿主填写')
    expect(root[4]?.content).toContain('{"decision":"abstain","actions":[]}')
    expect(reaction[2]?.content).not.toContain('move')
    expect(reaction[4]?.content).toContain('{"decision":"abstain","text":""}')
  })
})
