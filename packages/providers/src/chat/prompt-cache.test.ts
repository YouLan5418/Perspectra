import { expect, it } from 'vitest'
import { effectivePromptCacheMode, promptCacheMode, promptCachePayload } from './prompt-cache.ts'

it('recognizes checked routes without treating a model name, lookalike host or arbitrary path as an upstream', () => {
  expect(effectivePromptCacheMode('openai', new URL('https://api.deepseek.com/chat/completions'))).toBe('passive')
  expect(effectivePromptCacheMode('anthropic', new URL('https://api.deepseek.com/anthropic/v1/messages'))).toBe(
    'passive',
  )
  expect(
    effectivePromptCacheMode('openai', new URL('https://api.deepseek.com/chat/completions'), 'deepseek-user'),
  ).toBe('deepseek-user')
  expect(effectivePromptCacheMode('anthropic', new URL('https://api.anthropic.com/v1/messages'))).toBe('prefix')
  expect(effectivePromptCacheMode('openai', new URL('https://ark.cn-beijing.volces.com/api/v3/chat/completions'))).toBe(
    'prompt-key',
  )
  for (const url of [
    'https://api.openai.com.evil.example/v1/chat/completions',
    'https://api.openai.com/proxy/chat/completions',
    'https://api.openai.com:8443/v1/chat/completions',
    'http://api.openai.com/v1/chat/completions',
    'https://gateway.example/v1/chat/completions',
  ])
    expect(effectivePromptCacheMode('openai', new URL(url))).toBe('passive')
})

it('recognizes the checked gateway routes including the native OpenCode Go protocols', () => {
  expect(effectivePromptCacheMode('openai', new URL('https://openrouter.ai/api/v1/chat/completions'))).toBe(
    'openrouter',
  )
  expect(effectivePromptCacheMode('openai', new URL('https://opencode.ai/zen/go/v1/chat/completions'))).toBe(
    'opencode-go',
  )
  expect(effectivePromptCacheMode('anthropic', new URL('https://opencode.ai/inference/go/anthropic/v1/messages'))).toBe(
    'opencode-go',
  )
  expect(
    effectivePromptCacheMode(
      'google',
      new URL('https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent'),
    ),
  ).toBe('opencode-go')
})

it('validates explicit choices and lets a custom endpoint opt into a supported wire format', () => {
  expect(promptCacheMode(undefined)).toBe('auto')
  expect(() => promptCacheMode('constructor')).toThrow('缓存适配')
  expect(() => effectivePromptCacheMode('google', new URL('https://g.example'), 'prefix')).toThrow('Google')
  expect(() => effectivePromptCacheMode('anthropic', new URL('https://a.example'), 'prompt-key')).toThrow('OpenAI')
  expect(effectivePromptCacheMode('openai', new URL('https://gateway.example'), 'prompt-key')).toBe('prompt-key')
})

it('preserves existing metadata while adding the DeepSeek isolation ID', () => {
  const before = { metadata: { purpose: 'fixture' } }
  expect(promptCachePayload(before, 'anthropic', 'deepseek-user', 'opaque')).toEqual({
    metadata: { purpose: 'fixture', user_id: 'opaque' },
  })
  expect(before).toEqual({ metadata: { purpose: 'fixture' } })
})

it('refuses Go routes without a session, since Go answers 400 MissingSessionID', () => {
  const go = new URL('https://opencode.ai/zen/go/v1/chat/completions')
  for (const mode of ['passive', 'prefix', 'prompt-key', 'deepseek-user', 'openrouter'] as const)
    expect(() => effectivePromptCacheMode('openai', go, mode)).toThrow(/OpenCode Go/)
  expect(effectivePromptCacheMode('openai', go, 'opencode-go')).toBe('opencode-go')
  // A local gateway in front of Go adds its own session, so passive stays allowed there.
  expect(effectivePromptCacheMode('openai', new URL('http://127.0.0.1:3495/v1/chat/completions'), 'passive')).toBe(
    'passive',
  )
})
