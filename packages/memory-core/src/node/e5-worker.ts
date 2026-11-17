/** Experimental encoder worker; no model credentials, archives or authority are loaded here. */
import { parentPort, workerData } from 'node:worker_threads'
import { NodeE5 } from './e5.ts'
if (!parentPort) throw new Error('E5 worker requires a parent')
const port = parentPort
let encoder: NodeE5 | undefined
let busy = false
port.on('message', async (request: { texts: string[]; query: boolean }) => {
  if (busy) {
    port.postMessage({ error: 'E5 worker is busy' })
    return
  }
  busy = true
  try {
    if (
      !Array.isArray(request.texts) ||
      !request.texts.every(t => typeof t === 'string') ||
      typeof request.query !== 'boolean'
    )
      throw new Error('Invalid E5 input')
    encoder ??= await NodeE5.open(workerData.directory)
    port.postMessage({
      result: {
        tokens: request.texts.map(t => encoder!.tokens(t, request.query)),
        vectors: await encoder.encode(request.texts, request.query),
      },
    })
  } catch {
    port.postMessage({ error: 'Local E5 request failed; verify frozen assets and native runtime' })
  } finally {
    busy = false
  }
})
