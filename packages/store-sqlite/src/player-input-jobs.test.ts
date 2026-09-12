import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { brandId, hashWorldJson, worldAddressKey } from '@harness-world/contracts'
import { BranchAdministration } from './branch-administration.ts'
import { RoundInbox } from './round-inbox.ts'
import { WorldStore } from './world-store.ts'
import { WriterLeaseService } from './writer-lease.ts'
import { PlayerInputJobs, readPlayerInputRow, PLAYER_INPUT_TRANSITIONS, type PlayerInputStatus } from './player-input-jobs.ts'
import { WorldBootstrap } from '@harness-world/kernel'
import { intentWorld } from '../../../tests/fixtures/player-intent-world.ts'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'intent-jobs-'))
  const path = join(root, 'world.sqlite')
  const compiled = intentWorld()
  const address = compiled.manifest.address
  const world = new WorldStore(path)
  new WorldBootstrap(world, true).activate(compiled)
  world.close()
  const leases = new WriterLeaseService(path, () => 100)
  const lease = leases.acquire(address, 'writer', 1000)
  const jobs = new PlayerInputJobs(path, () => 100)
  return { root, path, address, lease, leases, jobs,
    close() { jobs.close(); leases.close(); rmSync(root, { recursive: true, force: true }) } }
}

it('includes accepted interpretation work in fork, maintenance and archive barriers while allowing it to drain', () => {
  const s = setup()
  const admin = new BranchAdministration(s.path, () => 2000)
  const world = new WorldStore(s.path)
  const inbox = new RoundInbox(s.path)
  try {
    let job = s.jobs.receive(s.address, 'p', 'input', { text: 'hello' }, 2)
    const request = { address: s.address, principalId: 'p', idempotencyKey: 'input', correlationId: 'test',
      playerInputId: job.inputId, input: { playerInputId: job.inputId } }
    expect(() => inbox.enqueue(request, 2)).toThrow('earlier player input')
    expect(() => world.forkBranch(s.address, { ...s.address, branchId: brandId('child', 'BranchId') }, 0)).toThrow('pending or claimed')
    admin.setAdmission(s.address, 'draining', 'test', 'test')
    expect(() => admin.enterMaintenance(s.address, 'test', 'test')).toThrow('maintenance requires')
    expect(() => admin.archive(s.address, 'test', 'test')).toThrow('archive requires')
    s.jobs.claim(s.address, s.lease)
    job = s.jobs.advance(job, s.lease, 'validated', {})
    for (const invalid of [{ idempotencyKey: 'other' }, { principalId: 'other' }, { input: {} }]) {
      expect(() => inbox.enqueue({ ...request, ...invalid }, 2)).toThrow('invalid durable player input binding')
    }
    expect(inbox.enqueue(request, 2).status).toBe('enqueued')
    expect(() => inbox.enqueue({ ...request, playerInputId: 'invented', idempotencyKey: 'invented' }, 2)).toThrow('earlier player input')
    expect(job.status).toBe('validated')
  } finally { inbox.close(); world.close(); admin.close(); s.close() }
})

it('rejects invented input handles without a durable job', () => {
  const s = setup()
  const inbox = new RoundInbox(s.path)
  try {
    expect(() => inbox.enqueue({ address: s.address, principalId: 'p', idempotencyKey: 'fake', correlationId: 'test',
      playerInputId: 'fake', input: {} }, 1)).toThrow('invalid durable player input binding')
  } finally { inbox.close(); s.close() }
})

it('durably binds input identity and FIFO across reopen, ambiguity and explicit fallback', () => {
  const s = setup()
  try {
    expect(s.jobs.claim(s.address, s.lease)).toBeUndefined()
    const first = s.jobs.receive(s.address, 'principal:p', 'one', { text: 'hold' }, 2)
    expect(first).toMatchObject({
      acceptedManifestHash: intentWorld().manifestHash,
      acceptedHeadSeq: expect.any(Number),
      acceptedHeadHash: expect.stringMatching(/^sha256:/u),
    })
    expect(s.jobs.unfinishedAddresses()).toEqual([s.address])
    expect(s.jobs.receive(s.address, 'principal:p', 'one', { text: 'hold' }, 2)).toEqual(first)
    expect(() => s.jobs.receive(s.address, 'principal:p', 'one', { text: 'different' }, 2)).toThrow('different content')
    const second = s.jobs.receive(s.address, 'principal:p', 'two', { text: '/move next' }, 2)
    expect(() => s.jobs.receive(s.address, 'principal:p', 'three', {}, 2)).toThrow('queue is full')
    expect(() => s.jobs.advance(second, s.lease, 'cancelled', {})).toThrow('not claimed')
    expect(s.jobs.claim(s.address, s.lease)).toEqual(first)
    let current = s.jobs.advance(first, s.lease, 'prepared', { profile: 'v1' })
    expect(s.jobs.advance(first, s.lease, 'prepared', { profile: 'v1' })).toEqual(current)
    expect(() => s.jobs.advance(first, s.lease, 'prepared', { profile: 'v2' })).toThrow('stale')
    current = s.jobs.advance(current, s.lease, 'dispatch_started', { modelCallId: 'call:1' })
    const reopened = new PlayerInputJobs(s.path)
    expect(reopened.read(s.address, 'one')).toEqual(current)
    reopened.close()
    current = s.jobs.advance(current, s.lease, 'timed_out_ambiguous', { reason: 'restart' })
    expect(() => s.jobs.advance(current, s.lease, 'validated', {})).toThrow('invalid')
    expect(s.jobs.claim(s.address, s.lease)).toEqual(second)
    let next = s.jobs.advance(second, s.lease, 'validated', { explicit: true })
    next = s.jobs.advance(next, s.lease, 'round_enqueued', { roundId: 'r', inboxSeq: 1 })
    next = s.jobs.advance(next, s.lease, 'completed', { tick: 1 })
    expect(next.records.validated).toEqual({ explicit: true })
    expect(s.jobs.claim(s.address, s.lease)).toBeUndefined()
    expect(s.jobs.unfinishedAddresses()).toEqual([])
  } finally { s.close() }
})

