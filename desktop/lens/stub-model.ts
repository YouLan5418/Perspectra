import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { WorldJsonObject } from '@harness-world/contracts'
import type { RuntimeRoleModels } from '../model-connections.ts'

/** The same shape a model's decision has: {decision:'abstain'}, publish or perform. */
export type StubDecision = WorldJsonObject

/** A local OpenAI-protocol endpoint that answers every character call with a scripted decision; no real model. */
export interface StubModel {
  readonly models: RuntimeRoleModels
  decide: (characterId: string, input: WorldJsonObject) => StubDecision
  close(): Promise<void>
}

/** One streamed chat completion whose text is the decision JSON. */
function stream(text: string): string {
  const base = { id: 'chatcmpl-lens', object: 'chat.completion.chunk', created: 0, model: 'lens-stub' }
  return (
    [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    ]
      .map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n')
      .join('') + 'data: [DONE]\n\n'
  )
}

function lastUserText(body: WorldJsonObject): string {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[]
  const content = messages.findLast(m => m.role === 'user')?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
}

export async function startStubModel(): Promise<StubModel> {
  let decide: StubModel['decide'] = () => ({ decision: 'abstain' })
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', chunk => {
      raw += String(chunk)
    })
    request.on('end', () => {
      try {
        const input = JSON.parse(lastUserText(JSON.parse(raw) as WorldJsonObject)) as WorldJsonObject
        const character = (input.context as WorldJsonObject | undefined)?.character as WorldJsonObject | undefined
        const decision = decide(String(character?.characterId ?? ''), input)
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.end(stream(JSON.stringify(decision)))
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('lens stub failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const target = {
    protocol: 'openai' as const,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`,
    model: 'lens-stub',
  }
  return {
    models: { default: { decision: target, memory: target }, characters: {} },
    get decide() {
      return decide
    },
    set decide(next) {
      decide = next
    },
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}
