import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type CommitRoundRequest, type WorldAddress, type WorldHash } from '@harness-world/contracts'
import { WorldArchiveService } from './archive-service.ts'
import { OperationalAuditLog } from './operational-audit.ts'
import { SessionDeliveryAdapter } from './session-delivery.ts'
import { SessionOutboxWorker, WorldOutbox } from './outbox-worker.ts'
import { WORLD_SCHEMA_VERSION, WorldStore } from './world-store.ts'

const directories: string[] = []

function fixture(): { directory: string; source: string; address: WorldAddress } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-archive-'))
  directories.push(directory)
  return {
    directory,
    source: join(directory, 'world.sqlite'),
    address: {
      tenantId: brandId('tenant:archive', 'TenantId'),
      worldId: brandId('world:archive', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
  }
}

function populate(path: string, address: WorldAddress): Promise<unknown> {
  const store = new WorldStore(path)
  store.createBranch(address)
  const request: CommitRoundRequest = {
    address,
    transactionId: brandId('transaction:archive', 'TransactionId'),
    roundId: brandId('round:archive', 'InteractionRoundId'),
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events: [{ eventType: 'archive.fixture', eventVersion: 1, data: { durable: true } }],
    outbox: [
      {
        deliveryId: brandId('delivery:archive:one', 'DeliveryId'),
        sessionId: brandId('session:archive', 'SessionId'),
        payload: { kind: 'observation', ordinal: 1 },
        critical: true,
      },
      {
        deliveryId: brandId('delivery:archive:two', 'DeliveryId'),
        sessionId: brandId('session:archive', 'SessionId'),
        payload: { kind: 'observation', ordinal: 2 },
        critical: true,
      },
    ],
    correlationId: 'archive:populate',
  }
  return store.commitRound(request).finally(() => store.close())
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorldArchiveService', () => {
  it('backs up, restores, exports, and imports an exact validated World database', async () => {
    const { directory, source, address } = fixture()
    await populate(source, address)
    const sessionId = brandId('session:archive', 'SessionId')
    const firstDeliveryId = brandId('delivery:archive:one', 'DeliveryId')
    const existingSession = new SessionDeliveryAdapter(join(directory, 'existing-session.sqlite'))
    const sourceOutbox = new WorldOutbox(source, undefined, { workerId: 'worker:source', createClaimToken: () => 'source' })
    const failedWorker = new SessionOutboxWorker(sourceOutbox, {
      appendIfAbsent: async () => { throw new Error('transient Session failure') },
    }, address, 1)
    await expect(failedWorker.runOnce('archive:dead-letter')).resolves.toMatchObject({ status: 'dead_letter', deliveryId: firstDeliveryId })
    sourceOutbox.retryDeadLetter(address, firstDeliveryId, 'archive:retry-requested')
    const sourceWorker = new SessionOutboxWorker(sourceOutbox, existingSession, address)
    await expect(sourceWorker.runOnce('archive:retry')).resolves.toMatchObject({ status: 'delivered', deliveryId: firstDeliveryId })
    await expect(sourceWorker.runOnce('archive:second')).resolves.toMatchObject({ status: 'delivered' })
    expect(existingSession.cursor(sessionId)).toBe(2)
    sourceOutbox.close()
    const service = new WorldArchiveService(source)
    const backupPath = join(directory, 'backup.sqlite')
    const artifact = await service.backup(backupPath, 'backup:create')
    expect(artifact).toMatchObject({ format: 'world-sqlite-backup/v1', schemaVersion: WORLD_SCHEMA_VERSION })

    const restoredPath = join(directory, 'restored.sqlite')
    expect(service.restore(backupPath, restoredPath, artifact.fileHash, 'backup:restore'))
      .toMatchObject({ format: 'world-sqlite-backup/v1', schemaVersion: WORLD_SCHEMA_VERSION })
    const restored = new WorldStore(restoredPath)
    expect(restored.head(address)).toMatchObject({ headSeq: 1, tick: 1 })
    const eventHash = restored.readEvents(address)[0]!.eventHash
    restored.close()
    const restoredOutbox = new WorldOutbox(restoredPath, undefined, { workerId: 'worker:restored', createClaimToken: () => 'restored' })
    const replayStatuses: string[] = []
    const restoredWorker = new SessionOutboxWorker(restoredOutbox, {
      appendIfAbsent: async request => {
        const result = await existingSession.appendIfAbsent(request)
        replayStatuses.push(result.status)
        return result
      },
    }, address)
    await expect(restoredWorker.runOnce('restore:existing-one')).resolves.toMatchObject({ status: 'delivered', deliveryId: firstDeliveryId })
    await expect(restoredWorker.runOnce('restore:existing-two')).resolves.toMatchObject({ status: 'delivered' })
    await expect(restoredWorker.runOnce('restore:existing-idle')).resolves.toEqual({ status: 'idle' })
    expect(replayStatuses).toEqual(['already_applied', 'already_applied'])
    expect(existingSession.cursor(sessionId)).toBe(2)
    restoredOutbox.close()
    existingSession.close()
    const restoreProvenance = new OperationalAuditLog(`${restoredPath}.audit.sqlite`)
    expect(restoreProvenance.read()).toMatchObject([{
      operation: 'archive.restore.completed',
      details: { backupPath: expect.stringContaining('backup.sqlite'), expectedHash: artifact.fileHash },
    }])
    restoreProvenance.close()

    const exportPath = join(directory, 'world.export.json')
    expect(await service.exportPortable(exportPath, 'export:create')).toEqual(artifact)
    const importedPath = join(directory, 'imported.sqlite')
    expect(service.importPortable(exportPath, importedPath, 'export:import'))
      .toMatchObject({ format: 'world-sqlite-backup/v1', schemaVersion: WORLD_SCHEMA_VERSION })
    const imported = new WorldStore(importedPath)
    expect(imported.readEvents(address)[0]!.eventHash).toBe(eventHash)
    imported.close()
    const freshSession = new SessionDeliveryAdapter(join(directory, 'fresh-session.sqlite'))
    const importedOutbox = new WorldOutbox(importedPath, undefined, { workerId: 'worker:imported', createClaimToken: () => 'imported' })
    const rebuildStatuses: string[] = []
    const importedWorker = new SessionOutboxWorker(importedOutbox, {
      appendIfAbsent: async request => {
        const result = await freshSession.appendIfAbsent(request)
        rebuildStatuses.push(result.status)
        return result
      },
    }, address)
    await expect(importedWorker.runOnce('import:fresh-one')).resolves.toMatchObject({ status: 'delivered', deliveryId: firstDeliveryId })
    await expect(importedWorker.runOnce('import:fresh-two')).resolves.toMatchObject({ status: 'delivered' })
    expect(rebuildStatuses).toEqual(['applied', 'applied'])
    expect(freshSession.cursor(sessionId)).toBe(2)
    expect(freshSession.readEvent(sessionId, 2)).toMatchObject({ payload: { ordinal: 2 } })
    importedOutbox.close()
    freshSession.close()
    const importProvenance = new OperationalAuditLog(`${importedPath}.audit.sqlite`)
    expect(importProvenance.read()).toMatchObject([{
      operation: 'archive.import.completed',
      details: { exportPath: expect.stringContaining('world.export.json') },
    }])
    importProvenance.close()

    expect(() => service.restore(backupPath, join(directory, 'bad-hash.sqlite'), 'sha256:wrong', 'restore:hash'))
      .toThrow('does not match')
    expect(() => service.restore(backupPath, restoredPath, artifact.fileHash, 'restore:exists')).toThrow('already exists')
    await expect(service.backup(source, 'backup:source')).rejects.toThrow('aliases the source')
    await expect(service.backup(join(directory, 'missing', 'backup.sqlite'), 'backup:io'))
      .rejects.toThrow('backup failed')
    const audit = new OperationalAuditLog(`${source}.audit.sqlite`)
    expect(audit.read().map(event => event.operation)).toEqual(expect.arrayContaining([
      'archive.backup.requested', 'archive.restore.requested', 'archive.export.requested', 'archive.import.requested',
      'archive.backup.completed', 'archive.restore.completed', 'archive.export.completed', 'archive.import.completed',
    ]))
    audit.close()
  })

  it('fails closed for damaged databases, malformed exports, and divergent payloads', async () => {
    const { directory, source, address } = fixture()
    await populate(source, address)
    const service = new WorldArchiveService(source)
    const damaged = join(directory, 'damaged.sqlite')
    writeFileSync(damaged, 'not sqlite')
    expect(() => service.restore(damaged, join(directory, 'restore.sqlite'), 'sha256:any', 'restore:damaged'))
      .toThrow('archive validation failed')

    const wrongIdentity = join(directory, 'wrong-identity.sqlite')
    const wrong = new DatabaseSync(wrongIdentity)
    wrong.exec('PRAGMA application_id = 1; PRAGMA user_version = 6; CREATE TABLE branches(id INTEGER);')
    wrong.close()
    expect(() => service.restore(wrongIdentity, join(directory, 'wrong-restore.sqlite'), 'sha256:any', 'restore:identity'))
      .toThrow('identity')

    const incomplete = join(directory, 'incomplete.sqlite')
    const incompleteDb = new DatabaseSync(incomplete)
    incompleteDb.exec('PRAGMA application_id = 0x48435757; PRAGMA user_version = 9; CREATE TABLE placeholder(id INTEGER);')
    incompleteDb.close()
    const incompleteHash = `sha256:${createHash('sha256').update(readFileSync(incomplete)).digest('hex')}` as WorldHash
    expect(() => service.restore(incomplete, join(directory, 'incomplete-restore.sqlite'), incompleteHash, 'restore:incomplete'))
      .toThrow('identity, schema, or integrity')

    const malformed = join(directory, 'malformed.json')
    writeFileSync(malformed, '{')
    expect(() => service.importPortable(malformed, join(directory, 'malformed.sqlite'), 'import:malformed'))
      .toThrow('portable export is invalid')

    const unsupported = join(directory, 'unsupported.json')
    writeFileSync(unsupported, JSON.stringify({ format: 'wrong', backup: { format: 'wrong' }, sqliteBase64: '' }))
    expect(() => service.importPortable(unsupported, join(directory, 'unsupported.sqlite'), 'import:unsupported')).toThrow('unsupported')
    const unsupportedBackup = join(directory, 'unsupported-backup.json')
    writeFileSync(unsupportedBackup, JSON.stringify({ format: 'world-portable-export/v1', backup: { format: 'wrong' }, sqliteBase64: '' }))
    expect(() => service.importPortable(unsupportedBackup, join(directory, 'unsupported-backup.sqlite'), 'import:unsupported-backup'))
      .toThrow('unsupported')

    const exportPath = join(directory, 'valid.json')
    await service.exportPortable(exportPath, 'export:valid')
    const envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as Record<string, unknown>
    envelope.sqliteBase64 = Buffer.from('different').toString('base64')
    writeFileSync(exportPath, JSON.stringify(envelope))
    expect(() => service.importPortable(exportPath, join(directory, 'divergent.sqlite'), 'import:divergent')).toThrow('payload hash')

    await service.exportPortable(join(directory, 'same-length-source.json'), 'export:same-length')
    const sameLengthPath = join(directory, 'same-length-source.json')
    const sameLength = JSON.parse(readFileSync(sameLengthPath, 'utf8')) as { sqliteBase64: string }
    const payload = Buffer.from(sameLength.sqliteBase64, 'base64')
    const last = payload.byteLength - 1
    payload[last] = payload[last]! ^ 1
    sameLength.sqliteBase64 = payload.toString('base64')
    writeFileSync(sameLengthPath, JSON.stringify(sameLength))
    expect(() => service.importPortable(sameLengthPath, join(directory, 'same-length.sqlite'), 'import:same-length'))
      .toThrow('payload hash')

    const blocked = new DatabaseSync(source)
    blocked.exec(`
      UPDATE outbox SET delivery_status = 'delivered', session_delivery_seq = 1 WHERE delivery_id = 'delivery:archive:one';
      INSERT INTO outbox_delivery_receipts(delivery_id, session_id, session_delivery_seq, payload_hash)
      SELECT delivery_id, session_id, session_delivery_seq, payload_hash FROM outbox WHERE delivery_id = 'delivery:archive:one';
      CREATE TRIGGER reject_recovery_receipt_delete BEFORE DELETE ON outbox_delivery_receipts
      BEGIN SELECT RAISE(FAIL, 'blocked recovery cleanup'); END;
    `)
    blocked.close()
    const blockedBackup = join(directory, 'blocked-backup.sqlite')
    const blockedArtifact = await service.backup(blockedBackup, 'backup:blocked-cleanup')
    expect(() => service.restore(blockedBackup, join(directory, 'blocked-restore.sqlite'), blockedArtifact.fileHash, 'restore:blocked-cleanup'))
      .toThrow('blocked recovery cleanup')
  })
})
