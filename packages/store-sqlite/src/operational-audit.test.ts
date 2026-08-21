import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationalAuditLog } from './operational-audit.ts'

const directories: string[] = []

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-audit-'))
  directories.push(directory)
  return join(directory, 'operations.audit.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('OperationalAuditLog', () => {
  it('appends durable low-cardinality operation evidence and filters by scope', () => {
    const path = database()
    const audit = new OperationalAuditLog(path, () => 42)
    expect(audit.record('world:a', 'backup.requested', 'audit:one', { targetHash: 'sha256:value' })).toMatchObject({
      auditSeq: 1, scopeKey: 'world:a', operation: 'backup.requested', operationalTimeMs: 42,
    })
    audit.record('world:b', 'restore.requested', 'audit:two', {})
    expect(audit.read()).toHaveLength(2)
    expect(audit.read('world:a')).toMatchObject([{ correlationId: 'audit:one', details: { targetHash: 'sha256:value' } }])
    expect(audit.read('missing')).toEqual([])
    expect(() => audit.record('', 'operation', 'correlation', {})).toThrow(TypeError)
    expect(() => audit.record('world:a', ' padded ', 'correlation', {})).toThrow(TypeError)
    audit.close()

    const reopened = new OperationalAuditLog(path)
    expect(reopened.read()).toHaveLength(2)
    reopened.close()
  })

  it('rejects an invalid operational clock without appending partial evidence', () => {
    const path = database()
    const audit = new OperationalAuditLog(path, () => -1)
    expect(() => audit.record('world:a', 'operation', 'audit:clock', {})).toThrow()
    expect(audit.read()).toEqual([])
    audit.close()
  })
})
