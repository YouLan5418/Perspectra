import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { LocalJsonRpcRequest, LocalJsonRpcResponse, LocalJsonRpcRouter } from './rpc.ts'

export interface LocalCliExecutionOptions {
  readonly busyRetryTimeoutMs?: number
  readonly busyRetryDelayMs?: number
  readonly roundWaitTimeoutMs?: number
  readonly roundWaitDelayMs?: number
  readonly now?: () => number
  readonly wait?: (delayMs: number) => Promise<void>
}

function address(tenantId: string | undefined, worldId: string | undefined, branchId: string | undefined): WorldJsonObject {
  if (tenantId === undefined || worldId === undefined || branchId === undefined) throw new TypeError('branch command requires tenantId worldId branchId')
  return { tenantId, worldId, branchId }
}

/** Parse the stable local worldctl command grammar into the same in-process JSON-RPC contract. */
export function parseLocalCli(argv: readonly string[]): LocalJsonRpcRequest {
  const [group, operation, tenantId, worldId, branchId, ...rest] = argv
  if (group === 'health' && operation === undefined) return { jsonrpc: '2.0', id: 'cli', method: 'health.get', params: {} }
  if (group === 'metrics' && operation === undefined) return { jsonrpc: '2.0', id: 'cli', method: 'metrics.get', params: {} }
  if (group === 'round' && operation === 'get') {
    const [idempotencyKey] = rest
    if (idempotencyKey === undefined) throw new TypeError('round get requires idempotencyKey')
    return { jsonrpc: '2.0', id: 'cli', method: 'round.get', params: { address: address(tenantId, worldId, branchId), idempotencyKey } }
  }
  if (group === 'round' && operation === 'submit') {
    const [principalId, idempotencyKey, actionType, parametersJson] = rest
    if ([principalId, idempotencyKey, actionType, parametersJson].some(value => value === undefined)) {
      throw new TypeError('round submit requires principalId idempotencyKey actionType parametersJson')
    }
    const parameters = JSON.parse(parametersJson!) as WorldJsonObject
    return {
      jsonrpc: '2.0', id: 'cli', method: 'round.submit',
      params: {
        address: address(tenantId, worldId, branchId), principalId: principalId!, idempotencyKey: idempotencyKey!,
        action: { actionType: actionType!, parameters }, correlationId: 'cli:round-submit',
      },
    }
  }
  if (group === 'world' && operation === 'head') {
    return { jsonrpc: '2.0', id: 'cli', method: 'world.head', params: { address: address(tenantId, worldId, branchId) } }
  }
  if (group === 'view' && operation === 'character') {
    const [principalId, characterId, asOf] = rest
    if (principalId === undefined || characterId === undefined) throw new TypeError('view character requires principalId characterId')
    return {
      jsonrpc: '2.0', id: 'cli', method: 'view.character',
      params: {
        address: address(tenantId, worldId, branchId), principalId, characterId,
        ...(asOf === undefined ? {} : { asOfWorldSeq: Number(asOf) }),
      },
    }
  }
  if (group === 'outbox' && (operation === 'drain' || operation === 'list')) {
    return {
      jsonrpc: '2.0', id: 'cli', method: `outbox.${operation}`,
      params: {
        address: address(tenantId, worldId, branchId),
        ...(operation === 'drain' ? { correlationId: 'cli:outbox-drain' } : {}),
      },
    }
  }
  if (group === 'outbox' && operation === 'retry') {
    const [deliveryId] = rest
    if (deliveryId === undefined) throw new TypeError('outbox retry requires deliveryId')
    return {
      jsonrpc: '2.0', id: 'cli', method: 'outbox.retry',
      params: {
        address: address(tenantId, worldId, branchId), deliveryId, correlationId: 'cli:outbox-retry',
      },
    }
  }
  if (group === 'snapshot' && (operation === 'create' || operation === 'latest')) {
    const [snapshotPath] = rest
    if (snapshotPath === undefined) throw new TypeError(`snapshot ${operation} requires snapshotPath`)
    return {
      jsonrpc: '2.0', id: 'cli', method: `snapshot.${operation}`,
      params: {
        address: address(tenantId, worldId, branchId), snapshotPath,
        ...(operation === 'create' ? { correlationId: 'cli:snapshot-create' } : {}),
      },
    }
  }
  if (group === 'backup' && operation === 'create') {
    if (tenantId === undefined) throw new TypeError('backup create requires targetPath')
    return { jsonrpc: '2.0', id: 'cli', method: 'backup.create', params: { targetPath: tenantId, correlationId: 'cli:backup-create' } }
  }
  if (group === 'transfer' && (operation === 'export-portable' || operation === 'export-authority')) {
    if (tenantId === undefined) throw new TypeError(`transfer ${operation} requires targetPath`)
    const pathName = operation === 'export-portable' ? 'exportPath' : 'targetPath'
    return {
      jsonrpc: '2.0', id: 'cli', method: `transfer.${operation}`,
      params: { [pathName]: tenantId, correlationId: `cli:transfer-${operation}` },
    }
  }
  if (group !== 'branch' || operation === undefined) throw new TypeError('unknown worldctl command')
  const target = address(tenantId, worldId, branchId)
  if (operation === 'status') return { jsonrpc: '2.0', id: 'cli', method: 'branch.status', params: { address: target } }
  if (operation === 'audit') return { jsonrpc: '2.0', id: 'cli', method: 'audit.list', params: { address: target } }
  if (operation === 'drain' || operation === 'open' || operation === 'archive') {
    const reason = rest.join(' ').trim()
    if (reason.length === 0) throw new TypeError(`${operation} requires a reason`)
    return {
      jsonrpc: '2.0', id: 'cli', method: operation === 'archive' ? 'branch.archive-coordinated' : `branch.${operation}`,
      params: { address: target, reason, correlationId: `cli:${operation}` },
    }
  }
  throw new TypeError(`unknown branch operation ${operation}`)
}

