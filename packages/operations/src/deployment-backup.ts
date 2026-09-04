import { createHash } from 'node:crypto'
import {
  copyFileSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  failWorld,
  hashContextReceipt,
  hashWorldJson,
  type FaultInjector,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { CONTEXT_APPLICATION_ID, CONTEXT_SCHEMA_VERSION, ProviderCallStore } from '@harness-world/agents'
import { MEMORY_APPLICATION_ID, MEMORY_SCHEMA_VERSION } from '@harness-world/memory'
import {
  AUDIT_APPLICATION_ID,
  AUDIT_SCHEMA_VERSION,
  OperationalAuditLog,
  readPragmaInteger,
  SESSION_APPLICATION_ID,
  SESSION_SCHEMA_VERSION,
  SessionDeliveryAdapter,
  WORLD_APPLICATION_ID,
  WORLD_SCHEMA_VERSION,
  WorldStore,
} from '@harness-world/store-sqlite'
import { WorldHostInstanceLock } from './host-config.ts'

export const DEPLOYMENT_BACKUP_FORMAT = 'world-deployment-backup/v1' as const

export type DeploymentDatabaseRole = 'world' | 'audit' | 'session' | 'memory' | 'context'

export interface DeploymentDatabasePaths {
  readonly worldPath: string
  readonly auditPath?: string
  readonly sessionPath: string
  readonly memoryPath: string
  readonly contextPath: string
  readonly lockPath: string
  readonly sourceDeployment?: string
}

export interface DeploymentBackupFile extends WorldJsonObject {
  readonly role: DeploymentDatabaseRole
  readonly path: string
  readonly byteLength: number
  readonly sha256: WorldHash
  readonly applicationId: number
  readonly userVersion: number
  readonly quickCheck: 'ok'
}

export interface DeploymentBranchWatermark extends WorldJsonObject {
  readonly addressKey: string
  readonly headSeq: number
  readonly tick: number
  readonly eventHash: string
}

export interface DeploymentBackupWatermarks extends WorldJsonObject {
  readonly branches: readonly DeploymentBranchWatermark[]
  readonly outbox: readonly WorldJsonObject[]
  readonly sessions: readonly WorldJsonObject[]
  readonly memory: readonly WorldJsonObject[]
  readonly providerCalls: readonly WorldJsonObject[]
  readonly maximumCheckpointAsOfSeq: number
  readonly activeReactionCycles: number
  readonly terminalReactionCycles: number
  readonly auditRecords: number
  readonly auditTailHash: string
}

export interface DeploymentBackupManifestInput extends WorldJsonObject {
  readonly format: typeof DEPLOYMENT_BACKUP_FORMAT
  readonly correlationId: string
  readonly createdAtMs: number
  readonly sourceDeployment: string
  readonly files: readonly DeploymentBackupFile[]
  readonly watermarks: DeploymentBackupWatermarks
}

export interface DeploymentBackupManifest extends DeploymentBackupManifestInput {
  readonly manifestHash: WorldHash
}

export interface DeploymentRestoreProvenance extends WorldJsonObject {
  readonly format: 'world-deployment-restore-provenance/v1'
  readonly sourceManifestHash: WorldHash
  readonly correlationId: string
  readonly restoredAtMs: number
  readonly fileHashes: readonly WorldJsonObject[]
  readonly checks: readonly string[]
  readonly provenanceHash: WorldHash
}

interface ExpectedDatabase {
  readonly role: DeploymentDatabaseRole
  readonly path: string
  readonly applicationId: number
  readonly userVersion: number
}

interface OpenDatabases {
  readonly world: DatabaseSync
  readonly session: DatabaseSync
  readonly memory: DatabaseSync
  readonly context: DatabaseSync
}

const FILE_NAMES: Readonly<Record<DeploymentDatabaseRole, string>> = Object.freeze({
  world: 'world.sqlite',
  audit: 'world.sqlite.audit.sqlite',
  session: 'session.sqlite',
  memory: 'memory.sqlite',
  context: 'context.sqlite',
})

const PROVIDER_STATES = Object.freeze([
  'budget_exhausted', 'committed', 'discarded_after_quarantine', 'failed_before_dispatch',
  'invalid_response', 'provider_rejected', 'timed_out_ambiguous',
] as const)

function bytesHash(bytes: Uint8Array): WorldHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalText(value: WorldJsonValue): string {
  return Buffer.from(canonicalizeWorldJson(value)).toString('utf8')
}

function error(
  errorCode: 'BACKUP_INVALID' | 'RESTORE_VALIDATION_FAILED' | 'IMPORT_ID_CONFLICT',
  correlationId: string,
  message: string,
): never {
  failWorld({ errorCode, category: errorCode === 'IMPORT_ID_CONFLICT' ? 'admin' : 'integrity', message, retryable: false, correlationId })
}

function invariant(condition: boolean, correlationId: string, message: string): void {
  if (!condition) error('BACKUP_INVALID', correlationId, message)
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { value: number }
  return row.value
}

function operationTime(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('deployment operation time must be a non-negative safe integer')
  return value
}

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

function closeDatabases(databases: OpenDatabases): void {
  databases.context.close()
  databases.memory.close()
  databases.session.close()
  databases.world.close()
}

function expectedDatabases(paths: DeploymentDatabasePaths): ExpectedDatabase[] {
  return [
    { role: 'world', path: paths.worldPath, applicationId: WORLD_APPLICATION_ID, userVersion: WORLD_SCHEMA_VERSION },
    { role: 'audit', path: paths.auditPath ?? `${paths.worldPath}.audit.sqlite`, applicationId: AUDIT_APPLICATION_ID, userVersion: AUDIT_SCHEMA_VERSION },
    { role: 'session', path: paths.sessionPath, applicationId: SESSION_APPLICATION_ID, userVersion: SESSION_SCHEMA_VERSION },
    { role: 'memory', path: paths.memoryPath, applicationId: MEMORY_APPLICATION_ID, userVersion: MEMORY_SCHEMA_VERSION },
    { role: 'context', path: paths.contextPath, applicationId: CONTEXT_APPLICATION_ID, userVersion: CONTEXT_SCHEMA_VERSION },
  ]
}

function artifactPaths(directory: string, lockPath = join(directory, 'instance.lock')): DeploymentDatabasePaths {
  return {
    worldPath: join(directory, FILE_NAMES.world),
    auditPath: join(directory, FILE_NAMES.audit),
    sessionPath: join(directory, FILE_NAMES.session),
    memoryPath: join(directory, FILE_NAMES.memory),
    contextPath: join(directory, FILE_NAMES.context),
    lockPath,
    sourceDeployment: basename(directory),
  }
}

function inspectDatabase(expected: ExpectedDatabase, correlationId: string, code: 'BACKUP_INVALID' | 'RESTORE_VALIDATION_FAILED'): DeploymentBackupFile {
  try {
    const bytes = readFileSync(expected.path)
    const db = openReadOnly(expected.path)
    try {
      const applicationId = readPragmaInteger(db, 'application_id')
      const userVersion = readPragmaInteger(db, 'user_version')
      const quickCheck = db.prepare('PRAGMA quick_check').get() as { quick_check?: string }
      const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
      invariant(applicationId === expected.applicationId, correlationId, `${expected.role} SQLite application identity is invalid`)
      invariant(userVersion === expected.userVersion, correlationId, `${expected.role} SQLite schema version is invalid`)
      invariant(quickCheck.quick_check === 'ok', correlationId, `${expected.role} SQLite quick_check failed`)
      invariant(foreignKeys.length === 0, correlationId, `${expected.role} SQLite foreign keys are invalid`)
      return {
        role: expected.role,
        path: FILE_NAMES[expected.role],
        byteLength: bytes.byteLength,
        sha256: bytesHash(bytes),
        applicationId,
        userVersion,
        quickCheck: 'ok',
      }
    } finally {
      db.close()
    }
  } catch (cause: unknown) {
    error(code, correlationId, `${expected.role} database validation failed: ${String(cause)}`)
  }
}

function branchKeyFromNamespace(namespaceKey: string, correlationId: string): string {
  const parts = namespaceKey.split('\u001f')
  invariant(parts.length === 4, correlationId, `character namespace is malformed: ${namespaceKey}`)
  invariant(parts.every(part => part.length > 0), correlationId, `character namespace is malformed: ${namespaceKey}`)
  return parts.slice(0, 3).join('\u001f')
}

function verifyAudit(path: string, correlationId: string): { readonly records: number; readonly tailHash: string } {
  try {
    const audit = new OperationalAuditLog(path)
    try {
      const records = audit.read()
      return { records: records.length, tailHash: records.at(-1)?.recordHash ?? 'genesis' }
    } finally {
      audit.close()
    }
  } catch (cause: unknown) {
    error('BACKUP_INVALID', correlationId, `audit hash chain validation failed: ${String(cause)}`)
  }
}

function auditWatermark(path: string): { readonly records: number; readonly tailHash: string } {
  const db = openReadOnly(path)
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS records,
        COALESCE((SELECT record_hash FROM operational_audit_events ORDER BY audit_seq DESC LIMIT 1), 'genesis') AS tail_hash
      FROM operational_audit_events
    `).get() as { records: number; tail_hash: string }
    return { records: row.records, tailHash: row.tail_hash }
  } finally {
    db.close()
  }
}

function verifyWorldAndReaction(path: string, correlationId: string): void {
  try {
    const world = new WorldStore(path)
    try {
      for (const address of world.listBranches()) {
        world.verifyBranchIntegrity(address)
        world.listReactionCycles(address)
      }
    } finally {
      world.close()
    }
  } catch (cause: unknown) {
    error('BACKUP_INVALID', correlationId, `World authority or Reaction integrity failed: ${String(cause)}`)
  }
}

function verifySession(path: string, correlationId: string): void {
  try {
    const session = new SessionDeliveryAdapter(path)
    try {
      session.verifyIntegrity({ tenantId: 'deployment', worldId: 'deployment', branchId: 'deployment' } as WorldAddress, correlationId)
    } finally {
      session.close()
    }
  } catch (cause: unknown) {
    error('BACKUP_INVALID', correlationId, `Session integrity failed: ${String(cause)}`)
  }
}

function verifyProviderRows(path: string, correlationId: string): void {
  const raw = openReadOnly(path)
  const ids = raw.prepare('SELECT model_call_id FROM provider_calls ORDER BY model_call_id').all() as Array<{ model_call_id: string }>
  raw.close()
  try {
    const calls = new ProviderCallStore(path)
    try {
      for (const row of ids) calls.read(row.model_call_id)
    } finally {
      calls.close()
    }
  } catch (cause: unknown) {
    error('BACKUP_INVALID', correlationId, `ProviderCall integrity failed: ${String(cause)}`)
  }
}

function verifyDeepViaScratch(paths: DeploymentDatabasePaths, correlationId: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'hcw-deployment-validate-'))
  try {
    const copied = artifactPaths(scratch)
    for (const expected of expectedDatabases(paths)) {
      copyFileSync(expected.path, join(scratch, FILE_NAMES[expected.role]), constants.COPYFILE_EXCL)
    }
    verifyWorldAndReaction(copied.worldPath, correlationId)
    verifySession(copied.sessionPath, correlationId)
    verifyProviderRows(copied.contextPath, correlationId)
    verifyAudit(copied.auditPath!, correlationId)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function assertQuiet(world: DatabaseSync, nowMs: number, correlationId: string): void {
  const blockers = [
    count(world, `SELECT COUNT(*) AS value FROM round_inbox WHERE status IN ('pending', 'claimed')`),
    count(world, `SELECT COUNT(*) AS value FROM writer_leases WHERE expires_at_ms > ${nowMs}`),
    count(world, `SELECT COUNT(*) AS value FROM outbox WHERE critical = 1 AND delivery_status <> 'delivered'`),
    count(world, `SELECT COUNT(*) AS value FROM world_reaction_cycles WHERE status <> 'terminal'`),
    count(world, `SELECT COUNT(*) AS value FROM world_reaction_jobs WHERE status IN ('pending', 'claimed')`),
    count(world, `SELECT COUNT(*) AS value FROM world_cognitive_jobs WHERE status <> 'completed'`),
    count(world, `SELECT COUNT(*) AS value FROM branch_controls WHERE runtime_phase = 'quarantined'`),
  ]
  if (blockers.some(value => value !== 0)) {
    error('BACKUP_INVALID', correlationId, `deployment is not quiescent: ${blockers.join(',')}`)
  }
}

function watermarks(paths: DeploymentDatabasePaths, nowMs: number, correlationId: string): DeploymentBackupWatermarks {
  const databases: OpenDatabases = {
    world: openReadOnly(paths.worldPath),
    session: openReadOnly(paths.sessionPath),
    memory: openReadOnly(paths.memoryPath),
    context: openReadOnly(paths.contextPath),
  }
  try {
    assertQuiet(databases.world, nowMs, correlationId)
    const branches = databases.world.prepare(`
      SELECT b.address_key, h.head_seq, h.tick, h.event_hash
      FROM branches b JOIN heads h ON h.address_key = b.address_key ORDER BY b.address_key
    `).all() as Array<{ address_key: string; head_seq: number; tick: number; event_hash: string }>
    const heads = new Map(branches.map(row => [row.address_key, row.head_seq]))
    const outbox = databases.world.prepare(`
      SELECT delivery_status AS status, COUNT(*) AS count, COALESCE(MAX(session_delivery_seq), 0) AS maxSessionDeliverySeq
      FROM outbox GROUP BY delivery_status ORDER BY delivery_status
    `).all() as WorldJsonObject[]
    const sessions = databases.session.prepare(`
      SELECT session_id AS sessionId, last_delivery_seq AS lastDeliverySeq
      FROM session_delivery_cursor ORDER BY session_id
    `).all() as WorldJsonObject[]
    const memory = databases.memory.prepare(`
      SELECT namespace_key AS namespaceKey, verified_through_seq AS verifiedThroughSeq,
        captured_through_seq AS capturedThroughSeq, memory_epoch AS memoryEpoch
      FROM cognitive_memory_v2_namespaces ORDER BY namespace_key
    `).all() as WorldJsonObject[]
    const providerCalls = databases.context.prepare(`
      SELECT state, COUNT(*) AS count FROM provider_calls GROUP BY state ORDER BY state
    `).all() as WorldJsonObject[]
    const maximumCheckpointAsOfSeq = count(databases.context,
      'SELECT COALESCE(MAX(as_of_seq), 0) AS value FROM continuity_checkpoints')
    const activeReactionCycles = count(databases.world,
      `SELECT COUNT(*) AS value FROM world_reaction_cycles WHERE status <> 'terminal'`)
    const terminalReactionCycles = count(databases.world,
      `SELECT COUNT(*) AS value FROM world_reaction_cycles WHERE status = 'terminal'`)

    const delivered = databases.world.prepare(`
      SELECT o.delivery_id, o.session_id, o.session_delivery_seq, o.payload_hash
      FROM outbox o WHERE o.delivery_status = 'delivered' ORDER BY o.session_id, o.session_delivery_seq
    `).all() as Array<{ delivery_id: string; session_id: string; session_delivery_seq: number | null; payload_hash: string }>
    const inbox = databases.session.prepare(`
      SELECT delivery_id, session_id, session_delivery_seq, payload_hash
      FROM session_delivery_inbox ORDER BY session_id, session_delivery_seq
    `).all() as typeof delivered
    invariant(canonicalText(delivered.map(row => ({
      deliveryId: row.delivery_id, sessionId: row.session_id, sessionDeliverySeq: row.session_delivery_seq, payloadHash: row.payload_hash,
    }))) === canonicalText(inbox.map(row => ({
      deliveryId: row.delivery_id, sessionId: row.session_id, sessionDeliverySeq: row.session_delivery_seq, payloadHash: row.payload_hash,
    }))), correlationId, 'World and Session delivery bindings diverged')

    for (const row of memory) {
      const namespaceKey = row.namespaceKey as string
      const branchKey = branchKeyFromNamespace(namespaceKey, correlationId)
      const head = heads.get(branchKey)
      const verified = row.verifiedThroughSeq as number
      const captured = row.capturedThroughSeq as number
      invariant(head !== undefined, correlationId, `Memory Branch is missing: ${namespaceKey}`)
      invariant(captured <= verified, correlationId, `Memory captured watermark exceeds verification: ${namespaceKey}`)
      invariant(verified <= head!, correlationId, `Memory watermark exceeds World Head: ${namespaceKey}`)
    }
    const requiredMemory = databases.world.prepare(`
      SELECT address_key, character_id, MAX(as_of_seq) AS required_seq
      FROM world_cognitive_jobs GROUP BY address_key, character_id ORDER BY address_key, character_id
    `).all() as Array<{ address_key: string; character_id: string; required_seq: number }>
    const memoryByKey = new Map(memory.map(row => [row.namespaceKey as string, row]))
    for (const required of requiredMemory) {
      const row = memoryByKey.get(`${required.address_key}\u001f${required.character_id}`)
      invariant(row !== undefined, correlationId, `Memory is absent for World cognitive work: ${required.character_id}`)
      invariant((row!.capturedThroughSeq as number) >= required.required_seq, correlationId,
        `Memory capture is behind World cognitive work: ${required.character_id}`)
    }

    const calls = databases.context.prepare(`
      SELECT namespace_key, state, transaction_id, authority_hash FROM provider_calls ORDER BY model_call_id
    `).all() as Array<{ namespace_key: string; state: string; transaction_id: string | null; authority_hash: string | null }>
    for (const call of calls) {
      if (!PROVIDER_STATES.includes(call.state as typeof PROVIDER_STATES[number])) {
        error('BACKUP_INVALID', correlationId, `ProviderCall is unfinished: ${call.state}`)
      }
      if (call.state === 'committed') {
        const matching = databases.world.prepare(`
          SELECT COUNT(*) AS value FROM round_commits
          WHERE address_key = ? AND transaction_id = ? AND authority_hash = ?
        `).get(call.namespace_key, call.transaction_id, call.authority_hash) as { value: number }
        invariant(matching.value === 1, correlationId, 'committed ProviderCall has no matching World authority')
      }
    }
    const checkpoints = databases.context.prepare(`
      SELECT namespace_key, as_of_seq FROM continuity_checkpoints ORDER BY namespace_key, as_of_seq
    `).all() as Array<{ namespace_key: string; as_of_seq: number }>
    for (const checkpoint of checkpoints) {
      const branchKey = branchKeyFromNamespace(checkpoint.namespace_key, correlationId)
      const head = heads.get(branchKey)
      invariant(head !== undefined, correlationId, `Context checkpoint Branch is missing: ${checkpoint.namespace_key}`)
      invariant(checkpoint.as_of_seq <= head!, correlationId, `Context checkpoint exceeds World Head: ${checkpoint.namespace_key}`)
    }
    const receipts = databases.context.prepare(`
      SELECT namespace_key, receipt_json, receipt_hash FROM context_receipts ORDER BY receipt_id
    `).all() as Array<{ namespace_key: string; receipt_json: string; receipt_hash: WorldHash }>
    for (const receiptRow of receipts) {
      const receipt = JSON.parse(receiptRow.receipt_json) as {
        address?: WorldAddress
        asOfWorldSeq?: number
        receiptHash?: WorldHash
      }
      invariant(receipt.address !== undefined, correlationId, 'Context receipt has no World address')
      invariant(typeof receipt.asOfWorldSeq === 'number', correlationId, 'Context receipt has no as-of sequence')
      const key = `${receipt.address!.tenantId}\u001f${receipt.address!.worldId}\u001f${receipt.address!.branchId}`
      const head = heads.get(key)
      invariant(head !== undefined, correlationId, 'Context receipt Branch is missing')
      invariant(receipt.asOfWorldSeq! <= head!, correlationId, 'Context receipt exceeds World Head')
      const { receiptHash, ...receiptInput } = receipt
      invariant(receiptRow.receipt_json === canonicalText(receipt as WorldJsonObject), correlationId,
        'Context receipt bytes are not canonical')
      invariant(receiptHash === receiptRow.receipt_hash
        && receiptHash === hashContextReceipt(receiptInput as never)
        && receiptRow.namespace_key === key, correlationId, 'Context receipt integrity failed')
    }
    const audit = auditWatermark(paths.auditPath ?? `${paths.worldPath}.audit.sqlite`)
    return {
      branches: branches.map(row => ({ addressKey: row.address_key, headSeq: row.head_seq, tick: row.tick, eventHash: row.event_hash })),
      outbox,
      sessions,
      memory,
      providerCalls,
      maximumCheckpointAsOfSeq,
      activeReactionCycles,
      terminalReactionCycles,
      auditRecords: audit.records,
      auditTailHash: audit.tailHash,
    }
  } finally {
    closeDatabases(databases)
  }
}

function inspectDeployment(
  paths: DeploymentDatabasePaths,
  nowMs: number,
  correlationId: string,
  code: 'BACKUP_INVALID' | 'RESTORE_VALIDATION_FAILED',
): { readonly files: DeploymentBackupFile[]; readonly watermarks: DeploymentBackupWatermarks } {
  verifyDeepViaScratch(paths, correlationId)
  const deploymentWatermarks = watermarks(paths, nowMs, correlationId)
  const files = expectedDatabases(paths).map(expected => inspectDatabase(expected, correlationId, code))
  return { files, watermarks: deploymentWatermarks }
}

function readManifest(directory: string, nowMs: number, correlationId: string): DeploymentBackupManifest {
  try {
    const manifestText = readFileSync(join(directory, 'manifest.json'), 'utf8')
    const value = JSON.parse(manifestText) as DeploymentBackupManifest
    if (canonicalText(value) !== manifestText || value.format !== DEPLOYMENT_BACKUP_FORMAT
      || value.correlationId.length === 0 || value.sourceDeployment.length === 0
      || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0
      || value.files.length !== 5) {
      throw new Error('deployment manifest shape or canonical bytes are invalid')
    }
    const { manifestHash, ...input } = value
    const expectedHash = hashWorldJson(DEPLOYMENT_BACKUP_FORMAT, input)
    if (manifestHash !== expectedHash || readFileSync(join(directory, 'ready'), 'utf8') !== manifestHash) {
      throw new Error('deployment ready marker or manifest hash is invalid')
    }
    const inspected = inspectDeployment(artifactPaths(directory), nowMs, correlationId, 'RESTORE_VALIDATION_FAILED')
    if (canonicalText(value.files) !== canonicalText(inspected.files)) {
      throw new Error('deployment files diverged from manifest')
    }
    if (canonicalText(value.watermarks) !== canonicalText(inspected.watermarks)) {
      throw new Error('deployment cross-store watermarks diverged from manifest')
    }
    return value
  } catch (cause: unknown) {
    error('RESTORE_VALIDATION_FAILED', correlationId, `deployment artifact validation failed: ${String(cause)}`)
  }
}

/** Offline five-database backup/restore set. It never rewrites Outbox, Session, Memory, or Context state. */
export class DeploymentBackupService {
  constructor(
    private readonly paths: DeploymentDatabasePaths,
    private readonly now: () => number = Date.now,
    private readonly faultInjector?: FaultInjector,
  ) {}

  async backup(targetDirectory: string, correlationId: string): Promise<DeploymentBackupManifest> {
    const target = resolve(targetDirectory)
    const sources = expectedDatabases(this.paths).map(value => resolve(value.path))
    if (existsSync(target) || sources.some(source => source === target || dirname(source) === target)) {
      error('IMPORT_ID_CONFLICT', correlationId, 'deployment backup target exists or aliases source data')
    }
    mkdirSync(dirname(target), { recursive: true })
    const nowMs = operationTime(this.now)
    const lock = WorldHostInstanceLock.acquire(this.paths.lockPath, this.paths.worldPath, { nowMs })
    let created = false
    try {
      const sourceInspection = inspectDeployment(this.paths, nowMs, correlationId, 'BACKUP_INVALID')
      mkdirSync(target)
      created = true
      for (const expected of expectedDatabases(this.paths)) {
        const source = openReadOnly(expected.path)
        try {
          await backup(source, join(target, FILE_NAMES[expected.role]))
        } finally {
          source.close()
        }
        this.faultInjector?.hit('deployment-backup.after-file-copy')
      }
      const copied = inspectDeployment(artifactPaths(target), nowMs, correlationId, 'BACKUP_INVALID')
      const finalSource = inspectDeployment(this.paths, nowMs, correlationId, 'BACKUP_INVALID')
      invariant(canonicalText(sourceInspection.watermarks) === canonicalText(finalSource.watermarks), correlationId,
        'source deployment changed while backup files were copied')
      invariant(canonicalText(finalSource.watermarks) === canonicalText(copied.watermarks), correlationId,
        'copied deployment diverged while backup files were copied')
      const input: DeploymentBackupManifestInput = {
        format: DEPLOYMENT_BACKUP_FORMAT,
        correlationId,
        createdAtMs: nowMs,
        sourceDeployment: this.paths.sourceDeployment ?? basename(dirname(resolve(this.paths.worldPath))),
        files: copied.files,
        watermarks: copied.watermarks,
      }
      const manifest: DeploymentBackupManifest = {
        ...input,
        manifestHash: hashWorldJson(DEPLOYMENT_BACKUP_FORMAT, input),
      }
      writeFileSync(join(target, 'manifest.json'), canonicalizeWorldJson(manifest), { flag: 'wx' })
      this.faultInjector?.hit('deployment-backup.before-ready')
      writeFileSync(join(target, 'ready'), manifest.manifestHash, { flag: 'wx' })
      return manifest
    } catch (cause: unknown) {
      if (created) rmSync(target, { recursive: true, force: true })
      throw cause
    } finally {
      lock.release()
    }
  }

  validate(backupDirectory: string, correlationId: string): DeploymentBackupManifest {
    return readManifest(resolve(backupDirectory), operationTime(this.now), correlationId)
  }

  restore(backupDirectory: string, targetDirectory: string, correlationId: string): DeploymentRestoreProvenance {
    const source = resolve(backupDirectory)
    const target = resolve(targetDirectory)
    if (existsSync(target) || source === target) {
      error('IMPORT_ID_CONFLICT', correlationId, 'deployment restore target exists or aliases the artifact')
    }
    const nowMs = operationTime(this.now)
    const manifest = readManifest(source, nowMs, correlationId)
    mkdirSync(dirname(target), { recursive: true })
    try {
      mkdirSync(target)
      for (const file of manifest.files) {
        copyFileSync(join(source, file.path), join(target, file.path), constants.COPYFILE_EXCL)
        this.faultInjector?.hit('deployment-restore.after-file-copy')
      }
      const restoredPaths = artifactPaths(target)
      const inspected = inspectDeployment(restoredPaths, nowMs, correlationId, 'RESTORE_VALIDATION_FAILED')
      if (canonicalText(inspected.files) !== canonicalText(manifest.files)
        || canonicalText(inspected.watermarks) !== canonicalText(manifest.watermarks)) {
        error('RESTORE_VALIDATION_FAILED', correlationId, 'restored deployment does not match the source manifest')
      }
      const provenanceInput = {
        format: 'world-deployment-restore-provenance/v1' as const,
        sourceManifestHash: manifest.manifestHash,
        correlationId,
        restoredAtMs: nowMs,
        fileHashes: inspected.files.map(file => ({ role: file.role, sha256: file.sha256 })),
        checks: ['file-hash', 'sqlite-identity', 'quick-check', 'foreign-keys', 'world-authority', 'audit-chain', 'cross-store-watermarks'],
      }
      const provenance: DeploymentRestoreProvenance = {
        ...provenanceInput,
        provenanceHash: hashWorldJson('world-deployment-restore-provenance/v1', provenanceInput),
      }
      writeFileSync(join(target, 'manifest.json'), canonicalizeWorldJson(manifest), { flag: 'wx' })
      writeFileSync(join(target, 'restore-provenance.json'), canonicalizeWorldJson(provenance), { flag: 'wx' })
      this.faultInjector?.hit('deployment-restore.before-ready')
      writeFileSync(join(target, 'ready'), manifest.manifestHash, { flag: 'wx' })
      return provenance
    } catch (cause: unknown) {
      rmSync(target, { recursive: true, force: true })
      throw cause
    }
  }
}
