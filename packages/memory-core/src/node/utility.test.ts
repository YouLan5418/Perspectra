import { expect, it } from 'vitest'
import { createUtility, type MemoryModel, type UtilityTraceRecord } from './utility.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

it('sends OpenAI-compatible JSON requests and parses their utility object', async () => {
  let sentUrl = '',
    sentHeaders: HeadersInit | undefined,
    sentBody: Record<string, unknown> | undefined
  const send: typeof fetch = async (url, init) => {
      sentUrl = String(url)
      sentHeaders = init?.headers
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        choices: [{ message: { content: '{"atoms":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      })
    },
    model: MemoryModel = {
      protocol: 'openai',
      endpoint: 'http://127.0.0.1:8045/v1/chat/completions',
      model: 'fixture-model',
      apiKey: 'TEST_API_KEY',
    },
    result = await createUtility(model, new AbortController().signal, send)('system', 'raw evidence', 64)
  expect(result).toEqual({ atoms: [] })
  expect(sentUrl).toBe(model.endpoint)
  expect((sentHeaders as Record<string, string>).authorization).toBe('Bearer TEST_API_KEY')
  expect(sentBody).toMatchObject({
    model: 'fixture-model',
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 64,
    thinking: { type: 'disabled' },
  })
})

it('sends Anthropic system and key headers and extracts text blocks', async () => {
  let headers: Record<string, string> = {},
    body: Record<string, unknown> = {}
  const send: typeof fetch = async (_url, init) => {
      headers = init?.headers as Record<string, string>
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        content: [
          { type: 'thinking', thinking: 'ignored' },
          { type: 'text', text: '{"groups":[]}' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 3 },
      })
    },
    result = await createUtility(
      {
        protocol: 'anthropic',
        endpoint: 'https://api.example/v1/messages',
        model: 'claude-test',
        apiKey: 'ANTHROPIC_KEY',
      },
      new AbortController().signal,
      send,
    )('group prompt', 'evidence', 128)
  expect(result).toEqual({ groups: [] })
  expect(headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'x-api-key': 'ANTHROPIC_KEY' })
  expect(body).toMatchObject({
    model: 'claude-test',
    system: 'group prompt\n只返回所要求的 JSON 对象，不要 Markdown 或解释。',
    max_tokens: 128,
  })
})

it('rewrites the Google model path, filters thought parts, and keeps credentials out of diagnostics', async () => {
  let sentUrl = '',
    headers: Record<string, string> = {}
  const trace: UtilityTraceRecord[] = [],
    send: typeof fetch = async (url, init) => {
      sentUrl = String(url)
      headers = init?.headers as Record<string, string>
      return jsonResponse({
        candidates: [
          {
            content: { parts: [{ thought: true, text: 'private thought' }, { text: '{"observations":[]}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 },
      })
    },
    result = await createUtility(
      {
        protocol: 'google',
        endpoint:
          'https://generativelanguage.example/v1beta/models/placeholder:generateContent?transport_secret=HIDDEN',
        model: 'models/gemini-test',
        apiKey: 'GOOGLE_KEY',
      },
      new AbortController().signal,
      send,
      { onTrace: row => trace.push(row) },
    )('observe', 'private source', 96)
  expect(result).toEqual({ observations: [] })
  expect(new URL(sentUrl).pathname).toBe('/v1beta/models/gemini-test:generateContent')
  expect(new URL(sentUrl).searchParams.get('transport_secret')).toBe('HIDDEN')
  expect(headers['x-goog-api-key']).toBe('GOOGLE_KEY')
  expect(JSON.stringify(trace)).not.toContain('GOOGLE_KEY')
  expect(JSON.stringify(trace)).not.toContain('transport_secret')
  expect(JSON.stringify(trace)).not.toContain('private source')
  expect(JSON.stringify(trace)).not.toContain('private thought')
})

it('retries a Gemini timeout once with thinking disabled and records only safe attempt diagnostics', async () => {
  let calls = 0
  const bodies: Record<string, unknown>[] = [],
    trace: UtilityTraceRecord[] = [],
    send: typeof fetch = async (_url, init) => {
      calls++
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (calls === 1) {
        const signal = init?.signal as AbortSignal
        await new Promise<never>((_resolve, reject) => {
          const fail = () => reject(new Error('transport rejected after timeout'))
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail, { once: true })
        })
      }
      return jsonResponse({ choices: [{ message: { content: '{"atoms":[]}' }, finish_reason: 'stop' }] })
    },
    result = await createUtility(
      {
        protocol: 'openai',
        endpoint: 'http://127.0.0.1:8045/v1/chat/completions?private=ENDPOINT_SECRET',
        model: 'gemini-test',
        apiKey: 'GEMINI_KEY',
      },
      new AbortController().signal,
      send,
      { timeoutMs: 15, sleep: async () => {}, onTrace: row => trace.push(row), metadata: { stage: 'retain' } },
    )('retain', 'private source', 64)
  expect(result).toEqual({ atoms: [] })
  expect(calls).toBe(2)
  expect(bodies[0]).toHaveProperty('reasoning_effort', 'low')
  expect(bodies[0]).not.toHaveProperty('thinking')
  expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  expect(bodies[1]).toHaveProperty('thinking', { type: 'disabled' })
  expect(trace.map(row => row.event)).toEqual(['started', 'finished', 'started', 'finished'])
  const diagnostics = JSON.stringify(trace)
  expect(diagnostics).not.toContain('GEMINI_KEY')
  expect(diagnostics).not.toContain('ENDPOINT_SECRET')
  expect(diagnostics).not.toContain('private source')
})

it('does not retry cancellation and never returns transport error contents', async () => {
  const controller = new AbortController()
  let calls = 0
  const trace: UtilityTraceRecord[] = [],
    send: typeof fetch = async (_url, init) => {
      calls++
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal,
          fail = () => reject(new Error('leaked credentials: TEST_API_KEY'))
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      })
      throw new Error('unreachable')
    },
    pending = createUtility(
      {
        protocol: 'openai',
        endpoint: 'https://example.test/private?token=ENDPOINT_SECRET',
        model: 'fixture-model',
        apiKey: 'TEST_API_KEY',
      },
      controller.signal,
      send,
      { timeoutMs: 10_000, onTrace: row => trace.push(row) },
    )('system', 'private source', 64)
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(calls).toBe(1)
  const diagnostics = JSON.stringify(trace)
  expect(diagnostics).not.toContain('TEST_API_KEY')
  expect(diagnostics).not.toContain('ENDPOINT_SECRET')
  expect(diagnostics).not.toContain('private source')
})
