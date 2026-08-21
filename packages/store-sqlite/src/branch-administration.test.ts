import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, type CommitRoundRequest, type WorldAddress } from '@harness-world/contracts'
import { BranchAdministration } from './branch-administration.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-branch-admin-'))
  directories.push(directory)
  return join(directory, 'world.sqlite')
}

function address(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:admin', 'TenantId'),
    worldId: brandId('world:admin', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

function round(target: WorldAddress, suffix = 'one'): CommitRoundRequest {
  return {
    address: target,
    transactionId: brandId(`transaction:admin:${suffix}`, 'TransactionId'),
    roundId: brandId(`round:admin:${suffix}`, 'InteractionRoundId'),
    expectedHeadSeq: suffix === 'one' ? 0 : 1,
    expectedTick: suffix === 'one' ? 0 : 1,
    nextTick: suffix === 'one' ? 1 : 2,
    events: [{ eventType: 'admin.fixture', eventVersion: 1, data: { suffix } }],
    outbox: [],
    correlationId: `admin:${suffix}`,
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('BranchAdministration', () => {
  it('blocks admission while draining and makes archive irreversible without deleting history', async () => {
    const path = database()
    const target = address()
    const store = new WorldStore(path)
    store.createBranch(target)
    const admin = new BranchAdministration(path, () => 1234)
    expect(admin.status(target)).toEqual({ admissionState: 'open', lifecycleState: 'active', reason: null, revision: 0 })
    expect(admin.setAdmission(target, 'draining', 'maintenance', 'admin:drain')).toMatchObject({ admissionState: 'draining', revision: 1 })
    expect(() => store.assertAdmissionOpen(target, 'player:blocked')).toThrow('draining')
    await expect(store.commitRound(round(target))).rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: true } })
    expect(admin.setAdmission(target, 'open', 'maintenance complete', 'admin:open')).toMatchObject({ admissionState: 'open', revision: 2 })
    const committed = await store.commitRound(round(target))
    const archived = admin.archive(target, 'story complete', 'admin:archive')
    expect(archived).toMatchObject({ admissionState: 'draining', lifecycleState: 'archived', revision: 3 })
    await expect(store.commitRound(round(target))).resolves.toEqual({ ...committed, status: 'already_committed' })
    await expect(store.commitRound(round(target, 'two'))).rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: false } })
    expect(() => admin.setAdmission(target, 'open', 'try reopen', 'admin:reopen')).toThrow('cannot reopen')
    expect(store.readEvents(target)).toHaveLength(1)
    expect(admin.readAudit(target)).toMatchObject([
      { auditSeq: 1, operation: 'branch.admission.changed', correlationId: 'admin:drain', operationalTimeMs: 1234 },
      { auditSeq: 2, operation: 'branch.admission.changed' },
      { auditSeq: 3, operation: 'branch.archived' },
    ])
    admin.close()
    store.close()
  })

  it('validates administration input, unknown branches, and rolls back failed audit writes', () => {
    const path = database()
    const target = address('validation')
    const store = new WorldStore(path)
    store.createBranch(target)
    expect(() => store.assertAdmissionOpen(address('missing'), 'missing')).toThrow('unknown world branch')
    const admin = new BranchAdministration(path)
    expect(() => admin.status(address('missing'))).toThrow('unknown world branch')
    expect(() => admin.setAdmission(target, 'draining', '', 'correlation')).toThrow(TypeError)
    expect(() => admin.archive(target, 'reason', '')).toThrow(TypeError)
    admin.close()

    const invalidClock = new BranchAdministration(path, () => -1)
    expect(() => invalidClock.archive(target, 'invalid time', 'admin:invalid-time')).toThrow()
    expect(invalidClock.status(target).revision).toBe(0)
    invalidClock.close()
    store.close()
  })
})
