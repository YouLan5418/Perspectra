import { afterEach, expect, it, vi } from 'vitest'
import { createChatProvider } from './provider.ts'
import { prototypeTurnCall } from './prototype-turn.ts'
import { nativePayload, providerEndpoint, providerProtocol } from './protocol.ts'
import { RequestInspector } from './request-inspector.ts'
const call = { ...prototypeTurnCall({context:{},continuation:false}),
  inspection:{characterId:'npc:a',continuation:false,sources:[{source:'core',name:'契约'},{source:'context',name:'授权上下文'}]} }
afterEach(() => vi.unstubAllGlobals())
for (const protocol of ['anthropic','google'] as const) {
  it(`${protocol}: carries the real decision schema, credentials only in headers and authorized message sources`, async () => {
    const inspector = new RequestInspector(); inspector.configure(true)
    const response = protocol === 'anthropic'
      ? {content:[{type:'thinking',thinking:'private reasoning'},{type:'tool_use',name:'submit_actions',input:{decision:'abstain'}}],usage:{input_tokens:12,output_tokens:5}}
      : {candidates:[{content:{parts:[{thought:true,text:'private reasoning'},{functionCall:{name:'submit_actions',args:{decision:'abstain'}}}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:5,totalTokenCount:17}}
    const post = vi.fn(async () => new Response(JSON.stringify(response)))
    const provider = createChatProvider({protocol,endpoint:new URL(protocol==='google'?'https://vendor.test/v1beta/models/old:generateContent':'https://vendor.test/v1/messages'),model:'chosen',apiKey:'secret',inspector,fetch:post})
    expect(await provider.decide(call,AbortSignal.timeout(1000))).toEqual({decision:'abstain'})
    const [url, init] = post.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject(protocol==='anthropic'?{'x-api-key':'secret','anthropic-version':'2023-06-01'}:{'x-goog-api-key':'secret'})
    const body=JSON.parse(String(init.body))
    expect(JSON.stringify(body)).not.toContain('secret')
    if(protocol==='anthropic') {
      expect(body.tools[0].input_schema).toEqual(call.schema)
      expect(body.messages).toEqual([call.messages[1]])
      expect(body.system).toContain(call.messages[0]!.content)
      expect(body).not.toHaveProperty('thinking')
      expect(body).not.toHaveProperty('temperature')
    } else {
      expect(url.pathname).toBe('/v1beta/models/chosen:generateContent')
      expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(call.schema)
      expect(body.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['submit_actions'])
      expect(body.contents[0].parts[0].text).toBe(call.messages[1]!.content)
    }
    const inspected=inspector.snapshot().requests[0]!
    expect(inspected.model).toBe('chosen')
    expect(inspected.messages[1]!.source.source).toBe('context')
    expect(inspected.usage).toMatchObject({inputTokens:12,outputTokens:5})
    expect(JSON.stringify(inspected)).not.toContain('private reasoning')
    expect(JSON.stringify(inspected)).not.toContain('secret')
  })
  it(`${protocol}: cancellation, HTTP failures and unsupported prefill cannot produce a decision`, async () => {
    const post=vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return new Response('{}',{status:429})
    }) as typeof fetch
    const provider=createChatProvider({protocol,endpoint:new URL(protocol==='google'?'https://vendor.test/models/m:generateContent':'https://vendor.test/messages'),model:'m',fetch:post})
    await expect(provider.decide(call,AbortSignal.abort())).rejects.toThrow()
    await expect(provider.decide(call,AbortSignal.timeout(1000))).rejects.toThrow('HTTP 429')
    await expect(provider.decide({...call,messages:[...call.messages,{role:'assistant',content:'prefill'}]},AbortSignal.timeout(1000))).rejects.toThrow('assistant')
  })
}
it('keeps malformed decision content for Host validation and rejects ambiguous or truncated envelopes', () => {
  expect(nativePayload({content:[{type:'text',text:'not JSON'}]},'anthropic')).toBe('not JSON')
  expect(nativePayload({candidates:[{content:{parts:[{text:'{"decision":"invented"}'}]}}]},'google')).toEqual({decision:'invented'})
  for(const protocol of ['anthropic','google'] as const) {
    expect(()=>nativePayload({},protocol)).toThrow()
    const call=protocol==='anthropic'?{type:'tool_use',name:'other',input:{}}:{functionCall:{name:'other',args:{}}}
    const envelope=protocol==='anthropic'?{content:[call]}:{candidates:[{content:{parts:[call]}}]}
    expect(()=>nativePayload(envelope,protocol,'submit_actions')).toThrow('指定工具')
    const multiple=protocol==='anthropic'?{content:[call,call]}:{candidates:[{content:{parts:[call,call]}}]}
    expect(()=>nativePayload(multiple,protocol)).toThrow()
  }
  expect(()=>nativePayload({stop_reason:'max_tokens',content:[{type:'text',text:'{}'}]},'anthropic')).toThrow('token')
  expect(()=>nativePayload({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{}'}]}}]},'google')).toThrow('token')
})
it('validates protocol and does not silently discard unsupported Anthropic penalties', async () => {
  expect(providerProtocol(undefined)).toBe('openai')
  expect(()=>providerProtocol('invalid')).toThrow()
  expect(()=>providerEndpoint(new URL('https://vendor.test/chat'),'google','m')).toThrow()
  const post=vi.fn()
  const provider=createChatProvider({protocol:'anthropic',model:'m',endpoint:new URL('https://vendor.test/messages'),preset:{frequencyPenalty:1},fetch:post})
  await expect(provider.decide(call,AbortSignal.timeout(1000))).rejects.toThrow('frequencyPenalty')
  expect(post).not.toHaveBeenCalled()
})
