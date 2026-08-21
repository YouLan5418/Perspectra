import {
  brandId,
  createErrorEnvelope,
  WorldError,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { BranchAdministration, WorldStore } from '@harness-world/store-sqlite'
import { WorldHealthService } from './health.ts'
import { OperationsMetrics } from './metrics.ts'

export interface LocalJsonRpcRequest extends WorldJsonObject {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly method: string
  readonly params: WorldJsonObject
}

export interface LocalJsonRpcResponse extends WorldJsonObject {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: WorldJsonValue
  readonly error?: WorldJsonValue
}

function stringParam(params: WorldJsonObject, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function addressParam(value: WorldJsonValue | undefined, name = 'address'): WorldAddress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  const objectValue = value as WorldJsonObject
  const keys = Object.keys(objectValue).sort()
  if (keys.join(',') !== 'branchId,tenantId,worldId') throw new TypeError(`${name} has invalid fields`)
  return {
    tenantId: brandId(stringParam(objectValue, 'tenantId'), 'TenantId'),
    worldId: brandId(stringParam(objectValue, 'worldId'), 'WorldId'),
    branchId: brandId(stringParam(objectValue, 'branchId'), 'BranchId'),
  }
}

/** In-process JSON-RPC 2.0 router. It intentionally owns no socket or remote listener. */
export class LocalJsonRpcRouter {
  readonly #store: WorldStore
  readonly #admin: BranchAdministration
  readonly #health: WorldHealthService
  readonly metrics = new OperationsMetrics()

  constructor(worldPath: string) {
    this.#store = new WorldStore(worldPath)
    this.#admin = new BranchAdministration(worldPath)
    this.#health = new WorldHealthService(worldPath)
  }

  async handle(request: LocalJsonRpcRequest): Promise<LocalJsonRpcResponse> {
    this.metrics.increment('rpc_requests')
    try {
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.method.length === 0
        || typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)) {
        throw new TypeError('invalid JSON-RPC request')
      }
      const result = await this.#dispatch(request.method, request.params)
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (error: unknown) {
      this.metrics.increment('rpc_errors')
      const envelope = error instanceof WorldError ? error.envelope : createErrorEnvelope({
        errorCode: 'INVALID_REQUEST', category: 'admin', message: String(error), retryable: false,
        correlationId: `rpc:${String(request.id)}`,
      })
      return { jsonrpc: '2.0', id: request.id, error: envelope as unknown as WorldJsonValue }
    }
  }

  close(): void {
    this.#admin.close()
    this.#store.close()
  }

  async #dispatch(method: string, params: WorldJsonObject): Promise<WorldJsonValue> {
    if (method === 'health.get') return this.#health.check()
    if (method === 'metrics.get') return this.metrics.snapshot()
    if (method === 'branch.status') return this.#admin.status(addressParam(params.address))
    if (method === 'branch.drain' || method === 'branch.open') {
      this.metrics.increment('branch_transitions')
      return this.#admin.setAdmission(
        addressParam(params.address), method === 'branch.drain' ? 'draining' : 'open',
        stringParam(params, 'reason'), stringParam(params, 'correlationId'),
      )
    }
    if (method === 'branch.archive') {
      this.metrics.increment('branch_transitions')
      return this.#admin.archive(addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'))
    }
    if (method === 'branch.fork') {
      const forkSeq = params.forkSeq
      if (typeof forkSeq !== 'number') throw new TypeError('forkSeq must be a number')
      this.#store.forkBranch(addressParam(params.parent, 'parent'), addressParam(params.child, 'child'), forkSeq)
      this.metrics.increment('branch_forks')
      return { status: 'forked', forkSeq }
    }
    if (method === 'audit.list') return this.#admin.readAudit(addressParam(params.address))
    throw new TypeError(`unknown local RPC method ${method}`)
  }
}
