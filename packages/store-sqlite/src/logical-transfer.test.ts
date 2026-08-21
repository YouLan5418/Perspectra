import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId } from '@harness-world/contracts'
import { fixtureAddress, fixtureCommitRequest } from '@harness-world/testkit'
import { WorldLogicalTransferService } from './logical-transfer.ts'
import { OperationalAuditLog } from './operational-audit.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'hcw-logical-transfer-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('WorldLogicalTransferService', () => {
  it('round-trips authority tables without Session, Memory, Audit, or process state', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const parent = fixtureAddress('logical-parent')
    const child = fixtureAddress('logical-child')
    const setup = new WorldStore(source)
    setup.createBranch(parent)
    await setup.commitRound(fixtureCommitRequest(parent))
    setup.forkBranch(parent, child, 1)
    const eventHash = setup.readEvents(parent)[0]!.eventHash
    setup.close()

    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'world.dshworld')
    const bundleHash = service.exportAuthority(exportPath, 'logical:export')
    const target = join(root, 'target.sqlite')
    expect(service.importAuthority(exportPath, target, 'logical:import')).toBe(bundleHash)
    const imported = new WorldStore(target)
    expect(imported.readEvents(parent)[0]!.eventHash).toBe(eventHash)
    expect(imported.readEvents(child)).toHaveLength(1)
    imported.close()
    expect(() => service.exportAuthority(source, 'logical:alias')).toThrow('aliases the source')
    expect(() => service.importAuthority(exportPath, target, 'logical:exists')).toThrow('already exists')
    const audit = new OperationalAuditLog(`${source}.audit.sqlite`)
    expect(audit.read().map(event => event.operation)).toEqual(expect.arrayContaining([
      'authority.export.requested', 'authority.import.requested',
    ]))
    audit.close()
  })

  it('rejects malformed, unsupported, missing-table, invalid-row, and divergent Event exports', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    setup.createBranch(fixtureAddress())
    await setup.commitRound(fixtureCommitRequest())
    setup.close()
    const service = new WorldLogicalTransferService(source)
    const malformed = join(root, 'malformed.dshworld')
    writeFileSync(malformed, '{')
    expect(() => service.importAuthority(malformed, join(root, 'malformed.sqlite'), 'logical:malformed')).toThrow('invalid')

    const valid = join(root, 'valid.dshworld')
    service.exportAuthority(valid, 'logical:valid')
    const envelope = JSON.parse(readFileSync(valid, 'utf8')) as any
    const unsupported = join(root, 'unsupported.dshworld')
    writeFileSync(unsupported, JSON.stringify({ ...envelope, format: 'wrong' }))
    expect(() => service.importAuthority(unsupported, join(root, 'unsupported.sqlite'), 'logical:unsupported')).toThrow('unsupported')
    const badHash = join(root, 'bad-hash.dshworld')
    writeFileSync(badHash, JSON.stringify({ ...envelope, bundleHash: 'sha256:wrong' }))
    expect(() => service.importAuthority(badHash, join(root, 'bad-hash.sqlite'), 'logical:hash')).toThrow('hash is invalid')

    const missing = structuredClone(envelope)
    delete missing.data.tables.heads
    missing.bundleHash = (await import('@harness-world/contracts')).hashWorldJson('logical-authority-export', missing.data)
    const missingPath = join(root, 'missing.dshworld')
    writeFileSync(missingPath, JSON.stringify(missing))
    expect(() => service.importAuthority(missingPath, join(root, 'missing.sqlite'), 'logical:missing')).toThrow('table heads is missing')

    const invalidRow = structuredClone(envelope)
    invalidRow.data.tables.heads = [1]
    invalidRow.bundleHash = (await import('@harness-world/contracts')).hashWorldJson('logical-authority-export', invalidRow.data)
    const invalidRowPath = join(root, 'invalid-row.dshworld')
    writeFileSync(invalidRowPath, JSON.stringify(invalidRow))
    expect(() => service.importAuthority(invalidRowPath, join(root, 'invalid-row.sqlite'), 'logical:row')).toThrow('invalid row')

    const divergent = structuredClone(envelope)
    divergent.data.tables.events[0].event_hash = brandId('sha256:divergent', 'WorldHash')
    divergent.bundleHash = (await import('@harness-world/contracts')).hashWorldJson('logical-authority-export', divergent.data)
    const divergentPath = join(root, 'divergent.dshworld')
    writeFileSync(divergentPath, JSON.stringify(divergent))
    expect(() => service.importAuthority(divergentPath, join(root, 'divergent.sqlite'), 'logical:event')).toThrow('divergent Event')
  })
})
