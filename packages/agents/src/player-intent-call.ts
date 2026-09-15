import type { DatabaseSync } from 'node:sqlite'
import { deterministicId, failWorld, hashWorldJson, worldAddressKey,
  type WorldAddress, type WorldHash, type WorldJsonValue } from '@harness-world/contracts'
import { parseWorldJson, worldJsonText } from '@harness-world/store-sqlite'
import { openContextDatabase } from './context-database.ts'

export interface PlayerIntentCall {
  readonly modelCallId: string
  readonly state: 'prepared' | 'dispatch_started' | 'response_received' | 'validated' | 'invalid_response' | 'timed_out_ambiguous' | 'failed_before_dispatch'
  readonly request: WorldJsonValue
  readonly requestHash: WorldHash
  readonly response: WorldJsonValue | null
  readonly responseHash: WorldHash | null
}

/** Purpose-specific ProviderCall identity: no invented Round, participant, or ContextReceipt. */
export class PlayerIntentCallStore {
  readonly #db: DatabaseSync
  constructor(path: string) { this.#db = openContextDatabase(path) }
  close(): void { this.#db.close() }

  prepare(address: WorldAddress, inputId: string, request: WorldJsonValue): PlayerIntentCall {
    const requestHash = hashWorldJson('player-intent-request/v2', request)
    const modelCallId = deterministicId('player-intent-call/v1', { address, inputId })
    this.#db.prepare(`INSERT OR IGNORE INTO provider_calls(model_call_id,purpose,work_id,request_json,namespace_key,
      receipt_hash,controller_epoch,context_hash,provider_request_hash,state) VALUES (?,'player_intent',?,?,?, ?,0,?,?,'prepared')`)
      .run(modelCallId, inputId, worldJsonText(request), worldAddressKey(address), requestHash, requestHash, requestHash)
    const call = this.read(modelCallId)!
    if (call.requestHash !== requestHash) this.#conflict()
    return call
  }

  read(modelCallId: string): PlayerIntentCall | undefined {
    const row = this.#db.prepare("SELECT * FROM provider_calls WHERE model_call_id = ? AND purpose = 'player_intent'")
      .get(modelCallId) as { state: PlayerIntentCall['state']; request_json: string; provider_request_hash: WorldHash; response_json: string | null; response_hash: WorldHash | null } | undefined
    if (row === undefined) return undefined
    const request = parseWorldJson(row.request_json)
    const response = row.response_json === null ? null : parseWorldJson(row.response_json)
    if (hashWorldJson('player-intent-request/v2', request) !== row.provider_request_hash
      || (response === null ? row.response_hash !== null : hashWorldJson('player-intent-response/v1', response) !== row.response_hash)) this.#conflict()
    return { modelCallId, state: row.state, request, requestHash: row.provider_request_hash, response, responseHash: row.response_hash }
  }

  /** CAS winner alone may issue the external request. */
  start(modelCallId: string): boolean {
    return this.#db.prepare("UPDATE provider_calls SET state = 'dispatch_started' WHERE model_call_id = ? AND purpose = 'player_intent' AND state = 'prepared'")
      .run(modelCallId).changes === 1
  }

  respond(modelCallId: string, response: WorldJsonValue): boolean {
    const responseHash = hashWorldJson('player-intent-response/v1', response)
    const result = this.#db.prepare("UPDATE provider_calls SET state = 'response_received',response_json = ?,response_hash = ? WHERE model_call_id = ? AND purpose = 'player_intent' AND state = 'dispatch_started'")
      .run(worldJsonText(response), responseHash, modelCallId)
    if (result.changes === 1) return true
    const current = this.read(modelCallId)
    if (current === undefined) throw new TypeError('player intent call is missing')
    if (current.state === 'response_received' || current.state === 'validated') {
      if (current.responseHash !== responseHash) this.#conflict()
      return true
    }
    this.#db.prepare('INSERT OR IGNORE INTO player_intent_late_responses(model_call_id,response_hash) VALUES (?,?)').run(modelCallId, responseHash)
    return false
  }

  finish(modelCallId: string, expected: PlayerIntentCall['state'], state: 'validated' | 'invalid_response' | 'timed_out_ambiguous' | 'failed_before_dispatch'): void {
    const allowed = expected === 'response_received' ? ['validated', 'invalid_response']
      : expected === 'dispatch_started' ? ['timed_out_ambiguous', 'invalid_response'] : expected === 'prepared' ? ['failed_before_dispatch'] : []
    if (!allowed.includes(state)) throw new TypeError('player intent call transition is invalid')
    if (this.#db.prepare("UPDATE provider_calls SET state = ? WHERE model_call_id = ? AND purpose = 'player_intent' AND state = ?")
      .run(state, modelCallId, expected).changes !== 1 && this.read(modelCallId)?.state !== state) this.#conflict()
  }

  #conflict(): never {
    failWorld({ errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false,
      message: 'player intent ProviderCall authority conflict', correlationId: 'player-intent-call' })
  }
}
