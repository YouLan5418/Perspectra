import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http'
import type { ProviderProtocol } from '@harness-world/provider-chat'
import type { RuntimeRoleModels } from '../../desktop/model-connections.ts'

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
  /** OpenAI only: returned as `reasoning_content`. */
  readonly thinking?: string
  readonly stop?: 'length'
  readonly status?: number
  /** Text of a non-200 answer; defaults to a fixed refusal. */
  readonly body?: string
  /** OpenAI only: tool arguments sent verbatim instead of the JSON of `tool`. */
  readonly rawArguments?: string
  readonly plainJson?: boolean
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

function sse(events: readonly (readonly [string | undefined, unknown])[], done?: boolean): string {
  return (
    events.map(([event, data]) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`).join('') +
    (done ? 'data: [DONE]\n\n' : '')
  )
}
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
function writeSse(response: ServerResponse, body: string) {
  response.writeHead(200, SSE_HEADERS)
  response.end(body)
}

function openaiStream(answer: FakeAnswer): string {
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fixture' }
  const delta =
    answer.tool === undefined
      ? {
          role: 'assistant',
          content: answer.text ?? '',
          ...(answer.thinking === undefined ? {} : { reasoning_content: answer.thinking }),
        }
      : {
          role: 'assistant',
          content: answer.text ?? null,
          ...(answer.thinking === undefined ? {} : { reasoning_content: answer.thinking }),
          tool_calls: [
            {
              index: 0,
              id: 'call_fake',
              type: 'function',
              function: { name: 'submit_actions', arguments: answer.rawArguments ?? JSON.stringify(answer.tool) },
            },
          ],
        }
  const finish = answer.stop === 'length' ? 'length' : answer.tool === undefined ? 'stop' : 'tool_calls'
  return sse(
    [
      [undefined, { ...base, choices: [{ index: 0, delta, finish_reason: null }] }],
      [undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }],
      [undefined, { ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }],
    ],
    true,
  )
}

function anthropicStream(answer: FakeAnswer): string {
  const block =
    answer.tool === undefined
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: 'toolu_fake', name: 'submit_actions', input: {} }
  const delta =
    answer.tool === undefined
      ? { type: 'text_delta', text: answer.text ?? '' }
      : { type: 'input_json_delta', partial_json: JSON.stringify(answer.tool) }
  const stop = answer.stop === 'length' ? 'max_tokens' : answer.tool === undefined ? 'end_turn' : 'tool_use'
  return sse([
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

function googleStream(answer: FakeAnswer): string {
  const part =
    answer.tool === undefined
      ? { text: answer.text ?? '' }
      : { functionCall: { name: 'submit_actions', args: answer.tool } }
  return sse([
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
            response.end(result.body ?? 'fake provider refused: ' + result.status)
          } else if (result.plainJson) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ message: { content: JSON.stringify(result.tool ?? result.text ?? '') } }))
          } else
            writeSse(
              response,
              protocol === 'openai'
                ? openaiStream(result)
                : protocol === 'anthropic'
                  ? anthropicStream(result)
                  : googleStream(result),
            )
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

/**
 * Wraps an existing scenario server that answers in an older non-streaming shape (`{ message: { content } }` or
 * `{ choices: [{ message }] }`) so the same handler now answers as an OpenAI-compatible stream. Any other answer
 * - an error status, an empty body - passes through untouched.
 */
export function streamingChat(handler: RequestListener): RequestListener {
  return (request, response) => {
    const writeHead = response.writeHead.bind(response)
    const end = response.end.bind(response)
    let status = 200
    let head: unknown[] = []
    response.writeHead = ((code: number, ...rest: unknown[]) => {
      status = code
      head = rest
      return response
    }) as typeof response.writeHead
    response.end = ((chunk?: unknown, ...rest: unknown[]) => {
      response.writeHead = writeHead
      response.end = end
      const passThrough = () => {
        if (!response.headersSent) (writeHead as (...args: unknown[]) => void)(status, ...head)
        return (end as (...args: unknown[]) => ServerResponse)(chunk, ...rest)
      }
      if (status !== 200 || chunk === undefined || typeof chunk === 'function') return passThrough()
      let stream: string | undefined
      try {
        stream = streamFor(JSON.parse(String(chunk)))
      } catch {
        return passThrough()
      }
      if (stream === undefined) return passThrough()
      writeSse(response, stream)
      return response
    }) as typeof response.end
    handler(request, response)
  }
}

/** One keyless target used for every role. */
export function fakeModels(
  endpoint: string,
  protocol: ProviderProtocol = 'openai',
  model = 'fixture',
  apiKey?: string,
): RuntimeRoleModels {
  // pi-ai's Google adapter refuses keyless calls, so the Google fixture carries a dummy key.
  const key = apiKey ?? (protocol === 'google' ? 'fixture-key' : undefined)
  const target = {
    protocol,
    endpoint: endpoint.replace(/\/api\/chat$/, '/v1/chat/completions'),
    model,
    ...(key ? { apiKey: key } : {}),
  }
  return { default: { decision: target, memory: target }, characters: {} }
}

/** `node:http`'s createServer with {@link streamingChat} applied, for scenario tests written against the old shape. */
export function createChatServer(handler: RequestListener) {
  return createServer(streamingChat(handler))
}

/** The streamed answer for one older non-streaming body, or undefined when the body is not a model answer. */
function streamFor(body: unknown): string | undefined {
  const root = body as {
    message?: { content?: unknown }
    choices?: { message?: { content?: unknown; tool_calls?: { function: { arguments: string } }[] } }[]
    content?: { type: string; text?: string; input?: unknown }[]
    candidates?: { content?: { parts?: { text?: string; functionCall?: { args?: unknown } }[] } }[]
  } | null
  const message = root?.message ?? root?.choices?.[0]?.message
  if (message !== undefined) {
    const calls = (message as { tool_calls?: { function: { arguments: string } }[] }).tool_calls
    const thinking = (message as { reasoning_content?: unknown }).reasoning_content
    return openaiStream({
      ...(calls?.length ? { tool: JSON.parse(calls[0]!.function.arguments) } : { text: String(message.content ?? '') }),
      ...(typeof thinking === 'string' ? { thinking } : {}),
    })
  }
  if (Array.isArray(root?.content)) {
    const tool = root.content.find(block => block.type === 'tool_use')
    return anthropicStream(tool ? { tool: tool.input } : { text: root.content.map(block => block.text ?? '').join('') })
  }
  const parts = root?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    const call = parts.find(part => part.functionCall)
    return googleStream(
      call ? { tool: call.functionCall!.args } : { text: parts.map(part => part.text ?? '').join('') },
    )
  }
  return undefined
}

/** Wraps a stubbed fetch written against the old non-streaming bodies so its answers arrive as streams. */
export function streamingFetch(stub: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const response = await stub(input, init)
    if (!response.ok) return response
    let body: unknown
    try {
      body = JSON.parse(await response.clone().text())
    } catch {
      return response
    }
    const stream = streamFor(body)
    return stream === undefined ? response : new Response(stream, { status: 200, headers: SSE_HEADERS })
  }) as typeof globalThis.fetch
}
