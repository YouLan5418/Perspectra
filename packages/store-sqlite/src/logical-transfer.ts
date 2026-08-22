import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  failWorld,
  hashWorldJson,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { openWorldDatabase } from './world-store.ts'
import { parseWorldJson } from './sqlite.ts'
import { OperationalAuditLog } from './operational-audit.ts'

type SqlValue = string | number | null
type SqlRow = Record<string, SqlValue>

const TABLES = [
  'world_manifests', 'branches', 'heads', 'round_commits', 'round_authority', 'events', 'outbox', 'branch_activations',
  'outbox_session_counters', 'branch_controls', 'branch_failures', 'branch_audit_events', 'round_inbox_counters', 'round_inbox',
] as const

const COLUMNS: Record<(typeof TABLES)[number], readonly string[]> = {
  world_manifests: ['manifest_hash', 'manifest_json'],
  branches: ['address_key', 'tenant_id', 'world_id', 'branch_id', 'parent_address_key', 'fork_seq'],
  heads: ['address_key', 'head_seq', 'tick', 'event_hash'],
  round_commits: ['transaction_id', 'address_key', 'request_hash', 'round_id', 'base_head_seq', 'base_tick', 'head_seq', 'tick', 'bundle_hash', 'authority_hash'],
  round_authority: ['transaction_id', 'address_key', 'round_id', 'authority_hash', 'authority_json'],
  events: ['address_key', 'seq', 'tick', 'event_type', 'event_version', 'data_json', 'previous_hash', 'event_hash', 'transaction_id', 'event_ordinal'],
  outbox: ['delivery_id', 'address_key', 'session_id', 'world_seq', 'payload_hash', 'payload_json', 'critical', 'transaction_id', 'delivery_status', 'attempt_count', 'session_delivery_seq', 'last_error'],
  outbox_session_counters: ['session_id', 'next_delivery_seq'],
  branch_activations: ['address_key', 'activation_hash', 'manifest_hash', 'genesis_hash', 'transaction_id'],
  branch_controls: ['address_key', 'admission_state', 'lifecycle_state', 'runtime_phase', 'runtime_epoch', 'reason', 'revision'],
  branch_failures: [
    'failure_id', 'address_key', 'error_hash', 'error_json', 'source', 'status', 'occurred_at_ms',
    'recovered_at_ms', 'recovery_correlation_id',
  ],
  branch_audit_events: ['audit_seq', 'address_key', 'operation', 'correlation_id', 'details_json', 'operational_time_ms'],
  round_inbox_counters: ['address_key', 'next_inbox_seq'],
  round_inbox: [
    'address_key', 'inbox_seq', 'idempotency_key', 'input_hash', 'principal_id', 'input_json', 'status',
    'claim_owner_id', 'claim_fencing_token', 'result_hash', 'result_json', 'commit_transaction_id', 'commit_bundle_hash',
  ],
}

interface LogicalAuthorityData extends WorldJsonObject {
  readonly authorityVersion: 5
  readonly tables: WorldJsonObject
}

interface LogicalAuthorityEnvelope extends WorldJsonObject {
  readonly format: 'dshworld-authority/v5'
  readonly data: LogicalAuthorityData
  readonly bundleHash: WorldHash
}

interface LegacyAuthorityData extends WorldJsonObject {
  readonly authorityVersion: 4
  readonly tables: WorldJsonObject
}

interface LegacyAuthorityEnvelope extends WorldJsonObject {
  readonly format: 'dshworld-authority/v4'
  readonly data: LegacyAuthorityData
  readonly bundleHash: WorldHash
}

/** Authority-only logical transfer. Session, Memory, operational sidecar Audit, Presentation, and process state are omitted. */
export class WorldLogicalTransferService {
  constructor(
    private readonly sourcePath: string,
    private readonly afterTableRead?: (table: (typeof TABLES)[number]) => void,
  ) {}

