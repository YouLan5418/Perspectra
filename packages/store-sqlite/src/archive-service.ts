import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  canonicalizeWorldJson,
  failWorld,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import { readPragmaInteger, rollbackAndThrow, WORLD_APPLICATION_ID } from './sqlite.ts'
import { openWorldDatabase, WORLD_SCHEMA_VERSION } from './world-store.ts'
import { OperationalAuditLog } from './operational-audit.ts'

export interface WorldBackupArtifact extends WorldJsonObject {
  readonly format: 'world-sqlite-backup/v1'
  readonly byteLength: number
  readonly fileHash: WorldHash
  readonly schemaVersion: number
}

interface PortableWorldExport extends WorldJsonObject {
  readonly format: 'world-portable-export/v1'
  readonly backup: WorldBackupArtifact
  readonly sqliteBase64: string
}

function hashBytes(bytes: Uint8Array): WorldHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Creates exact local SQLite backups and canonical portable exports without overwriting targets. */
export class WorldArchiveService {
  constructor(private readonly sourcePath: string) {}

  async backup(targetPath: string, correlationId: string): Promise<WorldBackupArtifact> {
    this.#audit('archive.backup.requested', correlationId, { targetPath })
    this.#guardNewTarget(targetPath, correlationId)
    const source = openWorldDatabase(this.sourcePath)
    try {
      await backup(source, targetPath)
      const artifact = this.#inspect(targetPath, correlationId, 'BACKUP_INVALID')
      this.#audit('archive.backup.completed', correlationId, { targetPath, artifact })
      return artifact
    } catch (error: unknown) {
      rmSync(targetPath, { force: true })
      failWorld({
        errorCode: 'BACKUP_INVALID', category: 'persistence', message: `backup failed: ${String(error)}`,
        retryable: false, correlationId,
      })
    } finally {
      source.close()
    }
  }

  restore(backupPath: string, targetPath: string, expectedHash: WorldHash, correlationId: string): WorldBackupArtifact {
    this.#audit('archive.restore.requested', correlationId, { backupPath, targetPath, expectedHash })
    this.#guardNewTarget(targetPath, correlationId)
    const artifact = this.#inspect(backupPath, correlationId, 'RESTORE_VALIDATION_FAILED')
    if (artifact.fileHash !== expectedHash) {
      failWorld({
        errorCode: 'RESTORE_VALIDATION_FAILED', category: 'integrity', message: 'backup hash does not match restore request',
        retryable: false, correlationId,
      })
    }
    writeFileSync(targetPath, readFileSync(backupPath), { flag: 'wx' })
    this.#prepareRecoveryTarget(targetPath)
    const restored = this.#inspect(targetPath, correlationId, 'RESTORE_VALIDATION_FAILED')
    const provenance = {
      sourcePath: resolve(this.sourcePath), backupPath: resolve(backupPath), expectedHash,
      recoveryMode: 'redeliver-outbox', artifact: restored,
    }
    this.#auditAt(targetPath, 'archive.restore.completed', correlationId, provenance)
    this.#audit('archive.restore.completed', correlationId, { targetPath, artifact: restored })
    return restored
  }

