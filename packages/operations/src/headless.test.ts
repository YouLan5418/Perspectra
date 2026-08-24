import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
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

  it('serializes ephemeral notifications on the same stdout stream', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    let listener: ((notification: {
      jsonrpc: '2.0'
      method: 'health.changed'
      params: { healthHash: string }
    }) => void) | undefined
    let unsubscribed = false
    output.on('data', chunk => { text += chunk.toString() })
    const router: HeadlessRouter = {
      subscribeNotifications(callback) {
        listener = callback as typeof listener
        return () => { unsubscribed = true }
      },
      async handle(request) {
        listener?.({ jsonrpc: '2.0', method: 'health.changed', params: { healthHash: 'sha256:fixture' } })
        return { jsonrpc: '2.0', id: request.id, result: { ok: true } }
      },
      invalidRequest: (id, error) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    }
    const running = runHeadlessJsonRpc(input, output, router)
    input.end('{"jsonrpc":"2.0","id":1,"method":"health.get","params":{}}\n')
    expect(await running).toBe(1)
    expect(text.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', method: 'health.changed', params: { healthHash: 'sha256:fixture' } },
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
    ])
    expect(unsubscribed).toBe(true)
  })

  it('honors output backpressure and stops cleanly when aborted', async () => {
    let text = ''
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        text += chunk.toString()
        setImmediate(callback)
      },
    })
    const input = new PassThrough()
    const controller = new AbortController()
    const router: HeadlessRouter = {
      handle: async request => ({ jsonrpc: '2.0', id: request.id, result: { ok: true } }),
      invalidRequest: (id, error) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    }
    const running = runHeadlessJsonRpc(input, output, router, { signal: controller.signal })
    input.write('{"jsonrpc":"2.0","id":1,"method":"health.get","params":{}}\n')
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    expect(await running).toBe(1)
    expect(text).toContain('"ok":true')

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    expect(await runHeadlessJsonRpc(new PassThrough(), new PassThrough(), router, { signal: alreadyAborted.signal })).toBe(0)
  })

  it('fails the host loop on asynchronous or synchronous stdout failure', async () => {
    const router: HeadlessRouter = {
      handle: async request => ({ jsonrpc: '2.0', id: request.id, result: null }),
      invalidRequest: (id, error) => ({ jsonrpc: '2.0', id, error: { message: String(error) } }),
    }
    const asynchronousInput = new PassThrough()
    const asynchronousOutput = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('EPIPE async')) },
    })
    const asynchronous = runHeadlessJsonRpc(asynchronousInput, asynchronousOutput, router)
    asynchronousInput.end('{"jsonrpc":"2.0","id":1,"method":"health.get","params":{}}\n')
    await expect(asynchronous).rejects.toThrow('EPIPE async')

    const synchronousInput = new PassThrough()
    const synchronousOutput = new PassThrough()
    vi.spyOn(synchronousOutput, 'write').mockImplementation(() => { throw new Error('EPIPE sync') })
    const synchronous = runHeadlessJsonRpc(synchronousInput, synchronousOutput, router)
    synchronousInput.end('{"jsonrpc":"2.0","id":2,"method":"health.get","params":{}}\n')
    await expect(synchronous).rejects.toThrow('EPIPE sync')

    const notificationOutput = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('EPIPE notification')) },
    })
    const notificationRouter: HeadlessRouter = {
      subscribeNotifications(listener) {
        listener({ jsonrpc: '2.0', method: 'health.changed', params: {} })
        return () => undefined
      },
      handle: router.handle,
      invalidRequest: router.invalidRequest,
    }
    await expect(runHeadlessJsonRpc(new PassThrough(), notificationOutput, notificationRouter))
      .rejects.toThrow('EPIPE notification')
  })
})
