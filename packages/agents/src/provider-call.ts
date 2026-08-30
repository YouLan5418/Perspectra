import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  deterministicId,
  failWorld,
  hashContextReceipt,
  hashWorldJson,
  worldAddressKey,
  type ContextReceipt,
  type InteractionRoundId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openContextDatabase } from './context-database.ts'

export type ProviderCallState =
  | 'prepared'
  | 'dispatch_started'
  | 'response_received'
  | 'validated'
  | 'committed'
  | 'failed_before_dispatch'
  | 'provider_rejected'
  | 'timed_out_ambiguous'
  | 'invalid_response'
  | 'budget_exhausted'
  | 'discarded_after_quarantine'

export type ProviderCallTerminalState = Exclude<ProviderCallState,
  'prepared' | 'dispatch_started' | 'response_received' | 'validated' | 'committed'>

export interface ProviderCallIntent extends WorldJsonObject {
  readonly schemaVersion: 'provider-call-intent/v1'
  readonly modelCallId: string
  readonly address: WorldAddress
  readonly roundId: InteractionRoundId
  readonly participantId: string
  readonly receiptId: string
  readonly receiptHash: WorldHash
  readonly controllerEpoch: number
  readonly contextHash: WorldHash
  readonly providerRequestHash: WorldHash
}

export interface ProviderCallRecord extends ProviderCallIntent {
  readonly state: ProviderCallState
  readonly response: WorldJsonValue | null
  readonly responseHash: WorldHash | null
  readonly proposal: WorldJsonValue | null
  readonly proposalHash: WorldHash | null
  readonly terminalMetadata: WorldJsonObject | null
  readonly transactionId: string | null
  readonly authorityHash: WorldHash | null
}

export type ProviderCallRecovery = 'dispatch_safe' | 'result_available' | 'ambiguous' | 'terminal'

interface ProviderCallRow {
  readonly model_call_id: string
  readonly namespace_key: string
  readonly round_id: InteractionRoundId
  readonly participant_id: string
  readonly receipt_id: string
  readonly receipt_hash: WorldHash
  readonly controller_epoch: number
  readonly context_hash: WorldHash
  readonly provider_request_hash: WorldHash
  readonly state: ProviderCallState
  readonly response_json: string | null
  readonly response_hash: WorldHash | null
  readonly proposal_json: string | null
  readonly proposal_hash: WorldHash | null
  readonly terminal_json: string | null
  readonly transaction_id: string | null
  readonly authority_hash: WorldHash | null
}

function jsonText(value: WorldJsonValue): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function parseJson(value: string | null): WorldJsonValue | null {
  return value === null ? null : JSON.parse(value) as WorldJsonValue
}

function intentFromReceipt(receipt: ContextReceipt): ProviderCallIntent {
  const { receiptHash: _receiptHash, ...receiptInput } = receipt
  if (receipt.receiptHash !== hashContextReceipt(receiptInput)) {
    throw new TypeError('Provider call requires a valid Context receipt')
  }
  const identity = {
    address: receipt.address,
    roundId: receipt.roundId,
    participantId: receipt.participantId,
    controllerEpoch: receipt.controllerEpoch,
    contextHash: receipt.contextHash,
    providerRequestHash: receipt.providerRequestHash,
  }
  return {
    schemaVersion: 'provider-call-intent/v1',
    modelCallId: deterministicId('provider-model-call/v1', identity),
    ...identity,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
  }
}

function isResultState(state: ProviderCallState): boolean {
  return state === 'response_received' || state === 'validated' || state === 'committed'
}

