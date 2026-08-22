import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { canonicalizeWorldJson } from '@harness-world/contracts'
import type { LocalJsonRpcRequest, LocalJsonRpcRouter } from './rpc.ts'

export type HeadlessRouter = Pick<LocalJsonRpcRouter, 'handle' | 'invalidRequest'>

/** Newline-delimited, local stdio JSON-RPC host loop. Notifications are outside this unit. */
export async function runHeadlessJsonRpc(input: Readable, output: Writable, router: HeadlessRouter): Promise<number> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  let handled = 0
  for await (const line of lines) {
    let response
    try {
      response = await router.handle(JSON.parse(line) as LocalJsonRpcRequest)
    } catch (error: unknown) {
      response = router.invalidRequest(null, error)
    }
    output.write(`${Buffer.from(canonicalizeWorldJson(response)).toString('utf8')}\n`)
    handled += 1
  }
  return handled
}
