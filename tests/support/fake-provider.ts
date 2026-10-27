import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ProviderProtocol } from '@harness-world/provider-chat'

/** What the fake endpoint was asked. `userText` is the last user turn's plain text, whatever shape the protocol uses. */
export interface FakeProviderCall {
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
  readonly userText: string
}
export interface FakeAnswer {
  readonly tool?: unknown
  readonly text?: string
  readonly stop?: 'length'
  readonly status?: number
  readonly plainJson?: boolean
}

interface RuntimeModel {
  readonly protocol: ProviderProtocol
  readonly endpoint: string
  readonly model: string
}
interface RuntimeRoleModels {
  readonly default: { readonly decision: RuntimeModel; readonly memory: RuntimeModel }
  readonly characters: Readonly<Record<string, { readonly decision: RuntimeModel; readonly memory: RuntimeModel }>>
}

const PATHS = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
  google: '/v1beta/models/fixture:generateContent',
} as const

function plain(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
}

function userText(protocol: ProviderProtocol, body: Record<string, unknown>): string {
  if (protocol === 'google') {
    const contents = (body.contents ?? []) as { role?: string; parts?: unknown }[]
    return plain(contents.findLast(c => c.role !== 'model')?.parts)
  }
  const messages = (body.messages ?? []) as { role: string; content: unknown }[]
  return plain(messages.findLast(m => m.role === 'user')?.content)
}

function sse(response: ServerResponse, events: readonly (readonly [string | undefined, unknown])[], done?: boolean) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [event, data] of events)
    response.write((event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`)
  if (done) response.write('data: [DONE]\n\n')
  response.end()
}

function openaiAnswer(response: ServerResponse, answer: FakeAnswer) {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fixture' }
  const delta =
    answer.tool === undefined
      ? { role: 'assistant', content: answer.text ?? '' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_fake',
              type: 'function',
              function: { name: 'submit_actions', arguments: JSON.stringify(answer.tool) },
            },
          ],
        }
  const finish = answer.stop === 'length' ? 'length' : answer.tool === undefined ? 'stop' : 'tool_calls'
  sse(
    response,
    [
      [undefined, { ...base, choices: [{ index: 0, delta, finish_reason: null }] }],
      [undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }],
      [undefined, { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }],
    ],
    true,
  )
}

function anthropicAnswer(response: ServerResponse, answer: FakeAnswer) {
  const block =
    answer.tool === undefined
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: 'toolu_fake', name: 'submit_actions', input: {} }
  const delta =
    answer.tool === undefined
      ? { type: 'text_delta', text: answer.text ?? '' }
      : { type: 'input_json_delta', partial_json: JSON.stringify(answer.tool) }
  const stop = answer.stop === 'length' ? 'max_tokens' : answer.tool === undefined ? 'end_turn' : 'tool_use'
  sse(response, [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'fixture',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

function googleAnswer(response: ServerResponse, answer: FakeAnswer) {
  const part =
    answer.tool === undefined
      ? { text: answer.text ?? '' }
      : { functionCall: { name: 'submit_actions', args: answer.tool } }
  sse(response, [
    [
      undefined,
      {
        candidates: [
          { content: { role: 'model', parts: [part] }, finishReason: answer.stop === 'length' ? 'MAX_TOKENS' : 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
      },
    ],
  ])
}

/** A local endpoint that speaks each protocol's streaming wire format and records what it was asked. */
export async function startFakeProvider(
  protocol: ProviderProtocol,
  answer: (call: FakeProviderCall) => FakeAnswer | Promise<FakeAnswer>,
): Promise<{ endpoint: string; calls: FakeProviderCall[]; close(): Promise<void> }> {
  const calls: FakeProviderCall[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', chunk => {
      raw += String(chunk)
    })
    request.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(raw || '{}') as Record<string, unknown>
          const call: FakeProviderCall = {
            path: request.url ?? '',
            headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])),
            body,
            userText: userText(protocol, body),
          }
          calls.push(call)
          const result = await answer(call)
          if (response.destroyed) return
          if (result.status !== undefined && result.status !== 200) {
            response.writeHead(result.status, { 'content-type': 'text/plain' })
            response.end('fake provider refused: ' + result.status)
          } else if (result.plainJson) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ message: { content: JSON.stringify(result.tool ?? result.text ?? '') } }))
          } else if (protocol === 'openai') openaiAnswer(response, result)
          else if (protocol === 'anthropic') anthropicAnswer(response, result)
          else googleAnswer(response, result)
        } catch {
          if (!response.destroyed) {
            response.writeHead(503)
            response.end('fixture failed')
          }
        }
      })()
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  return {
    endpoint: `http://127.0.0.1:${port}${PATHS[protocol]}`,
    calls,
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

/** One keyless `fixture` target used for every role. */
export function fakeModels(endpoint: string, protocol: ProviderProtocol = 'openai'): RuntimeRoleModels {
  const target = { protocol, endpoint, model: 'fixture' }
  return { default: { decision: target, memory: target }, characters: {} }
}
