import {
  ChatTransportError,
  RequestInspector,
  createChatProvider,
  testTextCall,
  type ChatCallObservation,
  type ChatProviderOptions,
  type ProviderProtocol,
} from '@harness-world/provider-chat'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeProvider, streamingFetch, type FakeAnswer, type FakeProviderCall } from '../support/fake-provider.ts'

const call = {
  messages: [
    { role: 'system', content: 'portray exactly one character' },
    { role: 'user', content: '{"context":{"scene":"tavern"}}' },
  ],
  schema: { type: 'object', additionalProperties: false, properties: { decision: { type: 'string' } } },
  description: 'Decide whether to respond.',
  inspection: {
    characterId: 'character:a',
    continuation: false,
    sources: [
      { source: 'core', name: '角色契约' },
      { source: 'context', name: '授权上下文' },
    ],
  },
}
const proposal = { decision: 'abstain' }
const protocols = ['openai', 'anthropic', 'google'] as const
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function provider(
  protocol: ProviderProtocol,
  answer: (call: FakeProviderCall) => FakeAnswer,
  options: Partial<ChatProviderOptions> = {},
) {
  const server = await startFakeProvider(protocol, answer)
  closers.push(server.close)
  const observations: ChatCallObservation[] = []
  const chat = createChatProvider({
    protocol,
    endpoint: new URL(server.endpoint),
    model: 'fixture',
    maxOutputTokens: 512,
    onCall: o => observations.push(o),
    ...options,
  })
  return { chat, server, observations }
}
const decide = (chat: { decide: (c: typeof call, s: AbortSignal) => Promise<unknown> }) =>
  chat.decide(call, new AbortController().signal)

