import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runHeadlessJsonRpc, type HeadlessRouter } from './headless.ts'

describe('runHeadlessJsonRpc', () => {
  it('serves multiple newline-delimited requests and keeps malformed input recoverable', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', chunk => { text += chunk.toString() })
    const router: HeadlessRouter = {
      handle: async request => ({ jsonrpc: '2.0', id: request.id, result: { method: request.method } }),
      invalidRequest: (id, error) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    }
    const running = runHeadlessJsonRpc(input, output, router)
    input.end('{"jsonrpc":"2.0","id":1,"method":"health.get","params":{}}\r\nnot-json\n')
    expect(await running).toBe(2)
    const responses = text.trim().split('\n').map(line => JSON.parse(line))
    expect(responses).toEqual([
      { id: 1, jsonrpc: '2.0', result: { method: 'health.get' } },
      { error: { message: expect.stringContaining('SyntaxError') }, id: null, jsonrpc: '2.0' },
    ])
  })
})
