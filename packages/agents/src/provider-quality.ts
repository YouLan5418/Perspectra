import { DatabaseSync } from 'node:sqlite'
import {
  assertProtocolString,
  canonicalizeWorldJson,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'

const QUALITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_quality_state (
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  eligible_ticks INTEGER NOT NULL CHECK(eligible_ticks >= 0),
  response_invalid_streak INTEGER NOT NULL CHECK(response_invalid_streak >= 0),
  response_backoff_level INTEGER NOT NULL CHECK(response_backoff_level BETWEEN 0 AND 4),
  response_backoff_remaining INTEGER NOT NULL CHECK(response_backoff_remaining >= 0),
  reflection_invalid_streak INTEGER NOT NULL CHECK(reflection_invalid_streak >= 0),
  reflection_suspension_remaining INTEGER NOT NULL CHECK(reflection_suspension_remaining >= 0),
  state_hash TEXT NOT NULL,
  PRIMARY KEY(namespace_key, participant_id)
) STRICT;
CREATE TABLE IF NOT EXISTS provider_quality_audit (
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  details_json TEXT NOT NULL,
  operational_time_ms INTEGER NOT NULL,
  previous_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE IF NOT EXISTS provider_quality_outcomes (
  namespace_key TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('response', 'reflection')),
  outcome_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('valid', 'invalid')),
  PRIMARY KEY(namespace_key, participant_id, outcome_kind, outcome_id)
) STRICT;
`

export type ProviderQualityResponseMode = 'normal' | 'skip' | 'probe'
export type ProviderQualityReflectionMode = 'normal' | 'suspended' | 'probe'

interface ProviderQualityStateInput extends WorldJsonObject {
  readonly address: WorldAddress
  readonly participantId: string
  readonly eligibleTicks: number
  readonly responseInvalidStreak: number
  readonly responseBackoffLevel: number
  readonly responseBackoffRemaining: number
  readonly reflectionInvalidStreak: number
  readonly reflectionSuspensionRemaining: number
}

export interface ProviderQualityState extends ProviderQualityStateInput {
  readonly stateHash: WorldHash
}

export interface ProviderQualityDecision extends WorldJsonObject {
  readonly state: ProviderQualityState
  readonly responseMode: ProviderQualityResponseMode
  readonly reflectionMode: ProviderQualityReflectionMode
}

export interface ProviderQualityAuditRecord extends WorldJsonObject {
  readonly auditSeq: number
  readonly address: WorldAddress
  readonly participantId: string
  readonly operation: string
  readonly details: WorldJsonObject
  readonly operationalTimeMs: number
  readonly previousHash: WorldHash | 'genesis'
  readonly recordHash: WorldHash
}

interface QualityRow {
  readonly namespace_key: string
  readonly participant_id: string
  readonly eligible_ticks: number
  readonly response_invalid_streak: number
  readonly response_backoff_level: number
  readonly response_backoff_remaining: number
  readonly reflection_invalid_streak: number
  readonly reflection_suspension_remaining: number
  readonly state_hash: WorldHash
}

function jsonText(value: WorldJsonObject): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function addressFromKey(key: string): WorldAddress {
  const [tenantId, worldId, branchId] = key.split('\u001f')
  return { tenantId, worldId, branchId } as WorldAddress
}

function stateInput(row: Omit<QualityRow, 'state_hash'>): ProviderQualityStateInput {
  return {
    address: addressFromKey(row.namespace_key), participantId: row.participant_id,
    eligibleTicks: row.eligible_ticks,
    responseInvalidStreak: row.response_invalid_streak,
    responseBackoffLevel: row.response_backoff_level,
    responseBackoffRemaining: row.response_backoff_remaining,
    reflectionInvalidStreak: row.reflection_invalid_streak,
    reflectionSuspensionRemaining: row.reflection_suspension_remaining,
  }
}

function stateHash(input: ProviderQualityStateInput): WorldHash {
  return hashWorldJson('provider-quality-state/v1', input)
}

/** Durable provider-quality/v1 eligible-Tick, suspension, probe, and backoff state machine. */
export class ProviderQualityStore {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly now: () => number = Date.now) {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < 0 || version > 4) {
      this.#db.close()
      throw new Error(`unsupported Context derivation schema version ${version}`)
    }
    this.#db.exec(QUALITY_SCHEMA)
    if (version < 4) this.#db.exec('PRAGMA user_version=4')
  }

  state(address: WorldAddress, participantId: string): ProviderQualityState {
    this.#validateParticipant(participantId)
    this.#ensure(address, participantId)
    return this.#read(address, participantId)
  }

  beginEligibleTick(address: WorldAddress, participantId: string): ProviderQualityDecision {
    this.#validateParticipant(participantId)
    const changed = this.#mutate(address, participantId, 'provider-quality.eligible-tick', (current) => {
      const responseMode = current.responseBackoffRemaining > 0
        ? 'skip' as const
        : current.responseInvalidStreak >= 3 ? 'probe' as const : 'normal' as const
      const reflectionMode = current.reflectionSuspensionRemaining > 0
        ? 'suspended' as const
        : current.reflectionInvalidStreak >= 3 ? 'probe' as const : 'normal' as const
      return {
        next: {
          ...current,
          eligibleTicks: current.eligibleTicks + 1,
          responseBackoffRemaining: Math.max(0, current.responseBackoffRemaining - 1),
          reflectionSuspensionRemaining: Math.max(0, current.reflectionSuspensionRemaining - 1),
        },
        details: { responseMode, reflectionMode },
        result: { responseMode, reflectionMode },
      }
    })
    return { state: changed.state, ...changed.result }
  }

  recordResponse(
    address: WorldAddress,
    participantId: string,
    outcomeId: string,
    result: 'valid' | 'invalid',
  ): ProviderQualityState {
    this.#validateParticipant(participantId)
    assertProtocolString(outcomeId, 'provider quality response outcomeId')
    return this.#mutate(address, participantId, `provider-quality.response-${result}`, (current) => {
      if (result === 'valid') {
        return {
          next: { ...current, responseInvalidStreak: 0, responseBackoffLevel: 0, responseBackoffRemaining: 0 },
          details: { result }, result: undefined,
        }
      }
      const streak = current.responseInvalidStreak + 1
      const level = streak < 3 ? current.responseBackoffLevel : Math.min(4, current.responseBackoffLevel + 1)
      const remaining = streak < 3 ? current.responseBackoffRemaining : 2 ** (level - 1)
      return {
        next: {
          ...current,
          responseInvalidStreak: streak,
          responseBackoffLevel: level,
          responseBackoffRemaining: remaining,
        },
        details: { result, backoffEligibleTicks: remaining }, result: undefined,
      }
    }, { kind: 'response', id: outcomeId, result }).state
  }

  recordReflection(
    address: WorldAddress,
    participantId: string,
    outcomeId: string,
    result: 'valid' | 'invalid',
  ): ProviderQualityState {
    this.#validateParticipant(participantId)
    assertProtocolString(outcomeId, 'provider quality reflection outcomeId')
    return this.#mutate(address, participantId, `provider-quality.reflection-${result}`, (current) => {
      if (result === 'valid') {
        return {
          next: { ...current, reflectionInvalidStreak: 0, reflectionSuspensionRemaining: 0 },
          details: { result }, result: undefined,
        }
      }
      const streak = current.reflectionInvalidStreak + 1
      return {
        next: {
          ...current,
          reflectionInvalidStreak: streak,
          reflectionSuspensionRemaining: streak >= 3 ? 4 : current.reflectionSuspensionRemaining,
        },
        details: { result, suspensionEligibleTicks: streak >= 3 ? 4 : 0 }, result: undefined,
      }
    }, { kind: 'reflection', id: outcomeId, result }).state
  }

  readAudit(address: WorldAddress, participantId: string): readonly ProviderQualityAuditRecord[] {
    this.#validateParticipant(participantId)
    const rows = this.#db.prepare(`
      SELECT * FROM provider_quality_audit
      WHERE namespace_key = ? AND participant_id = ? ORDER BY audit_seq
    `).all(worldAddressKey(address), participantId) as Array<{
      audit_seq: number; namespace_key: string; participant_id: string; operation: string; details_json: string;
      operational_time_ms: number; previous_hash: WorldHash | 'genesis'; record_hash: WorldHash
    }>
    let previousHash: WorldHash | 'genesis' = 'genesis'
    return rows.map((row) => {
      const details = JSON.parse(row.details_json) as WorldJsonObject
      const input = {
        address: addressFromKey(row.namespace_key), participantId: row.participant_id,
        operation: row.operation, details, operationalTimeMs: row.operational_time_ms, previousHash,
      }
      const expected = hashWorldJson('provider-quality-audit/v1', input)
      if (row.previous_hash !== previousHash || row.record_hash !== expected) this.#integrity(address, participantId)
      previousHash = row.record_hash
      return {
        auditSeq: row.audit_seq, ...input, recordHash: row.record_hash,
      }
    })
  }

  close(): void {
    this.#db.close()
  }

  #mutate<Result>(
    address: WorldAddress,
    participantId: string,
    operation: string,
    update: (state: ProviderQualityState) => {
      readonly next: ProviderQualityStateInput
      readonly details: WorldJsonObject
      readonly result: Result
    },
    outcome?: { readonly kind: 'response' | 'reflection'; readonly id: string; readonly result: 'valid' | 'invalid' },
  ): { readonly state: ProviderQualityState; readonly result: Result } {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#ensure(address, participantId)
      const current = this.#read(address, participantId)
      const change = update(current)
      if (outcome !== undefined) {
        const existing = this.#db.prepare(`
          SELECT result FROM provider_quality_outcomes
          WHERE namespace_key = ? AND participant_id = ? AND outcome_kind = ? AND outcome_id = ?
        `).get(worldAddressKey(address), participantId, outcome.kind, outcome.id) as { result: string } | undefined
        if (existing !== undefined) {
          if (existing.result !== outcome.result) this.#integrity(address, participantId)
          this.#db.exec('COMMIT')
          return { state: current, result: change.result }
        }
      }
      const { stateHash: _ignored, ...next } = change.next as ProviderQualityState
      const hash = stateHash(next)
      this.#db.prepare(`
        UPDATE provider_quality_state SET
          eligible_ticks = ?, response_invalid_streak = ?, response_backoff_level = ?,
          response_backoff_remaining = ?, reflection_invalid_streak = ?,
          reflection_suspension_remaining = ?, state_hash = ?
        WHERE namespace_key = ? AND participant_id = ?
      `).run(
        next.eligibleTicks, next.responseInvalidStreak, next.responseBackoffLevel,
        next.responseBackoffRemaining, next.reflectionInvalidStreak,
        next.reflectionSuspensionRemaining, hash, worldAddressKey(address), participantId,
      )
      this.#appendAudit(address, participantId, operation, change.details)
      if (outcome !== undefined) {
        this.#db.prepare(`
          INSERT INTO provider_quality_outcomes(namespace_key, participant_id, outcome_kind, outcome_id, result)
          VALUES (?, ?, ?, ?, ?)
        `).run(worldAddressKey(address), participantId, outcome.kind, outcome.id, outcome.result)
      }
      this.#db.exec('COMMIT')
      return { state: { ...next, stateHash: hash }, result: change.result }
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #ensure(address: WorldAddress, participantId: string): void {
    const input = {
      address, participantId, eligibleTicks: 0,
      responseInvalidStreak: 0, responseBackoffLevel: 0, responseBackoffRemaining: 0,
      reflectionInvalidStreak: 0, reflectionSuspensionRemaining: 0,
    }
    this.#db.prepare(`
      INSERT OR IGNORE INTO provider_quality_state(
        namespace_key, participant_id, eligible_ticks, response_invalid_streak,
        response_backoff_level, response_backoff_remaining, reflection_invalid_streak,
        reflection_suspension_remaining, state_hash
      ) VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?)
    `).run(worldAddressKey(address), participantId, stateHash(input))
  }

  #read(address: WorldAddress, participantId: string): ProviderQualityState {
    const row = this.#db.prepare(`
      SELECT * FROM provider_quality_state WHERE namespace_key = ? AND participant_id = ?
    `).get(worldAddressKey(address), participantId) as unknown as QualityRow
    const input = stateInput(row)
    if (row.state_hash !== stateHash(input)) this.#integrity(address, participantId)
    return { ...input, stateHash: row.state_hash }
  }

  #appendAudit(address: WorldAddress, participantId: string, operation: string, details: WorldJsonObject): void {
    const tail = this.#db.prepare(`
      SELECT record_hash FROM provider_quality_audit
      WHERE namespace_key = ? AND participant_id = ? ORDER BY audit_seq DESC LIMIT 1
    `).get(worldAddressKey(address), participantId) as { record_hash: WorldHash } | undefined
    const previousHash = tail?.record_hash ?? 'genesis'
    const operationalTimeMs = this.now()
    if (!Number.isSafeInteger(operationalTimeMs) || operationalTimeMs < 0) throw new RangeError('operational clock must return a non-negative safe integer')
    const recordHash = hashWorldJson('provider-quality-audit/v1', {
      address, participantId, operation, details, operationalTimeMs, previousHash,
    })
    this.#db.prepare(`
      INSERT INTO provider_quality_audit(
        namespace_key, participant_id, operation, details_json, operational_time_ms, previous_hash, record_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      worldAddressKey(address), participantId, operation, jsonText(details), operationalTimeMs, previousHash, recordHash,
    )
  }

  #validateParticipant(participantId: string): void {
    assertProtocolString(participantId, 'provider quality participantId')
  }

  #integrity(address: WorldAddress, participantId: string): never {
    failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity',
      message: 'provider quality durable state or audit chain diverged', retryable: false,
      correlationId: `provider-quality:${participantId}`, address,
    })
  }
}