describe('the pi-ai adapter on the wire', () => {
  it('openai forces the decision tool and carries the key only in its header', async () => {
    const { chat, server } = await provider('openai', () => ({ tool: proposal }), { apiKey: 'secret-value' })
    expect(await decide(chat)).toEqual(proposal)
    const { body, headers } = server.calls[0]!
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_actions' } })
    expect((body.tools as { function: { parameters: unknown } }[])[0]!.function.parameters).toEqual(call.schema)
    expect(body.max_tokens).toBe(512)
    expect((body.messages as { role: string }[]).map(m => m.role)).toEqual(['system', 'user'])
    expect(headers.authorization).toBe('Bearer secret-value')
    expect(JSON.stringify(body)).not.toContain('secret-value')
  })

  for (const protocol of ['openai', 'anthropic'] as const)
    it(`${protocol}: a keyless connection sends no auth header`, async () => {
      const { chat, server } = await provider(protocol, () => ({ tool: proposal }))
      expect(await decide(chat)).toEqual(proposal)
      const { headers } = server.calls[0]!
      expect([headers.authorization, headers['x-api-key'], headers['x-goog-api-key']]).toEqual([
        undefined,
        undefined,
        undefined,
      ])
    })

  for (const protocol of protocols)
    it(`${protocol}: unset thinking sends no thinking fields`, async () => {
      const { chat, server } = await provider(protocol, () => ({ tool: proposal }), { apiKey: 'k' })
      await decide(chat)
      const body = server.calls[0]!.body
      expect(body.thinking).toBeUndefined()
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.enable_thinking).toBeUndefined()
      expect((body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig).toBeUndefined()
    })

  it('explicit off sends the protocol’s own disable', async () => {
    const { chat, server } = await provider('anthropic', () => ({ tool: proposal }), { thinkingLevel: 'off' })
    await decide(chat)
    expect((server.calls[0]!.body.thinking as { type: string }).type).toBe('disabled')
  })

  it('explicit off sends reasoning_effort none for an unknown OpenAI-compatible model', async () => {
    const { chat, server } = await provider('openai', () => ({ tool: proposal }), { thinkingLevel: 'off' })
    await decide(chat)
    expect(server.calls[0]!.body.reasoning_effort).toBe('none')
  })

  it('OpenRouter leaves thinking unset unless the player explicitly switches it off', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetch = streamingFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ message: { content: JSON.stringify(proposal) } }))
    })
    for (const level of [undefined, 'off'] as const) {
      const chat = createChatProvider({
        endpoint: new URL('https://openrouter.ai/api/v1/chat/completions'),
        model: 'fixture',
        fetch,
        ...(level === undefined ? {} : { thinkingLevel: level }),
      })
      await decide(chat)
    }
    expect(bodies[0]!.reasoning).toBeUndefined()
    expect(bodies[1]!.reasoning).toEqual({ effort: 'none' })
    expect(bodies[1]!.reasoning_effort).toBeUndefined()
  })

  it('a thinking level raises the output ceiling to its floor', async () => {
    const { chat, server } = await provider('openai', () => ({ tool: proposal }), { thinkingLevel: 'low' })
    await decide(chat)
    expect(server.calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(8192)
  })

  it('anthropic keeps auto tool choice; google keeps ANY with the tool name', async () => {
    const anthropic = await provider('anthropic', () => ({ tool: proposal }))
    await decide(anthropic.chat)
    expect((anthropic.server.calls[0]!.body.tool_choice as { type: string }).type).toBe('auto')
    const google = await provider('google', () => ({ tool: proposal }), { apiKey: 'k' })
    await decide(google.chat)
    expect((google.server.calls[0]!.body.toolConfig as Record<string, unknown>).functionCallingConfig).toEqual({
      mode: 'ANY',
      allowedFunctionNames: ['submit_actions'],
    })
  })

  it('carries preset sampling on each protocol and refuses Anthropic penalties', async () => {
    const preset = { topP: 0.9, frequencyPenalty: 0.1, presencePenalty: 0.2, stop: ['END'] }
    const openai = await provider('openai', () => ({ tool: proposal }), { preset })
    await decide(openai.chat)
    expect(openai.server.calls[0]!.body).toMatchObject({
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ['END'],
    })
    const anthropic = await provider('anthropic', () => ({ tool: proposal }), { preset: { topP: 0.9, stop: ['END'] } })
    await decide(anthropic.chat)
    expect(anthropic.server.calls[0]!.body).toMatchObject({ top_p: 0.9, stop_sequences: ['END'] })
    const refused = await provider('anthropic', () => ({ tool: proposal }), { preset })
    await expect(decide(refused.chat)).rejects.toThrow('Anthropic 不支持 frequencyPenalty / presencePenalty')
    const google = await provider('google', () => ({ tool: proposal }), {
      apiKey: 'k',
      preset: { topP: 0.9, stop: ['END'] },
    })
    await decide(google.chat)
    expect(google.server.calls[0]!.body.generationConfig).toMatchObject({ topP: 0.9, stopSequences: ['END'] })
  })

  it('anthropic drops temperature and top_p while thinking', async () => {
    const { chat, server } = await provider('anthropic', () => ({ tool: proposal }), {
      thinkingLevel: 'low',
      preset: { temperature: 0.7, topP: 0.9 },
    })
    await decide(chat)
    expect(server.calls[0]!.body.temperature).toBeUndefined()
    expect(server.calls[0]!.body.top_p).toBeUndefined()
  })

  for (const protocol of protocols) {
    it(`${protocol}: prose is returned as the model stated it`, async () => {
      const { chat } = await provider(protocol, () => ({ text: 'I would rather not.' }), { apiKey: 'k' })
      expect(await decide(chat)).toBe('I would rather not.')
    })
    it(`${protocol}: JSON text is parsed`, async () => {
      const { chat } = await provider(protocol, () => ({ text: JSON.stringify(proposal) }), { apiKey: 'k' })
      expect(await decide(chat)).toEqual(proposal)
    })
    it(`${protocol}: a truncated answer fails`, async () => {
      const { chat } = await provider(protocol, () => ({ tool: proposal, stop: 'length' }), { apiKey: 'k' })
      await expect(decide(chat)).rejects.toThrow('模型输出超过 token 上限。')
    })
    it(`${protocol}: an empty answer fails`, async () => {
      const { chat } = await provider(protocol, () => ({ text: '' }), { apiKey: 'k' })
      await expect(decide(chat)).rejects.toThrow('模型接口未返回有效文本。')
    })
  }

  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}: a non-streaming answer names streaming`, async () => {
      const { chat } = await provider(protocol, () => ({ tool: proposal, plainJson: true }))
      await expect(decide(chat)).rejects.toThrow('流式')
    })
    it(`${protocol}: a refusal reports its HTTP status and the endpoint's words`, async () => {
      const { chat, observations } = await provider(protocol, () => ({ status: 401 }))
      const failure = await decide(chat).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ChatTransportError)
      expect(String((failure as Error).message)).toContain('401')
      expect(String((failure as Error).message)).toContain('fake provider refused')
      expect(observations.at(-1)).toMatchObject({ status: 'failed', httpStatus: 401 })
    })
  }

  it('a cancelled call is recorded as cancelled', async () => {
    const inspector = new RequestInspector()
    inspector.configure(true)
    const { chat } = await provider('openai', () => new Promise<FakeAnswer>(() => {}) as never, { inspector })
    const controller = new AbortController()
    const pending = chat.decide(call, controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toBeInstanceOf(Error)
    expect(inspector.snapshot().requests[0]?.failure).toBe('cancelled')
  })

  it('the inspector keeps the final payload and the pre-conversion messages', async () => {
    const inspector = new RequestInspector()
    inspector.configure(true)
    const { chat } = await provider('anthropic', () => ({ tool: proposal }), { inspector })
    await decide(chat)
    const record = inspector.snapshot().requests[0]!
    expect(record.body?.tools).toBeDefined()
    expect(record.messages.map(m => [m.role, m.source.name])).toEqual([
      ['system', '角色契约'],
      ['user', '授权上下文'],
    ])
    expect(record.status).toBe('ok')
    expect(record.usage?.inputTokens).toBe(11)
    expect(record.response?.toolCalls[0]?.name).toBe('submit_actions')
  })

  for (const protocol of protocols)
    it(`${protocol}: the connection test returns the model's text`, async () => {
      const server = await startFakeProvider(protocol, () => ({ text: 'OK' }))
      closers.push(server.close)
      expect(
        await testTextCall(
          { protocol, endpoint: new URL(server.endpoint), model: 'fixture' },
          'k',
          new AbortController().signal,
        ),
      ).toBe('OK')
    })
})

