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
