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
})
