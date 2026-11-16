import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The ports browsers and fetch refuse to connect to (WHATWG Fetch, "bad port"). */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

const ATTEMPTS = 32

function listenOnce(server: Server, host: string): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      fail(error)
    }
    const onListening = () => {
      server.off('error', onError)
      done((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

/**
 * Bind a page or service a browser or fetch must reach to any free port it can actually open. Machines
 * whose dynamic port range starts low hand these out, and the page would then refuse to load.
 */
export async function listenOnSafePort(server: Server, host = '127.0.0.1'): Promise<number> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const port = await listenOnce(server, host)
    if (!BLOCKED_PORTS.has(port)) return port
    await new Promise(done => server.close(done))
  }
  throw new Error(`连续 ${ATTEMPTS} 次分配到浏览器禁用的端口，请检查本机的动态端口范围。`)
}
