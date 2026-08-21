import type { DatabaseSync } from 'node:sqlite'
import { failWorld, hashWorldJson, type WorldHash, type WorldJsonValue } from '@harness-world/contracts'
import { openOwnedDatabase, parseWorldJson, worldJsonText } from '@harness-world/store-sqlite'

const MODEL_REPLAY_APPLICATION_ID = 0x4843574d
const MODEL_REPLAY_SCHEMA = `
CREATE TABLE model_replays (
  call_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  response_json TEXT NOT NULL
) STRICT;
`

/** Append-once local record used to replay model outputs without invoking a provider. */
export class ModelReplayStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openOwnedDatabase(path, MODEL_REPLAY_APPLICATION_ID, MODEL_REPLAY_SCHEMA)
  }

  record(callId: string, request: WorldJsonValue, response: WorldJsonValue): 'recorded' | 'already_recorded' {
    const requestHash = hashWorldJson('model-call-request', request)
    const responseHash = hashWorldJson('model-call-response', response)
    const existing = this.#db.prepare(`SELECT request_hash, response_hash FROM model_replays WHERE call_id = ?`)
      .get(callId) as { request_hash: WorldHash; response_hash: WorldHash } | undefined
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash || existing.response_hash !== responseHash) this.#conflict(callId)
      return 'already_recorded'
    }
    this.#db.prepare(`INSERT INTO model_replays(call_id, request_hash, response_hash, response_json) VALUES (?, ?, ?, ?)`)
      .run(callId, requestHash, responseHash, worldJsonText(response))
    return 'recorded'
  }

  replay(callId: string, request: WorldJsonValue): WorldJsonValue | undefined {
    const row = this.#db.prepare(`SELECT request_hash, response_json FROM model_replays WHERE call_id = ?`)
      .get(callId) as { request_hash: WorldHash; response_json: string } | undefined
    if (row === undefined) return undefined
    if (row.request_hash !== hashWorldJson('model-call-request', request)) this.#conflict(callId)
    return parseWorldJson(row.response_json)
  }

  close(): void {
    this.#db.close()
  }

  #conflict(callId: string): never {
    failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH',
      category: 'integrity',
      message: 'model replay callId is bound to different request or response content',
      retryable: false,
      correlationId: `model-replay:${callId}`,
    })
  }
}
