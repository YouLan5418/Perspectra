import type { DatabaseSync } from 'node:sqlite'
import {
  hashWorldJson,
  worldAddressKey,
  type ProjectionBundle,
  type ProjectionKind,
  type ProjectionRecord,
  type StoredWorldEvent,
  type WorldAddress,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openOwnedDatabase, parseWorldJson, PROJECTION_APPLICATION_ID, rollbackAndThrow, worldJsonText } from './sqlite.ts'
import type { WorldStore } from './world-store.ts'

const PROJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_records (
  address_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('observation', 'claim', 'goal', 'visibility')),
  record_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  valid_from_seq INTEGER NOT NULL,
  valid_to_seq INTEGER,
  PRIMARY KEY(address_key, kind, record_id, valid_from_seq),
  CHECK(valid_to_seq IS NULL OR valid_to_seq > valid_from_seq)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS projection_records_one_current
  ON projection_records(address_key, kind, record_id) WHERE valid_to_seq IS NULL;
`

function projectionOperation(event: StoredWorldEvent): { kind: ProjectionKind; operation: 'upsert' | 'remove'; id: string; value?: WorldJsonValue } | undefined {
  const match = /^(observation|claim|goal|visibility)\.(upsert|remove)$/.exec(event.eventType)
  if (match === null) return undefined
  const data = event.data as WorldJsonObject
  const id = data.id
  if (typeof id !== 'string') throw new Error(`${event.eventType} requires a string id`)
  const kind = match[1] as ProjectionKind
  const operation = match[2] as 'upsert' | 'remove'
  if (operation === 'upsert' && data.value === undefined) throw new Error(`${event.eventType} requires value`)
  return operation === 'upsert' ? { kind, operation, id, value: data.value as WorldJsonValue } : { kind, operation, id }
}

function emptyState(): Record<ProjectionKind, Map<string, ProjectionRecord>> {
  return {
    observation: new Map(),
    claim: new Map(),
    goal: new Map(),
    visibility: new Map(),
  }
}

/** Temporal SQLite projection owner used to compare materialized and replayed views. */
export class ProjectionStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openOwnedDatabase(path, PROJECTION_APPLICATION_ID, PROJECTION_SCHEMA)
  }

  /** Replace one branch's derived rows from a verified effective event prefix. */
  replaceFromEvents(address: WorldAddress, events: readonly StoredWorldEvent[]): void {
    const key = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('DELETE FROM projection_records WHERE address_key = ?').run(key)
      for (const event of events) this.#apply(key, event)
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Query all records valid at the exact world sequence. */
  readAt(address: WorldAddress, asOfSeq: number): ProjectionRecord[] {
    const rows = this.#db.prepare(`
      SELECT kind, record_id, value_json, source_seq
      FROM projection_records
      WHERE address_key = ? AND valid_from_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
      ORDER BY kind, record_id
    `).all(worldAddressKey(address), asOfSeq, asOfSeq) as Array<{
      kind: ProjectionKind
      record_id: string
      value_json: string
      source_seq: number
    }>
    return rows.map(row => ({ kind: row.kind, id: row.record_id, value: parseWorldJson(row.value_json), sourceSeq: row.source_seq }))
  }

  close(): void {
    this.#db.close()
  }

  #apply(addressKey: string, event: StoredWorldEvent): void {
    const change = projectionOperation(event)
    if (change === undefined) return
    this.#db.prepare(`
      UPDATE projection_records SET valid_to_seq = ?
      WHERE address_key = ? AND kind = ? AND record_id = ? AND valid_to_seq IS NULL
    `).run(event.seq, addressKey, change.kind, change.id)
    if (change.operation === 'remove') return
    this.#db.prepare(`
      INSERT INTO projection_records(address_key, kind, record_id, value_json, source_seq, valid_from_seq, valid_to_seq)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(addressKey, change.kind, change.id, worldJsonText(change.value as WorldJsonValue), event.seq, event.seq)
  }
}

/** Pure event replay for fork-point CharacterView components. */
export class ProjectionRebuilder {
  constructor(private readonly worldStore: WorldStore) {}

  /** Rebuild Observation, Claim, Goal, and Visibility exactly as of forkSeq. */
  rebuildAt(address: WorldAddress, forkSeq: number, heartbeat?: () => void): ProjectionBundle {
    const state = emptyState()
    for (const [index, event] of this.worldStore.readEvents(address, forkSeq).entries()) {
      if (index % 128 === 0) heartbeat?.()
      const change = projectionOperation(event)
      if (change === undefined) continue
      if (change.operation === 'remove') {
        state[change.kind].delete(change.id)
      } else {
        state[change.kind].set(change.id, { kind: change.kind, id: change.id, value: change.value as WorldJsonValue, sourceSeq: event.seq })
      }
    }
    heartbeat?.()
    const sorted = (kind: ProjectionKind): ProjectionRecord[] => [...state[kind].keys()].sort().map(id => state[kind].get(id) as ProjectionRecord)
    const observations = sorted('observation')
    const claims = sorted('claim')
    const goals = sorted('goal')
    const visibility = sorted('visibility')
    const base = { address, asOfWorldSeq: forkSeq, observations, claims, goals, visibility }
    return { ...base, bundleHash: hashWorldJson('world-projection-bundle', base) }
  }
}
