import type { DatabaseSync } from 'node:sqlite'
import {
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type CommitRoundRequest,
  type CommitRoundResult,
  type FaultInjector,
  type StoredOutboxItem,
  type StoredWorldEvent,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonValue,
} from '@harness-world/contracts'
import {
  openMigratedDatabase,
  parseWorldJson,
  rollbackAndThrow,
  WORLD_APPLICATION_ID,
  worldJsonText,
} from './sqlite.ts'
import { OperationalAuditLog } from './operational-audit.ts'

export const WORLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  address_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_address_key TEXT,
  fork_seq INTEGER,
  UNIQUE(tenant_id, world_id, branch_id),
  FOREIGN KEY(parent_address_key) REFERENCES branches(address_key),
  CHECK ((parent_address_key IS NULL AND fork_seq IS NULL) OR (parent_address_key IS NOT NULL AND fork_seq >= 0))
) STRICT;
CREATE TABLE IF NOT EXISTS heads (
  address_key TEXT PRIMARY KEY,
  head_seq INTEGER NOT NULL CHECK(head_seq >= 0),
  tick INTEGER NOT NULL CHECK(tick >= 0),
  event_hash TEXT NOT NULL,
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE IF NOT EXISTS round_commits (
  transaction_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  round_id TEXT NOT NULL,
  base_head_seq INTEGER NOT NULL,
  base_tick INTEGER NOT NULL,
  head_seq INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  bundle_hash TEXT NOT NULL,
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  address_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL,
  PRIMARY KEY(address_key, seq),
  UNIQUE(transaction_id, event_ordinal),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS outbox (
  delivery_id TEXT PRIMARY KEY,
  address_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  world_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  critical INTEGER NOT NULL CHECK(critical IN (0, 1)),
  transaction_id TEXT NOT NULL,
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
`

const WORLD_LEASE_SCHEMA = `
CREATE TABLE writer_lease_counters (
  address_key TEXT PRIMARY KEY,
  next_fencing_token INTEGER NOT NULL CHECK(next_fencing_token >= 1),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE writer_leases (
  address_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
`

const WORLD_ACTIVATION_SCHEMA = `
CREATE TABLE world_manifests (
  manifest_hash TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL
) STRICT;
CREATE TABLE branch_activations (
  address_key TEXT PRIMARY KEY,
  activation_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  transaction_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  FOREIGN KEY(manifest_hash) REFERENCES world_manifests(manifest_hash),
  FOREIGN KEY(transaction_id) REFERENCES round_commits(transaction_id)
) STRICT;
`

const WORLD_ROUND_INBOX_SCHEMA = `
CREATE TABLE round_inbox_counters (
  address_key TEXT PRIMARY KEY,
  next_inbox_seq INTEGER NOT NULL CHECK(next_inbox_seq >= 1),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
CREATE TABLE round_inbox (
  address_key TEXT NOT NULL,
  inbox_seq INTEGER NOT NULL CHECK(inbox_seq >= 1),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'completed')),
  claim_owner_id TEXT,
  claim_fencing_token INTEGER,
  result_hash TEXT,
  result_json TEXT,
  PRIMARY KEY(address_key, inbox_seq),
  UNIQUE(address_key, idempotency_key),
  FOREIGN KEY(address_key) REFERENCES branches(address_key),
  CHECK (
    (status = 'pending' AND claim_owner_id IS NULL AND claim_fencing_token IS NULL AND result_hash IS NULL AND result_json IS NULL)
    OR (status = 'claimed' AND claim_owner_id IS NOT NULL AND claim_fencing_token >= 1 AND result_hash IS NULL AND result_json IS NULL)
    OR (status = 'completed' AND claim_owner_id IS NOT NULL AND claim_fencing_token >= 1 AND result_hash IS NOT NULL AND result_json IS NOT NULL)
  )
) STRICT;
`

const WORLD_OUTBOX_DELIVERY_SCHEMA = `
ALTER TABLE outbox ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(delivery_status IN ('pending', 'inflight', 'delivered', 'dead_letter'));
ALTER TABLE outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE outbox ADD COLUMN session_delivery_seq INTEGER CHECK(session_delivery_seq > 0);
ALTER TABLE outbox ADD COLUMN last_error TEXT;
CREATE TABLE outbox_session_counters (
  session_id TEXT PRIMARY KEY,
  next_delivery_seq INTEGER NOT NULL CHECK(next_delivery_seq >= 1)
) STRICT;
CREATE TABLE outbox_delivery_receipts (
  delivery_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_delivery_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  FOREIGN KEY(delivery_id) REFERENCES outbox(delivery_id)
) STRICT;
`

const WORLD_BRANCH_ADMIN_SCHEMA = `
CREATE TABLE branch_controls (
  address_key TEXT PRIMARY KEY,
  admission_state TEXT NOT NULL CHECK(admission_state IN ('open', 'draining')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active', 'archived')),
  reason TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision)
SELECT address_key, 'open', 'active', NULL, 0 FROM branches;
CREATE TABLE branch_audit_events (
  audit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  address_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  operational_time_ms INTEGER NOT NULL CHECK(operational_time_ms >= 0),
  FOREIGN KEY(address_key) REFERENCES branches(address_key)
) STRICT;
`

export const WORLD_SCHEMA_VERSION = 6

export function openWorldDatabase(path: string): DatabaseSync {
  return openMigratedDatabase(path, WORLD_APPLICATION_ID, [
    { version: 1, sql: WORLD_SCHEMA },
    { version: 2, sql: WORLD_LEASE_SCHEMA },
    { version: 3, sql: WORLD_ACTIVATION_SCHEMA },
    { version: 4, sql: WORLD_ROUND_INBOX_SCHEMA },
    { version: 5, sql: WORLD_OUTBOX_DELIVERY_SCHEMA },
    { version: WORLD_SCHEMA_VERSION, sql: WORLD_BRANCH_ADMIN_SCHEMA },
  ])
}

export interface ActivateBranchRequest {
  readonly address: WorldAddress
  readonly manifest: WorldJsonValue
  readonly manifestHash: WorldHash
  readonly genesisEvents: readonly WorldEventDraft[]
  readonly genesisHash: WorldHash
  readonly transactionId: TransactionId
  readonly roundId: CommitRoundRequest['roundId']
  readonly correlationId: string
}

export interface ActivateBranchResult {
  readonly status: 'activated' | 'already_active'
  readonly headSeq: number
  readonly tick: 0
  readonly bundleHash: WorldHash
}

interface HeadRow {
  readonly head_seq: number
  readonly tick: number
  readonly event_hash: WorldHash | 'genesis'
}

interface BranchRow {
  readonly tenant_id: string
  readonly world_id: string
  readonly branch_id: string
  readonly parent_address_key: string | null
  readonly fork_seq: number | null
}

interface EventRow {
  readonly seq: number
  readonly tick: number
  readonly event_type: string
  readonly event_version: number
  readonly data_json: string
  readonly previous_hash: WorldHash | 'genesis'
  readonly event_hash: WorldHash
  readonly transaction_id: string
  readonly event_ordinal: number
}

/** Authoritative Phase 0 World Event, Head, Tick, and Outbox store. */
export class WorldStore {
  readonly #db: DatabaseSync
  readonly #audit: OperationalAuditLog

  constructor(
    path: string,
    private readonly faultInjector?: FaultInjector,
    private readonly operationalNow: () => number = Date.now,
  ) {
    this.#db = openWorldDatabase(path)
    this.#audit = new OperationalAuditLog(`${path}.audit.sqlite`, operationalNow)
  }

  /** Create an empty root branch at seq/tick zero. */
  createBranch(address: WorldAddress): void {
    const key = worldAddressKey(address)
    this.#audit.record(key, 'world.branch.create.requested', `create:${address.branchId}`, { address })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`
        INSERT INTO branches(address_key, tenant_id, world_id, branch_id, parent_address_key, fork_seq)
        VALUES (?, ?, ?, ?, NULL, NULL)
      `).run(key, address.tenantId, address.worldId, address.branchId)
      this.#db.prepare(`INSERT INTO heads(address_key, head_seq, tick, event_hash) VALUES (?, 0, 0, 'genesis')`).run(key)
      this.#db.prepare(`INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision) VALUES (?, 'open', 'active', NULL, 0)`).run(key)
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Atomically install one compiled manifest and its deterministic Tick 0 Genesis events. */
  activateBranch(request: ActivateBranchRequest): ActivateBranchResult {
    if (request.genesisEvents.length === 0) throw new TypeError('Genesis requires at least one event')
    if (hashWorldJson('compiled-world-manifest', request.manifest) !== request.manifestHash) {
      throw new TypeError('manifestHash does not match manifest')
    }
    if (hashWorldJson('world-genesis-plan', request.genesisEvents) !== request.genesisHash) {
      throw new TypeError('genesisHash does not match Genesis events')
    }
    const addressKey = worldAddressKey(request.address)
    this.#audit.record(addressKey, 'world.activate.requested', request.correlationId, {
      manifestHash: request.manifestHash,
      genesisHash: request.genesisHash,
      transactionId: request.transactionId,
    })
    const activationHash = hashWorldJson('world-activation-request', {
      address: request.address,
      manifestHash: request.manifestHash,
      genesisHash: request.genesisHash,
      transactionId: request.transactionId,
      roundId: request.roundId,
    })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#db.prepare(`
        SELECT activation_hash, transaction_id FROM branch_activations WHERE address_key = ?
      `).get(addressKey) as { activation_hash: WorldHash; transaction_id: string } | undefined
      if (replay !== undefined) {
        if (replay.activation_hash !== activationHash || replay.transaction_id !== request.transactionId) {
          failWorld({
            errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
            category: 'admission',
            message: 'world branch is already active with another Genesis plan',
            retryable: false,
            correlationId: request.correlationId,
            address: request.address,
          })
        }
        const committed = this.#db.prepare(`
          SELECT head_seq, bundle_hash FROM round_commits WHERE transaction_id = ?
        `).get(request.transactionId) as { head_seq: number; bundle_hash: WorldHash }
        this.#db.exec('COMMIT')
        return { status: 'already_active', headSeq: committed.head_seq, tick: 0, bundleHash: committed.bundle_hash }
      }
      if (this.#db.prepare(`SELECT 1 AS present FROM branches WHERE address_key = ?`).get(addressKey) !== undefined) {
        failWorld({
          errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
          category: 'admission',
          message: 'an unactivated branch already occupies the WorldAddress',
          retryable: false,
          correlationId: request.correlationId,
          address: request.address,
        })
      }
      const manifestText = worldJsonText(request.manifest)
      const existingManifest = this.#db.prepare(`SELECT manifest_json FROM world_manifests WHERE manifest_hash = ?`)
        .get(request.manifestHash) as { manifest_json: string } | undefined
      if (existingManifest !== undefined && existingManifest.manifest_json !== manifestText) {
        failWorld({
          errorCode: 'BUNDLE_HASH_MISMATCH',
          category: 'integrity',
          message: 'manifest hash is bound to different bytes',
          retryable: false,
          correlationId: request.correlationId,
          address: request.address,
        })
      }
      this.#db.prepare(`INSERT OR IGNORE INTO world_manifests(manifest_hash, manifest_json) VALUES (?, ?)`)
        .run(request.manifestHash, manifestText)
      this.#db.prepare(`
        INSERT INTO branches(address_key, tenant_id, world_id, branch_id, parent_address_key, fork_seq)
        VALUES (?, ?, ?, ?, NULL, NULL)
      `).run(addressKey, request.address.tenantId, request.address.worldId, request.address.branchId)

      let previousHash: WorldHash | 'genesis' = 'genesis'
      const eventHashes: WorldHash[] = []
      for (const [eventOrdinal, draft] of request.genesisEvents.entries()) {
        const seq = eventOrdinal + 1
        const eventHash = hashWorldJson('world-event-envelope', {
          address: request.address,
          seq,
          tick: 0,
          eventType: draft.eventType,
          eventVersion: draft.eventVersion,
          data: draft.data,
          previousHash,
          transactionId: request.transactionId,
          eventOrdinal,
        })
        this.#db.prepare(`
          INSERT INTO events(address_key, seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal)
          VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          addressKey,
          seq,
          draft.eventType,
          draft.eventVersion,
          worldJsonText(draft.data),
          previousHash,
          eventHash,
          request.transactionId,
          eventOrdinal,
        )
        previousHash = eventHash
        eventHashes.push(eventHash)
      }
      const bundleHash = hashWorldJson('world-round-bundle', {
        address: request.address,
        roundId: request.roundId,
        tick: 0,
        eventHashes,
        outboxHashes: [],
      })
      this.#db.prepare(`
        INSERT INTO round_commits(transaction_id, address_key, request_hash, round_id, base_head_seq, base_tick, head_seq, tick, bundle_hash)
        VALUES (?, ?, ?, ?, 0, 0, ?, 0, ?)
      `).run(request.transactionId, addressKey, activationHash, request.roundId, request.genesisEvents.length, bundleHash)
      this.#db.prepare(`INSERT INTO heads(address_key, head_seq, tick, event_hash) VALUES (?, ?, 0, ?)`)
        .run(addressKey, request.genesisEvents.length, previousHash)
      this.#db.prepare(`INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision) VALUES (?, 'open', 'active', NULL, 0)`).run(addressKey)
      this.#db.prepare(`
        INSERT INTO branch_activations(address_key, activation_hash, manifest_hash, genesis_hash, transaction_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(addressKey, activationHash, request.manifestHash, request.genesisHash, request.transactionId)
      this.#db.exec('COMMIT')
      return { status: 'activated', headSeq: request.genesisEvents.length, tick: 0, bundleHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Read the compiled manifest bound to an activated branch. */
  readManifest(address: WorldAddress): { readonly manifest: WorldJsonValue; readonly manifestHash: WorldHash } | undefined {
    return this.#readManifestByKey(worldAddressKey(address))
  }

  #readManifestByKey(addressKey: string): { readonly manifest: WorldJsonValue; readonly manifestHash: WorldHash } | undefined {
    const row = this.#db.prepare(`
      SELECT a.manifest_hash, m.manifest_json
      FROM branch_activations a JOIN world_manifests m ON m.manifest_hash = a.manifest_hash
      WHERE a.address_key = ?
    `).get(addressKey) as { manifest_hash: WorldHash; manifest_json: string } | undefined
    if (row !== undefined) return { manifest: parseWorldJson(row.manifest_json), manifestHash: row.manifest_hash }
    const branch = this.#db.prepare(`SELECT parent_address_key FROM branches WHERE address_key = ?`).get(addressKey) as {
      parent_address_key: string | null
    } | undefined
    return branch?.parent_address_key === null || branch === undefined ? undefined : this.#readManifestByKey(branch.parent_address_key)
  }

  /** Create a child branch whose effective history stops exactly at forkSeq. */
  forkBranch(parent: WorldAddress, child: WorldAddress, forkSeq: number): void {
    if (parent.tenantId !== child.tenantId || parent.worldId !== child.worldId) {
      throw new TypeError('child branch must remain in the parent tenant and world')
    }
    const parentHead = this.head(parent)
    if (!Number.isSafeInteger(forkSeq) || forkSeq < 0 || forkSeq > parentHead.headSeq) {
      throw new RangeError(`forkSeq ${forkSeq} is outside parent head ${parentHead.headSeq}`)
    }
    const forkEvent = forkSeq === 0 ? undefined : this.readEvents(parent, forkSeq).find(event => event.seq === forkSeq)
    if (forkSeq !== 0 && forkEvent === undefined) throw new Error(`fork event ${forkSeq} is missing`)
    if (this.#branchDepth(worldAddressKey(parent)) >= 8) {
      failWorld({
        errorCode: 'BRANCH_DEPTH_LIMIT', category: 'admin', message: 'branch depth limit 8 would be exceeded',
        retryable: false, correlationId: `fork:${child.branchId}`, address: child,
      })
    }
    const childKey = worldAddressKey(child)
    this.#audit.record(childKey, 'world.branch.fork.requested', `fork:${child.branchId}`, { parent, child, forkSeq })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(`
        INSERT INTO branches(address_key, tenant_id, world_id, branch_id, parent_address_key, fork_seq)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(childKey, child.tenantId, child.worldId, child.branchId, worldAddressKey(parent), forkSeq)
      this.#db.prepare(`INSERT INTO heads(address_key, head_seq, tick, event_hash) VALUES (?, ?, ?, ?)`).run(
        childKey,
        forkSeq,
        forkEvent?.tick ?? 0,
        forkEvent?.eventHash ?? 'genesis',
      )
      this.#db.prepare(`INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision) VALUES (?, 'open', 'active', NULL, 0)`).run(childKey)
      this.#db.prepare(`
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, 'branch.forked', ?, ?, ?)
      `).run(childKey, `fork:${child.branchId}`, worldJsonText({ parent, forkSeq }), this.operationalNow())
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Atomically commit every authoritative effect of one accepted Round. */
  async commitRound(request: CommitRoundRequest): Promise<CommitRoundResult> {
    if (request.events.length === 0) throw new TypeError('a committed round requires at least one event')
    if (request.nextTick !== request.expectedTick + 1) throw new TypeError('a committed round advances exactly one tick')
    const addressKey = worldAddressKey(request.address)
    const requestHash = hashWorldJson('world-round-commit-request', {
      address: request.address,
      transactionId: request.transactionId,
      roundId: request.roundId,
      expectedHeadSeq: request.expectedHeadSeq,
      expectedTick: request.expectedTick,
      nextTick: request.nextTick,
      events: request.events,
      outbox: request.outbox,
    })

    this.#db.exec('BEGIN IMMEDIATE')
    let result: CommitRoundResult
    try {
      const replay = this.#db.prepare(`
        SELECT request_hash, head_seq, tick, bundle_hash FROM round_commits WHERE transaction_id = ?
      `).get(request.transactionId) as { request_hash: WorldHash; head_seq: number; tick: number; bundle_hash: WorldHash } | undefined
      if (replay !== undefined) {
        if (replay.request_hash !== requestHash) {
          failWorld({
            errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
            category: 'admission',
            message: 'transactionId is already bound to another Round request',
            retryable: false,
            correlationId: request.correlationId,
            address: request.address,
            roundId: request.roundId,
          })
        }
        this.#db.exec('COMMIT')
        return { status: 'already_committed', headSeq: replay.head_seq, tick: replay.tick, bundleHash: replay.bundle_hash }
      }

      this.#assertAdmissionOpen(addressKey, request.correlationId, request.address)

      this.#assertWriterLease(addressKey, request)

      const head = this.#headRow(addressKey)
      if (head.head_seq !== request.expectedHeadSeq || head.tick !== request.expectedTick) {
        failWorld({
          errorCode: 'WRITER_LEASE_LOST',
          category: 'runtime',
          message: 'branch head changed before Round commit',
          retryable: true,
          correlationId: request.correlationId,
          address: request.address,
          roundId: request.roundId,
          details: { actualHeadSeq: head.head_seq, actualTick: head.tick },
        })
      }

      let previousHash = head.event_hash
      const eventHashes: WorldHash[] = []
      for (const [eventOrdinal, draft] of request.events.entries()) {
        const seq = head.head_seq + eventOrdinal + 1
        const eventHash = hashWorldJson('world-event-envelope', {
          address: request.address,
          seq,
          tick: request.nextTick,
          eventType: draft.eventType,
          eventVersion: draft.eventVersion,
          data: draft.data,
          previousHash,
          transactionId: request.transactionId,
          eventOrdinal,
        })
        this.#db.prepare(`
          INSERT INTO events(address_key, seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          addressKey,
          seq,
          request.nextTick,
          draft.eventType,
          draft.eventVersion,
          worldJsonText(draft.data),
          previousHash,
          eventHash,
          request.transactionId,
          eventOrdinal,
        )
        previousHash = eventHash
        eventHashes.push(eventHash)
      }
      await this.faultInjector?.hit('store.after-event-insert')

      const finalHeadSeq = head.head_seq + request.events.length
      const outboxHashes = request.outbox.map((item) => {
        const payloadHash = hashWorldJson('world-outbox-payload', item.payload)
        this.#db.prepare(`
          INSERT INTO outbox(delivery_id, address_key, session_id, world_seq, payload_hash, payload_json, critical, transaction_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.deliveryId,
          addressKey,
          item.sessionId,
          finalHeadSeq,
          payloadHash,
          worldJsonText(item.payload),
          item.critical ? 1 : 0,
          request.transactionId,
        )
        return payloadHash
      })
      const bundleHash = hashWorldJson('world-round-bundle', {
        address: request.address,
        roundId: request.roundId,
        tick: request.nextTick,
        eventHashes,
        outboxHashes,
      })
      this.#db.prepare(`
        INSERT INTO round_commits(transaction_id, address_key, request_hash, round_id, base_head_seq, base_tick, head_seq, tick, bundle_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.transactionId,
        addressKey,
        requestHash,
        request.roundId,
        request.expectedHeadSeq,
        request.expectedTick,
        finalHeadSeq,
        request.nextTick,
        bundleHash,
      )
      this.#db.prepare(`UPDATE heads SET head_seq = ?, tick = ?, event_hash = ? WHERE address_key = ?`).run(
        finalHeadSeq,
        request.nextTick,
        previousHash,
        addressKey,
      )
      await this.faultInjector?.hit('store.before-commit')
      this.#db.exec('COMMIT')
      result = { status: 'committed', headSeq: finalHeadSeq, tick: request.nextTick, bundleHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
    await this.faultInjector?.hit('store.after-commit')
    return result
  }

  /** Read the branch head or fail closed for an unknown address. */
  head(address: WorldAddress): { readonly headSeq: number; readonly tick: number; readonly eventHash: WorldHash | 'genesis' } {
    const row = this.#headRow(worldAddressKey(address))
    return { headSeq: row.head_seq, tick: row.tick, eventHash: row.event_hash }
  }

  /** Read effective inherited history through asOfSeq. */
  readEvents(address: WorldAddress, asOfSeq = Number.MAX_SAFE_INTEGER): StoredWorldEvent[] {
    return this.#readEventsByKey(worldAddressKey(address), asOfSeq)
  }

  /** Read committed Outbox items for one branch. */
  readOutbox(address: WorldAddress): StoredOutboxItem[] {
    const key = worldAddressKey(address)
    const rows = this.#db.prepare(`
      SELECT delivery_id, session_id, world_seq, payload_hash, payload_json, critical
      FROM outbox WHERE address_key = ? ORDER BY world_seq, delivery_id
    `).all(key) as Array<{
      delivery_id: StoredOutboxItem['deliveryId']
      session_id: StoredOutboxItem['sessionId']
      world_seq: number
      payload_hash: WorldHash
      payload_json: string
      critical: number
    }>
    return rows.map(row => ({
      deliveryId: row.delivery_id,
      sessionId: row.session_id,
      address,
      worldSeq: row.world_seq,
      payloadHash: row.payload_hash,
      payload: parseWorldJson(row.payload_json),
      critical: row.critical === 1,
    }))
  }

  /** Return the frozen base boundary used by an already committed transaction. */
  roundBase(transactionId: CommitRoundRequest['transactionId']): { readonly headSeq: number; readonly tick: number } | undefined {
    const row = this.#db.prepare(`
      SELECT base_head_seq, base_tick FROM round_commits WHERE transaction_id = ?
    `).get(transactionId) as { base_head_seq: number; base_tick: number } | undefined
    return row === undefined ? undefined : { headSeq: row.base_head_seq, tick: row.base_tick }
  }

  /** Fail closed before admitting new work to a draining or archived branch. */
  assertAdmissionOpen(address: WorldAddress, correlationId: string): void {
    this.#assertAdmissionOpen(worldAddressKey(address), correlationId, address)
  }

  close(): void {
    this.#audit.close()
    this.#db.close()
  }

  #headRow(addressKey: string): HeadRow {
    const row = this.#db.prepare(`SELECT head_seq, tick, event_hash FROM heads WHERE address_key = ?`).get(addressKey) as HeadRow | undefined
    if (row === undefined) throw new Error(`unknown world branch ${addressKey}`)
    return row
  }

  #branchDepth(addressKey: string): number {
    let depth = 0
    let current: string | null = addressKey
    while (current !== null) {
      const row = this.#db.prepare(`SELECT parent_address_key FROM branches WHERE address_key = ?`).get(current) as {
        parent_address_key: string | null
      } | undefined
      if (row === undefined) throw new Error(`unknown world branch ${current}`)
      current = row.parent_address_key
      if (current !== null) depth += 1
    }
    return depth
  }

  #assertWriterLease(addressKey: string, request: CommitRoundRequest): void {
    const counter = this.#db.prepare(`SELECT 1 AS present FROM writer_lease_counters WHERE address_key = ?`).get(addressKey)
    if (counter === undefined) return
    const lease = this.#db.prepare(`
      SELECT fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?
    `).get(addressKey) as { fencing_token: number; expires_at_ms: number } | undefined
    const now = this.operationalNow()
    if (lease === undefined || lease.expires_at_ms <= now || request.writerFencingToken !== lease.fencing_token) {
      failWorld({
        errorCode: 'WRITER_LEASE_LOST',
        category: 'runtime',
        message: 'database writer lease is missing, expired, or fenced',
        retryable: true,
        correlationId: request.correlationId,
        address: request.address,
        roundId: request.roundId,
        details: { suppliedFencingToken: request.writerFencingToken ?? 0 },
      })
    }
  }

  #assertAdmissionOpen(addressKey: string, correlationId: string, address: WorldAddress): void {
    const row = this.#db.prepare(`
      SELECT admission_state, lifecycle_state FROM branch_controls WHERE address_key = ?
    `).get(addressKey) as { admission_state: 'open' | 'draining'; lifecycle_state: 'active' | 'archived' } | undefined
    if (row === undefined) throw new Error(`unknown world branch ${addressKey}`)
    if (row.admission_state !== 'open' || row.lifecycle_state !== 'active') {
      failWorld({
        errorCode: 'BRANCH_DRAINING',
        category: 'admin',
        message: row.lifecycle_state === 'archived' ? 'branch is archived' : 'branch admission is draining',
        retryable: row.lifecycle_state !== 'archived',
        correlationId,
        address,
      })
    }
  }

  #readEventsByKey(addressKey: string, asOfSeq: number): StoredWorldEvent[] {
    const branch = this.#db.prepare(`
      SELECT tenant_id, world_id, branch_id, parent_address_key, fork_seq FROM branches WHERE address_key = ?
    `).get(addressKey) as BranchRow | undefined
    if (branch === undefined) throw new Error(`unknown world branch ${addressKey}`)
    const address = {
      tenantId: branch.tenant_id,
      worldId: branch.world_id,
      branchId: branch.branch_id,
    } as WorldAddress
    const inherited = branch.parent_address_key === null
      ? []
      : this.#readEventsByKey(branch.parent_address_key, Math.min(asOfSeq, branch.fork_seq as number))
    const lowerBound = branch.fork_seq ?? 0
    const rows = this.#db.prepare(`
      SELECT seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal
      FROM events WHERE address_key = ? AND seq > ? AND seq <= ? ORDER BY seq
    `).all(addressKey, lowerBound, asOfSeq) as unknown as EventRow[]
    const local = rows.map(row => ({
      address,
      seq: row.seq,
      tick: row.tick,
      eventType: row.event_type,
      eventVersion: row.event_version,
      data: parseWorldJson(row.data_json),
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
      transactionId: row.transaction_id as StoredWorldEvent['transactionId'],
      eventOrdinal: row.event_ordinal,
    }))
    return [...inherited, ...local]
  }
}
