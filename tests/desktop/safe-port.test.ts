import { EventEmitter, once } from 'node:events'
import { createServer, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { BLOCKED_PORTS, listenOnSafePort } from '../../desktop/safe-port.ts'
import { avoidBlockedPorts } from '../support/avoid-blocked-ports.ts'

const open: Server[] = []
afterEach(async () => {
  for (const server of open.splice(0)) await new Promise(done => server.close(done))
})

/** A server whose operating system hands out the given ports in turn. */
function serverOffering(...ports: number[]) {
  const server = new EventEmitter() as EventEmitter & {
    closed: number
    listen: unknown
    close: unknown
    address: unknown
  }
  server.closed = 0
  let current = 0
  server.listen = () => {
    current = ports.shift()!
    queueMicrotask(() => server.emit('listening'))
  }
  server.close = (done: () => void) => {
    server.closed++
    queueMicrotask(done)
  }
  server.address = () => ({ port: current })
  return server
}

it('lists only ports fetch really refuses, and refuses them without connecting', async () => {
  for (const port of [...BLOCKED_PORTS]) {
    const failure = await fetch(`http://127.0.0.1:${port}/`).catch((error: Error) => error.cause as Error)
    expect((failure as Error).message, String(port)).toBe('bad port')
  }
})

it('keeps a port browsers can open', async () => {
  const server = serverOffering(8123)
  await expect(listenOnSafePort(server as never)).resolves.toBe(8123)
  expect(server.closed).toBe(0)
})

it('gives back a blocked port and takes another', async () => {
  const server = serverOffering(6666, 10080, 8124)
  await expect(listenOnSafePort(server as never)).resolves.toBe(8124)
  expect(server.closed).toBe(2)
})

it('fails rather than serve on a port the player could not open', async () => {
  const server = serverOffering(...Array.from({ length: 64 }, () => 6666))
  await expect(listenOnSafePort(server as never)).rejects.toThrow('端口')
})

it('reports a listen failure', async () => {
  const server = serverOffering(8125)
  server.listen = () => queueMicrotask(() => server.emit('error', new Error('no permission')))
  await expect(listenOnSafePort(server as never)).rejects.toThrow('no permission')
})

it('binds a real server', async () => {
  const server = createServer()
  open.push(server)
  const port = await listenOnSafePort(server)
  expect((server.address() as AddressInfo).port).toBe(port)
  expect(BLOCKED_PORTS.has(port)).toBe(false)
})

it('moves a test server off a blocked port without its listeners noticing', async () => {
  class Retrying extends Server {}
  const seen: number[] = []
  avoidBlockedPorts(Retrying.prototype, port => {
    seen.push(port)
    return seen.length === 1
  })
  for (const listen of [
    (server: Server, done: () => void) => server.listen(0, '127.0.0.1', done),
    (server: Server, done: () => void) => server.listen({ port: 0, host: '127.0.0.1' }, done),
  ]) {
    seen.length = 0
    const server = new Retrying()
    open.push(server)
    let listened = 0,
      closed = 0
    server.on('close', () => closed++)
    server.on('listening', () => listened++)
    await new Promise<void>(done => listen(server, done))
    expect(listened).toBe(1)
    expect(closed).toBe(0)
    expect(seen).toHaveLength(2)
    expect((server.address() as AddressInfo).port).toBe(seen[1])
  }
})

it('works for callers that wait on the listening event', async () => {
  class Retrying extends Server {}
  let first = true
  avoidBlockedPorts(Retrying.prototype, () => {
    const blocked = first
    first = false
    return blocked
  })
  const server = new Retrying()
  open.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  expect(first).toBe(false)
  expect((server.address() as AddressInfo).port).toBeGreaterThan(0)
})
