import { expect, it } from 'vitest'
import { createChatProvider, type ChatCallObservation } from './provider.ts'

function response(usage?: object): Response {
  const frames = [
    { id: 'test', choices: [{ index: 0, delta: { content: '{"decision":"abstain"}' }, finish_reason: null }] },
    { id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ...(usage === undefined ? [] : [{ id: 'test', choices: [], usage }]),
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}
const call = {
  messages: [{ role: 'user' as const, content: 'test' }],
  schema: { type: 'object', properties: { decision: { type: 'string' } } },
  description: 'test',
}

it('distinguishes absent usage from an endpoint explicitly reporting zero tokens', async () => {
  for (const usage of [undefined, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }]) {
    const observations: ChatCallObservation[] = []
    const provider = createChatProvider({
      endpoint: new URL('http://localhost/v1/chat/completions'),
      model: 'fixture',
      fetch: async () => response(usage),
      onCall: value => observations.push(value),
    })
    expect(await provider.decide(call, new AbortController().signal)).toEqual({ decision: 'abstain' })
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ httpAttempts: 1, usageReported: usage !== undefined })
  }
})

it('counts each visible HTTP retry without inventing another business decision call', async () => {
  const observations: ChatCallObservation[] = []
  let attempts = 0
  const provider = createChatProvider({
    endpoint: new URL('http://localhost/v1/chat/completions'),
    model: 'fixture',
    maxRetries: 1,
    fetch: async () =>
      ++attempts === 1
        ? new Response('retry', { status: 429, headers: { 'retry-after-ms': '1' } })
        : response({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
    onCall: value => observations.push(value),
  })
  await provider.decide(call, new AbortController().signal)
  expect(attempts).toBe(2)
  expect(observations).toHaveLength(1)
  expect(observations[0]).toMatchObject({
    httpAttempts: 2,
    usageReported: true,
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  })
})

it('counts a failing fetch attempt and leaves usage missing', async () => {
  const observations: ChatCallObservation[] = []
  const provider = createChatProvider({
    endpoint: new URL('http://localhost/v1/chat/completions'),
    model: 'fixture',
    fetch: async () => {
      throw new Error('offline')
    },
    onCall: value => observations.push(value),
  })
  await expect(provider.decide(call, new AbortController().signal)).rejects.toThrow()
  expect(observations[0]).toMatchObject({ status: 'failed', httpAttempts: 1, usageReported: false })
})
