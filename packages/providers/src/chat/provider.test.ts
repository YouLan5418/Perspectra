import { describe, expect, it } from 'vitest'
import { piModel } from './pi-model.ts'
import { thinkingPayload } from './provider.ts'
import { thinkingLevel } from './thinking.ts'

const deepseek = piModel({
  protocol: 'openai',
  endpoint: new URL('https://api.deepseek.com/chat/completions'),
  model: 'deepseek-flash',
})
const gateway = piModel({
  protocol: 'openai',
  endpoint: new URL('http://127.0.0.1:8045/v1/chat/completions'),
  model: 'fixture',
})

describe('thinkingPayload', () => {
  it('disables thinking for an unset DeepSeek-format character decision', () => {
    expect(thinkingPayload(deepseek, 'openai', { thinking: { type: 'enabled' } }, undefined, 'character')).toEqual({
      thinking: { type: 'disabled' },
    })
  })
  it('sends no thinking field for an unset DeepSeek-format interpretation call', () => {
    expect(thinkingPayload(deepseek, 'openai', { thinking: { type: 'disabled' } }, undefined, 'intent')).toEqual({})
  })
  it('strips what pi-ai wrote for an unset level on every protocol', () => {
    expect(
      thinkingPayload(
        gateway,
        'openai',
        { reasoning_effort: 'none', enable_thinking: false, a: 1 },
        undefined,
        'character',
      ),
    ).toEqual({ a: 1 })
    expect(
      thinkingPayload(gateway, 'anthropic', { thinking: { type: 'disabled' }, a: 1 }, undefined, 'character'),
    ).toEqual({ a: 1 })
    expect(
      thinkingPayload(
        gateway,
        'google',
        { config: { thinkingConfig: { thinkingBudget: 0 }, a: 1 } },
        undefined,
        'character',
      ),
    ).toEqual({ config: { a: 1 } })
  })
  it('leaves an explicit level to pi-ai', () => {
    const payload = { thinking: { type: 'disabled' } }
    expect(thinkingPayload(gateway, 'anthropic', payload, 'off', 'character')).toEqual(payload)
  })
})

it('accepts only the four thinking levels', () => {
  expect(() => thinkingLevel('max')).toThrow()
  expect(thinkingLevel('low')).toBe('low')
})
