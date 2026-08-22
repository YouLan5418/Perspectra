import {
  brandId,
  canonicalizeWorldJson,
  createErrorEnvelope,
  WorldError,
  type WorldAddress,
  type CharacterId,
  type SessionId,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { BranchAdministration, WorldStore } from '@harness-world/store-sqlite'
import { WorldHealthService } from './health.ts'
import { OperationsMetrics } from './metrics.ts'

export interface WorldApplicationPort {
  activateSpec(input: WorldJsonValue): unknown
  submit(address: WorldAddress, request: {
    readonly idempotencyKey: string
    readonly principalId: string
    readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
    readonly correlationId: string
  }): Promise<unknown>
  roundResult(address: WorldAddress, idempotencyKey: string): Promise<unknown | undefined>
  head(address: WorldAddress): Promise<unknown>
  characterView(address: WorldAddress, characterId: CharacterId, asOfWorldSeq?: number): Promise<unknown>
  deliver(address: WorldAddress, correlationId: string): Promise<number>
  renderSession(address: WorldAddress, sessionId: SessionId, sessionEventSeq: number, options?: { readonly locale?: 'en' | 'zh-CN' }): Promise<unknown>
  forkAtHead(parent: WorldAddress, child: WorldAddress, reason: string, correlationId: string): Promise<unknown>
  archive(address: WorldAddress, reason: string, correlationId: string): Promise<unknown>
  close(): Promise<void>
}

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

function integerParam(params: WorldJsonObject, name: string, optional = false): number | undefined {
  const value = params[name]
  if (optional && value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value as number
}

function objectParam(params: WorldJsonObject, name: string): WorldJsonObject {
  const value = params[name]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as WorldJsonObject
}

function worldResult(value: unknown): WorldJsonValue {
  canonicalizeWorldJson(value as WorldJsonValue)
  return value as WorldJsonValue
}

/** In-process JSON-RPC 2.0 router. It intentionally owns no socket or remote listener. */
export class LocalJsonRpcRouter {
  readonly #store: WorldStore
  readonly #admin: BranchAdministration
  readonly #health: WorldHealthService
  readonly metrics = new OperationsMetrics()

  constructor(worldPath: string, private readonly application?: WorldApplicationPort) {
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
    if (method === 'world.activate') return worldResult(this.#application().activateSpec(params.spec as WorldJsonValue))
    if (method === 'round.submit') {
      const action = objectParam(params, 'action')
      const actionKeys = Object.keys(action).sort()
      if (actionKeys.join(',') !== 'actionType,parameters') throw new TypeError('action has invalid fields')
      return worldResult(await this.#application().submit(addressParam(params.address), {
        idempotencyKey: stringParam(params, 'idempotencyKey'),
        principalId: stringParam(params, 'principalId'),
        action: { actionType: stringParam(action, 'actionType'), parameters: action.parameters! },
        correlationId: stringParam(params, 'correlationId'),
      }))
    }
    if (method === 'round.get') {
      const result = await this.#application().roundResult(addressParam(params.address), stringParam(params, 'idempotencyKey'))
      return result === undefined ? null : worldResult(result)
    }
    if (method === 'world.head') return worldResult(await this.#application().head(addressParam(params.address)))
    if (method === 'view.character') {
      return worldResult(await this.#application().characterView(
        addressParam(params.address),
        brandId(stringParam(params, 'characterId'), 'CharacterId'),
        integerParam(params, 'asOfWorldSeq', true),
      ))
    }
    if (method === 'outbox.drain') {
      return { delivered: await this.#application().deliver(addressParam(params.address), stringParam(params, 'correlationId')) }
    }
    if (method === 'session.render') {
      const locale = params.locale
      if (locale !== undefined && locale !== 'en' && locale !== 'zh-CN') throw new TypeError('locale is unsupported')
      const options: { readonly locale: 'en' | 'zh-CN' } | undefined = locale === undefined ? undefined : { locale }
      return worldResult(await this.#application().renderSession(
        addressParam(params.address),
        brandId(stringParam(params, 'sessionId'), 'SessionId'),
        integerParam(params, 'sessionEventSeq')!,
        options,
      ))
    }
    if (method === 'branch.fork-at-head') {
      this.metrics.increment('branch_forks')
      return worldResult(await this.#application().forkAtHead(
        addressParam(params.parent, 'parent'), addressParam(params.child, 'child'),
        stringParam(params, 'reason'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'branch.archive-coordinated') {
      this.metrics.increment('branch_transitions')
      return worldResult(await this.#application().archive(
        addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'),
      ))
    }
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

  #application(): WorldApplicationPort {
    if (this.application === undefined) throw new Error('WorldApplication Port is not configured')
    return this.application
  }
}
