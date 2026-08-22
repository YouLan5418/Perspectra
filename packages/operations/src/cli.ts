import { canonicalizeWorldJson, type WorldJsonObject } from '@harness-world/contracts'
import type { LocalJsonRpcRequest, LocalJsonRpcRouter } from './rpc.ts'

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
    const [characterId, asOf] = rest
    if (characterId === undefined) throw new TypeError('view character requires characterId')
    return {
      jsonrpc: '2.0', id: 'cli', method: 'view.character',
      params: { address: address(tenantId, worldId, branchId), characterId, ...(asOf === undefined ? {} : { asOfWorldSeq: Number(asOf) }) },
    }
  }
  if (group === 'outbox' && operation === 'drain') {
    return {
      jsonrpc: '2.0', id: 'cli', method: 'outbox.drain',
      params: { address: address(tenantId, worldId, branchId), correlationId: 'cli:outbox-drain' },
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
      jsonrpc: '2.0', id: 'cli', method: `branch.${operation}`,
      params: { address: target, reason, correlationId: `cli:${operation}` },
    }
  }
  throw new TypeError(`unknown branch operation ${operation}`)
}

export async function executeLocalCli(argv: readonly string[], router: LocalJsonRpcRouter): Promise<string> {
  const response = await router.handle(parseLocalCli(argv))
  return `${Buffer.from(canonicalizeWorldJson(response)).toString('utf8')}\n`
}