  exportAuthority(targetPath: string, correlationId: string): WorldHash {
    this.#guardTarget(targetPath, correlationId)
    this.#audit('authority.export.requested', correlationId, { targetPath })
    const db = new DatabaseSync(this.sourcePath, { readOnly: true })
    try {
      db.exec('BEGIN DEFERRED')
      const tables: Record<string, WorldJsonValue> = {}
      for (const table of TABLES) {
        tables[table] = this.#exportRows(db, table)
        this.afterTableRead?.(table)
      }
      db.exec('COMMIT')
      const data: LogicalAuthorityData = { authorityVersion: 5, tables }
      const bundleHash = hashWorldJson('logical-authority-export', data)
      const envelope: LogicalAuthorityEnvelope = { format: 'dshworld-authority/v5', data, bundleHash }
      writeFileSync(targetPath, canonicalizeWorldJson(envelope), { flag: 'wx' })
      this.#audit('authority.export.completed', correlationId, { targetPath, bundleHash })
      return bundleHash
    } catch (error: unknown) {
      try { db.exec('ROLLBACK') } catch { /* a failed read may end the transaction */ }
      throw error
    } finally {
      db.close()
    }
  }

  importAuthority(exportPath: string, targetPath: string, correlationId: string): WorldHash {
    this.#guardTarget(targetPath, correlationId)
    this.#audit('authority.import.requested', correlationId, { exportPath, targetPath })
    let parsed: LogicalAuthorityEnvelope | LegacyAuthorityEnvelope
    try {
      parsed = JSON.parse(readFileSync(exportPath, 'utf8')) as LogicalAuthorityEnvelope | LegacyAuthorityEnvelope
      canonicalizeWorldJson(parsed)
    } catch (error: unknown) {
      this.#invalid('logical export is invalid', correlationId, error)
    }
    if (!((parsed.format === 'dshworld-authority/v5' && parsed.data.authorityVersion === 5)
      || (parsed.format === 'dshworld-authority/v4' && parsed.data.authorityVersion === 4))) {
      this.#invalid('logical export format is unsupported', correlationId)
    }
    const actualHash = hashWorldJson('logical-authority-export', parsed.data)
    if (actualHash !== parsed.bundleHash) this.#invalid('logical export hash is invalid', correlationId)
    const envelope: LogicalAuthorityEnvelope = parsed.format === 'dshworld-authority/v4'
      ? { format: 'dshworld-authority/v5', data: this.#upgradeV4(parsed.data, correlationId), bundleHash: parsed.bundleHash }
      : parsed
    const db = openWorldDatabase(targetPath)
    try {
      db.exec('BEGIN IMMEDIATE')
      for (const table of TABLES) {
        const rows = envelope.data.tables[table]
        if (!Array.isArray(rows)) this.#invalid(`logical table ${table} is missing`, correlationId)
        const columns = COLUMNS[table]
        const insert = db.prepare(`INSERT INTO ${table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        for (const row of rows) {
          if (typeof row !== 'object' || row === null || Array.isArray(row)) this.#invalid(`logical table ${table} has an invalid row`, correlationId)
          const rowKeys = Object.keys(row).sort()
          const expectedKeys = [...columns].sort()
          if (rowKeys.length !== expectedKeys.length || rowKeys.some((key, index) => key !== expectedKeys[index])) {
            this.#invalid(`logical table ${table} row has missing or unknown columns`, correlationId)
          }
          insert.run(...columns.map(column => (row as WorldJsonObject)[column] as SqlValue))
        }
      }
      this.#validateEvents(db, correlationId)
      this.#validateBranchesAndHeads(db, correlationId)
      this.#validateRoundBundles(db, correlationId)
      this.#validateOutbox(db, correlationId)
      this.#validateCompletedInbox(db, correlationId)
      this.#validateFailures(db, correlationId)
      db.exec('COMMIT')
      const provenance = { sourcePath: resolve(this.sourcePath), exportPath: resolve(exportPath), bundleHash: actualHash }
      this.#auditAt(targetPath, 'authority.import.completed', correlationId, provenance)
      this.#audit('authority.import.completed', correlationId, { targetPath, bundleHash: actualHash })
      return actualHash
    } catch (error: unknown) {
      try { db.exec('ROLLBACK') } catch { /* validation may fail after SQLite ended the transaction */ }
      db.close()
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${targetPath}${suffix}`, { force: true })
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${targetPath}.audit.sqlite${suffix}`, { force: true })
      throw error
    } finally {
      if (db.isOpen) db.close()
    }
  }

  #upgradeV4(data: LegacyAuthorityData, correlationId: string): LogicalAuthorityData {
    const commits = data.tables.round_commits
    if (!Array.isArray(commits)) this.#invalid('logical table round_commits is missing', correlationId)
    const upgradedCommits = commits.map((row) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return row
      return { ...row, authority_hash: null }
    })
    return {
      authorityVersion: 5,
      tables: { ...data.tables, round_commits: upgradedCommits, round_authority: [] },
    }
  }

  #exportRows(db: DatabaseSync, table: (typeof TABLES)[number]): SqlRow[] {
    if (table === 'outbox') {
      return db.prepare(`
        SELECT delivery_id, address_key, session_id, world_seq, payload_hash, payload_json, critical, transaction_id,
          'pending' AS delivery_status, 0 AS attempt_count, session_delivery_seq, NULL AS last_error
        FROM outbox ORDER BY rowid
      `).all() as SqlRow[]
    }
    if (table === 'round_inbox') {
      return db.prepare(`
        SELECT ${COLUMNS.round_inbox.join(', ')} FROM round_inbox WHERE status = 'completed' ORDER BY rowid
      `).all() as SqlRow[]
    }
    return db.prepare(`SELECT ${COLUMNS[table].join(', ')} FROM ${table} ORDER BY rowid`).all() as SqlRow[]
  }

  #validateEvents(db: DatabaseSync, correlationId: string): void {
    const rows = db.prepare(`
      SELECT e.*, b.tenant_id, b.world_id, b.branch_id FROM events e
      JOIN branches b ON b.address_key = e.address_key ORDER BY e.address_key, e.seq
    `).all() as Array<{
      tenant_id: string
      world_id: string
      branch_id: string
      seq: number
      tick: number
      event_type: string
      event_version: number
      data_json: string
      previous_hash: string
      transaction_id: string
      event_ordinal: number
      event_hash: WorldHash
    }>
    for (const row of rows) {
      const address = { tenantId: row.tenant_id, worldId: row.world_id, branchId: row.branch_id } as WorldAddress
      const actual = hashWorldJson('world-event-envelope', {
        address,
        seq: row.seq,
        tick: row.tick,
        eventType: row.event_type,
        eventVersion: row.event_version,
        data: parseWorldJson(row.data_json),
        previousHash: row.previous_hash,
        transactionId: row.transaction_id,
        eventOrdinal: row.event_ordinal,
      })
      if (actual !== row.event_hash) this.#invalid('logical export contains a divergent Event hash', correlationId)
    }
  }

  #validateBranchesAndHeads(db: DatabaseSync, correlationId: string): void {
    const branches = db.prepare(`
      SELECT address_key, tenant_id, world_id, parent_address_key, fork_seq FROM branches
    `).all() as Array<{
      address_key: string
      tenant_id: string
      world_id: string
      parent_address_key: string | null
      fork_seq: number | null
    }>
    const byKey = new Map(branches.map(branch => [branch.address_key, branch]))
    const eventAt = (addressKey: string, seq: number, seen = new Set<string>()): { event_hash: WorldHash; tick: number } | undefined => {
      if (seen.has(addressKey)) this.#invalid('logical export contains a cyclic Branch lineage', correlationId)
      seen.add(addressKey)
      const local = db.prepare(`SELECT event_hash, tick FROM events WHERE address_key = ? AND seq = ?`)
        .get(addressKey, seq) as { event_hash: WorldHash; tick: number } | undefined
      if (local !== undefined) return local
      const branch = byKey.get(addressKey)
      if (branch?.parent_address_key !== null && branch?.parent_address_key !== undefined && seq <= (branch.fork_seq as number)) {
        return eventAt(branch.parent_address_key, seq, seen)
      }
      return undefined
    }

    for (const branch of branches) {
      if (branch.parent_address_key !== null) {
        const parent = byKey.get(branch.parent_address_key)
        if (parent === undefined || parent.tenant_id !== branch.tenant_id || parent.world_id !== branch.world_id) {
          this.#invalid('logical export contains an invalid Branch parent', correlationId)
        }
        if (branch.fork_seq === null || (branch.fork_seq > 0 && eventAt(branch.parent_address_key, branch.fork_seq) === undefined)) {
          this.#invalid('logical export contains an invalid Branch fork anchor', correlationId)
        }
      }
      const lowerBound = branch.fork_seq ?? 0
      const localEvents = db.prepare(`
        SELECT seq, previous_hash, event_hash FROM events WHERE address_key = ? ORDER BY seq
      `).all(branch.address_key) as Array<{ seq: number; previous_hash: string; event_hash: WorldHash }>
      let expectedSeq = lowerBound + 1
      let previousHash: WorldHash | 'genesis' = lowerBound === 0
        ? 'genesis'
        : eventAt(branch.address_key, lowerBound)!.event_hash
      for (const event of localEvents) {
        if (event.seq !== expectedSeq || event.previous_hash !== previousHash) {
          this.#invalid('logical export contains a discontinuous Event chain', correlationId)
        }
        expectedSeq += 1
        previousHash = event.event_hash
      }
      const head = db.prepare(`SELECT head_seq, tick, event_hash FROM heads WHERE address_key = ?`)
        .get(branch.address_key) as { head_seq: number; tick: number; event_hash: string } | undefined
      if (head === undefined || head.head_seq !== expectedSeq - 1) {
        this.#invalid('logical export Head does not match the Event chain length', correlationId)
      }
      const tail = head.head_seq === 0 ? undefined : eventAt(branch.address_key, head.head_seq)
      if (
        (head.head_seq === 0 && (head.event_hash !== 'genesis' || head.tick !== 0))
        || (head.head_seq > 0 && (tail!.event_hash !== head.event_hash || tail!.tick !== head.tick))
      ) {
        this.#invalid('logical export Head does not match the Event chain tail', correlationId)
      }
    }
  }

  #validateRoundBundles(db: DatabaseSync, correlationId: string): void {
    const commits = db.prepare(`
      SELECT transaction_id, address_key, round_id, base_head_seq, base_tick, head_seq, tick, bundle_hash, authority_hash
      FROM round_commits ORDER BY rowid
    `).all() as Array<{
      transaction_id: string
      address_key: string
      round_id: string
      base_head_seq: number
      base_tick: number
      head_seq: number
      tick: number
      bundle_hash: WorldHash
      authority_hash: WorldHash | null
    }>
    for (const commit of commits) {
      const branch = db.prepare(`SELECT tenant_id, world_id, branch_id FROM branches WHERE address_key = ?`)
        .get(commit.address_key) as { tenant_id: string; world_id: string; branch_id: string } | undefined
      const eventRows = db.prepare(`
        SELECT seq, tick, event_hash, event_ordinal FROM events WHERE transaction_id = ? ORDER BY event_ordinal
      `).all(commit.transaction_id) as Array<{ seq: number; tick: number; event_hash: WorldHash; event_ordinal: number }>
      if (
        eventRows.length !== commit.head_seq - commit.base_head_seq
        || eventRows.some((event, index) => event.event_ordinal !== index || event.seq !== commit.base_head_seq + index + 1 || event.tick !== commit.tick)
      ) this.#invalid('logical export Round event range is inconsistent', correlationId)
      const outboxRows = db.prepare(`
        SELECT world_seq, payload_hash FROM outbox WHERE transaction_id = ? ORDER BY rowid
      `).all(commit.transaction_id) as Array<{ world_seq: number; payload_hash: WorldHash }>
      if (outboxRows.some(row => row.world_seq !== commit.head_seq)) {
        this.#invalid('logical export Round Outbox boundary is inconsistent', correlationId)
      }
      const authorityRow = db.prepare(`
        SELECT round_id, authority_hash, authority_json FROM round_authority WHERE transaction_id = ? AND address_key = ?
      `).get(commit.transaction_id, commit.address_key) as {
        round_id: string
        authority_hash: WorldHash
        authority_json: string
      } | undefined
      if ((commit.authority_hash === null) !== (authorityRow === undefined)) {
        this.#invalid('logical export Round authority presence is inconsistent', correlationId)
      }
      if (authorityRow !== undefined) {
        const authority = parseWorldJson(authorityRow.authority_json)
        if (authorityRow.round_id !== commit.round_id
          || authorityRow.authority_hash !== commit.authority_hash
          || hashWorldJson('world-round-authority', authority) !== authorityRow.authority_hash) {
          this.#invalid('logical export Round authority is divergent', correlationId)
        }
      }
      const actual = hashWorldJson('world-round-bundle', {
        address: { tenantId: branch!.tenant_id, worldId: branch!.world_id, branchId: branch!.branch_id },
        roundId: commit.round_id,
        tick: commit.tick,
        eventHashes: eventRows.map(event => event.event_hash),
        outboxHashes: outboxRows.map(row => row.payload_hash),
        ...(commit.authority_hash === null ? {} : { authorityHash: commit.authority_hash }),
      })
      if (actual !== commit.bundle_hash) this.#invalid('logical export contains a divergent Round bundle', correlationId)
      if (commit.tick !== 0 && commit.tick !== commit.base_tick + 1) {
        this.#invalid('logical export Round tick boundary is inconsistent', correlationId)
      }
    }
  }

  #validateOutbox(db: DatabaseSync, correlationId: string): void {
    const rows = db.prepare(`
      SELECT payload_json, payload_hash, delivery_status, attempt_count, session_delivery_seq, last_error FROM outbox
    `).all() as Array<{
      payload_json: string
      payload_hash: WorldHash
      delivery_status: string
      attempt_count: number
      session_delivery_seq: number | null
      last_error: string | null
    }>
    for (const row of rows) {
      if (
        hashWorldJson('world-outbox-payload', parseWorldJson(row.payload_json)) !== row.payload_hash
        || row.delivery_status !== 'pending'
        || row.attempt_count !== 0
        || row.last_error !== null
      ) this.#invalid('logical export contains an invalid normalized Outbox item', correlationId)
    }
    const sequenceDivergence = db.prepare(`
      WITH ordered AS (
        SELECT session_id, session_delivery_seq,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY world_seq, delivery_id) AS expected_seq,
          MAX(CASE WHEN session_delivery_seq IS NOT NULL THEN 1 ELSE 0 END)
            OVER (PARTITION BY session_id ORDER BY world_seq, delivery_id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS later_assigned
        FROM outbox
      )
      SELECT 1 AS divergent FROM ordered
      WHERE (session_delivery_seq IS NOT NULL AND session_delivery_seq <> expected_seq)
        OR (session_delivery_seq IS NULL AND later_assigned = 1)
      LIMIT 1
    `).get()
    const counterDivergence = db.prepare(`
      WITH assigned AS (
        SELECT session_id, MAX(session_delivery_seq) AS max_seq FROM outbox GROUP BY session_id
      )
      SELECT 1 AS divergent FROM assigned a
      LEFT JOIN outbox_session_counters c ON c.session_id = a.session_id
      WHERE (a.max_seq IS NULL AND c.session_id IS NOT NULL)
        OR (a.max_seq IS NOT NULL AND (c.session_id IS NULL OR c.next_delivery_seq <> a.max_seq + 1))
      UNION ALL
      SELECT 1 AS divergent FROM outbox_session_counters c
      LEFT JOIN assigned a ON a.session_id = c.session_id WHERE a.session_id IS NULL
      LIMIT 1
    `).get()
    if (sequenceDivergence !== undefined || counterDivergence !== undefined) {
      this.#invalid('logical export contains divergent Outbox delivery sequencing', correlationId)
    }
  }

  #validateCompletedInbox(db: DatabaseSync, correlationId: string): void {
    const rows = db.prepare(`
      SELECT address_key, input_hash, principal_id, input_json, result_hash, result_json,
        commit_transaction_id, commit_bundle_hash, status
      FROM round_inbox
    `).all() as Array<{
      address_key: string
      input_hash: WorldHash
      principal_id: string
      input_json: string
      result_hash: WorldHash
      result_json: string
      commit_transaction_id: string
      commit_bundle_hash: WorldHash
      status: string
    }>
    for (const row of rows) {
      const commit = db.prepare(`SELECT bundle_hash FROM round_commits WHERE transaction_id = ? AND address_key = ?`)
        .get(row.commit_transaction_id, row.address_key) as { bundle_hash: WorldHash } | undefined
      const result = parseWorldJson(row.result_json)
      const resultBundleHash = typeof result === 'object' && result !== null && !Array.isArray(result)
        ? (result as WorldJsonObject).bundleHash
        : undefined
      if (
        row.status !== 'completed'
        || hashWorldJson('player-round-input', { principalId: row.principal_id, input: parseWorldJson(row.input_json) }) !== row.input_hash
        || hashWorldJson('player-round-result', result) !== row.result_hash
        || resultBundleHash !== row.commit_bundle_hash
        || commit?.bundle_hash !== row.commit_bundle_hash
      ) this.#invalid('logical export contains an invalid completed Round Inbox item', correlationId)
    }
  }

  #validateFailures(db: DatabaseSync, correlationId: string): void {
    const rows = db.prepare(`SELECT error_hash, error_json FROM branch_failures`).all() as Array<{
      error_hash: WorldHash
      error_json: string
    }>
    for (const row of rows) {
      const error = parseWorldJson(row.error_json)
      if (hashWorldJson('branch-failure-envelope', error) !== row.error_hash) {
        this.#invalid('logical export contains a divergent Branch failure', correlationId)
      }
    }
  }

  #guardTarget(targetPath: string, correlationId: string): void {
    if (resolve(targetPath) === resolve(this.sourcePath) || existsSync(targetPath)) {
      failWorld({
        errorCode: 'IMPORT_ID_CONFLICT', category: 'admin', message: 'logical transfer target already exists or aliases the source',
        retryable: false, correlationId,
      })
    }
  }

  #invalid(message: string, correlationId: string, error?: unknown): never {
    failWorld({
      errorCode: 'BACKUP_INVALID', category: 'integrity', message: error === undefined ? message : `${message}: ${String(error)}`,
      retryable: false, correlationId,
    })
  }

  #audit(operation: string, correlationId: string, details: WorldJsonObject): void {
    this.#auditAt(this.sourcePath, operation, correlationId, details)
  }

  #auditAt(databasePath: string, operation: string, correlationId: string, details: WorldJsonObject): void {
    const audit = new OperationalAuditLog(`${databasePath}.audit.sqlite`)
    try {
      audit.record(resolve(databasePath), operation, correlationId, details)
    } finally {
      audit.close()
    }
  }
}
