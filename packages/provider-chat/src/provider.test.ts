import { describe, expect, it, vi } from 'vitest'
import { createStepManifestationSchema, type WorldJsonObject } from '@harness-world/contracts'
import { ChatTransportError, createChatProvider, type ChatCallObservation } from './provider.ts'

/** A minimal frozen tool description: enough to render, with one interaction option offered. */
const tools: WorldJsonObject = {
  type: 'object', schemaVersion: 'submit_actions/v7', maximumExternalActions: 2, maximumReflectionOperations: 4,
  actionGroup: { version: 'bounded-action-group/v2', allowedActionTypes: ['speak', 'interact'],
    failure: 'stop_remaining_steps', manifestation: { optional: true, schemasByAction: {
      speak: createStepManifestationSchema('speak'), interact: createStepManifestationSchema('interact') } } },
  interact: { parameters: ['targetRef', 'bindingId', 'definitionRef', 'arguments'] },
}

const exact = {
  messages: [
    { role: 'developer', content: '{"role":"portray exactly one character"}' },
    { role: 'user', content: JSON.stringify({ segmentKind: 'character_anchor', content: { characterId: 'character:companion' } }) },
    { role: 'user', content: JSON.stringify({ segmentKind: 'affordances', content: [
      { actionType: 'interact', actionVersion: 2, performances: [],
        interactions: [{ targetRef: { kind: 'entity', id: 'entity:cup' }, bindingId: 'binding:cup-take',
          definitionRef: { id: 'base:take', version: 1 }, arguments: {} }] }] }) },
  ],
  tools,
}

const intentRequest: WorldJsonObject = { version: 'player-intent-request/v2', contract: 'Interpret only the player intent.',
  sourceText: '拿起杯子', affordances: [{ affordanceId: 'take' }],
  responseSchema: { type: 'object', additionalProperties: false, required: ['version'] } }

const profile = { modelId: 'deepseek-flash', timeoutMs: 1_000, maxOutputTokens: 64 }

