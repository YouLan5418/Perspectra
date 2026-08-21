import type { DatabaseSync } from 'node:sqlite'
import {
  deterministicId,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openOwnedDatabase, parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'

const SNAPSHOT_APPLICATION_ID = 0x4843574e
const SNAPSHOT_SCHEMA = `
CREATE TABLE snapshot_bundles (
  address_key TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL CHECK(as_of_seq >= 0),
  bundle_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'retired')),
  PRIMARY KEY(address_key, snapshot_id),
  UNIQUE(address_key, as_of_seq)
) STRICT;
CREATE TABLE snapshot_units (
  address_key TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  unit_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  PRIMARY KEY(address_key, snapshot_id, unit_name),
  FOREIGN KEY(address_key, snapshot_id) REFERENCES snapshot_bundles(address_key, snapshot_id)
) STRICT;
`

export interface SnapshotBundle extends WorldJsonObject {
  readonly snapshotId: string
  readonly address: WorldAddress
  readonly asOfSeq: number
  readonly status: 'ready' | 'retired'
  readonly units: WorldJsonObject
  readonly bundleHash: WorldHash
}

export interface CreateSnapshotResult {
  readonly status: 'created' | 'already_created'
  readonly bundle: SnapshotBundle
}

/** Independent, disposable acceleration store; it never mutates the WorldLog. */
export class SnapshotStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = openOwnedDatabase(path, SNAPSHOT_APPLICATION_ID, SNAPSHOT_SCHEMA)
  }

  create(address: WorldAddress, asOfSeq: number, units: WorldJsonObject, correlationId: string): CreateSnapshotResult {
    if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0) throw new RangeError('snapshot asOfSeq must be a non-negative safe integer')
    const entries = Object.entries(units).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0 || entries.some(([name]) => name.length === 0)) throw new TypeError('snapshot requires named units')
    const unitHashes = entries.map(([name, content]) => ({ name, hash: hashWorldJson(`snapshot-unit/${name}`, content as WorldJsonValue) }))
    const bundleHash = hashWorldJson('snapshot-bundle', { address, asOfSeq, unitHashes })
    const snapshotId = deterministicId('snapshot', { address, asOfSeq, bundleHash })
    const key = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db.prepare(`
        SELECT snapshot_id, bundle_hash FROM snapshot_bundles WHERE address_key = ? AND as_of_seq = ?
      `).get(key, asOfSeq) as { snapshot_id: string; bundle_hash: WorldHash } | undefined
      if (existing !== undefined) {
        if (existing.snapshot_id !== snapshotId || existing.bundle_hash !== bundleHash) {
          failWorld({
            errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'snapshot boundary is bound to different units',
            retryable: false, correlationId, address,
          })
        }
        const bundle = this.read(address, snapshotId)
        this.#db.exec('COMMIT')
        return { status: 'already_created', bundle }
      }
      this.#db.prepare(`
        INSERT INTO snapshot_bundles(address_key, snapshot_id, as_of_seq, bundle_hash, status)
        VALUES (?, ?, ?, ?, 'ready')
      `).run(key, snapshotId, asOfSeq, bundleHash)
      for (const [index, [name, content]] of entries.entries()) {
        this.#db.prepare(`
          INSERT INTO snapshot_units(address_key, snapshot_id, unit_name, unit_hash, content_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(key, snapshotId, name, unitHashes[index]!.hash, worldJsonText(content as WorldJsonValue))
      }
      this.#db.exec('COMMIT')
      return { status: 'created', bundle: { snapshotId, address, asOfSeq, status: 'ready', units, bundleHash } }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  latest(address: WorldAddress): SnapshotBundle | undefined {
    const row = this.#db.prepare(`
      SELECT snapshot_id FROM snapshot_bundles
      WHERE address_key = ? AND status = 'ready' ORDER BY as_of_seq DESC LIMIT 1
    `).get(worldAddressKey(address)) as { snapshot_id: string } | undefined
    return row === undefined ? undefined : this.read(address, row.snapshot_id)
  }

  read(address: WorldAddress, snapshotId: string): SnapshotBundle {
    return this.#read(address, snapshotId)
  }

  retireBefore(address: WorldAddress, minimumAsOfSeq: number): number {
    if (!Number.isSafeInteger(minimumAsOfSeq) || minimumAsOfSeq < 0) throw new RangeError('retention boundary must be a non-negative safe integer')
    const result = this.#db.prepare(`
      UPDATE snapshot_bundles SET status = 'retired'
      WHERE address_key = ? AND as_of_seq < ? AND status = 'ready'
    `).run(worldAddressKey(address), minimumAsOfSeq)
    return Number(result.changes)
  }

  close(): void {
    this.#db.close()
  }

  #read(address: WorldAddress, snapshotId: string): SnapshotBundle {
    const key = worldAddressKey(address)
    const header = this.#db.prepare(`
      SELECT as_of_seq, bundle_hash, status FROM snapshot_bundles WHERE address_key = ? AND snapshot_id = ?
    `).get(key, snapshotId) as { as_of_seq: number; bundle_hash: WorldHash; status: SnapshotBundle['status'] } | undefined
    if (header === undefined) throw new Error('snapshot header is missing')
    const rows = this.#db.prepare(`
      SELECT unit_name, unit_hash, content_json FROM snapshot_units
      WHERE address_key = ? AND snapshot_id = ? ORDER BY unit_name
    `).all(key, snapshotId) as Array<{ unit_name: string; unit_hash: WorldHash; content_json: string }>
    if (rows.length === 0) throw new Error('snapshot has no units')
    const units: Record<string, WorldJsonValue> = {}
    const unitHashes = rows.map(row => {
      const content = parseWorldJson(row.content_json)
      const actual = hashWorldJson(`snapshot-unit/${row.unit_name}`, content)
      if (actual !== row.unit_hash) throw new Error(`snapshot unit ${row.unit_name} is corrupt`)
      units[row.unit_name] = content
      return { name: row.unit_name, hash: actual }
    })
    const actualBundleHash = hashWorldJson('snapshot-bundle', { address, asOfSeq: header.as_of_seq, unitHashes })
    if (actualBundleHash !== header.bundle_hash) throw new Error('snapshot bundle hash is corrupt')
    return {
      snapshotId,
      address,
      asOfSeq: header.as_of_seq,
      status: header.status,
      units,
      bundleHash: header.bundle_hash,
    }
  }
}