describe('review fixes', () => {
  it('refuses to follow a redirect, so the key never reaches another host', async () => {
    const elsewhere = await startFakeProvider('anthropic', () => ({ tool: proposal }))
    closers.push(elsewhere.close)
    const { createServer } = await import('node:http')
    const redirector = createServer((_request, response) => {
      response.writeHead(307, { location: elsewhere.endpoint })
      response.end()
    })
    await new Promise<void>(done => redirector.listen(0, '127.0.0.1', done))
    closers.push(() => new Promise<void>(done => redirector.close(() => done())))
    const port = (redirector.address() as { port: number }).port
    const chat = createChatProvider({
      protocol: 'anthropic',
      endpoint: new URL(`http://127.0.0.1:${port}/v1/messages`),
      model: 'fixture',
      apiKey: 'SECRET_KEY',
    })
    await expect(decide(chat)).rejects.toBeInstanceOf(Error)
    expect(elsewhere.calls).toHaveLength(0)
  })

  it('returns the model’s own text when its tool arguments are not JSON', async () => {
    const inspector = new RequestInspector()
    inspector.configure(true)
    const rawArguments = '{"decision": "publish", oops'
    const { chat } = await provider('openai', () => ({ tool: {}, rawArguments }), { inspector })
    expect(await decide(chat)).toBe(rawArguments)
    expect(inspector.snapshot().requests[0]!.response?.toolCalls[0]?.arguments).toBe(rawArguments)
  })

  it('names streaming when a gateway refuses stream_options', async () => {
    const { chat } = await provider('openai', () => ({
      status: 400,
      body: 'Unrecognized request argument supplied: stream_options',
    }))
    await expect(decide(chat)).rejects.toThrow('流式')
  })

  it('keeps later system messages in place on the DeepSeek official endpoint', async () => {
    const bodies: Record<string, unknown>[] = []
    const chat = createChatProvider({
      protocol: 'openai',
      endpoint: new URL('https://api.deepseek.com/chat/completions'),
      model: 'deepseek-flash',
      apiKey: 'k',
      fetch: streamingFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ message: { content: JSON.stringify(proposal) } }))
      }),
    })
    await chat.decide(
      {
        ...call,
        messages: [...call.messages, { role: 'system', content: 'after context' }, { role: 'user', content: 'go' }],
      },
      new AbortController().signal,
    )
    expect((bodies[0]!.messages as { role: string }[]).map(m => m.role)).toEqual(['system', 'user', 'system', 'user'])
  })
})
