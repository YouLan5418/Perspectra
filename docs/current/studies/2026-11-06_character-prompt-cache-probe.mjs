// Offline research fixture. No provider credentials or network requests are used.
// Run from the repository root: node --import tsx docs/current/studies/2026-11-06_character-prompt-cache-probe.mjs
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { piModel } from '../../../packages/provider-chat/src/pi-model.ts'
import { createChatProvider } from '../../../packages/provider-chat/src/provider.ts'
import { RequestInspector } from '../../../packages/provider-chat/src/request-inspector.ts'

const originalFetch = globalThis.fetch
let networkAttempts = 0
globalThis.fetch = async () => {
  networkAttempts++
  throw new Error('NETWORK_FORBIDDEN')
}
const apis = { openai: openAICompletionsApi, anthropic: anthropicMessagesApi, google: googleGenerativeAIApi }
const context = normalizeContext({
  messages: [
    { role: 'system', content: 'Stable character contract', timestamp: 0 },
    { role: 'user', content: 'Authorized history plus current stimulus', timestamp: 0 },
  ],
})
const cases = [
  ['openai-none', 'openai', 'https://api.openai.com/v1/chat/completions', 'gpt-4.1', 'none'],
  ['openai-short', 'openai', 'https://api.openai.com/v1/chat/completions', 'gpt-4.1', 'short'],
  ['gateway-short', 'openai', 'https://gateway.example/v1/chat/completions', 'fixture', 'short'],
  ['deepseek-chat-short', 'openai', 'https://api.deepseek.com/chat/completions', 'deepseek-flash', 'short'],
  ['claude-none', 'anthropic', 'https://api.anthropic.com/v1/messages', 'claude-sonnet-4-5', 'none'],
  ['claude-short', 'anthropic', 'https://api.anthropic.com/v1/messages', 'claude-sonnet-4-5', 'short'],
  ['deepseek-messages-short', 'anthropic', 'https://api.deepseek.com/anthropic/v1/messages', 'deepseek-flash', 'short'],
  ['google-short', 'google', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 'gemini-2.5-flash', 'short'],
]
function markerCount(value) {
  if (!value || typeof value !== 'object') return 0
  return Object.entries(value).reduce((count, [key, child]) => count + (key === 'cache_control' ? 1 : markerCount(child)), 0)
}

try {
  const requests = []
  for (const [name, protocol, endpoint, modelId, cacheRetention] of cases) {
    let captured
    const model = piModel({ protocol, endpoint: new URL(endpoint), model: modelId })
    const result = await apis[protocol]().streamSimple(model, context, {
      apiKey: 'offline-fixture',
      maxRetries: 0,
      cacheRetention,
      sessionId: 'game7_roleA',
      metadata: { user_id: 'game7_roleA' },
      onPayload(payload) {
        captured = JSON.parse(JSON.stringify(payload))
        // Stop before the SDK can send any HTTP request. The resulting error is intentional.
        throw new Error('CAPTURE_ONLY')
      },
    }).result()
    if (!captured || result.stopReason !== 'error') throw new Error('Offline payload capture failed: ' + name)
    requests.push({
      name,
      cacheKey: captured.prompt_cache_key ?? null,
      userId: captured.user_id ?? captured.metadata?.user_id ?? null,
      cacheMarkers: markerCount(captured),
      googleCachedContent: captured.config?.cachedContent ?? null,
    })
  }

  const upstreamUsage = {
    prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020,
    prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
  }
  const base = { id: 'offline', object: 'chat.completion.chunk', created: 0, model: 'fixture' }
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '{"decision":"abstain"}' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: upstreamUsage },
  ]
  const inspector = new RequestInspector()
  inspector.configure(true)
  let observation
  const provider = createChatProvider({
    endpoint: new URL('https://offline.example/v1/chat/completions'), model: 'fixture', inspector,
    onCall(value) { observation = value },
    fetch: async () => new Response(
      chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + String.fromCharCode(10, 10)).join('') + 'data: [DONE]' + String.fromCharCode(10, 10),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  })
  await provider.decide({
    messages: [{ role: 'system', content: 'Fixture contract' }, { role: 'user', content: 'Fixture authorized context' }],
    schema: { type: 'object' }, description: 'Fixture',
    inspection: { characterId: 'a', continuation: false, sources: [] },
  }, new AbortController().signal)
  if (networkAttempts !== 0) throw new Error('Unexpected network attempt')
  console.log(JSON.stringify({
    requests,
    usage: { upstream: upstreamUsage, inspector: inspector.snapshot().requests[0]?.usage, callback: observation?.usage ?? null },
    networkAttempts,
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