it.each(['clarification_required', 'invalid_response', 'timed_out', 'cancelled', 'validated'] as const)('persists %s terminal or validated outcomes', state => {
  const s = setup()
  try {
    let job = s.jobs.receive(s.address, 'p', 'key', 'text', 1)
    s.jobs.claim(s.address, s.lease)
    if (state !== 'clarification_required' && state !== 'cancelled') {
      job = s.jobs.advance(job, s.lease, 'prepared', {})
      job = s.jobs.advance(job, s.lease, 'dispatch_started', {})
      if (state === 'validated') job = s.jobs.advance(job, s.lease, 'response_received', {})
    }
    expect(s.jobs.advance(job, s.lease, state, {}).status).toBe(state)
    expect(PLAYER_INPUT_TRANSITIONS[state]).toBeDefined()
  } finally { s.close() }
})

it('rejects invalid admission and stale/expired/missing writer leases', () => {
  const s = setup()
  try {
    for (const limit of [0, 1.5]) expect(() => s.jobs.receive(s.address, 'p', 'k', '', limit)).toThrow('queueLimit')
    const first = s.jobs.receive(s.address, 'p', 'one', 'text', 2)
    for (const lease of [{ ...s.lease, ownerId: 'other' }, { ...s.lease, fencingToken: 99 }]) expect(() => s.jobs.claim(s.address, lease)).toThrow('lease lost')
    const expired = new PlayerInputJobs(s.path, () => 99999)
    expect(() => expired.claim(s.address, s.lease)).toThrow('lease lost')
    expired.close()
    s.jobs.claim(s.address, s.lease)
    expect(() => s.jobs.advance({ ...first, idempotencyKey: 'missing' }, s.lease, 'cancelled', {})).toThrow('missing')
    const raw = new DatabaseSync(s.path)
    for (const update of ["admission_state='draining'", "admission_state='open', runtime_phase='maintenance'", "runtime_phase='active', lifecycle_state='archived'"]) {
      raw.exec(`UPDATE branch_controls SET ${update}`)
      expect(() => s.jobs.receive(s.address, 'p', 'new', 'text', 2)).toThrow('not open')
    }
    raw.exec('DELETE FROM writer_leases')
    expect(() => s.jobs.claim(s.address, s.lease)).toThrow('lease lost')
    raw.exec("UPDATE branch_controls SET admission_state='open',runtime_phase='active',lifecycle_state='active'; DELETE FROM branch_activations")
    expect(() => s.jobs.receive(s.address, 'p', 'no-manifest', 'text', 2)).toThrow('no active Manifest or Head')
    raw.exec('DELETE FROM branch_controls')
    expect(() => s.jobs.receive(s.address, 'p', 'new', 'text', 2)).toThrow('not open')
    raw.close()
  } finally { s.close() }
})

it('detects damaged imported or locally stored input authority', () => {
  const s = setup()
  try {
    const job = s.jobs.receive(s.address, 'p', 'key', 'source', 1)
    const row = { address_key: worldAddressKey(s.address), input_seq: 1, idempotency_key: 'key', input_hash: job.inputHash,
      status: job.status, job_json: JSON.stringify(job), state_hash: hashWorldJson('player-input-state/v1', job) }
    expect(readPlayerInputRow(row)).toEqual(job)
    for (const patch of [ { version: 'bad' }, { address: { ...s.address, branchId: 'other' } }, { inputSeq: 2 }, { idempotencyKey: 'bad' },
      { status: 'completed' }, { input: 'changed' }, { inputHash: 'bad' }, { inputId: 'bad' }, { acceptedManifestHash: 'bad' },
      { acceptedHeadSeq: -1 }, { acceptedHeadSeq: 0 }, { acceptedHeadSeq: 1.5 }, { acceptedHeadHash: 'bad' } ]) {
      const changed = { ...job, ...patch }
      expect(() => readPlayerInputRow({ ...row, job_json: JSON.stringify(changed), state_hash: hashWorldJson('player-input-state/v1', changed) })).toThrow()
    }
    expect(() => readPlayerInputRow({ ...row, state_hash: 'sha256:bad' })).toThrow('inconsistent')
    expect(() => readPlayerInputRow({ ...row, status: 'unknown' as PlayerInputStatus, job_json: JSON.stringify({ ...job, status: 'unknown' }) })).toThrow('inconsistent')
  } finally { s.close() }
})
