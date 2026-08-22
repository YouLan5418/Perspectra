import type { DatabaseSync } from 'node:sqlite'
import { assertProtocolString, failWorld, worldAddressKey, type WorldAddress } from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { rollbackAndThrow } from './sqlite.ts'

export interface WriterLease {
  readonly ownerId: string
  readonly fencingToken: number
  readonly expiresAtMs: number
}

/** Durable database lease with monotonically increasing fencing tokens. */
export class WriterLeaseService {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly now: () => number = Date.now) {
    this.#db = openWorldDatabase(path)
  }

  acquire(address: WorldAddress, ownerId: string, ttlMs = 30_000): WriterLease {
    this.#validate(ownerId, ttlMs)
    const key = worldAddressKey(address)
    const now = this.now()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#requireBranch(key)
      this.#db.prepare(`
        INSERT INTO writer_lease_counters(address_key, next_fencing_token) VALUES (?, 1)
        ON CONFLICT(address_key) DO NOTHING
      `).run(key)
      const current = this.#db.prepare(`
        SELECT owner_id, fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?
      `).get(key) as { owner_id: string; fencing_token: number; expires_at_ms: number } | undefined
      if (current !== undefined && current.expires_at_ms > now) {
        if (current.owner_id !== ownerId) {
          failWorld({
            errorCode: 'WORLDSTORE_BUSY',
            category: 'persistence',
            message: 'another writer owns the branch lease',
            retryable: true,
            correlationId: `lease:${key}`,
            address,
            details: { expiresAtMs: current.expires_at_ms },
          })
        }
        this.#db.exec('COMMIT')
        return { ownerId, fencingToken: current.fencing_token, expiresAtMs: current.expires_at_ms }
      }
      const counter = this.#db.prepare(`
        SELECT next_fencing_token FROM writer_lease_counters WHERE address_key = ?
      `).get(key) as { next_fencing_token: number }
      const fencingToken = counter.next_fencing_token
      const expiresAtMs = now + ttlMs
      this.#db.prepare(`UPDATE writer_lease_counters SET next_fencing_token = ? WHERE address_key = ?`).run(fencingToken + 1, key)
      this.#db.prepare(`
        INSERT INTO writer_leases(address_key, owner_id, fencing_token, expires_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(address_key) DO UPDATE SET owner_id = excluded.owner_id,
          fencing_token = excluded.fencing_token, expires_at_ms = excluded.expires_at_ms
      `).run(key, ownerId, fencingToken, expiresAtMs)
      this.#db.exec('COMMIT')
      return { ownerId, fencingToken, expiresAtMs }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  renew(address: WorldAddress, ownerId: string, fencingToken: number, ttlMs = 30_000): WriterLease {
    this.#validate(ownerId, ttlMs)
    const key = worldAddressKey(address)
    const now = this.now()
    const expiresAtMs = now + ttlMs
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#db.prepare(`
        UPDATE writer_leases SET expires_at_ms = ?
        WHERE address_key = ? AND owner_id = ? AND fencing_token = ? AND expires_at_ms > ?
      `).run(expiresAtMs, key, ownerId, fencingToken, now)
      if (result.changes !== 1) this.#lost(address, key)
      this.#db.exec('COMMIT')
      return { ownerId, fencingToken, expiresAtMs }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  release(address: WorldAddress, ownerId: string, fencingToken: number): boolean {
    const result = this.#db.prepare(`
      DELETE FROM writer_leases WHERE address_key = ? AND owner_id = ? AND fencing_token = ?
    `).run(worldAddressKey(address), ownerId, fencingToken)
    return result.changes === 1
  }

  close(): void {
    this.#db.close()
  }

  #validate(ownerId: string, ttlMs: number): void {
    assertProtocolString(ownerId, 'ownerId')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be a positive safe integer')
  }

  #requireBranch(key: string): void {
    if (this.#db.prepare(`SELECT 1 AS present FROM branches WHERE address_key = ?`).get(key) === undefined) {
      throw new Error(`unknown world branch ${key}`)
    }
  }

  #lost(address: WorldAddress, key: string): never {
    failWorld({
      errorCode: 'WRITER_LEASE_LOST',
      category: 'runtime',
      message: 'writer lease cannot be renewed because it expired or was fenced',
      retryable: true,
      correlationId: `lease:${key}`,
      address,
    })
  }
}
