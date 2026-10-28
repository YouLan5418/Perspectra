import { describe, expect, it } from 'vitest'
import { piBaseUrl, piModel, supportedThinkingLevels, usesDeepSeekThinking } from './pi-model.ts'

const gateway = new URL('http://127.0.0.1:8045/v1/chat/completions')
const googleApi = new URL('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent')

describe('piBaseUrl', () => {
  it.each([
    ['openai', 'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com'],
    ['openai', 'http://127.0.0.1:8045/v1/chat/completions', 'http://127.0.0.1:8045/v1'],
    ['anthropic', 'https://api.anthropic.com/v1/messages', 'https://api.anthropic.com'],
    ['anthropic', 'https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com/anthropic'],
    ['google', googleApi.href, 'https://generativelanguage.googleapis.com/v1beta'],
  ] as const)('%s %s', (protocol, endpoint, base) => {
    expect(piBaseUrl(new URL(endpoint), protocol)).toBe(base)
  })
  it('refuses an anthropic address that does not end in /v1/messages', () => {
    expect(() => piBaseUrl(new URL('https://x.test/messages'), 'anthropic')).toThrow('/v1/messages')
  })
})

describe('piModel', () => {
  it('keeps the connection address, protocol and model id whatever the catalog says', () => {
    const model = piModel({ protocol: 'openai', endpoint: gateway, model: 'gemini-3-flash-preview' })
    expect([model.api, model.baseUrl, model.id]).toEqual([
      'openai-completions',
      'http://127.0.0.1:8045/v1',
      'gemini-3-flash-preview',
    ])
    // A different API and host: the wire-format layer is not inherited.
    expect(model.compat).toBeUndefined()
  })
  it('inherits compat when API and host match the catalog entry', () => {
    const model = piModel({
      protocol: 'openai',
      endpoint: new URL('https://api.deepseek.com/chat/completions'),
      model: 'deepseek-flash',
    })
    expect(usesDeepSeekThinking(model)).toBe(true)
  })
  it('does not treat a gateway-served DeepSeek id as the DeepSeek wire format', () => {
    expect(usesDeepSeekThinking(piModel({ protocol: 'openai', endpoint: gateway, model: 'deepseek-flash' }))).toBe(
      false,
    )
  })
  it('gives an unknown id the conservative default', () => {
    const model = piModel({
      protocol: 'openai',
      endpoint: new URL('http://127.0.0.1:1/v1/chat/completions'),
      model: 'fixture',
    })
    expect([model.reasoning, model.thinkingLevelMap, model.compat, model.input]).toEqual([
      true,
      undefined,
      undefined,
      ['text'],
    ])
  })
})

describe('supportedThinkingLevels', () => {
  it('drops off for Gemini 3 under both openai and google protocols', () => {
    for (const [protocol, endpoint] of [
      ['openai', gateway],
      ['google', googleApi],
    ] as const)
      expect(supportedThinkingLevels({ protocol, endpoint, model: 'gemini-3.8-flash' })).toEqual([
        'low',
        'medium',
        'high',
      ])
  })
  it('follows the catalog for levels a model does not offer', () => {
    expect(
      supportedThinkingLevels({
        protocol: 'openai',
        endpoint: new URL('https://api.deepseek.com/chat/completions'),
        model: 'deepseek-flash',
      }),
    ).toEqual(['off', 'low', 'high'])
  })
  it('offers all four for an unknown id', () => {
    expect(
      supportedThinkingLevels({
        protocol: 'openai',
        endpoint: new URL('http://127.0.0.1:1/v1/chat/completions'),
        model: 'fixture',
      }),
    ).toEqual(['off', 'low', 'medium', 'high'])
  })
})
