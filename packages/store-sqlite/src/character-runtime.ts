import type { DatabaseSync } from 'node:sqlite'
import {
  compareWorldText,
  worldAddressKey,
  type CharacterId,
  type CharacterRuntimeAvailability,
  type RuntimeAvailabilityState,
  type WorldAddress,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'

const STATES = new Set<RuntimeAvailabilityState>([
  'provisioning', 'ready', 'session_lag', 'model_unavailable', 'provider_output_invalid',
  'budget_unavailable', 'offline', 'disabled',
])

interface RuntimeRow {
  readonly character_id: CharacterId
  readonly state: RuntimeAvailabilityState
  readonly reason: string | null
  readonly changed_at_ms: number
}

/** Operational availability is durable local runtime state, never a World Event or world-hash input. */
export class CharacterRuntimeAvailabilityService {
  readonly #db: DatabaseSync

  constructor(path: string, private readonly now: () => number = Date.now) {
    this.#db = openWorldDatabase(path)
  }

  initialize(address: WorldAddress, states: readonly { readonly characterId: CharacterId; readonly state: RuntimeAvailabilityState }[]): void {
    const key = worldAddressKey(address)
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO character_runtime_availability(address_key, character_id, state, reason, changed_at_ms, revision)
      VALUES (?, ?, ?, NULL, ?, 0)
    `)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const value of [...states].sort((a, b) => compareWorldText(a.characterId, b.characterId))) {
        if (!STATES.has(value.state)) throw new TypeError('invalid Runtime Availability state')
        insert.run(key, value.characterId, value.state, this.now())
      }
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  set(address: WorldAddress, characterId: CharacterId, state: RuntimeAvailabilityState, reason: string | null): CharacterRuntimeAvailability {
    if (!STATES.has(state)) throw new TypeError('invalid Runtime Availability state')
    if (reason !== null && (reason.length === 0 || reason.trim() !== reason)) throw new TypeError('availability reason must be null or a non-empty, unpadded string')
    const changedAtMs = this.now()
    const result = this.#db.prepare(`
      UPDATE character_runtime_availability
      SET state = ?, reason = ?, changed_at_ms = ?, revision = revision + 1
      WHERE address_key = ? AND character_id = ?
    `).run(state, reason, changedAtMs, worldAddressKey(address), characterId)
    if (result.changes !== 1) throw new Error(`runtime availability is not initialized for ${characterId}`)
    return { address, characterId, state, reason, changedAtMs }
  }

  get(address: WorldAddress, characterId: CharacterId): CharacterRuntimeAvailability | undefined {
    const row = this.#db.prepare(`
      SELECT character_id, state, reason, changed_at_ms FROM character_runtime_availability
      WHERE address_key = ? AND character_id = ?
    `).get(worldAddressKey(address), characterId) as RuntimeRow | undefined
    return row === undefined ? undefined : { address, characterId: row.character_id, state: row.state, reason: row.reason, changedAtMs: row.changed_at_ms }
  }

  list(address: WorldAddress): CharacterRuntimeAvailability[] {
    const rows = this.#db.prepare(`
      SELECT character_id, state, reason, changed_at_ms FROM character_runtime_availability
      WHERE address_key = ? ORDER BY character_id
    `).all(worldAddressKey(address)) as unknown as RuntimeRow[]
    return rows.map(row => ({ address, characterId: row.character_id, state: row.state, reason: row.reason, changedAtMs: row.changed_at_ms }))
  }

  close(): void { this.#db.close() }
}
