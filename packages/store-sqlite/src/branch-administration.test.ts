import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, worldAddressKey, type CommitRoundRequest, type WorldAddress } from '@harness-world/contracts'
import { BranchAdministration } from './branch-administration.ts'
import { RoundInbox } from './round-inbox.ts'
import { WorldOutbox } from './outbox-worker.ts'
import { WriterLeaseService } from './writer-lease.ts'
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
    expect(() => store.assertAdmissionOpen(target, 'player:open')).not.toThrow()
    expect(admin.setAdmission(target, 'draining', 'maintenance', 'admin:drain')).toMatchObject({ admissionState: 'draining', revision: 1 })
    expect(() => store.assertAdmissionOpen(target, 'player:blocked')).toThrow('draining')
    await expect(store.commitRound(round(target))).rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: true } })
    expect(admin.setAdmission(target, 'open', 'maintenance complete', 'admin:open')).toMatchObject({ admissionState: 'open', revision: 2 })
    const committed = await store.commitRound(round(target))
    expect(() => admin.archive(target, 'too early', 'admin:early-archive')).toThrow('requires a drained admission barrier')
    admin.setAdmission(target, 'draining', 'archive barrier', 'admin:archive-drain')
    const archived = admin.archive(target, 'story complete', 'admin:archive')
    expect(archived).toMatchObject({ admissionState: 'draining', lifecycleState: 'archived', revision: 4 })
    await expect(store.commitRound(round(target))).resolves.toEqual({ ...committed, status: 'already_committed' })
    await expect(store.commitRound(round(target, 'two'))).rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: false } })
    expect(() => admin.setAdmission(target, 'open', 'try reopen', 'admin:reopen')).toThrow('cannot reopen')
    expect(store.readEvents(target)).toHaveLength(1)
    expect(admin.readAudit(target)).toMatchObject([
      { auditSeq: 1, operation: 'branch.admission.changed', correlationId: 'admin:drain', operationalTimeMs: 1234 },
      { auditSeq: 2, operation: 'branch.admission.changed' },
      { auditSeq: 3, operation: 'round.committed', correlationId: 'admin:one' },
      { auditSeq: 4, operation: 'branch.admission.changed' },
      { auditSeq: 5, operation: 'branch.archived' },
    ])
    admin.close()
    store.close()
  })

  it('validates administration input, unknown branches, and rolls back failed audit writes', async () => {
    const path = database()
    const target = address('validation')
    const store = new WorldStore(path)
    store.createBranch(target)
    expect(() => store.assertAdmissionOpen(address('missing'), 'missing')).toThrow('unknown world branch')
    await expect(store.commitRound(round(address('missing')))).rejects.toThrow('unknown world branch')
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

  it('requires quiescent writers, rounds, and critical deliveries and forbids forks from archived branches', async () => {
    const path = database()
    const leaseTarget = address('lease-guard')
    const inboxTarget = address('inbox-guard')
    const deliveryTarget = address('delivery-guard')
    const archivedTarget = address('archived-parent')
    const store = new WorldStore(path, undefined, () => 100)
    for (const target of [leaseTarget, inboxTarget, deliveryTarget, archivedTarget]) store.createBranch(target)
    const admin = new BranchAdministration(path, () => 100)

    admin.setAdmission(leaseTarget, 'draining', 'lease guard', 'admin:lease-drain')
    const leases = new WriterLeaseService(path, () => 100)
    const lease = leases.acquire(leaseTarget, 'kernel:archive-guard', 100)
    expect(() => admin.archive(leaseTarget, 'blocked by writer', 'admin:lease-archive')).toThrow('active writer')
    expect(leases.release(leaseTarget, lease.ownerId, lease.fencingToken)).toBe(true)

    const inbox = new RoundInbox(path, () => 100)
    inbox.enqueue({
      address: inboxTarget,
      idempotencyKey: 'archive:pending',
      principalId: 'principal:archive',
      input: { actionType: 'wait' },
      correlationId: 'archive:pending',
    }, 4)
    admin.setAdmission(inboxTarget, 'draining', 'inbox guard', 'admin:inbox-drain')
    expect(() => admin.archive(inboxTarget, 'blocked by Round', 'admin:inbox-archive')).toThrow('unfinished Round')
    admin.setAdmission(inboxTarget, 'open', 'test fork guard', 'admin:inbox-open')
    expect(() => store.forkBranch(inboxTarget, address('pending-round-child'), 0)).toThrow('pending or claimed Round')

    await store.commitRound({
      ...round(deliveryTarget),
      outbox: [{
        deliveryId: brandId('delivery:archive-guard', 'DeliveryId'),
        sessionId: brandId('session:archive-guard', 'SessionId'),
        payload: { kind: 'observation', text: 'must remain reconstructable' },
        critical: true,
      }],
    })
    admin.setAdmission(deliveryTarget, 'draining', 'delivery guard', 'admin:delivery-drain')
    expect(() => admin.archive(deliveryTarget, 'blocked by Outbox', 'admin:delivery-archive')).toThrow('critical delivery')
    const outbox = new WorldOutbox(path, undefined, { workerId: 'worker:archive', now: () => 100, createClaimToken: () => 'archive' })
    const claimed = outbox.claimNext(deliveryTarget)
    if (claimed === undefined) throw new Error('critical Outbox fixture is missing')
    await outbox.recordDelivered(claimed)
    expect(admin.archive(deliveryTarget, 'delivered', 'admin:delivery-complete')).toMatchObject({ lifecycleState: 'archived' })

    admin.setAdmission(archivedTarget, 'draining', 'archive parent', 'admin:parent-drain')
    admin.archive(archivedTarget, 'archived parent', 'admin:parent-archive')
    expect(() => store.forkBranch(archivedTarget, address('illegal-child'), 0)).toThrow('archived')
    expect(() => store.assertAdmissionOpen(archivedTarget, 'archived-admission')).toThrow('archived')
    const inconsistentArchived = new DatabaseSync(path)
    inconsistentArchived.prepare(`UPDATE branch_controls SET admission_state = 'open' WHERE address_key = ?`)
      .run(worldAddressKey(archivedTarget))
    inconsistentArchived.close()
    expect(() => store.assertAdmissionOpen(archivedTarget, 'archived-open-admission')).toThrow('archived')
    expect(() => store.forkBranch(address('missing-parent'), address('missing-child'), 0)).toThrow('unknown world branch')

    outbox.close()
    inbox.close()
    leases.close()
    admin.close()
    store.close()
  })

  it('allows only a matching durable Inbox admission to finish behind a draining gate', async () => {
    const path = database()
    const target = address('admitted-drain')
    const store = new WorldStore(path, undefined, () => 100)
    store.createBranch(target)
    const inbox = new RoundInbox(path, () => 100)
    const leases = new WriterLeaseService(path, () => 100)
    const lease = leases.acquire(target, 'kernel:drain', 1_000)
    const admitted = inbox.enqueue({
      address: target,
      idempotencyKey: 'admitted-before-drain',
      principalId: 'principal:player',
      input: { actionType: 'speak', parameters: { text: 'accepted' } },
      correlationId: 'admitted-before-drain',
    }, 4)
    inbox.claimNext(target, lease.ownerId, lease.fencingToken)
    const admin = new BranchAdministration(path, () => 100)
    admin.setAdmission(target, 'draining', 'drain accepted work', 'admin:drain-accepted')
    const request = {
      ...round(target),
      writerFencingToken: lease.fencingToken,
      admissionProof: { inboxSeq: admitted.inboxSeq, inputHash: admitted.inputHash },
    }
    await expect(store.commitRound({
      ...request,
      transactionId: brandId('transaction:wrong-admission', 'TransactionId'),
      admissionProof: { ...request.admissionProof, inputHash: 'sha256:wrong' },
    })).rejects.toThrow('no matching durable admission proof')
    await expect(store.commitRound(request)).resolves.toMatchObject({ status: 'committed', tick: 1 })
    admin.close()
    inbox.close()
    leases.close()
    store.close()
  })
})
