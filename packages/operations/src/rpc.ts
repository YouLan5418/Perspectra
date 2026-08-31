import {
  assertProtocolString,
  brandId,
  canonicalizeWorldJson,
  compareWorldText,
  createErrorEnvelope,
  hashWorldJson,
  WorldError,
  type WorldAddress,
  type CharacterId,
  type DeliveryId,
  type InteractionRoundId,
  type ReactionCycleId,
  type ReactionCycleStatus,
  type RuntimeAvailabilityState,
  type SessionId,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { BranchAdministration, RoundInbox, WorldStore } from '@harness-world/store-sqlite'
import { WorldHealthService } from './health.ts'
import { OperationsMetrics } from './metrics.ts'

export interface WorldApplicationPort {
  compileSpec(input: WorldJsonValue): unknown
  activateSpec(input: WorldJsonValue): unknown
  listWorlds(): unknown
  getWorld(address: WorldAddress): unknown
  submit(address: WorldAddress, request: {
    readonly idempotencyKey: string
    readonly principalId: string
    readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
    readonly correlationId: string
  }): Promise<unknown>
  acceptRound(address: WorldAddress, request: {
    readonly idempotencyKey: string
    readonly principalId: string
    readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
    readonly correlationId: string
  }): Promise<unknown>
  processAcceptedRounds(address: WorldAddress, correlationId: string): Promise<number>
  roundStatus(address: WorldAddress, lookup: { readonly idempotencyKey?: string; readonly roundId?: InteractionRoundId }): Promise<unknown | undefined>
  cancelQueuedRound(address: WorldAddress, lookup: { readonly idempotencyKey?: string; readonly roundId?: InteractionRoundId }, correlationId: string): Promise<unknown>
  roundResult(address: WorldAddress, idempotencyKey: string): Promise<unknown | undefined>
  reactionCycle(address: WorldAddress, cycleId: ReactionCycleId): Promise<unknown | undefined>
  listReactionCycles(address: WorldAddress, query?: { readonly status?: ReactionCycleStatus; readonly limit?: number }): Promise<unknown>
  cancelReactionCycle(address: WorldAddress, cycleId: ReactionCycleId, correlationId: string): Promise<unknown>
  head(address: WorldAddress): Promise<unknown>
  characterViewForPrincipal(address: WorldAddress, principalId: string, characterId: CharacterId, asOfWorldSeq?: number): Promise<unknown>
  characterAvailability(address: WorldAddress, characterId: CharacterId): Promise<unknown>
  setCharacterAvailability(address: WorldAddress, characterId: CharacterId, state: RuntimeAvailabilityState, reason: string | null): Promise<unknown>
  deliver(address: WorldAddress, correlationId: string): Promise<number>
  deadLetters(address: WorldAddress): Promise<unknown>
  retryDeadLetter(address: WorldAddress, deliveryId: DeliveryId, correlationId: string): Promise<void>
  renderSession(address: WorldAddress, sessionId: SessionId, sessionEventSeq: number, options?: { readonly locale?: 'en' | 'zh-CN' }): Promise<unknown>
  forkAtHead(parent: WorldAddress, child: WorldAddress, reason: string, correlationId: string): Promise<unknown>
  archive(address: WorldAddress, reason: string, correlationId: string): Promise<unknown>
  branchStatus(address: WorldAddress): unknown
  branchAudit(address: WorldAddress): unknown
  enterMaintenance(address: WorldAddress, reason: string, correlationId: string): Promise<unknown>
  exitMaintenance(address: WorldAddress, reason: string, correlationId: string): Promise<unknown>
  quarantineExplain(address: WorldAddress): unknown
  quarantineRecover(address: WorldAddress, correlationId: string): Promise<unknown>
  createSnapshot(address: WorldAddress, snapshotPath: string, correlationId: string): Promise<unknown>
  latestSnapshot(address: WorldAddress, snapshotPath: string): unknown | undefined
  listSnapshots(address: WorldAddress, snapshotPath: string): unknown
  backup(targetPath: string, correlationId: string): Promise<unknown>
  restore(backupPath: string, targetPath: string, expectedHash: string, correlationId: string): unknown
  exportPortable(exportPath: string, correlationId: string): Promise<unknown>
  importPortable(exportPath: string, targetPath: string, correlationId: string): unknown
  exportAuthority(targetPath: string, correlationId: string): unknown
  importAuthority(exportPath: string, targetPath: string, correlationId: string): unknown
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

export type LocalNotificationMethod =
  | 'round.committed'
  | 'presentation.ready'
  | 'health.changed'
  | 'outbox.dead-lettered'
  | 'branch.quarantined'

export interface LocalJsonRpcNotification extends WorldJsonObject {
  readonly jsonrpc: '2.0'
  readonly method: LocalNotificationMethod
  readonly params: WorldJsonObject
}

function stringParam(params: WorldJsonObject, name: string): string {
  const value = params[name]
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return assertProtocolString(value, name)
}

function addressParam(value: WorldJsonValue | undefined, name = 'address'): WorldAddress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  const objectValue = value as WorldJsonObject
  const keys = Object.keys(objectValue).sort(compareWorldText)
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
  readonly #store: WorldStore | undefined
  readonly #admin: BranchAdministration | undefined
  readonly #health: WorldHealthService
  readonly metrics = new OperationsMetrics()
  readonly #roundWorkers = new Map<string, Promise<void>>()
  readonly #roundWorkerRequests = new Map<string, { readonly address: WorldAddress; readonly correlationId: string }>()
  readonly #notificationListeners = new Set<(notification: LocalJsonRpcNotification) => void>()
  #lastHealthHash: string | undefined
  #closing = false

  constructor(private readonly worldPath: string, private readonly application?: WorldApplicationPort) {
    this.#store = application === undefined ? new WorldStore(worldPath) : undefined
    this.#admin = application === undefined ? new BranchAdministration(worldPath) : undefined
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
      return this.#errorResponse(request.id, error)
    }
  }

  invalidRequest(id: string | number | null, error: unknown): LocalJsonRpcResponse {
    this.metrics.increment('rpc_requests')
    return this.#errorResponse(id, error)
  }

  subscribeNotifications(listener: (notification: LocalJsonRpcNotification) => void): () => void {
    this.#notificationListeners.add(listener)
    return () => { this.#notificationListeners.delete(listener) }
  }

  async close(): Promise<void> {
    this.#closing = true
    while (this.#roundWorkers.size > 0) await Promise.all(this.#roundWorkers.values())
    this.#admin?.close()
    this.#store?.close()
  }

  /** Wake every durable active FIFO after host restart; the workers retain normal fencing rules. */
  recoverAcceptedRounds(correlationId = 'round:startup-recovery'): number {
    assertProtocolString(correlationId, 'correlationId')
    this.#application()
    const inbox = new RoundInbox(this.worldPath)
    try {
      const addresses = inbox.unfinishedAddresses()
      for (const address of addresses) this.#kickRoundWorker(address, correlationId)
      return addresses.length
    } finally {
      inbox.close()
    }
  }

  async #dispatch(method: string, params: WorldJsonObject): Promise<WorldJsonValue> {
    if (method === 'world.compile') return worldResult(this.#application().compileSpec(params.spec as WorldJsonValue))
    if (method === 'world.activate') return worldResult(this.#application().activateSpec(params.spec as WorldJsonValue))
    if (method === 'world.list') return worldResult(this.#application().listWorlds())
    if (method === 'world.get') return worldResult(this.#application().getWorld(addressParam(params.address)))
    if (method === 'branch.get') return worldResult(this.#application().getWorld(addressParam(params.address)))
    if (method === 'round.submit') {
      const action = objectParam(params, 'action')
      const actionKeys = Object.keys(action).sort(compareWorldText)
      if (actionKeys.join(',') !== 'actionType,parameters') throw new TypeError('action has invalid fields')
      const address = addressParam(params.address)
      const accepted = await this.#application().acceptRound(address, {
        idempotencyKey: stringParam(params, 'idempotencyKey'),
        principalId: stringParam(params, 'principalId'),
        action: { actionType: stringParam(action, 'actionType'), parameters: action.parameters! },
        correlationId: stringParam(params, 'correlationId'),
      })
      if ((accepted as { readonly status?: string }).status === 'queued' || (accepted as { readonly status?: string }).status === 'processing') {
        this.#kickRoundWorker(address, stringParam(params, 'correlationId'))
      }
      return worldResult(accepted)
    }
    if (method === 'round.get') {
      const idempotencyKey = params.idempotencyKey
      const roundId = params.roundId
      if ((typeof idempotencyKey === 'string') === (typeof roundId === 'string')) throw new TypeError('round.get requires exactly one idempotencyKey or roundId')
      const result = await this.#application().roundStatus(addressParam(params.address), typeof idempotencyKey === 'string'
        ? { idempotencyKey: stringParam(params, 'idempotencyKey') }
        : { roundId: brandId(stringParam(params, 'roundId'), 'InteractionRoundId') })
      return result === undefined ? null : worldResult(result)
    }
    if (method === 'round.process') {
      const address = addressParam(params.address)
      const correlationId = stringParam(params, 'correlationId')
      const processed = await this.#application().processAcceptedRounds(address, correlationId)
      if (processed > 0) this.#notify('round.committed', { address, processed, correlationId })
      return { processed }
    }
    if (method === 'round.cancel-queued') {
      const idempotencyKey = params.idempotencyKey
      const roundId = params.roundId
      if ((typeof idempotencyKey === 'string') === (typeof roundId === 'string')) throw new TypeError('round.cancel-queued requires exactly one idempotencyKey or roundId')
      return worldResult(await this.#application().cancelQueuedRound(
        addressParam(params.address),
        typeof idempotencyKey === 'string' ? { idempotencyKey: stringParam(params, 'idempotencyKey') } : { roundId: brandId(stringParam(params, 'roundId'), 'InteractionRoundId') },
        stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'reaction.get') {
      const result = await this.#application().reactionCycle(
        addressParam(params.address), brandId(stringParam(params, 'cycleId'), 'ReactionCycleId'),
      )
      return result === undefined ? null : worldResult(result)
    }
    if (method === 'reaction.list') {
      const status = params.status
      if (status !== undefined && typeof status !== 'string') throw new TypeError('status must be a string')
      return worldResult(await this.#application().listReactionCycles(addressParam(params.address), {
        ...(status === undefined ? {} : { status: status as ReactionCycleStatus }),
        ...(params.limit === undefined ? {} : { limit: integerParam(params, 'limit')! }),
      }))
    }
    if (method === 'reaction.cancel') {
      return worldResult(await this.#application().cancelReactionCycle(
        addressParam(params.address),
        brandId(stringParam(params, 'cycleId'), 'ReactionCycleId'),
        stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'world.head') return worldResult(await this.#application().head(addressParam(params.address)))
    if (method === 'view.character' || method === 'character.view') {
      return worldResult(await this.#application().characterViewForPrincipal(
        addressParam(params.address),
        stringParam(params, 'principalId'),
        brandId(stringParam(params, 'characterId'), 'CharacterId'),
        integerParam(params, 'asOfWorldSeq', true),
      ))
    }
    if (method === 'character.availability.get') {
      return worldResult(await this.#application().characterAvailability(
        addressParam(params.address), brandId(stringParam(params, 'characterId'), 'CharacterId'),
      ))
    }
    if (method === 'character.availability.set') {
      const state = stringParam(params, 'state')
      if (!['provisioning', 'ready', 'session_lag', 'model_unavailable', 'budget_unavailable', 'offline', 'disabled'].includes(state)) {
        throw new TypeError('character availability state is invalid')
      }
      const reason = params.reason
      if (reason !== null && typeof reason !== 'string') throw new TypeError('reason must be a string or null')
      return worldResult(await this.#application().setCharacterAvailability(
        addressParam(params.address), brandId(stringParam(params, 'characterId'), 'CharacterId'),
        state as RuntimeAvailabilityState, reason,
      ))
    }
    if (method === 'outbox.drain') {
      return { delivered: await this.#application().deliver(addressParam(params.address), stringParam(params, 'correlationId')) }
    }
    if (method === 'outbox.list') {
      const address = addressParam(params.address)
      const result = await this.#application().deadLetters(address)
      if (Array.isArray(result) && result.length > 0) {
        this.#notify('outbox.dead-lettered', { address, count: result.length })
      }
      return worldResult(result)
    }
    if (method === 'outbox.retry') {
      await this.#application().retryDeadLetter(
        addressParam(params.address),
        brandId(stringParam(params, 'deliveryId'), 'DeliveryId'),
        stringParam(params, 'correlationId'),
      )
      return { status: 'retry_scheduled' }
    }
    if (method === 'session.render') {
      const locale = params.locale
      if (locale !== undefined && locale !== 'en' && locale !== 'zh-CN') throw new TypeError('locale is unsupported')
      const options: { readonly locale: 'en' | 'zh-CN' } | undefined = locale === undefined ? undefined : { locale }
      const address = addressParam(params.address)
      const sessionId = brandId(stringParam(params, 'sessionId'), 'SessionId')
      const sessionEventSeq = integerParam(params, 'sessionEventSeq')!
      const rendered = await this.#application().renderSession(
        address,
        sessionId,
        sessionEventSeq,
        options,
      )
      this.#notify('presentation.ready', { address, sessionId, sessionEventSeq })
      return worldResult(rendered)
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
    if (method === 'maintenance.enter') {
      this.metrics.increment('branch_transitions')
      return worldResult(await this.#application().enterMaintenance(
        addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'maintenance.exit') {
      this.metrics.increment('branch_transitions')
      return worldResult(await this.#application().exitMaintenance(
        addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'quarantine.explain') {
      const address = addressParam(params.address)
      const result = this.#application().quarantineExplain(address)
      if (typeof result === 'object' && result !== null && !Array.isArray(result)
        && (result as { runtimePhase?: string }).runtimePhase === 'quarantined') {
        this.#notify('branch.quarantined', { address })
      }
      return worldResult(result)
    }
    if (method === 'quarantine.recover') {
      return worldResult(await this.#application().quarantineRecover(
        addressParam(params.address), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'snapshot.create') {
      return worldResult(await this.#application().createSnapshot(
        addressParam(params.address), stringParam(params, 'snapshotPath'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'snapshot.latest') {
      return worldResult(this.#application().latestSnapshot(
        addressParam(params.address), stringParam(params, 'snapshotPath'),
      ) ?? null)
    }
    if (method === 'snapshot.list') {
      return worldResult(this.#application().listSnapshots(
        addressParam(params.address), stringParam(params, 'snapshotPath'),
      ))
    }
    if (method === 'backup.create') {
      return worldResult(await this.#application().backup(stringParam(params, 'targetPath'), stringParam(params, 'correlationId')))
    }
    if (method === 'backup') {
      return worldResult(await this.#application().backup(
        stringParam(params, 'targetPath'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'backup.restore') {
      return worldResult(this.#application().restore(
        stringParam(params, 'backupPath'), stringParam(params, 'targetPath'),
        stringParam(params, 'expectedHash'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'restore') {
      return worldResult(this.#application().restore(
        stringParam(params, 'backupPath'), stringParam(params, 'targetPath'),
        stringParam(params, 'expectedHash'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'transfer.export-portable') {
      return worldResult(await this.#application().exportPortable(stringParam(params, 'exportPath'), stringParam(params, 'correlationId')))
    }
    if (method === 'world.export') {
      return worldResult(await this.#application().exportPortable(
        stringParam(params, 'exportPath'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'transfer.import-portable') {
      return worldResult(this.#application().importPortable(
        stringParam(params, 'exportPath'), stringParam(params, 'targetPath'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'world.import') {
      return worldResult(this.#application().importPortable(
        stringParam(params, 'exportPath'), stringParam(params, 'targetPath'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'transfer.export-authority') {
      return worldResult(this.#application().exportAuthority(stringParam(params, 'targetPath'), stringParam(params, 'correlationId')))
    }
    if (method === 'transfer.import-authority') {
      return worldResult(this.#application().importAuthority(
        stringParam(params, 'exportPath'), stringParam(params, 'targetPath'), stringParam(params, 'correlationId'),
      ))
    }
    if (method === 'health.get') {
      const health = this.#health.check()
      const healthHash = hashWorldJson('local-health-notification', health)
      if (healthHash !== this.#lastHealthHash) {
        this.#lastHealthHash = healthHash
        this.#notify('health.changed', { healthHash, health })
      }
      return health
    }
    if (method === 'metrics.get') return this.metrics.snapshot()
    if (method === 'branch.status') {
      const address = addressParam(params.address)
      return worldResult(this.application === undefined ? this.#legacyAdmin().status(address) : this.application.branchStatus(address))
    }
    if (method === 'branch.drain' || method === 'branch.open') {
      this.metrics.increment('branch_transitions')
      if (this.application !== undefined) {
        return worldResult(await (method === 'branch.drain'
          ? this.application.enterMaintenance(
              addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'),
            )
          : this.application.exitMaintenance(
              addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'),
            )))
      }
      return this.#legacyAdmin().setAdmission(
        addressParam(params.address), method === 'branch.drain' ? 'draining' : 'open',
        stringParam(params, 'reason'), stringParam(params, 'correlationId'),
      )
    }
    if (method === 'branch.archive') {
      this.metrics.increment('branch_transitions')
      if (this.application !== undefined) {
        return worldResult(await this.application.archive(
          addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'),
        ))
      }
      return this.#legacyAdmin().archive(addressParam(params.address), stringParam(params, 'reason'), stringParam(params, 'correlationId'))
    }
    if (method === 'branch.fork') {
      if (this.application !== undefined) {
        this.metrics.increment('branch_forks')
        return worldResult(await this.application.forkAtHead(
          addressParam(params.parent, 'parent'), addressParam(params.child, 'child'),
          stringParam(params, 'reason'), stringParam(params, 'correlationId'),
        ))
      }
      const forkSeq = params.forkSeq
      if (typeof forkSeq !== 'number') throw new TypeError('forkSeq must be a number')
      this.#legacyStore().forkBranch(addressParam(params.parent, 'parent'), addressParam(params.child, 'child'), forkSeq)
      this.metrics.increment('branch_forks')
      return { status: 'forked', forkSeq }
    }
    if (method === 'audit.list') {
      const address = addressParam(params.address)
      return worldResult(this.application === undefined ? this.#legacyAdmin().readAudit(address) : this.application.branchAudit(address))
    }
    throw new TypeError(`unknown local RPC method ${method}`)
  }

  #application(): WorldApplicationPort {
    if (this.application === undefined) throw new Error('WorldApplication Port is not configured')
    return this.application
  }

  #kickRoundWorker(address: WorldAddress, correlationId: string): void {
    const key = `${address.tenantId}\u001f${address.worldId}\u001f${address.branchId}`
    this.#roundWorkerRequests.set(key, { address, correlationId })
    if (this.#roundWorkers.has(key)) return
    const worker = Promise.resolve().then(async () => {
      while (true) {
        const requested = this.#roundWorkerRequests.get(key)
        if (requested === undefined) {
          this.#roundWorkers.delete(key)
          return
        }
        this.#roundWorkerRequests.delete(key)
        try {
          const processed = await this.#application().processAcceptedRounds(requested.address, `${requested.correlationId}:worker`)
          if (processed > 0) {
            this.#notify('round.committed', {
              address: requested.address, processed, correlationId: requested.correlationId,
            })
          }
        } catch (error: unknown) {
          this.metrics.increment('round_worker_failures')
          const details = error instanceof WorldError
            ? { errorId: error.envelope.errorId, errorCode: error.envelope.errorCode }
            : { errorType: typeof error, message: String(error) }
          const audit = new BranchAdministration(this.worldPath)
          try {
            audit.recordRoundWorkerFailure(requested.address, `${requested.correlationId}:worker-failed`, details)
          } finally {
            audit.close()
          }
          if (error instanceof WorldError && error.envelope.retryable && !this.#closing) {
            await new Promise(resolve => setTimeout(resolve, 100))
            this.#roundWorkerRequests.set(key, requested)
          }
        }
      }
    })
    this.#roundWorkers.set(key, worker)
  }

  #legacyAdmin(): BranchAdministration {
    return this.#admin!
  }

  #notify(method: LocalNotificationMethod, params: WorldJsonObject): void {
    const notification: LocalJsonRpcNotification = { jsonrpc: '2.0', method, params }
    for (const listener of this.#notificationListeners) {
      try {
        listener(notification)
      } catch {
        // Notifications are ephemeral hints. A broken subscriber must not change an authoritative result.
      }
    }
  }

  #legacyStore(): WorldStore {
    return this.#store!
  }

  #errorResponse(id: string | number | null, error: unknown): LocalJsonRpcResponse {
    this.metrics.increment('rpc_errors')
    const envelope = error instanceof WorldError ? error.envelope : createErrorEnvelope({
      errorCode: 'INVALID_REQUEST', category: 'admin', message: String(error), retryable: false,
      correlationId: `rpc:${String(id)}`,
    })
    return { jsonrpc: '2.0', id, error: envelope as unknown as WorldJsonValue }
  }
}
