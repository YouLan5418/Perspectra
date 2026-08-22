import type { DatabaseSync } from 'node:sqlite'
import {
  assertProtocolString,
  brandId,
  deterministicId,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
  type WorldJsonValue,
  type TransactionId,
  type InteractionRoundId,
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
  readonly roundId: InteractionRoundId
}

export interface RoundLookup {
  readonly idempotencyKey?: string
  readonly roundId?: InteractionRoundId
}

export interface DurableRoundStatus {
  readonly status: 'queued' | 'processing' | 'committed' | 'failed' | 'cancelled'
  readonly inboxSeq: number
  readonly idempotencyKey: string
  readonly roundId: InteractionRoundId
  readonly result: WorldJsonValue | null
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

export interface RoundCommitProof {
  readonly transactionId: TransactionId
  readonly bundleHash: WorldHash
}

interface InboxRow {
  readonly inbox_seq: number
  readonly idempotency_key: string
  readonly principal_id: string
  readonly input_json: string
  readonly input_hash: WorldHash
}

interface StatusRow extends InboxRow {
  readonly status: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled'
  readonly result_json: string | null
  readonly result_hash: WorldHash | null
}

export function coordinatedRoundId(
  address: WorldAddress,
  inboxSeq: number,
  idempotencyKey: string,
  inputHash: WorldHash,
): InteractionRoundId {
  return brandId(deterministicId('round:coordinated', { address, inboxSeq, idempotencyKey, inputHash }), 'InteractionRoundId')
}

function boundBundleHash(result: WorldJsonValue): WorldHash | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
  const value = (result as Record<string, WorldJsonValue>).bundleHash
  return typeof value === 'string' ? value as WorldHash : undefined
}

