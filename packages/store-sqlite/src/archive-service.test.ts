import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type CommitRoundRequest, type WorldAddress } from '@harness-world/contracts'
import { WorldArchiveService } from './archive-service.ts'
import { WorldStore } from './world-store.ts'

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
    outbox: [],
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
    const service = new WorldArchiveService(source)
    const backupPath = join(directory, 'backup.sqlite')
    const artifact = await service.backup(backupPath, 'backup:create')
    expect(artifact).toMatchObject({ format: 'world-sqlite-backup/v1', schemaVersion: 6 })

    const restoredPath = join(directory, 'restored.sqlite')
    expect(service.restore(backupPath, restoredPath, artifact.fileHash, 'backup:restore')).toEqual(artifact)
    const restored = new WorldStore(restoredPath)
    expect(restored.head(address)).toMatchObject({ headSeq: 1, tick: 1 })
    const eventHash = restored.readEvents(address)[0]!.eventHash
    restored.close()

    const exportPath = join(directory, 'world.export.json')
    expect(await service.exportPortable(exportPath, 'export:create')).toEqual(artifact)
    const importedPath = join(directory, 'imported.sqlite')
    expect(service.importPortable(exportPath, importedPath, 'export:import')).toEqual(artifact)
    const imported = new WorldStore(importedPath)
    expect(imported.readEvents(address)[0]!.eventHash).toBe(eventHash)
    imported.close()

    expect(() => service.restore(backupPath, join(directory, 'bad-hash.sqlite'), 'sha256:wrong', 'restore:hash'))
      .toThrow('does not match')
    expect(() => service.restore(backupPath, restoredPath, artifact.fileHash, 'restore:exists')).toThrow('already exists')
    await expect(service.backup(source, 'backup:source')).rejects.toThrow('aliases the source')
    await expect(service.backup(join(directory, 'missing', 'backup.sqlite'), 'backup:io'))
      .rejects.toThrow('backup failed')
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
  })
})