/** A local endpoint that records what it was asked and answers with what the case states. */
function endpoint(answer: unknown, status = 200) {
  const sent: { headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal }[] = []
  const fetchImpl = (async (_url: URL, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => {
    // A real transport refuses an already-cancelled call rather than answering it.
    if (init.signal.aborted) throw new Error('the call was aborted')
    sent.push({ headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal })
    return new Response(JSON.stringify(answer), { status })
  }) as unknown as typeof globalThis.fetch
  return { sent, fetchImpl }
}

const toolAnswer = (payload: unknown) => ({ choices: [{ message: {
  tool_calls: [{ function: { name: 'submit_actions', arguments: JSON.stringify(payload) } }] } }] })
const proposal = { schemaVersion: 7, decision: 'abstain', actions: [] }

describe('the adapter a real endpoint is called through', () => {
  it('sends the Host’s request as a forced tool call and returns what the model stated', async () => {
    const { sent, fetchImpl } = endpoint(toolAnswer(proposal))
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'deepseek-flash',
      apiKey: 'secret-value', maxOutputTokens: 512, fetch: fetchImpl })
    expect(await provider.propose({ exactProviderRequest: exact })).toEqual(proposal)
    const body = sent[0]!.body
    expect(body.model).toBe('deepseek-flash')
    expect(body.max_tokens).toBe(512)
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_actions' } })
    // The forced call and the endpoint's reasoning mode are mutually exclusive, so reasoning is off.
    expect(body.thinking).toEqual({ type: 'disabled' })
    const fn = ((body.tools as WorldJsonObject[])[0] as { function: WorldJsonObject }).function
    expect(fn.name).toBe('submit_actions')
    // The schema is derived from the Host's own description, and the developer message travels as system.
    const schema = fn.parameters as { properties: { schemaVersion: { const: number } } }
    expect(schema.properties.schemaVersion.const).toBe(7)
    const messages = body.messages as { role: string; content: string }[]
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toBe('{"role":"portray exactly one character"}')
    // The Secret is carried in the header and nowhere in the request the test can see.
    expect(sent[0]!.headers.authorization).toBe('Bearer secret-value')
    expect(JSON.stringify(body)).not.toContain('secret-value')
  })

  it('takes the payload whether the endpoint answered as content or already parsed', async () => {
    const content = endpoint({ choices: [{ message: { content: JSON.stringify(proposal) } }] })
    expect(await createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: content.fetchImpl }).propose({ exactProviderRequest: exact })).toEqual(proposal)
    const parsed = endpoint({ choices: [{ message: { tool_calls: [{ function: { arguments: proposal } }] } }] })
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: parsed.fetchImpl })
    expect(await provider.propose({ exactProviderRequest: exact })).toEqual(proposal)
    // No credential configured: no authorization header is invented.
    expect(parsed.sent[0]!.headers.authorization).toBeUndefined()
  })

  it('returns prose as it was stated, so the world is what refuses it', async () => {
    const prose = endpoint({ choices: [{ message: { content: 'I would rather not act.' } }] })
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: prose.fetchImpl })
    expect(await provider.propose({ exactProviderRequest: exact })).toBe('I would rather not act.')
  })

  it('throws on an endpoint that failed, and on one that answered with nothing', async () => {
    const failed = endpoint({ error: 'rate limited' }, 429)
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: failed.fetchImpl })
    await expect(provider.propose({ exactProviderRequest: exact }))
      .rejects.toThrow('chat endpoint returned HTTP 429')
    // An endpoint that refused without saying anything, as a proxy does: the status is all there is.
    const silent = (async () => new Response('', { status: 502 })) as unknown as typeof globalThis.fetch
    await expect(createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: silent }).propose({ exactProviderRequest: exact }))
      .rejects.toThrow('chat endpoint returned HTTP 502')
    const empty = endpoint({ choices: [{ message: {} }] })
    await expect(createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: empty.fetchImpl }).propose({ exactProviderRequest: exact }))
      .rejects.toBeInstanceOf(ChatTransportError)
    await expect(createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm' })
      .propose({})).rejects.toThrow('carries no exact provider request')
  })

  it('gives up on its own deadline, and reports every call without content', async () => {
    const observed: ChatCallObservation[] = []
    const stalling = (async (_url: URL, init: { signal: AbortSignal }) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('the call was aborted')))
    })) as unknown as typeof globalThis.fetch
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      timeoutMs: 20, fetch: stalling, onCall: observation => observed.push(observation) })
    await expect(provider.propose({ exactProviderRequest: exact })).rejects.toThrow('aborted')
    expect(observed).toEqual([{ kind: 'character', model: 'm', durationMs: expect.any(Number), status: 'failed' }])

    const answered = endpoint(toolAnswer(proposal))
    const ok: ChatCallObservation[] = []
    await createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm', fetch: answered.fetchImpl,
      onCall: observation => ok.push(observation) }).propose({ exactProviderRequest: exact })
    expect(ok[0]).toMatchObject({ kind: 'character', status: 'ok' })
    expect(ok[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('uses the endpoint the platform provides when the caller injected none', async () => {
    const { fetchImpl } = endpoint(toolAnswer(proposal))
    vi.stubGlobal('fetch', fetchImpl)
    try {
      const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm' })
      expect(await provider.propose({ exactProviderRequest: exact })).toEqual(proposal)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('the interpretation call the Host dispatches', () => {
  it('renders the Host’s request, honours its profile and passes its cancellation through', async () => {
    const { sent, fetchImpl } = endpoint(toolAnswer({ version: 'player-intent-candidate/v2' }))
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'configured',
      fetch: fetchImpl })
    const controller = new AbortController()
    expect(await provider.dispatch(intentRequest, profile, controller.signal))
      .toEqual({ version: 'player-intent-candidate/v2' })
    const body = sent[0]!.body
    expect(body.model).toBe('deepseek-flash')
    expect(body.max_tokens).toBe(64)
    const fn = ((body.tools as WorldJsonObject[])[0] as { function: WorldJsonObject }).function
    expect(fn.parameters).toEqual(intentRequest.responseSchema)
    expect(JSON.stringify(body.messages)).toContain('拿起杯子')
    // The Host's own deadline is enforced alongside its cancellation: aborting the call ends it.
    await expect(provider.dispatch(intentRequest, profile, AbortSignal.abort())).rejects.toBeTruthy()
  })

  it('falls back to its own model and limits where the profile states none', async () => {
    const { sent, fetchImpl } = endpoint(toolAnswer({ version: 'player-intent-candidate/v2' }))
    const provider = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'configured',
      maxOutputTokens: 128, fetch: fetchImpl })
    await provider.dispatch(intentRequest, { modelId: '', timeoutMs: 1_000 }, AbortSignal.timeout(1_000))
    expect(sent[0]!.body.model).toBe('configured')
    expect(sent[0]!.body.max_tokens).toBe(128)
    // Nowhere states an output budget: the adapter's own small default is what one call is allowed.
    const bounded = createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'configured',
      fetch: fetchImpl })
    await bounded.dispatch(intentRequest, { modelId: 'deepseek-flash', timeoutMs: 1_000 }, AbortSignal.timeout(1_000))
    expect(sent[1]!.body.max_tokens).toBe(1_024)
    // A request that is not an object at all, and one with no schema: both are refusals before any call.
    await expect(provider.dispatch('not a request', profile, AbortSignal.timeout(1_000)))
      .rejects.toThrow('no response schema')
    await expect(provider.dispatch({}, profile, AbortSignal.timeout(1_000))).rejects.toThrow('no response schema')
    expect(sent).toHaveLength(2)
  })

  it('speaks a local endpoint’s output format when asked to', async () => {
    const { sent, fetchImpl } = endpoint({ message: { content: JSON.stringify(proposal) } })
    const provider = createChatProvider({ endpoint: new URL('http://127.0.0.1:11434/api/chat'), model: 'local',
      style: 'format', temperature: 0.2, maxOutputTokens: 256, fetch: fetchImpl })
    expect(await provider.propose({ exactProviderRequest: exact })).toEqual(proposal)
    const body = sent[0]!.body as { format: WorldJsonObject; options: WorldJsonObject }
    expect(body.format.properties?.toString).toBeDefined()
    expect(body.options).toMatchObject({ temperature: 0.2, num_predict: 256 })
    expect(body).not.toHaveProperty('tools')
    // A local endpoint has no reasoning flag to state, and none is invented for it.
    expect(body).not.toHaveProperty('thinking')
    // The sampling defaults are the adapter's own, and a caller that states one gets it.
    const defaults = endpoint({ message: { content: JSON.stringify(proposal) } })
    await createChatProvider({ endpoint: new URL('http://127.0.0.1:11434/api/chat'), model: 'local',
      style: 'format', fetch: defaults.fetchImpl }).propose({ exactProviderRequest: exact })
    expect((defaults.sent[0]!.body as { options: WorldJsonObject }).options).toMatchObject({ temperature: 0.3 })
    const toolSampling = endpoint(toolAnswer(proposal))
    await createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm', temperature: 0.9,
      fetch: toolSampling.fetchImpl }).propose({ exactProviderRequest: exact })
    expect(toolSampling.sent[0]!.body.temperature).toBe(0.9)
    // A caller that wants reasoning instead states so, and the adapter does not decide for it.
    const reasoning = endpoint(toolAnswer(proposal))
    await createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      thinking: 'unspecified', fetch: reasoning.fetchImpl }).propose({ exactProviderRequest: exact })
    expect(reasoning.sent[0]!.body).not.toHaveProperty('thinking')
    // An endpoint that answered with no choices at all answered with no payload.
    const shapeless = endpoint({ choices: 'not an array' })
    await expect(createChatProvider({ endpoint: new URL('https://example.test/chat'), model: 'm',
      fetch: shapeless.fetchImpl }).propose({ exactProviderRequest: exact }))
      .rejects.toThrow('returned no payload')
  })
})
