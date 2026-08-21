import type { DatabaseSync } from 'node:sqlite'
import {
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

export interface EnqueueRoundRequest {
  readonly address: WorldAddress
  readonly idempotencyKey: string
  readonly principalId: string
  readonly input: WorldJsonValue
  readonly correlationId: string
}

export interface EnqueueRoundResult {
  readonly status: 'enqueued' | 'already_enqueued'
  readonly inboxSeq: number
  readonly inputHash: WorldHash
}

export interface ClaimedRound {
  readonly inboxSeq: number
  readonly idempotencyKey: string
  readonly principalId: string
  readonly input: WorldJsonValue
  readonly inputHash: WorldHash
}

export interface CompleteRoundResult {
  readonly status: 'completed' | 'already_completed'
  readonly resultHash: WorldHash
}

interface InboxRow {
  readonly inbox_seq: number
  readonly idempotency_key: string
  readonly principal_id: string
  readonly input_json: string
  readonly input_hash: WorldHash
}

/** Durable admission queue and idempotency ledger for one branch's player inputs. */
export class RoundInbox {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openWorldDatabase(path)
  }

  enqueue(request: EnqueueRoundRequest, queueLimit: number): EnqueueRoundResult {
    this.#validateText(request.idempotencyKey, 'idempotencyKey')
    this.#validateText(request.principalId, 'principalId')
    if (!Number.isSafeInteger(queueLimit) || queueLimit <= 0) throw new RangeError('queueLimit must be a positive safe integer')
    const key = worldAddressKey(request.address)
    const inputHash = hashWorldJson('player-round-input', { principalId: request.principalId, input: request.input })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#requireBranch(key)
      const replay = this.#db.prepare(`
        SELECT inbox_seq, input_hash FROM round_inbox WHERE address_key = ? AND idempotency_key = ?
      `).get(key, request.idempotencyKey) as { inbox_seq: number; input_hash: WorldHash } | undefined
      if (replay !== undefined) {
        if (replay.input_hash !== inputHash) {
          failWorld({
            errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
            category: 'admission',
            message: 'idempotencyKey is already bound to different player input',
            retryable: false,
            correlationId: request.correlationId,
            address: request.address,
          })
        }
        this.#db.exec('COMMIT')
        return { status: 'already_enqueued', inboxSeq: replay.inbox_seq, inputHash }
      }
      const queued = this.#db.prepare(`
        SELECT COUNT(*) AS count FROM round_inbox WHERE address_key = ? AND status IN ('pending', 'claimed')
      `).get(key) as { count: number }
      if (queued.count >= queueLimit) {
        failWorld({
          errorCode: 'ROUND_QUEUE_FULL',
          category: 'admission',
          message: 'branch player Round queue is full',
          retryable: true,
          correlationId: request.correlationId,
          address: request.address,
          details: { queueLimit },
        })
      }
      this.#db.prepare(`
        INSERT INTO round_inbox_counters(address_key, next_inbox_seq) VALUES (?, 1)
        ON CONFLICT(address_key) DO NOTHING
      `).run(key)
      const counter = this.#db.prepare(`
        SELECT next_inbox_seq FROM round_inbox_counters WHERE address_key = ?
      `).get(key) as { next_inbox_seq: number }
      const inboxSeq = counter.next_inbox_seq
      this.#db.prepare(`UPDATE round_inbox_counters SET next_inbox_seq = ? WHERE address_key = ?`).run(inboxSeq + 1, key)
      this.#db.prepare(`
        INSERT INTO round_inbox(address_key, inbox_seq, idempotency_key, input_hash, principal_id, input_json, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(key, inboxSeq, request.idempotencyKey, inputHash, request.principalId, worldJsonText(request.input))
      this.#db.exec('COMMIT')
      return { status: 'enqueued', inboxSeq, inputHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  claimNext(address: WorldAddress, ownerId: string, fencingToken: number): ClaimedRound | undefined {
    this.#validateText(ownerId, 'ownerId')
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) throw new RangeError('fencingToken must be a positive safe integer')
    const key = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#db.prepare(`
        SELECT inbox_seq, idempotency_key, principal_id, input_json, input_hash
        FROM round_inbox
        WHERE address_key = ? AND (
          status = 'pending'
          OR (status = 'claimed' AND claim_fencing_token < ?)
          OR (status = 'claimed' AND claim_owner_id = ? AND claim_fencing_token = ?)
        )
        ORDER BY inbox_seq LIMIT 1
      `).get(key, fencingToken, ownerId, fencingToken) as InboxRow | undefined
      if (row === undefined) {
        this.#db.exec('COMMIT')
        return undefined
      }
      this.#db.prepare(`
        UPDATE round_inbox SET status = 'claimed', claim_owner_id = ?, claim_fencing_token = ?
        WHERE address_key = ? AND inbox_seq = ?
      `).run(ownerId, fencingToken, key, row.inbox_seq)
      this.#db.exec('COMMIT')
      return this.#claimed(row)
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  complete(
    address: WorldAddress,
    inboxSeq: number,
    ownerId: string,
    fencingToken: number,
    result: WorldJsonValue,
  ): CompleteRoundResult {
    const key = worldAddressKey(address)
    const resultHash = hashWorldJson('player-round-result', result)
    const resultText = worldJsonText(result)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#db.prepare(`
        SELECT status, claim_owner_id, claim_fencing_token, result_hash, result_json
        FROM round_inbox WHERE address_key = ? AND inbox_seq = ?
      `).get(key, inboxSeq) as {
        status: 'pending' | 'claimed' | 'completed'
        claim_owner_id: string | null
        claim_fencing_token: number | null
        result_hash: WorldHash | null
        result_json: string | null
      } | undefined
      if (current?.status === 'completed') {
        if (current.result_hash !== resultHash || current.result_json !== resultText) this.#completionConflict(address, key)
        this.#db.exec('COMMIT')
        return { status: 'already_completed', resultHash }
      }
      if (current?.status !== 'claimed' || current.claim_owner_id !== ownerId || current.claim_fencing_token !== fencingToken) {
        failWorld({
          errorCode: 'WRITER_LEASE_LOST',
          category: 'runtime',
          message: 'Round completion is not owned by this fencing token',
          retryable: true,
          correlationId: `round-inbox:${key}:${inboxSeq}`,
          address,
        })
      }
      this.#db.prepare(`
        UPDATE round_inbox SET status = 'completed', result_hash = ?, result_json = ?
        WHERE address_key = ? AND inbox_seq = ?
      `).run(resultHash, resultText, key, inboxSeq)
      this.#db.exec('COMMIT')
      return { status: 'completed', resultHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  readCompleted(address: WorldAddress, idempotencyKey: string): WorldJsonValue | undefined {
    const row = this.#db.prepare(`
      SELECT result_json FROM round_inbox
      WHERE address_key = ? AND idempotency_key = ? AND status = 'completed'
    `).get(worldAddressKey(address), idempotencyKey) as { result_json: string } | undefined
    return row === undefined ? undefined : parseWorldJson(row.result_json)
  }

  close(): void {
    this.#db.close()
  }

  #claimed(row: InboxRow): ClaimedRound {
    return {
      inboxSeq: row.inbox_seq,
      idempotencyKey: row.idempotency_key,
      principalId: row.principal_id,
      input: parseWorldJson(row.input_json),
      inputHash: row.input_hash,
    }
  }

  #validateText(value: string, name: string): void {
    if (value.length === 0 || value.trim() !== value) throw new TypeError(`${name} must be a non-empty, unpadded string`)
  }

  #requireBranch(key: string): void {
    if (this.#db.prepare(`SELECT 1 AS present FROM branches WHERE address_key = ?`).get(key) === undefined) {
      throw new Error(`unknown world branch ${key}`)
    }
  }

  #completionConflict(address: WorldAddress, key: string): never {
    failWorld({
      errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
      category: 'integrity',
      message: 'completed Round is bound to a different result',
      retryable: false,
      correlationId: `round-inbox:${key}`,
      address,
    })
  }
}