/** Durable, append-once boundary between an exact Context request and one provider dispatch. */
export class ProviderCallStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openContextDatabase(path)
  }

  prepare(receipt: ContextReceipt): ProviderCallRecord {
    const intent = intentFromReceipt(receipt)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`
        INSERT OR IGNORE INTO provider_calls(
          model_call_id, namespace_key, round_id, participant_id, receipt_id, receipt_hash, controller_epoch,
          context_hash, provider_request_hash, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')
      `).run(
        intent.modelCallId, worldAddressKey(intent.address), intent.roundId, intent.participantId,
        intent.receiptId, intent.receiptHash, intent.controllerEpoch, intent.contextHash, intent.providerRequestHash,
      )
      const existing = this.#db.prepare(`
        SELECT model_call_id FROM provider_calls
        WHERE namespace_key = ? AND round_id = ? AND participant_id = ?
      `).get(worldAddressKey(intent.address), intent.roundId, intent.participantId) as { model_call_id: string }
      const record = this.read(existing.model_call_id)!
      if (hashWorldJson('provider-call-intent/v1', this.#intent(record))
        !== hashWorldJson('provider-call-intent/v1', intent)) this.#conflict(intent.modelCallId)
      this.#db.exec('COMMIT')
      return record
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  markDispatchStarted(modelCallId: string): ProviderCallRecord {
    return this.#transition(modelCallId, 'prepared', 'dispatch_started')
  }

  recordResponse(
    modelCallId: string,
    response: WorldJsonValue,
    metadata: WorldJsonObject,
  ): ProviderCallRecord {
    const responseJson = jsonText(response)
    const responseHash = hashWorldJson('provider-call-response/v1', response)
    const terminalJson = jsonText(metadata)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#required(modelCallId)
      if (current.state === 'response_received' || current.state === 'validated' || current.state === 'committed') {
        if (current.response_json !== responseJson || current.response_hash !== responseHash
          || current.terminal_json !== terminalJson) this.#conflict(modelCallId)
      } else {
        if (current.state !== 'dispatch_started') this.#invalidTransition(modelCallId, current.state, 'response_received')
        this.#db.prepare(`
          UPDATE provider_calls SET state = 'response_received', response_json = ?, response_hash = ?, terminal_json = ?
          WHERE model_call_id = ? AND state = 'dispatch_started'
        `).run(responseJson, responseHash, terminalJson, modelCallId)
      }
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return this.read(modelCallId)!
  }

  markValidated(modelCallId: string, proposal: WorldJsonValue): ProviderCallRecord {
    const proposalJson = jsonText(proposal)
    const proposalHash = hashWorldJson('provider-call-proposal/v1', proposal)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#required(modelCallId)
      if (current.state === 'validated' || current.state === 'committed') {
        if (current.proposal_json !== proposalJson || current.proposal_hash !== proposalHash) this.#conflict(modelCallId)
      } else {
        if (current.state !== 'response_received') this.#invalidTransition(modelCallId, current.state, 'validated')
        this.#db.prepare(`
          UPDATE provider_calls SET state = 'validated', proposal_json = ?, proposal_hash = ?
          WHERE model_call_id = ? AND state = 'response_received'
        `).run(proposalJson, proposalHash, modelCallId)
      }
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return this.read(modelCallId)!
  }

  markCommitted(modelCallId: string, transactionId: string, authorityHash: WorldHash): ProviderCallRecord {
    return this.#transition(modelCallId, 'validated', 'committed', {
      transaction_id: transactionId,
      authority_hash: authorityHash,
    })
  }

  markTerminal(modelCallId: string, state: ProviderCallTerminalState, metadata: WorldJsonObject): ProviderCallRecord {
    const terminalJson = jsonText(metadata)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#required(modelCallId)
      if (current.state === state) {
        if (current.terminal_json !== terminalJson) this.#conflict(modelCallId)
      } else {
        const allowed = state === 'failed_before_dispatch' || state === 'budget_exhausted'
          ? current.state === 'prepared'
          : state === 'provider_rejected' || state === 'timed_out_ambiguous'
            ? current.state === 'dispatch_started'
            : state === 'invalid_response'
              ? current.state === 'response_received'
              : current.state !== 'committed'
        if (!allowed) this.#invalidTransition(modelCallId, current.state, state)
        this.#db.prepare(`UPDATE provider_calls SET state = ?, terminal_json = ? WHERE model_call_id = ?`)
          .run(state, terminalJson, modelCallId)
      }
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return this.read(modelCallId)!
  }

  read(modelCallId: string): ProviderCallRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM provider_calls WHERE model_call_id = ?').get(modelCallId) as ProviderCallRow | undefined
    if (row === undefined) return undefined
    const address = this.#address(row.namespace_key)
    const intent: ProviderCallIntent = {
      schemaVersion: 'provider-call-intent/v1', modelCallId: row.model_call_id, address,
      roundId: row.round_id, participantId: row.participant_id, receiptId: row.receipt_id,
      receiptHash: row.receipt_hash,
      controllerEpoch: row.controller_epoch, contextHash: row.context_hash,
      providerRequestHash: row.provider_request_hash,
    }
    const response = parseJson(row.response_json)
    const proposal = parseJson(row.proposal_json)
    const terminalMetadata = parseJson(row.terminal_json) as WorldJsonObject | null
    if ((response === null ? null : hashWorldJson('provider-call-response/v1', response)) !== row.response_hash
      || (proposal === null ? null : hashWorldJson('provider-call-proposal/v1', proposal)) !== row.proposal_hash) {
      this.#conflict(modelCallId)
    }
    return {
      ...intent, state: row.state, response, responseHash: row.response_hash,
      proposal, proposalHash: row.proposal_hash, terminalMetadata,
      transactionId: row.transaction_id, authorityHash: row.authority_hash,
    }
  }

  recovery(modelCallId: string): ProviderCallRecovery {
    const state = this.#required(modelCallId).state
    if (state === 'prepared') return 'dispatch_safe'
    if (state === 'dispatch_started') return 'ambiguous'
    if (isResultState(state)) return 'result_available'
    return 'terminal'
  }

  close(): void {
    this.#db.close()
  }

  #transition(
    modelCallId: string,
    expected: ProviderCallState,
    next: ProviderCallState,
    columns: { readonly transaction_id: string; readonly authority_hash: WorldHash } | undefined = undefined,
  ): ProviderCallRecord {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#required(modelCallId)
      if (current.state === next) {
        if (columns !== undefined
          && (current.transaction_id !== columns.transaction_id || current.authority_hash !== columns.authority_hash)) {
          this.#conflict(modelCallId)
        }
      } else {
        if (current.state !== expected) this.#invalidTransition(modelCallId, current.state, next)
        if (columns === undefined) {
          this.#db.prepare('UPDATE provider_calls SET state = ? WHERE model_call_id = ?')
            .run(next, modelCallId)
        } else {
          this.#db.prepare(`
            UPDATE provider_calls SET state = ?, transaction_id = ?, authority_hash = ?
            WHERE model_call_id = ?
          `).run(next, columns.transaction_id, columns.authority_hash, modelCallId)
        }
      }
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return this.read(modelCallId)!
  }

  #required(modelCallId: string): ProviderCallRow {
    const row = this.#db.prepare('SELECT * FROM provider_calls WHERE model_call_id = ?').get(modelCallId) as ProviderCallRow | undefined
    if (row === undefined) throw new Error(`provider call ${modelCallId} does not exist`)
    return row
  }

  #intent(record: ProviderCallRecord): ProviderCallIntent {
    return {
      schemaVersion: record.schemaVersion, modelCallId: record.modelCallId, address: record.address,
      roundId: record.roundId, participantId: record.participantId, receiptId: record.receiptId,
      receiptHash: record.receiptHash,
      controllerEpoch: record.controllerEpoch, contextHash: record.contextHash,
      providerRequestHash: record.providerRequestHash,
    }
  }

  #address(namespaceKey: string): WorldAddress {
    const parts = namespaceKey.split('\u001f')
    if (parts.length !== 3) throw new Error('provider call namespace is malformed')
    return { tenantId: parts[0]!, worldId: parts[1]!, branchId: parts[2]! } as WorldAddress
  }

  #invalidTransition(modelCallId: string, current: ProviderCallState, next: ProviderCallState): never {
    throw new Error(`provider call ${modelCallId} cannot transition from ${current} to ${next}`)
  }

  #conflict(modelCallId: string): never {
    failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
      message: 'provider call durable identity or append-once content diverged', retryable: false,
      correlationId: `provider-call:${modelCallId}`,
    })
  }
}
