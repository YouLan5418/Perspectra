import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, createErrorEnvelope, WorldError, worldAddressKey, type WorldAddress } from '@harness-world/contracts'
import { BranchAdministration } from './branch-administration.ts'
import { BranchQuarantineService } from './quarantine.ts'
import { RoundInbox } from './round-inbox.ts'
import { WriterLeaseService } from './writer-lease.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []

function fixture(): { path: string; address: WorldAddress } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-quarantine-'))
  directories.push(directory)
  return {
    path: join(directory, 'world.sqlite'),
    address: {
      tenantId: brandId('tenant:quarantine', 'TenantId'),
      worldId: brandId('world:quarantine', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function integrityError(address: WorldAddress, message = 'bundle integrity failed') {
  return createErrorEnvelope({
    errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message, retryable: false,
    correlationId: 'quarantine:detected', address,
  })
}

describe('BranchQuarantineService', () => {
  it('atomically closes admission, fences the writer, aborts uncommitted Rounds, and records diagnostics', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const inbox = new RoundInbox(path, () => 1_000)
    for (const idempotencyKey of ['round:claimed', 'round:pending']) {
      inbox.enqueue({
        address, idempotencyKey, principalId: 'principal:player',
        input: { actionType: 'speak', parameters: { text: idempotencyKey } }, correlationId: idempotencyKey,
      }, 4)
    }
    const leases = new WriterLeaseService(path, () => 1_000)
    const lease = leases.acquire(address, 'writer:quarantine', 1_000)
    expect(inbox.claimNext(address, lease.ownerId, lease.fencingToken)).toMatchObject({ inboxSeq: 1 })

    const quarantine = new BranchQuarantineService(path, () => 1_100)
    const error = integrityError(address)
    expect(quarantine.quarantine({ address, error, source: 'world-store.committed-round' })).toEqual({
      status: 'quarantined', failureId: error.errorId, abortedRoundCount: 2, runtimeEpoch: 0,
    })
    expect(store.head(address)).toMatchObject({ headSeq: 0, tick: 0 })
    const administration = new BranchAdministration(path)
    expect(administration.status(address)).toMatchObject({
      admissionState: 'draining', runtimePhase: 'quarantined', runtimeEpoch: 0,
    })
    expect(() => store.assertAdmissionOpen(address, 'after-quarantine')).toThrow('quarantined')
    expect(() => leases.renew(address, lease.ownerId, lease.fencingToken, 1_000)).toThrow('fenced')
    expect(() => leases.acquire(address, 'writer:new', 1_000)).toThrow('quarantined')
    expect(() => inbox.enqueue({
      address, idempotencyKey: 'round:new', principalId: 'principal:player',
      input: { actionType: 'speak', parameters: {} }, correlationId: 'round:new',
    }, 4)).toThrow('quarantined')
    expect(() => administration.setAdmission(address, 'open', 'unsafe reopen', 'quarantine:reopen')).toThrow('quarantined')
    expect(() => store.forkBranch(address, {
      ...address, branchId: brandId('branch:blocked-child', 'BranchId'),
    }, 0)).toThrow('quarantined')
    await expect(store.commitRound({
      address,
      transactionId: brandId('transaction:quarantine:blocked', 'TransactionId'),
      roundId: brandId('round:quarantine:blocked', 'InteractionRoundId'),
      expectedHeadSeq: 0,
      expectedTick: 0,
      nextTick: 1,
      events: [{ eventType: 'quarantine.blocked', eventVersion: 1, data: {} }],
      outbox: [],
      correlationId: 'quarantine:blocked',
    })).rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_QUARANTINED' } })
    expect(store.readEvents(address)).toEqual([])
    expect(quarantine.explain(address)).toMatchObject({
      runtimePhase: 'quarantined', failures: [{
        failureId: error.errorId, status: 'open', source: 'world-store.committed-round',
        error: { errorCode: 'BUNDLE_HASH_MISMATCH' },
      }],
    })
    const raw = new DatabaseSync(path, { readOnly: true })
    expect((raw.prepare(`SELECT COUNT(*) AS count FROM round_inbox WHERE status = 'failed'`).get() as { count: number }).count).toBe(2)
    expect((raw.prepare(`SELECT COUNT(*) AS count FROM writer_leases`).get() as { count: number }).count).toBe(0)
    raw.close()
    expect(administration.readAudit(address)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'branch.quarantined' }),
    ]))

    expect(quarantine.quarantine({ address, error, source: 'world-store.committed-round' })).toMatchObject({
      status: 'already_quarantined', abortedRoundCount: 0,
    })
    expect(() => quarantine.quarantine({
      address, error: { ...error, message: 'different bytes' }, source: 'world-store.committed-round',
    })).toThrow('another ErrorEnvelope')
    expect(() => quarantine.quarantine({
      address: { ...address, branchId: brandId('branch:other', 'BranchId') }, error, source: 'mismatch',
    })).toThrow('does not match')

    administration.close()
    quarantine.close()
    leases.close()
    inbox.close()
    store.close()
  })

  it('only reopens through maintenance after validation and remains quarantined after failure', () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const quarantine = new BranchQuarantineService(path, (() => {
      let now = 2_000
      return () => now += 10
    })())
    quarantine.quarantine({ address, error: integrityError(address), source: 'projection.rebuild' })
    expect(() => quarantine.recover(address, 'recover:failed', () => { throw new Error('projection still corrupt') }))
      .toThrow('controlled quarantine recovery validation failed')
    expect(quarantine.explain(address)).toMatchObject({
      runtimePhase: 'quarantined',
      failures: [
        { status: 'open', error: { errorCode: 'BUNDLE_HASH_MISMATCH' } },
        { status: 'open', error: { errorCode: 'RECOVERY_VALIDATION_FAILED' } },
      ],
    })
    const recovered = quarantine.recover(address, 'recover:verified', () => ({
      eventChain: 'verified', projection: 'verified', session: 'verified',
    }))
    expect(recovered).toMatchObject({ status: 'recovered', runtimeEpoch: 1, validationHash: expect.stringMatching(/^sha256:/) })
    expect(quarantine.explain(address)).toMatchObject({
      runtimePhase: 'active', runtimeEpoch: 1,
      failures: [{ status: 'recovered' }, { status: 'recovered' }],
    })
    expect(() => quarantine.recover(address, 'recover:illegal', () => ({}))).toThrow('requires a quarantined branch')
    const administration = new BranchAdministration(path)
    expect(administration.status(address)).toMatchObject({ admissionState: 'open', runtimePhase: 'active' })
    administration.close()

    quarantine.close()
    store.close()
  })

  it('fails closed for unknown and archived branches and can resume an interrupted maintenance validation', async () => {
    const { path, address } = fixture()
    const archived = { ...address, branchId: brandId('branch:archived', 'BranchId') }
    const store = new WorldStore(path)
    store.createBranch(address)
    store.createBranch(archived)
    const admin = new BranchAdministration(path)
    admin.setAdmission(archived, 'draining', 'archive', 'archive:drain')
    admin.archive(archived, 'archive', 'archive:complete')
    const quarantine = new BranchQuarantineService(path)
    expect(() => quarantine.quarantine({ address: archived, error: integrityError(archived), source: 'archived' }))
      .toThrow('archived branch')
    expect(() => quarantine.explain({ ...address, branchId: brandId('branch:missing', 'BranchId') })).toThrow('unknown world branch')

    quarantine.quarantine({ address, error: integrityError(address), source: 'resume' })
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE branch_controls SET runtime_phase = 'maintenance' WHERE address_key = ?`).run(worldAddressKey(address))
    raw.close()
    const maintenanceInbox = new RoundInbox(path)
    expect(() => maintenanceInbox.enqueue({
      address, idempotencyKey: 'maintenance:blocked', principalId: 'principal:player',
      input: { actionType: 'wait' }, correlationId: 'maintenance:blocked',
    }, 4)).toThrow('maintenance')
    maintenanceInbox.close()
    await expect(store.commitRound({
      address,
      transactionId: brandId('transaction:maintenance:blocked', 'TransactionId'),
      roundId: brandId('round:maintenance:blocked', 'InteractionRoundId'),
      expectedHeadSeq: 0,
      expectedTick: 0,
      nextTick: 1,
      events: [{ eventType: 'maintenance.blocked', eventVersion: 1, data: {} }],
      outbox: [],
      correlationId: 'maintenance:blocked',
    })).rejects.toThrow('maintenance')
    expect(quarantine.recover(address, 'recover:resume', () => ({ resumed: true }))).toMatchObject({ runtimeEpoch: 1 })

    quarantine.close()
    admin.close()
    store.close()
  })

  it('records WorldError recovery causes and rolls back when maintenance ownership changes', () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const quarantine = new BranchQuarantineService(path)
    quarantine.quarantine({ address, error: integrityError(address), source: 'recovery:world-error' })
    expect(() => quarantine.recover(address, 'recover:world-error', () => {
      throw new WorldError(integrityError(address, 'nested integrity failure'))
    })).toThrow('controlled quarantine recovery validation failed')
    expect(quarantine.explain(address).failures.at(-1)).toMatchObject({
      error: { details: { causedByErrorCode: 'BUNDLE_HASH_MISMATCH', causedByErrorId: expect.any(String) } },
    })

    const raw = new DatabaseSync(path)
    expect(() => quarantine.recover(address, 'recover:lost-maintenance', () => {
      raw.prepare(`UPDATE branch_controls SET runtime_phase = 'quarantined' WHERE address_key = ?`).run(worldAddressKey(address))
      return { eventChain: 'verified' }
    })).toThrow('branch left maintenance')
    raw.close()
    quarantine.close()
    store.close()
  })
})
