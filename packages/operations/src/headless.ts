import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { canonicalizeWorldJson } from '@harness-world/contracts'
import type { LocalJsonRpcNotification, LocalJsonRpcRequest, LocalJsonRpcRouter } from './rpc.ts'

export type HeadlessRouter = Pick<LocalJsonRpcRouter, 'handle' | 'invalidRequest'> & Partial<Pick<LocalJsonRpcRouter, 'subscribeNotifications'>>

export interface HeadlessOptions {
  readonly signal?: AbortSignal
}

function writeResponse(output: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      output.off('error', onError)
      output.off('drain', onDrain)
    }
    output.once('error', onError)
    try {
      if (output.write(text)) {
        cleanup()
        resolve()
      } else {
        output.once('drain', onDrain)
      }
    } catch (error: unknown) {
      cleanup()
      reject(error)
    }
  })
}

/** Newline-delimited, local stdio JSON-RPC host loop. Notifications are outside this unit. */
export async function runHeadlessJsonRpc(
  input: Readable,
  output: Writable,
  router: HeadlessRouter,
  options: HeadlessOptions = {},
): Promise<number> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  let writeTail: Promise<void> = Promise.resolve()
  let writeFailure: unknown
  const enqueue = (value: LocalJsonRpcNotification | Awaited<ReturnType<HeadlessRouter['handle']>>) => {
    const text = `${Buffer.from(canonicalizeWorldJson(value)).toString('utf8')}\n`
    writeTail = writeTail.then(() => writeResponse(output, text)).catch((error: unknown) => {
      writeFailure = error
      lines.close()
    })
  }
  const unsubscribe = router.subscribeNotifications?.(notification => { enqueue(notification) })
  const abort = () => {
    lines.close()
    input.destroy()
  }
  if (options.signal?.aborted) {
    abort()
    return 0
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  let handled = 0
  try {
    for await (const line of lines) {
      let response
      try {
        response = await router.handle(JSON.parse(line) as LocalJsonRpcRequest)
      } catch (error: unknown) {
        response = router.invalidRequest(null, error)
      }
      enqueue(response)
      await writeTail
      if (writeFailure !== undefined) throw writeFailure
      handled += 1
    }
  } finally {
    unsubscribe?.()
    await writeTail
    options.signal?.removeEventListener('abort', abort)
    lines.close()
  }
  if (writeFailure !== undefined) throw writeFailure
  return handled
}