export async function executeLocalCli(
  argv: readonly string[],
  router: LocalJsonRpcRouter,
  options: LocalCliExecutionOptions = {},
): Promise<string> {
  let request: LocalJsonRpcRequest
  try {
    request = parseLocalCli(argv.filter(value => value !== '--wait'))
  } catch (error: unknown) {
    return responseLine(router.invalidRequest('cli', error))
  }
  try {
    const timeoutMs = options.busyRetryTimeoutMs ?? 0
    const delayMs = options.busyRetryDelayMs ?? 100
    const roundWaitTimeoutMs = options.roundWaitTimeoutMs ?? 30_000
    const roundWaitDelayMs = options.roundWaitDelayMs ?? 25
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError('busyRetryTimeoutMs must be a non-negative safe integer')
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) throw new RangeError('busyRetryDelayMs must be a positive safe integer')
    if (!Number.isSafeInteger(roundWaitTimeoutMs) || roundWaitTimeoutMs < 0) throw new RangeError('roundWaitTimeoutMs must be a non-negative safe integer')
    if (!Number.isSafeInteger(roundWaitDelayMs) || roundWaitDelayMs <= 0) throw new RangeError('roundWaitDelayMs must be a positive safe integer')
    const now = options.now ?? Date.now
    const wait = options.wait ?? (delay => new Promise(resolve => setTimeout(resolve, delay)))
    const deadline = now() + timeoutMs
    let response: LocalJsonRpcResponse
    while (true) {
      response = await router.handle(request)
      if (!isWriterBusy(response) || now() >= deadline) break
      await wait(Math.min(delayMs, deadline - now()))
    }
    if (argv.includes('--wait') && request.method === 'round.submit' && response.error === undefined) {
      const result = response.result as WorldJsonObject
      const roundId = result.roundId
      if (typeof roundId !== 'string') throw new Error('round.submit response has no roundId')
      const waitDeadline = now() + roundWaitTimeoutMs
      while (true) {
        const polled = await router.handle({
          jsonrpc: '2.0', id: request.id, method: 'round.get',
          params: { address: request.params.address!, roundId },
        })
        if (polled.error !== undefined) {
          response = polled
          break
        }
        const polledResult = polled.result
        if (polledResult === null || polledResult === undefined) throw new Error('round.get returned no durable Round')
        const pollStatus = typeof polledResult === 'object' && !Array.isArray(polledResult)
          ? (polledResult as WorldJsonObject).status : undefined
        if (pollStatus !== 'queued' && pollStatus !== 'processing') {
          response = polled
          break
        }
        if (now() >= waitDeadline) throw new Error('round --wait timed out')
        await wait(Math.min(roundWaitDelayMs, waitDeadline - now()))
      }
    }
    return responseLine(response)
  } catch (error: unknown) {
    return responseLine(router.invalidRequest(request.id, error))
  }
}

function isWriterBusy(response: LocalJsonRpcResponse): boolean {
  return typeof response.error === 'object' && response.error !== null && !Array.isArray(response.error)
    && (response.error as WorldJsonObject).errorCode === 'WORLDSTORE_BUSY'
}

function responseLine(response: LocalJsonRpcResponse): string {
  return `${Buffer.from(canonicalizeWorldJson(response)).toString('utf8')}\n`
}