/** Durable admission queue and idempotency ledger for one branch's player inputs. */
export class RoundInbox {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly now: () => number = Date.now) {
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
        return {
          status: 'already_enqueued', inboxSeq: replay.inbox_seq, inputHash,
          roundId: coordinatedRoundId(request.address, replay.inbox_seq, request.idempotencyKey, inputHash),
        }
      }
      this.#assertNotQuarantined(request.address, key, request.correlationId)
      this.#assertAdmissionOpen(request.address, key, request.correlationId)
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
      return {
        status: 'enqueued', inboxSeq, inputHash,
        roundId: coordinatedRoundId(request.address, inboxSeq, request.idempotencyKey, inputHash),
      }
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
      this.#assertCurrentLease(address, key, ownerId, fencingToken)
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
    proof: RoundCommitProof,
    result: WorldJsonValue,
  ): CompleteRoundResult {
    const key = worldAddressKey(address)
    const resultHash = hashWorldJson('player-round-result', result)
    const resultText = worldJsonText(result)
    if (boundBundleHash(result) !== proof.bundleHash) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'Round result is not bound to its authoritative commit bundle',
        retryable: false,
        correlationId: `round-inbox:${key}:${inboxSeq}`,
        address,
      })
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#assertCurrentLease(address, key, ownerId, fencingToken)
      const current = this.#db.prepare(`
        SELECT status, claim_owner_id, claim_fencing_token, result_hash, result_json,
          commit_transaction_id, commit_bundle_hash
        FROM round_inbox WHERE address_key = ? AND inbox_seq = ?
      `).get(key, inboxSeq) as {
        status: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled'
        claim_owner_id: string | null
        claim_fencing_token: number | null
        result_hash: WorldHash | null
        result_json: string | null
        commit_transaction_id: string | null
        commit_bundle_hash: WorldHash | null
      } | undefined
      if (current?.status === 'completed') {
        if (
          current.result_hash !== resultHash
          || current.result_json !== resultText
          || current.commit_transaction_id !== proof.transactionId
          || current.commit_bundle_hash !== proof.bundleHash
        ) this.#completionConflict(address, key)
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
      const commit = this.#db.prepare(`
        SELECT bundle_hash FROM round_commits WHERE transaction_id = ? AND address_key = ?
      `).get(proof.transactionId, key) as { bundle_hash: WorldHash } | undefined
      if (commit?.bundle_hash !== proof.bundleHash) {
        failWorld({
          errorCode: 'BUNDLE_HASH_MISMATCH',
          category: 'integrity',
          message: 'Round completion has no matching authoritative commit proof',
          retryable: false,
          correlationId: `round-inbox:${key}:${inboxSeq}`,
          address,
        })
      }
      this.#db.prepare(`
        UPDATE round_inbox SET status = 'completed', result_hash = ?, result_json = ?,
          commit_transaction_id = ?, commit_bundle_hash = ?
        WHERE address_key = ? AND inbox_seq = ?
      `).run(resultHash, resultText, proof.transactionId, proof.bundleHash, key, inboxSeq)
      this.#db.exec('COMMIT')
      return { status: 'completed', resultHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  readCompleted(address: WorldAddress, idempotencyKey: string): WorldJsonValue | undefined {
    const row = this.#db.prepare(`
      SELECT result_json, result_hash, commit_transaction_id, commit_bundle_hash FROM round_inbox
      WHERE address_key = ? AND idempotency_key = ? AND status = 'completed'
    `).get(worldAddressKey(address), idempotencyKey) as {
      result_json: string
      result_hash: WorldHash
      commit_transaction_id: string | null
      commit_bundle_hash: WorldHash | null
    } | undefined
    if (row === undefined) return undefined
    const result = parseWorldJson(row.result_json)
    const resultText = worldJsonText(result)
    const resultHash = hashWorldJson('player-round-result', result)
    if (
      resultText !== row.result_json
      || resultHash !== row.result_hash
      || boundBundleHash(result) !== row.commit_bundle_hash
      || row.commit_transaction_id === null
      || row.commit_bundle_hash === null
    ) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'completed Round result or commit proof is corrupt',
        retryable: false,
        correlationId: `round-inbox:${worldAddressKey(address)}:${idempotencyKey}`,
        address,
      })
    }
    const commit = this.#db.prepare(`
      SELECT bundle_hash FROM round_commits WHERE transaction_id = ? AND address_key = ?
    `).get(row.commit_transaction_id, worldAddressKey(address)) as { bundle_hash: WorldHash } | undefined
    if (commit?.bundle_hash !== row.commit_bundle_hash) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'completed Round commit proof is missing or divergent',
        retryable: false,
        correlationId: `round-inbox:${worldAddressKey(address)}:${idempotencyKey}`,
        address,
      })
    }
    return result
  }

  readStatus(address: WorldAddress, lookup: RoundLookup): DurableRoundStatus | undefined {
    const row = this.#findStatusRow(address, lookup)
    if (row === undefined) return undefined
    const result = row.result_json === null ? null : parseWorldJson(row.result_json)
    if (result !== null && hashWorldJson('player-round-result', result) !== row.result_hash) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'Round status result is corrupt',
        retryable: false, correlationId: `round-status:${worldAddressKey(address)}:${row.inbox_seq}`, address,
      })
    }
    const status = row.status === 'pending' ? 'queued' : row.status === 'claimed' ? 'processing' : row.status === 'completed' ? 'committed' : row.status
    return {
      status, inboxSeq: row.inbox_seq, idempotencyKey: row.idempotency_key,
      roundId: coordinatedRoundId(address, row.inbox_seq, row.idempotency_key, row.input_hash), result,
    }
  }

  cancelQueued(address: WorldAddress, lookup: RoundLookup, correlationId: string): DurableRoundStatus {
    const key = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#findStatusRow(address, lookup)
      if (row === undefined) throw new Error('unknown Round')
      if (row.status === 'cancelled') {
        this.#db.exec('COMMIT')
        return this.readStatus(address, { idempotencyKey: row.idempotency_key })!
      }
      if (row.status !== 'pending') {
        failWorld({
          errorCode: 'ROUND_NOT_CANCELLABLE', category: 'admission', message: 'only a queued Round can be cancelled',
          retryable: false, correlationId, address,
          roundId: coordinatedRoundId(address, row.inbox_seq, row.idempotency_key, row.input_hash),
        })
      }
      const result = { status: 'cancelled', reason: 'cancelled_before_claim' } as const
      this.#db.prepare(`
        UPDATE round_inbox SET status = 'cancelled', result_hash = ?, result_json = ?
        WHERE address_key = ? AND inbox_seq = ? AND status = 'pending'
      `).run(hashWorldJson('player-round-result', result), worldJsonText(result), key, row.inbox_seq)
      this.#db.prepare(`
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, 'round.cancelled', ?, ?, ?)
      `).run(key, correlationId, worldJsonText({ inboxSeq: row.inbox_seq, idempotencyKey: row.idempotency_key }), this.now())
      this.#db.exec('COMMIT')
      return this.readStatus(address, { idempotencyKey: row.idempotency_key })!
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Discover active Branch FIFOs that need a post-restart drain. */
  unfinishedAddresses(): WorldAddress[] {
    return (this.#db.prepare(`
      SELECT DISTINCT b.tenant_id, b.world_id, b.branch_id
      FROM round_inbox i
      JOIN branches b ON b.address_key = i.address_key
      JOIN branch_controls c ON c.address_key = i.address_key
      WHERE i.status IN ('pending', 'claimed') AND c.runtime_phase = 'active'
      ORDER BY b.tenant_id, b.world_id, b.branch_id
    `).all() as Array<{ tenant_id: string; world_id: string; branch_id: string }>).map(row => ({
      tenantId: brandId(row.tenant_id, 'TenantId'),
      worldId: brandId(row.world_id, 'WorldId'),
      branchId: brandId(row.branch_id, 'BranchId'),
    }))
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

  #findStatusRow(address: WorldAddress, lookup: RoundLookup): StatusRow | undefined {
    if ((lookup.idempotencyKey === undefined) === (lookup.roundId === undefined)) throw new TypeError('Round lookup requires exactly one selector')
    const rows = this.#db.prepare(`
      SELECT inbox_seq, idempotency_key, principal_id, input_json, input_hash, status, result_json, result_hash
      FROM round_inbox WHERE address_key = ? ORDER BY inbox_seq
    `).all(worldAddressKey(address)) as unknown as StatusRow[]
    if (lookup.idempotencyKey !== undefined) {
      this.#validateText(lookup.idempotencyKey, 'idempotencyKey')
      return rows.find(row => row.idempotency_key === lookup.idempotencyKey)
    }
    return rows.find(row => coordinatedRoundId(address, row.inbox_seq, row.idempotency_key, row.input_hash) === lookup.roundId)
  }

  #validateText(value: string, name: string): void {
    assertProtocolString(value, name)
  }

  #requireBranch(key: string): void {
    if (this.#db.prepare(`SELECT 1 AS present FROM branches WHERE address_key = ?`).get(key) === undefined) {
      throw new Error(`unknown world branch ${key}`)
    }
  }

  #assertAdmissionOpen(address: WorldAddress, key: string, correlationId: string): void {
    const control = this.#db.prepare(`
      SELECT admission_state, lifecycle_state FROM branch_controls WHERE address_key = ?
    `).get(key) as {
      admission_state: 'open' | 'draining'
      lifecycle_state: 'active' | 'archived'
    } | undefined
    if (control === undefined) throw new Error(`unknown world branch ${key}`)
    if (control.admission_state === 'open' && control.lifecycle_state === 'active') return
    failWorld({
      errorCode: 'BRANCH_DRAINING',
      category: 'admin',
      message: control.lifecycle_state === 'archived' ? 'branch is archived' : 'branch admission is draining',
      retryable: control.lifecycle_state !== 'archived',
      correlationId,
      address,
    })
  }

  #assertNotQuarantined(address: WorldAddress, key: string, correlationId: string): void {
    const control = this.#db.prepare(`SELECT runtime_phase FROM branch_controls WHERE address_key = ?`).get(key) as {
      runtime_phase: 'active' | 'maintenance' | 'quarantined' | 'archived'
    } | undefined
    if (control?.runtime_phase !== 'quarantined' && control?.runtime_phase !== 'maintenance') return
    failWorld({
      errorCode: control.runtime_phase === 'quarantined' ? 'BRANCH_QUARANTINED' : 'BRANCH_DRAINING',
      category: 'admin', message: `branch runtime phase is ${control.runtime_phase}`, retryable: false,
      correlationId, address,
    })
  }

  #assertCurrentLease(address: WorldAddress, key: string, ownerId: string, fencingToken: number): void {
    const lease = this.#db.prepare(`
      SELECT owner_id, fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?
    `).get(key) as { owner_id: string; fencing_token: number; expires_at_ms: number } | undefined
    if (
      lease === undefined
      || lease.owner_id !== ownerId
      || lease.fencing_token !== fencingToken
      || lease.expires_at_ms <= this.now()
    ) {
      failWorld({
        errorCode: 'WRITER_LEASE_LOST',
        category: 'runtime',
        message: 'Round Inbox operation is not owned by the current Writer Lease',
        retryable: true,
        correlationId: `round-inbox:${key}`,
        address,
      })
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
