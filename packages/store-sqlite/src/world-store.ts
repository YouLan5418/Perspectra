import type { DatabaseSync } from 'node:sqlite'
import {
  brandId,
  compareWorldText,
  deterministicId,
  failWorld,
  hashWorldJson,
  worldAddressKey,
  type CommitRoundRequest,
  type CommitRoundResult,
  type CognitiveJobDraft,
  type FaultInjector,
  type StoredOutboxItem,
  type StoredCognitiveJob,
  type StoredRoundAuthority,
  type StoredWorldEvent,
  type TransactionId,
  type WorldAddress,
  type WorldEventDraft,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { parseWorldJson, rollbackAndThrow, worldJsonText } from './sqlite.ts'
import { OperationalAuditLog } from './operational-audit.ts'
import { openWorldDatabase } from './world-schema.ts'

export interface ActivateBranchRequest {
  readonly address: WorldAddress
  readonly manifest: WorldJsonValue
  readonly manifestHash: WorldHash
  readonly genesisEvents: readonly WorldEventDraft[]
  readonly genesisHash: WorldHash
  readonly transactionId: TransactionId
  readonly roundId: CommitRoundRequest['roundId']
  readonly cognitiveJobs?: readonly CognitiveJobDraft[]
  readonly correlationId: string
}

export interface BranchIntegrityReport extends WorldJsonObject {
  readonly headSeq: number
  readonly tick: number
  readonly eventCount: number
  readonly roundCount: number
  readonly verificationHash: WorldHash
}

export interface ActivateBranchResult {
  readonly status: 'activated' | 'already_active'
  readonly headSeq: number
  readonly tick: 0
  readonly bundleHash: WorldHash
}

export interface CommittedRoundRecord {
  readonly transactionId: TransactionId
  readonly roundId: CommitRoundRequest['roundId']
  readonly baseHeadSeq: number
  readonly baseTick: number
  readonly headSeq: number
  readonly tick: number
  readonly bundleHash: WorldHash
  readonly events: readonly StoredWorldEvent[]
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

function assertManifestEvents(manifest: WorldJsonValue, events: readonly WorldEventDraft[]): void {
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest) ||
    (manifest as WorldJsonObject).schemaVersion !== 10
  ) {
    throw new TypeError('new worlds require Manifest v10')
  }
  const root = manifest as WorldJsonObject
  const registries = root.registries
  if (typeof registries !== 'object' || registries === null || Array.isArray(registries))
    throw new TypeError('compiled manifest registries are malformed')
  const eventRegistry = (registries as WorldJsonObject).events
  if (typeof eventRegistry !== 'object' || eventRegistry === null || Array.isArray(eventRegistry)) {
    throw new TypeError('compiled manifest Event Registry is malformed')
  }
  const eventRegistryObject = eventRegistry as WorldJsonObject
  if (!Array.isArray(eventRegistryObject.definitions))
    throw new TypeError('compiled manifest Event Registry is malformed')
  const allowed = new Set(
    (eventRegistryObject.definitions as readonly WorldJsonValue[]).map(entry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new TypeError('compiled manifest Event Registry definition is malformed')
      }
      const definition = entry as WorldJsonObject
      if (
        typeof definition.name !== 'string' ||
        !Number.isSafeInteger(definition.version) ||
        (definition.version as number) <= 0
      ) {
        throw new TypeError('compiled manifest Event Registry definition is malformed')
      }
      return `${definition.name}\u001f${definition.version}`
    }),
  )
  for (const event of events) {
    if (!allowed.has(`${event.eventType}\u001f${event.eventVersion}`)) {
      throw new TypeError(`event ${event.eventType}@${event.eventVersion} is not locked by the Compiled Manifest`)
    }
  }
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
      this.#db
        .prepare(
          `
        INSERT INTO branches(address_key, tenant_id, world_id, branch_id, parent_address_key, fork_seq)
        VALUES (?, ?, ?, ?, NULL, NULL)
      `,
        )
        .run(key, address.tenantId, address.worldId, address.branchId)
      this.#db
        .prepare(`INSERT INTO heads(address_key, head_seq, tick, event_hash) VALUES (?, 0, 0, 'genesis')`)
        .run(key)
      this.#db
        .prepare(
          `INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision) VALUES (?, 'open', 'active', NULL, 0)`,
        )
        .run(key)
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  listBranches(): WorldAddress[] {
    const rows = this.#db
      .prepare(
        `
      SELECT tenant_id, world_id, branch_id FROM branches ORDER BY tenant_id, world_id, branch_id
    `,
      )
      .all() as Array<{ tenant_id: string; world_id: string; branch_id: string }>
    return rows.map(row => ({
      tenantId: brandId(row.tenant_id, 'TenantId'),
      worldId: brandId(row.world_id, 'WorldId'),
      branchId: brandId(row.branch_id, 'BranchId'),
    }))
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
    assertManifestEvents(request.manifest, request.genesisEvents)
    const cognitiveJobs = [...(request.cognitiveJobs ?? [])].sort((left, right) =>
      compareWorldText(left.characterId, right.characterId),
    )
    if (new Set(cognitiveJobs.map(job => job.characterId)).size !== cognitiveJobs.length) {
      throw new TypeError('Genesis cognitive job characterId values must be unique')
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
      ...(cognitiveJobs.length === 0 ? {} : { cognitiveJobs }),
    })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#db
        .prepare(
          `
        SELECT activation_hash, transaction_id FROM branch_activations WHERE address_key = ?
      `,
        )
        .get(addressKey) as { activation_hash: WorldHash; transaction_id: string } | undefined
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
        const committed = this.#db
          .prepare(
            `
          SELECT head_seq, bundle_hash FROM round_commits WHERE transaction_id = ?
        `,
          )
          .get(request.transactionId) as { head_seq: number; bundle_hash: WorldHash }
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
      const existingManifest = this.#db
        .prepare(`SELECT manifest_json FROM world_manifests WHERE manifest_hash = ?`)
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
      this.#db
        .prepare(`INSERT OR IGNORE INTO world_manifests(manifest_hash, manifest_json) VALUES (?, ?)`)
        .run(request.manifestHash, manifestText)
      this.#db
        .prepare(
          `
        INSERT INTO branches(address_key, tenant_id, world_id, branch_id, parent_address_key, fork_seq)
        VALUES (?, ?, ?, ?, NULL, NULL)
      `,
        )
        .run(addressKey, request.address.tenantId, request.address.worldId, request.address.branchId)

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
        this.#db
          .prepare(
            `
          INSERT INTO events(address_key, seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal)
          VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
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
      this.#db
        .prepare(
          `
        INSERT INTO round_commits(transaction_id, address_key, request_hash, round_id, base_head_seq, base_tick, head_seq, tick, bundle_hash)
        VALUES (?, ?, ?, ?, 0, 0, ?, 0, ?)
      `,
        )
        .run(
          request.transactionId,
          addressKey,
          activationHash,
          request.roundId,
          request.genesisEvents.length,
          bundleHash,
        )
      for (const job of cognitiveJobs) {
        const identity = {
          address: request.address,
          transactionId: request.transactionId,
          characterId: job.characterId,
          asOfWorldSeq: request.genesisEvents.length,
        }
        const jobId = deterministicId('world-cognitive-job-id', identity)
        const jobHash = hashWorldJson('world-cognitive-job', { jobId, ...identity })
        this.#db
          .prepare(
            `
          INSERT INTO world_cognitive_jobs(
            job_id, address_key, transaction_id, character_id, as_of_seq, status, attempt_count, last_error, job_hash
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?)
        `,
          )
          .run(jobId, addressKey, request.transactionId, job.characterId, request.genesisEvents.length, jobHash)
      }
      this.#db
        .prepare(`INSERT INTO heads(address_key, head_seq, tick, event_hash) VALUES (?, ?, 0, ?)`)
        .run(addressKey, request.genesisEvents.length, previousHash)
      this.#db
        .prepare(
          `INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision) VALUES (?, 'open', 'active', NULL, 0)`,
        )
        .run(addressKey)
      this.#db
        .prepare(
          `
        INSERT INTO branch_activations(address_key, activation_hash, manifest_hash, genesis_hash, transaction_id)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(addressKey, activationHash, request.manifestHash, request.genesisHash, request.transactionId)
      this.#db.exec('COMMIT')
      return { status: 'activated', headSeq: request.genesisEvents.length, tick: 0, bundleHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Read the compiled manifest bound to an activated branch. */
  readManifest(
    address: WorldAddress,
  ): { readonly manifest: WorldJsonValue; readonly manifestHash: WorldHash } | undefined {
    return this.#readManifestByKey(worldAddressKey(address))
  }

  #readManifestByKey(
    addressKey: string,
  ): { readonly manifest: WorldJsonValue; readonly manifestHash: WorldHash } | undefined {
    const row = this.#db
      .prepare(
        `
      SELECT a.manifest_hash, m.manifest_json
      FROM branch_activations a JOIN world_manifests m ON m.manifest_hash = a.manifest_hash
      WHERE a.address_key = ?
    `,
      )
      .get(addressKey) as { manifest_hash: WorldHash; manifest_json: string } | undefined
    if (row !== undefined) return { manifest: parseWorldJson(row.manifest_json), manifestHash: row.manifest_hash }
    const branch = this.#db.prepare(`SELECT parent_address_key FROM branches WHERE address_key = ?`).get(addressKey) as
      | {
          parent_address_key: string | null
        }
      | undefined
    return branch?.parent_address_key === null || branch === undefined
      ? undefined
      : this.#readManifestByKey(branch.parent_address_key)
  }

  /** Create a child branch whose effective history stops exactly at forkSeq. */
  forkBranch(parent: WorldAddress, child: WorldAddress, forkSeq: number): void {
    this.#forkBranch(parent, child, forkSeq, 'open')
  }

  /** Fork an active source while its administrative gate is durably draining. */
  forkDrainedBranch(parent: WorldAddress, child: WorldAddress, forkSeq: number): void {
    this.#forkBranch(parent, child, forkSeq, 'draining')
  }

  #forkBranch(
    parent: WorldAddress,
    child: WorldAddress,
    forkSeq: number,
    requiredAdmission: 'open' | 'draining',
  ): void {
    if (parent.tenantId !== child.tenantId || parent.worldId !== child.worldId) {
      throw new TypeError('child branch must remain in the parent tenant and world')
    }
    const parentKey = worldAddressKey(parent)
    const childKey = worldAddressKey(child)
    this.#audit.record(childKey, 'world.branch.fork.requested', `fork:${child.branchId}`, { parent, child, forkSeq })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const control = this.#db
        .prepare(
          `
        SELECT admission_state, lifecycle_state, runtime_phase FROM branch_controls WHERE address_key = ?
      `,
        )
        .get(parentKey) as
        | {
            admission_state: 'open' | 'draining'
            lifecycle_state: 'active' | 'archived'
            runtime_phase: 'active' | 'maintenance' | 'quarantined' | 'archived'
          }
        | undefined
      if (control === undefined) throw new Error(`unknown world branch ${parentKey}`)
      if (
        control.lifecycle_state !== 'active' ||
        control.runtime_phase !== 'active' ||
        control.admission_state !== requiredAdmission
      ) {
        failWorld({
          errorCode: control.runtime_phase === 'quarantined' ? 'BRANCH_QUARANTINED' : 'BRANCH_DRAINING',
          category: 'admin',
          message:
            control.runtime_phase === 'quarantined'
              ? 'branch is quarantined'
              : control.lifecycle_state === 'archived'
                ? 'branch is archived'
                : `branch fork requires admission state ${requiredAdmission}`,
          retryable: control.lifecycle_state !== 'archived',
          correlationId: `fork:${child.branchId}`,
          address: parent,
        })
      }
      const unfinishedRound = this.#db
        .prepare(
          `
        SELECT 1 AS present FROM round_inbox WHERE address_key = ? AND status IN ('pending', 'claimed')
        UNION ALL SELECT 1 FROM player_input_jobs WHERE address_key = ?
          AND status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued') LIMIT 1
      `,
        )
        .get(parentKey, parentKey)
      if (unfinishedRound !== undefined) {
        failWorld({
          errorCode: 'BRANCH_DRAINING',
          category: 'admin',
          message: 'branch fork requires no pending or claimed Round',
          retryable: true,
          correlationId: `fork:${child.branchId}`,
          address: parent,
        })
      }
      const parentHead = this.#headRow(parentKey)
      if (!Number.isSafeInteger(forkSeq) || forkSeq < 0 || forkSeq > parentHead.head_seq) {
        throw new RangeError(`forkSeq ${forkSeq} is outside parent head ${parentHead.head_seq}`)
      }
      const forkEvent =
        forkSeq === 0 ? undefined : this.#readEventsByKey(parentKey, 0, forkSeq).find(event => event.seq === forkSeq)
      if (forkSeq !== 0 && forkEvent === undefined) throw new Error(`fork event ${forkSeq} is missing`)
      if (this.#branchDepth(parentKey) >= 8) {
        failWorld({
          errorCode: 'BRANCH_DEPTH_LIMIT',
          category: 'admin',
          message: 'branch depth limit 8 would be exceeded',
          retryable: false,
          correlationId: `fork:${child.branchId}`,
          address: child,
        })
      }
      this.#db
        .prepare(
          `
        INSERT INTO branches(address_key, tenant_id, world_id, branch_id, parent_address_key, fork_seq)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(childKey, child.tenantId, child.worldId, child.branchId, parentKey, forkSeq)
      this.#db
        .prepare(`INSERT INTO heads(address_key, head_seq, tick, event_hash) VALUES (?, ?, ?, ?)`)
        .run(childKey, forkSeq, forkEvent?.tick ?? 0, forkEvent?.eventHash ?? 'genesis')
      this.#db
        .prepare(
          `INSERT INTO branch_controls(address_key, admission_state, lifecycle_state, reason, revision) VALUES (?, 'open', 'active', NULL, 0)`,
        )
        .run(childKey)
      this.#db
        .prepare(
          `
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, 'branch.forked', ?, ?, ?)
      `,
        )
        .run(childKey, `fork:${child.branchId}`, worldJsonText({ parent, forkSeq }), this.operationalNow())
      this.#db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  /** Atomically commit every authoritative effect of one accepted Round. */
  async commitRound(request: CommitRoundRequest): Promise<CommitRoundResult> {
    if (request.events.length === 0) throw new TypeError('a committed round requires at least one event')
    if (request.nextTick !== request.expectedTick + 1)
      throw new TypeError('a committed round advances exactly one tick')
    const addressKey = worldAddressKey(request.address)
    const cognitiveJobs = [...(request.cognitiveJobs ?? [])].sort((left, right) =>
      compareWorldText(left.characterId, right.characterId),
    )
    if (new Set(cognitiveJobs.map(job => job.characterId)).size !== cognitiveJobs.length) {
      throw new TypeError('cognitive job characterId values must be unique within one Round')
    }
    const activeManifest = this.#readManifestByKey(addressKey)
    if (activeManifest !== undefined) assertManifestEvents(activeManifest.manifest, request.events)
    const authorityHash =
      request.authority === undefined ? null : hashWorldJson('world-round-authority', request.authority)
    const requestHash = hashWorldJson('world-round-commit-request', {
      address: request.address,
      transactionId: request.transactionId,
      roundId: request.roundId,
      expectedHeadSeq: request.expectedHeadSeq,
      expectedTick: request.expectedTick,
      nextTick: request.nextTick,
      events: request.events,
      outbox: request.outbox,
      ...(cognitiveJobs.length === 0 ? {} : { cognitiveJobs }),
      ...(authorityHash === null ? {} : { authorityHash }),
    })

    this.#db.exec('BEGIN IMMEDIATE')
    let result: CommitRoundResult
    try {
      const replay = this.#db
        .prepare(
          `
        SELECT request_hash, head_seq, tick, bundle_hash FROM round_commits WHERE transaction_id = ?
      `,
        )
        .get(request.transactionId) as
        | { request_hash: WorldHash; head_seq: number; tick: number; bundle_hash: WorldHash }
        | undefined
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
        return {
          status: 'already_committed',
          headSeq: replay.head_seq,
          tick: replay.tick,
          bundleHash: replay.bundle_hash,
        }
      }

      this.#assertCommitAdmission(addressKey, request)

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
        this.#db
          .prepare(
            `
          INSERT INTO events(address_key, seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
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
      this.faultInjector?.hit('store.after-event-insert')

      const finalHeadSeq = head.head_seq + request.events.length
      const outboxHashes = request.outbox.map(item => {
        const payloadHash = hashWorldJson('world-outbox-payload', item.payload)
        this.#db
          .prepare(
            `
          INSERT INTO outbox(delivery_id, address_key, session_id, world_seq, payload_hash, payload_json, critical, transaction_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
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
        ...(authorityHash === null ? {} : { authorityHash }),
      })
      if (authorityHash !== null) {
        this.#db
          .prepare(
            `
          INSERT INTO round_authority(transaction_id, address_key, round_id, authority_hash, authority_json)
          VALUES (?, ?, ?, ?, ?)
        `,
          )
          .run(request.transactionId, addressKey, request.roundId, authorityHash, worldJsonText(request.authority!))
      }
      this.#db
        .prepare(
          `
        INSERT INTO round_commits(transaction_id, address_key, request_hash, round_id, base_head_seq, base_tick, head_seq, tick, bundle_hash, authority_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          request.transactionId,
          addressKey,
          requestHash,
          request.roundId,
          request.expectedHeadSeq,
          request.expectedTick,
          finalHeadSeq,
          request.nextTick,
          bundleHash,
          authorityHash,
        )
      for (const job of cognitiveJobs) {
        const identity = {
          address: request.address,
          transactionId: request.transactionId,
          characterId: job.characterId,
          asOfWorldSeq: finalHeadSeq,
        }
        const jobId = deterministicId('world-cognitive-job-id', identity)
        const jobHash = hashWorldJson('world-cognitive-job', { jobId, ...identity })
        this.#db
          .prepare(
            `
          INSERT INTO world_cognitive_jobs(
            job_id, address_key, transaction_id, character_id, as_of_seq, status, attempt_count, last_error, job_hash
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?)
        `,
          )
          .run(jobId, addressKey, request.transactionId, job.characterId, finalHeadSeq, jobHash)
      }
      this.#db
        .prepare(`UPDATE heads SET head_seq = ?, tick = ?, event_hash = ? WHERE address_key = ?`)
        .run(finalHeadSeq, request.nextTick, previousHash, addressKey)
      this.#db
        .prepare(
          `
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, 'round.committed', ?, ?, ?)
      `,
        )
        .run(
          addressKey,
          request.correlationId,
          worldJsonText({
            transactionId: request.transactionId,
            roundId: request.roundId,
            bundleHash,
            authorityHash,
            headSeq: finalHeadSeq,
            tick: request.nextTick,
            ...request.operationalSummary,
          }),
          this.operationalNow(),
        )
      this.faultInjector?.hit('store.before-commit')
      this.#db.exec('COMMIT')
      result = { status: 'committed', headSeq: finalHeadSeq, tick: request.nextTick, bundleHash }
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
    this.faultInjector?.hit('store.after-commit')
    return result
  }

  /** Read the branch head or fail closed for an unknown address. */
  head(address: WorldAddress): {
    readonly headSeq: number
    readonly tick: number
    readonly eventHash: WorldHash | 'genesis'
  } {
    const row = this.#headRow(worldAddressKey(address))
    return { headSeq: row.head_seq, tick: row.tick, eventHash: row.event_hash }
  }

  /** Read effective inherited history through asOfSeq. */
  readEvents(address: WorldAddress, asOfSeq = Number.MAX_SAFE_INTEGER): StoredWorldEvent[] {
    return this.#readEventsByKey(worldAddressKey(address), 0, asOfSeq)
  }

  /** Read timestamps in the effective branch prefix without loading event payloads. */
  readEventTicks(address: WorldAddress, asOfSeq: number): Pick<StoredWorldEvent, 'seq' | 'tick'>[] {
    if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0 || asOfSeq > this.head(address).headSeq) {
      throw new RangeError('invalid event timestamp prefix')
    }
    return this.#eventRangesByKey(worldAddressKey(address), 0, asOfSeq).flatMap(
      range =>
        this.#db
          .prepare(
            `
        SELECT seq, tick FROM events WHERE address_key = ? AND seq > ? AND seq <= ? ORDER BY seq
      `,
          )
          .all(range.addressKey, range.afterSeq, range.asOfSeq) as Pick<StoredWorldEvent, 'seq' | 'tick'>[],
    )
  }

  /** Read only one effective Event range; callers may additionally restrict the stable event vocabulary. */
  readEventsRange(
    address: WorldAddress,
    afterSeq: number,
    asOfSeq: number,
    eventTypes?: readonly string[],
  ): StoredWorldEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(asOfSeq) || asOfSeq < afterSeq) {
      throw new RangeError('Event range bounds must be ordered non-negative safe integers')
    }
    const normalizedTypes = eventTypes === undefined ? undefined : [...new Set(eventTypes)].sort(compareWorldText)
    if (normalizedTypes?.some(value => value.length === 0 || value.trim() !== value)) {
      throw new TypeError('Event range types must be non-empty, unpadded strings')
    }
    if (normalizedTypes?.length === 0) return []
    return this.#readEventsByKey(worldAddressKey(address), afterSeq, asOfSeq, normalizedTypes)
  }

  /** Read committed Outbox items for one branch. */
  readOutbox(address: WorldAddress): StoredOutboxItem[] {
    const key = worldAddressKey(address)
    const rows = this.#db
      .prepare(
        `
      SELECT delivery_id, session_id, world_seq, payload_hash, payload_json, critical
      FROM outbox WHERE address_key = ? ORDER BY world_seq, delivery_id
    `,
      )
      .all(key) as Array<{
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

  /** Read hash-verified derived-state jobs created by committed local Rounds. */
  readCognitiveJobs(address: WorldAddress, includeCompleted = false): StoredCognitiveJob[] {
    const addressKey = worldAddressKey(address)
    const rows = this.#db
      .prepare(
        `
      SELECT job_id, transaction_id, character_id, as_of_seq, status, attempt_count, last_error, job_hash
      FROM world_cognitive_jobs
      WHERE address_key = ? ${includeCompleted ? '' : "AND status != 'completed'"}
      ORDER BY as_of_seq, character_id, job_id
    `,
      )
      .all(addressKey) as Array<{
      job_id: string
      transaction_id: TransactionId
      character_id: StoredCognitiveJob['characterId']
      as_of_seq: number
      status: StoredCognitiveJob['status']
      attempt_count: number
      last_error: string | null
      job_hash: WorldHash
    }>
    return rows.map(row => {
      const expected = hashWorldJson('world-cognitive-job', {
        jobId: row.job_id,
        address,
        transactionId: row.transaction_id,
        characterId: row.character_id,
        asOfWorldSeq: row.as_of_seq,
      })
      if (expected !== row.job_hash) {
        failWorld({
          errorCode: 'BUNDLE_HASH_MISMATCH',
          category: 'integrity',
          message: 'World cognitive job hash is divergent',
          retryable: false,
          correlationId: `cognitive-job:${row.job_id}`,
          address,
        })
      }
      return {
        jobId: row.job_id,
        address,
        transactionId: row.transaction_id,
        characterId: row.character_id,
        asOfWorldSeq: row.as_of_seq,
        status: row.status,
        attemptCount: row.attempt_count,
        lastError: row.last_error,
        jobHash: row.job_hash,
      }
    })
  }

  /** Fence and record one idempotent cross-database cognitive worker attempt. */
  recordCognitiveJobResult(
    address: WorldAddress,
    jobId: string,
    ownerId: string,
    fencingToken: number,
    status: 'completed' | 'failed',
    error: string | null,
    correlationId: string,
  ): void {
    const addressKey = worldAddressKey(address)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const lease = this.#db
        .prepare(
          `
        SELECT owner_id, fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?
      `,
        )
        .get(addressKey) as { owner_id: string; fencing_token: number; expires_at_ms: number } | undefined
      if (
        lease === undefined ||
        lease.owner_id !== ownerId ||
        lease.fencing_token !== fencingToken ||
        lease.expires_at_ms <= this.operationalNow()
      ) {
        failWorld({
          errorCode: 'WRITER_LEASE_LOST',
          category: 'runtime',
          message: 'cognitive worker lost its database writer lease',
          retryable: true,
          correlationId,
          address,
          details: { suppliedFencingToken: fencingToken },
        })
      }
      const current = this.#db
        .prepare(
          `
        SELECT status FROM world_cognitive_jobs WHERE address_key = ? AND job_id = ?
      `,
        )
        .get(addressKey, jobId) as { status: StoredCognitiveJob['status'] } | undefined
      if (current === undefined) throw new Error('World cognitive job is missing')
      if (current.status === 'completed') {
        if (status !== 'completed') throw new Error('completed cognitive job cannot regress')
        this.#db.exec('COMMIT')
        return
      }
      this.#db
        .prepare(
          `
        UPDATE world_cognitive_jobs
        SET status = ?, attempt_count = attempt_count + 1, last_error = ?
        WHERE address_key = ? AND job_id = ?
      `,
        )
        .run(status, error, addressKey, jobId)
      this.#db.exec('COMMIT')
    } catch (caught: unknown) {
      rollbackAndThrow(this.#db, caught)
    }
  }

  /** Persist a no-Round admission clarification and its audit record idempotently. */
  recordClarification(
    address: WorldAddress,
    idempotencyKey: string,
    input: WorldJsonValue,
    result: WorldJsonValue,
    correlationId: string,
  ): WorldJsonValue {
    const addressKey = worldAddressKey(address)
    const inputHash = hashWorldJson('round-clarification-input', input)
    const resultHash = hashWorldJson('round-clarification-result', result)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db
        .prepare(
          `
        SELECT input_hash, result_hash, result_json FROM round_clarifications
        WHERE address_key = ? AND idempotency_key = ?
      `,
        )
        .get(addressKey, idempotencyKey) as
        | {
            input_hash: WorldHash
            result_hash: WorldHash
            result_json: string
          }
        | undefined
      if (existing !== undefined) {
        if (existing.input_hash !== inputHash) {
          failWorld({
            errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
            category: 'admission',
            message: 'clarification idempotencyKey is already bound to another input',
            retryable: false,
            correlationId,
            address,
          })
        }
        const stored = parseWorldJson(existing.result_json)
        if (existing.result_hash !== hashWorldJson('round-clarification-result', stored)) {
          failWorld({
            errorCode: 'BUNDLE_HASH_MISMATCH',
            category: 'integrity',
            message: 'durable clarification result hash is divergent',
            retryable: false,
            correlationId,
            address,
          })
        }
        this.#db.exec('COMMIT')
        return stored
      }
      this.#assertAdmissionOpen(addressKey, correlationId, address)
      const now = this.operationalNow()
      this.#db
        .prepare(
          `
        INSERT INTO round_clarifications(
          address_key, idempotency_key, input_hash, input_json, result_hash, result_json, correlation_id, operational_time_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          addressKey,
          idempotencyKey,
          inputHash,
          worldJsonText(input),
          resultHash,
          worldJsonText(result),
          correlationId,
          now,
        )
      this.#db
        .prepare(
          `
        INSERT INTO branch_audit_events(address_key, operation, correlation_id, details_json, operational_time_ms)
        VALUES (?, 'round.clarified', ?, ?, ?)
      `,
        )
        .run(addressKey, correlationId, worldJsonText({ idempotencyKey, inputHash, resultHash }), now)
      this.#db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      rollbackAndThrow(this.#db, error)
    }
  }

  readClarification(
    address: WorldAddress,
    idempotencyKey: string,
    input?: WorldJsonValue,
    correlationId = `clarification:${idempotencyKey}`,
  ): WorldJsonValue | undefined {
    const row = this.#db
      .prepare(
        `
      SELECT input_hash, result_hash, result_json FROM round_clarifications WHERE address_key = ? AND idempotency_key = ?
    `,
      )
      .get(worldAddressKey(address), idempotencyKey) as
      | {
          input_hash: WorldHash
          result_hash: WorldHash
          result_json: string
        }
      | undefined
    if (row === undefined) return undefined
    if (input !== undefined && row.input_hash !== hashWorldJson('round-clarification-input', input)) {
      failWorld({
        errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
        category: 'admission',
        message: 'clarification idempotencyKey is already bound to another input',
        retryable: false,
        correlationId,
        address,
      })
    }
    const result = parseWorldJson(row.result_json)
    if (row.result_hash !== hashWorldJson('round-clarification-result', result)) {
      failWorld({
        errorCode: 'BUNDLE_HASH_MISMATCH',
        category: 'integrity',
        message: 'durable clarification result hash is divergent',
        retryable: false,
        correlationId,
        address,
      })
    }
    return result
  }

  /** Return the frozen base boundary used by an already committed transaction. */
  roundBase(
    transactionId: CommitRoundRequest['transactionId'],
  ): { readonly headSeq: number; readonly tick: number } | undefined {
    const row = this.#db
      .prepare(
        `
      SELECT base_head_seq, base_tick FROM round_commits WHERE transaction_id = ?
    `,
      )
      .get(transactionId) as { base_head_seq: number; base_tick: number } | undefined
    return row === undefined ? undefined : { headSeq: row.base_head_seq, tick: row.base_tick }
  }

  /** Read same-transaction operational reconciliation intent for one committed Round. */
  committedRoundOperationalSummary(address: WorldAddress, transactionId: TransactionId): WorldJsonObject | undefined {
    const rows = this.#db
      .prepare(
        `
      SELECT details_json FROM branch_audit_events
      WHERE address_key = ? AND operation = 'round.committed' ORDER BY audit_seq
    `,
      )
      .all(worldAddressKey(address)) as Array<{ details_json: string }>
    const matches = rows
      .map(row => parseWorldJson(row.details_json))
      .filter((value): value is WorldJsonObject => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
        return (value as WorldJsonObject).transactionId === transactionId
      })
    if (matches.length > 1) {
      this.#invalidCommittedRound(address, transactionId, 'committed Round has divergent operational summaries')
    }
    return matches[0]
  }

  /** Read the authoritative outcome of one transaction without recomputing Provider proposals. */
  committedRound(address: WorldAddress, transactionId: TransactionId): CommittedRoundRecord | undefined {
    const addressKey = worldAddressKey(address)
    const row = this.#db
      .prepare(
        `
      SELECT round_id, base_head_seq, base_tick, head_seq, tick, bundle_hash, authority_hash
      FROM round_commits WHERE transaction_id = ? AND address_key = ?
    `,
      )
      .get(transactionId, addressKey) as
      | {
          round_id: CommitRoundRequest['roundId']
          base_head_seq: number
          base_tick: number
          head_seq: number
          tick: number
          bundle_hash: WorldHash
          authority_hash: WorldHash | null
        }
      | undefined
    if (row === undefined) return undefined
    const events = this.#db
      .prepare(
        `
      SELECT seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal
      FROM events WHERE address_key = ? AND transaction_id = ? ORDER BY event_ordinal
    `,
      )
      .all(addressKey, transactionId) as unknown as EventRow[]
    const outbox = this.#db
      .prepare(
        `
      SELECT world_seq, payload_hash FROM outbox WHERE address_key = ? AND transaction_id = ? ORDER BY rowid
    `,
      )
      .all(addressKey, transactionId) as Array<{ world_seq: number; payload_hash: WorldHash }>
    if (
      events.length === 0 ||
      events.length !== row.head_seq - row.base_head_seq ||
      events.some(
        (event, index) =>
          event.seq !== row.base_head_seq + index + 1 || event.tick !== row.tick || event.event_ordinal !== index,
      ) ||
      outbox.some(item => item.world_seq !== row.head_seq)
    ) {
      this.#invalidCommittedRound(address, transactionId, 'committed Round boundaries are inconsistent')
    }
    let previousHash = events[0]!.previous_hash
    const eventHashes: WorldHash[] = []
    for (const event of events) {
      if (event.previous_hash !== previousHash) {
        this.#invalidCommittedRound(address, transactionId, 'committed Round event chain is discontinuous')
      }
      const data = parseWorldJson(event.data_json)
      const eventHash = hashWorldJson('world-event-envelope', {
        address,
        seq: event.seq,
        tick: event.tick,
        eventType: event.event_type,
        eventVersion: event.event_version,
        data,
        previousHash: event.previous_hash,
        transactionId,
        eventOrdinal: event.event_ordinal,
      })
      if (event.event_hash !== eventHash) {
        this.#invalidCommittedRound(address, transactionId, 'committed Round event hash is divergent')
      }
      eventHashes.push(eventHash)
      previousHash = eventHash
    }
    const authority = this.#authorityRow(transactionId, address)
    if (
      (row.authority_hash === null) !== (authority === undefined) ||
      (authority !== undefined &&
        (authority.authorityHash !== row.authority_hash || authority.roundId !== row.round_id))
    ) {
      this.#invalidCommittedRound(address, transactionId, 'committed Round authority binding is divergent')
    }
    const bundleHash = hashWorldJson('world-round-bundle', {
      address,
      roundId: row.round_id,
      tick: row.tick,
      eventHashes,
      outboxHashes: outbox.map(item => item.payload_hash),
      ...(row.authority_hash === null ? {} : { authorityHash: row.authority_hash }),
    })
    if (bundleHash !== row.bundle_hash) {
      this.#invalidCommittedRound(address, transactionId, 'committed Round bundle hash is divergent')
    }
    return {
      transactionId,
      roundId: row.round_id,
      baseHeadSeq: row.base_head_seq,
      baseTick: row.base_tick,
      headSeq: row.head_seq,
      tick: row.tick,
      bundleHash: row.bundle_hash,
      events: events.map(event => ({
        address,
        seq: event.seq,
        tick: event.tick,
        eventType: event.event_type,
        eventVersion: event.event_version,
        data: parseWorldJson(event.data_json),
        previousHash: event.previous_hash,
        eventHash: event.event_hash,
        transactionId: event.transaction_id as TransactionId,
        eventOrdinal: event.event_ordinal,
      })),
    }
  }

  /** Read a hash-verified authority record only when its transaction is effective on this Branch. */
  readRoundAuthority(address: WorldAddress, transactionId: TransactionId): StoredRoundAuthority | undefined {
    if (!this.#transactionIsEffective(worldAddressKey(address), transactionId)) return undefined
    return this.#authorityRow(transactionId, address)
  }

  /** Verify the effective Event chain, Head, and every local committed Round without mutating authority. */
  verifyBranchIntegrity(address: WorldAddress): BranchIntegrityReport {
    const addressKey = worldAddressKey(address)
    const head = this.head(address)
    const events = this.readEvents(address, head.headSeq)
    let previousHash: WorldHash | 'genesis' = 'genesis'
    let tick = 0
    for (const [index, event] of events.entries()) {
      const expectedHash = hashWorldJson('world-event-envelope', {
        address: event.address,
        seq: event.seq,
        tick: event.tick,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        data: event.data,
        previousHash: event.previousHash,
        transactionId: event.transactionId,
        eventOrdinal: event.eventOrdinal,
      })
      if (
        event.seq !== index + 1 ||
        event.previousHash !== previousHash ||
        event.tick < tick ||
        event.eventHash !== expectedHash
      ) {
        this.#invalidBranchIntegrity(address, 'effective Event chain is divergent')
      }
      previousHash = event.eventHash
      tick = event.tick
    }
    if (events.length !== head.headSeq || previousHash !== head.eventHash || tick !== head.tick) {
      this.#invalidBranchIntegrity(address, 'Branch Head does not match the effective Event chain')
    }
    const transactions = this.#db
      .prepare(
        `
      SELECT transaction_id FROM round_commits WHERE address_key = ? ORDER BY base_head_seq, transaction_id
    `,
      )
      .all(addressKey) as Array<{ transaction_id: TransactionId }>
    for (const transaction of transactions) this.committedRound(address, transaction.transaction_id)
    const verified = {
      address,
      headSeq: head.headSeq,
      tick: head.tick,
      eventCount: events.length,
      roundCount: transactions.length,
      headEventHash: head.eventHash,
    }
    return {
      headSeq: head.headSeq,
      tick: head.tick,
      eventCount: events.length,
      roundCount: transactions.length,
      verificationHash: hashWorldJson('branch-integrity-verification', verified),
    }
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
    const row = this.#db
      .prepare(`SELECT head_seq, tick, event_hash FROM heads WHERE address_key = ?`)
      .get(addressKey) as HeadRow | undefined
    if (row === undefined) throw new Error(`unknown world branch ${addressKey}`)
    return row
  }

  #invalidCommittedRound(address: WorldAddress, transactionId: TransactionId, message: string): never {
    failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH',
      category: 'integrity',
      message,
      retryable: false,
      correlationId: `committed-round:${transactionId}`,
      address,
    })
  }

  #invalidBranchIntegrity(address: WorldAddress, message: string): never {
    failWorld({
      errorCode: 'BUNDLE_HASH_MISMATCH',
      category: 'integrity',
      message,
      retryable: false,
      correlationId: `branch-integrity:${worldAddressKey(address)}`,
      address,
    })
  }

  #authorityRow(transactionId: TransactionId, address: WorldAddress): StoredRoundAuthority | undefined {
    const row = this.#db
      .prepare(
        `
      SELECT round_id, authority_hash, authority_json FROM round_authority WHERE transaction_id = ?
    `,
      )
      .get(transactionId) as
      | { round_id: CommitRoundRequest['roundId']; authority_hash: WorldHash; authority_json: string }
      | undefined
    if (row === undefined) return undefined
    const authority = parseWorldJson(row.authority_json)
    if (
      typeof authority !== 'object' ||
      authority === null ||
      Array.isArray(authority) ||
      worldJsonText(authority) !== row.authority_json ||
      hashWorldJson('world-round-authority', authority) !== row.authority_hash
    ) {
      this.#invalidCommittedRound(address, transactionId, 'committed Round authority content is divergent')
    }
    return {
      transactionId,
      roundId: row.round_id,
      authorityHash: row.authority_hash,
      authority: authority as WorldJsonObject,
    }
  }

  #branchDepth(addressKey: string): number {
    let depth = 0
    let current: string | null = addressKey
    while (current !== null) {
      const row = this.#db.prepare(`SELECT parent_address_key FROM branches WHERE address_key = ?`).get(current) as
        | {
            parent_address_key: string | null
          }
        | undefined
      if (row === undefined) throw new Error(`unknown world branch ${current}`)
      current = row.parent_address_key
      if (current !== null) depth += 1
    }
    return depth
  }

  #assertWriterLease(addressKey: string, request: CommitRoundRequest): void {
    const counter = this.#db
      .prepare(`SELECT 1 AS present FROM writer_lease_counters WHERE address_key = ?`)
      .get(addressKey)
    if (counter === undefined) return
    const lease = this.#db
      .prepare(
        `
      SELECT fencing_token, expires_at_ms FROM writer_leases WHERE address_key = ?
    `,
      )
      .get(addressKey) as { fencing_token: number; expires_at_ms: number } | undefined
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
    const row = this.#db
      .prepare(
        `
      SELECT admission_state, lifecycle_state, runtime_phase FROM branch_controls WHERE address_key = ?
    `,
      )
      .get(addressKey) as
      | {
          admission_state: 'open' | 'draining'
          lifecycle_state: 'active' | 'archived'
          runtime_phase: 'active' | 'maintenance' | 'quarantined' | 'archived'
        }
      | undefined
    if (row === undefined) throw new Error(`unknown world branch ${addressKey}`)
    if (row.admission_state !== 'open' || row.lifecycle_state !== 'active' || row.runtime_phase !== 'active') {
      failWorld({
        errorCode: row.runtime_phase === 'quarantined' ? 'BRANCH_QUARANTINED' : 'BRANCH_DRAINING',
        category: 'admin',
        message:
          row.runtime_phase === 'quarantined'
            ? 'branch is quarantined'
            : row.lifecycle_state === 'archived'
              ? 'branch is archived'
              : 'branch admission is draining',
        retryable: row.lifecycle_state !== 'archived' && row.runtime_phase !== 'quarantined',
        correlationId,
        address,
      })
    }
  }

  #assertCommitAdmission(addressKey: string, request: CommitRoundRequest): void {
    const row = this.#db
      .prepare(
        `
      SELECT admission_state, lifecycle_state, runtime_phase FROM branch_controls WHERE address_key = ?
    `,
      )
      .get(addressKey) as
      | {
          admission_state: 'open' | 'draining'
          lifecycle_state: 'active' | 'archived'
          runtime_phase: 'active' | 'maintenance' | 'quarantined' | 'archived'
        }
      | undefined
    if (row === undefined) throw new Error(`unknown world branch ${addressKey}`)
    if (row.runtime_phase !== 'active') {
      failWorld({
        errorCode: row.runtime_phase === 'quarantined' ? 'BRANCH_QUARANTINED' : 'BRANCH_DRAINING',
        category: 'admin',
        message: `branch runtime phase is ${row.runtime_phase}`,
        retryable: false,
        correlationId: request.correlationId,
        address: request.address,
        roundId: request.roundId,
      })
    }
    const proof = request.admissionProof
    const admitted =
      proof === undefined
        ? undefined
        : (this.#db
            .prepare(
              `
      SELECT input_hash, commit_transaction_id FROM round_inbox
      WHERE address_key = ? AND inbox_seq = ? AND status IN ('pending', 'claimed')
    `,
            )
            .get(addressKey, proof.inboxSeq) as
            | {
                input_hash: WorldHash
                commit_transaction_id: string | null
              }
            | undefined)
    if (proof !== undefined && admitted?.input_hash === proof.inputHash) {
      if (admitted.commit_transaction_id !== null && admitted.commit_transaction_id !== request.transactionId) {
        failWorld({
          errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
          category: 'admission',
          message: 'durable Round admission is already bound to another transaction',
          retryable: false,
          correlationId: request.correlationId,
          address: request.address,
          roundId: request.roundId,
        })
      }
      const bound = this.#db
        .prepare(
          `
        UPDATE round_inbox SET commit_transaction_id = ?
        WHERE address_key = ? AND inbox_seq = ? AND input_hash = ?
          AND status IN ('pending', 'claimed')
          AND (commit_transaction_id IS NULL OR commit_transaction_id = ?)
      `,
        )
        .run(request.transactionId, addressKey, proof.inboxSeq, proof.inputHash, request.transactionId)
      if (bound.changes !== 1) {
        failWorld({
          errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
          category: 'admission',
          message: 'durable Round admission could not be bound to this transaction',
          retryable: false,
          correlationId: request.correlationId,
          address: request.address,
          roundId: request.roundId,
        })
      }
    }
    if (row.lifecycle_state === 'active' && row.admission_state === 'open') {
      if (proof === undefined || admitted?.input_hash === proof.inputHash) return
      failWorld({
        errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
        category: 'admission',
        message: 'Round commit has no matching durable admission proof',
        retryable: false,
        correlationId: request.correlationId,
        address: request.address,
        roundId: request.roundId,
      })
    }
    if (row.lifecycle_state !== 'active' || proof === undefined || admitted?.input_hash !== proof.inputHash) {
      failWorld({
        errorCode: 'BRANCH_DRAINING',
        category: 'admin',
        message:
          row.lifecycle_state === 'archived'
            ? 'branch is archived'
            : 'branch admission is draining and the Round has no matching durable admission proof',
        retryable: row.lifecycle_state !== 'archived',
        correlationId: request.correlationId,
        address: request.address,
        roundId: request.roundId,
      })
    }
  }

  #transactionIsEffective(addressKey: string, transactionId: TransactionId): boolean {
    const event = this.#db
      .prepare(
        `
      SELECT address_key, seq FROM events WHERE transaction_id = ? ORDER BY event_ordinal LIMIT 1
    `,
      )
      .get(transactionId) as { address_key: string; seq: number } | undefined
    if (event === undefined) return false
    const head = this.#headRow(addressKey)
    let currentKey = addressKey
    let effectiveThrough = head.head_seq
    while (true) {
      const branch = this.#db
        .prepare(
          `
        SELECT parent_address_key, fork_seq FROM branches WHERE address_key = ?
      `,
        )
        .get(currentKey) as { parent_address_key: string | null; fork_seq: number | null } | undefined
      if (branch === undefined) throw new Error(`unknown world branch ${currentKey}`)
      if (currentKey === event.address_key) {
        return event.seq > (branch.fork_seq ?? 0) && event.seq <= effectiveThrough
      }
      if (branch.parent_address_key === null) return false
      effectiveThrough = Math.min(effectiveThrough, branch.fork_seq as number)
      currentKey = branch.parent_address_key
    }
  }

  #eventRangesByKey(
    addressKey: string,
    afterSeq: number,
    asOfSeq: number,
  ): { address: WorldAddress; addressKey: string; afterSeq: number; asOfSeq: number }[] {
    const branch = this.#db
      .prepare(
        `
      SELECT tenant_id, world_id, branch_id, parent_address_key, fork_seq FROM branches WHERE address_key = ?
    `,
      )
      .get(addressKey) as BranchRow | undefined
    if (branch === undefined) throw new Error(`unknown world branch ${addressKey}`)
    const address = {
      tenantId: branch.tenant_id,
      worldId: branch.world_id,
      branchId: branch.branch_id,
    } as WorldAddress
    const parentAsOf = branch.parent_address_key === null ? 0 : Math.min(asOfSeq, branch.fork_seq as number)
    const inherited =
      branch.parent_address_key === null || parentAsOf <= afterSeq
        ? []
        : this.#eventRangesByKey(branch.parent_address_key, afterSeq, parentAsOf)
    return [...inherited, { address, addressKey, afterSeq: Math.max(branch.fork_seq ?? 0, afterSeq), asOfSeq }]
  }

  #readEventsByKey(
    addressKey: string,
    afterSeq: number,
    asOfSeq: number,
    eventTypes?: readonly string[],
  ): StoredWorldEvent[] {
    const typeFilter = eventTypes === undefined ? '' : `AND event_type IN (${eventTypes.map(() => '?').join(', ')})`
    return this.#eventRangesByKey(addressKey, afterSeq, asOfSeq).flatMap(range => {
      const rows = this.#db
        .prepare(
          `
        SELECT seq, tick, event_type, event_version, data_json, previous_hash, event_hash, transaction_id, event_ordinal
        FROM events WHERE address_key = ? AND seq > ? AND seq <= ? ${typeFilter} ORDER BY seq
      `,
        )
        .all(range.addressKey, range.afterSeq, range.asOfSeq, ...(eventTypes ?? [])) as unknown as EventRow[]
      return rows.map(row => ({
        address: range.address,
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
    })
  }
}