  async exportPortable(exportPath: string, correlationId: string): Promise<WorldBackupArtifact> {
    this.#audit('archive.export.requested', correlationId, { exportPath })
    this.#guardNewTarget(exportPath, correlationId)
    const temporary = `${exportPath}.sqlite-tmp`
    this.#guardNewTarget(temporary, correlationId)
    try {
      const artifact = await this.backup(temporary, correlationId)
      const envelope: PortableWorldExport = {
        format: 'world-portable-export/v1',
        backup: artifact,
        sqliteBase64: readFileSync(temporary).toString('base64'),
      }
      writeFileSync(exportPath, canonicalizeWorldJson(envelope), { flag: 'wx' })
      this.#audit('archive.export.completed', correlationId, { exportPath, artifact })
      return artifact
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  importPortable(exportPath: string, targetPath: string, correlationId: string): WorldBackupArtifact {
    this.#audit('archive.import.requested', correlationId, { exportPath, targetPath })
    this.#guardNewTarget(targetPath, correlationId)
    let envelope: PortableWorldExport
    try {
      envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as PortableWorldExport
      canonicalizeWorldJson(envelope)
    } catch (error: unknown) {
      failWorld({
        errorCode: 'BACKUP_INVALID', category: 'integrity', message: `portable export is invalid: ${String(error)}`,
        retryable: false, correlationId,
      })
    }
    if (envelope.format !== 'world-portable-export/v1' || envelope.backup.format !== 'world-sqlite-backup/v1') {
      failWorld({
        errorCode: 'BACKUP_INVALID', category: 'integrity', message: 'portable export format is unsupported',
        retryable: false, correlationId,
      })
    }
    const bytes = Buffer.from(envelope.sqliteBase64, 'base64')
    if (bytes.byteLength !== envelope.backup.byteLength || hashBytes(bytes) !== envelope.backup.fileHash) {
      failWorld({
        errorCode: 'BACKUP_INVALID', category: 'integrity', message: 'portable export payload hash is invalid',
        retryable: false, correlationId,
      })
    }
    writeFileSync(targetPath, bytes, { flag: 'wx' })
    this.#prepareRecoveryTarget(targetPath)
    const imported = this.#inspect(targetPath, correlationId, 'BACKUP_INVALID')
    const provenance = {
      sourcePath: resolve(this.sourcePath), exportPath: resolve(exportPath),
      recoveryMode: 'redeliver-outbox', artifact: imported,
    }
    this.#auditAt(targetPath, 'archive.import.completed', correlationId, provenance)
    this.#audit('archive.import.completed', correlationId, { targetPath, artifact: imported })
    return imported
  }

  #guardNewTarget(targetPath: string, correlationId: string): void {
    if (resolve(targetPath) === resolve(this.sourcePath) || existsSync(targetPath)) {
      failWorld({
        errorCode: 'IMPORT_ID_CONFLICT', category: 'admin', message: 'archive target already exists or aliases the source',
        retryable: false, correlationId,
      })
    }
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

  #prepareRecoveryTarget(path: string): void {
    const db = openWorldDatabase(path)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        UPDATE outbox SET delivery_status = 'pending', attempt_count = 0, session_delivery_seq = NULL,
          last_error = NULL, claim_owner_id = NULL, claim_token = NULL, claim_expires_at_ms = NULL;
        DELETE FROM outbox_delivery_receipts;
        DELETE FROM outbox_session_counters;
      `)
      db.exec('COMMIT')
    } catch (error: unknown) {
      rollbackAndThrow(db, error)
    } finally {
      db.close()
    }
  }

  #inspect(path: string, correlationId: string, errorCode: 'BACKUP_INVALID' | 'RESTORE_VALIDATION_FAILED'): WorldBackupArtifact {
    try {
      const bytes = readFileSync(path)
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const applicationId = readPragmaInteger(db, 'application_id')
        const schemaVersion = readPragmaInteger(db, 'user_version')
        const quickCheck = db.prepare('PRAGMA quick_check').get() as { quick_check?: string }
        if (applicationId !== WORLD_APPLICATION_ID || schemaVersion !== WORLD_SCHEMA_VERSION || quickCheck.quick_check !== 'ok') {
          throw new Error('SQLite identity, schema, or integrity check failed')
        }
      } finally {
        db.close()
      }
      return { format: 'world-sqlite-backup/v1', byteLength: bytes.byteLength, fileHash: hashBytes(bytes), schemaVersion: WORLD_SCHEMA_VERSION }
    } catch (error: unknown) {
      failWorld({
        errorCode, category: 'integrity', message: `archive validation failed: ${String(error)}`,
        retryable: false, correlationId,
      })
    }
  }
}
