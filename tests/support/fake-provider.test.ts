import type { Api, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { piModel } from '@harness-world/provider-chat'
import { describe, expect, it } from 'vitest'
import { startFakeProvider } from './fake-provider.ts'

const apis: Record<'openai' | 'anthropic' | 'google', () => ProviderStreams> = {
  openai: openAICompletionsApi,
  anthropic: anthropicMessagesApi,
  google: googleGenerativeAIApi,
}

describe('the streaming fake provider', () => {
  for (const protocol of ['openai', 'anthropic', 'google'] as const) {
    it(`${protocol}: pi-ai reads its tool call and the fake reads the user text`, async () => {
      const server = await startFakeProvider(protocol, () => ({ tool: { decision: 'abstain' } }))
      try {
        const model: Model<Api> = piModel({ protocol, endpoint: new URL(server.endpoint), model: 'fixture' })
        const context = normalizeContext({
          systemPrompt: 'portray one character',
          messages: [{ role: 'user', content: 'hello there', timestamp: 0 }],
          tools: [
            {
              name: 'submit_actions',
              description: 'decide',
              parameters: { type: 'object', properties: { decision: { type: 'string' } } } as never,
            },
          ],
        })
        const message = await apis[protocol]().streamSimple(model, context, { apiKey: 'k', maxRetries: 0 }).result()
        expect(message.stopReason).toBe('toolUse')
        const call = message.content.find(block => block.type === 'toolCall')
        expect(call?.type === 'toolCall' ? call.arguments : undefined).toEqual({ decision: 'abstain' })
        expect(server.calls[0]!.userText).toBe('hello there')
      } finally {
        await server.close()
      }
    })
  }
})
