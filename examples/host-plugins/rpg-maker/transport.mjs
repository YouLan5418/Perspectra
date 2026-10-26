import { createServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'

/** Connection skeleton only. Remote results are not committed Perspectra facts. */
export async function createRpgMakerBridge({ port = 0, token, timeoutMs = 5000 }) {
  if (!/^[a-f0-9]{64}$/i.test(token ?? '') || !Number.isInteger(port) || port < 0 || port > 65535 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30000)
    throw new TypeError('RPG Maker bridge requires a loopback port, a 32-byte hex token and a bounded timeout')
  const pending = new Map(), sockets = new Set()
  let peer, counter = 0, closed = false, requester, decision
  const cancelDecision = (notify = false) => {
    if (notify && decision && peer === decision.socket)
      peer.write(JSON.stringify({ type: 'character-result', id: decision.id, ok: false, error: 'CHARACTER_UNAVAILABLE' }) + '\n')
    decision?.controller.abort(); decision = undefined
  }
  const rejectPending = () => {
    for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('RPG Maker connection closed; inspect the game before retrying a command')) }
    pending.clear()
  }
  const server = createServer(socket => {
    if (closed || peer) { socket.destroy(); return }
    sockets.add(socket)
    let buffer = '', authenticated = false
    socket.setEncoding('utf8')
    const handshake = setTimeout(() => socket.destroy(), timeoutMs)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(handshake); sockets.delete(socket)
      if (peer === socket) { peer = undefined; rejectPending(); cancelDecision() }
    })
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 65536) { socket.destroy(); return }
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { socket.destroy(); return }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return }
        if (!authenticated) {
          if (peer || message.type !== 'hello' || message.engine !== 'RPG Maker MZ' || typeof message.token !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(message.token) || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))) {
            socket.destroy(); return
          }
          authenticated = true; peer = socket; clearTimeout(handshake)
          socket.write('{"type":"ready"}\n'); continue
        }
        if (message.type === 'request-character') {
          if (!Number.isSafeInteger(message.id) || message.id < 1 || !Number.isSafeInteger(message.actorId) || message.actorId < 1) { socket.destroy(); return }
          if (!requester || decision) {
            socket.write(JSON.stringify({ type: 'character-result', id: message.id, ok: false, error: 'CHARACTER_UNAVAILABLE' }) + '\n'); continue
          }
          const work = { controller: new AbortController(), socket, id: message.id }, bound = requester
          decision = work
          void Promise.resolve().then(() => bound(message.actorId, work.controller.signal)).then(result => {
            if (decision === work && peer === socket && !work.controller.signal.aborted)
              socket.write(JSON.stringify({ type: 'character-result', id: message.id, ok: true, result }) + '\n')
          }, () => {
            if (decision === work && peer === socket && !work.controller.signal.aborted)
              socket.write(JSON.stringify({ type: 'character-result', id: message.id, ok: false, error: 'CHARACTER_REQUEST_FAILED' }) + '\n')
          }).finally(() => { if (decision === work) decision = undefined })
          continue
        }
        const work = pending.get(message.id)
        if (!work || typeof message.ok !== 'boolean') { socket.destroy(); return }
        pending.delete(message.id); clearTimeout(work.timer)
        if (message.ok) work.resolve(message.result)
        else work.reject(new Error('RPG Maker rejected the request: ' + (typeof message.error === 'string' && /^[A-Z_]{1,60}$/.test(message.error) ? message.error : 'INVALID_RESPONSE')))
      }
    })
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); done() })
  })
  const request = (method, params) => {
    if (closed || !peer) return Promise.reject(new Error('RPG Maker is not connected'))
    if (pending.size >= 16) return Promise.reject(new Error('RPG Maker bridge request limit reached'))
    const socket = peer, id = ++counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (peer === socket) peer = undefined
        socket.destroy()
        rejectPending()
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  return {
    port: server.address().port,
    get connected() { return !!peer && !closed },
    observe: actorId => request('observe', { actorId }),
    queueCommonEvent: (actorId, eventId) => request('common-event', { actorId, eventId }),
    bindCharacterRequester: callback => {
      if (closed || requester) throw new Error('RPG Maker is already bound to a world')
      requester = callback
      return () => { if (requester === callback) { requester = undefined; cancelDecision(true) } }
    },
    close: async () => {
      if (closed) return
      closed = true
      requester = undefined; cancelDecision()
      for (const socket of sockets) socket.destroy()
      rejectPending()
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
    },
  }
}
