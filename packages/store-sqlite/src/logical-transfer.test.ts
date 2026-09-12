import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, createErrorEnvelope, hashWorldJson, type ReactionCycleDraft } from '@harness-world/contracts'
import { BranchQuarantineService } from './quarantine.ts'
import { fixtureAddress, fixtureCommitRequest } from '@harness-world/testkit'
import { WorldLogicalTransferService } from './logical-transfer.ts'
import { OperationalAuditLog } from './operational-audit.ts'
import { RoundInbox } from './round-inbox.ts'
import { SessionDeliveryAdapter } from './session-delivery.ts'
import { SessionOutboxWorker, WorldOutbox } from './outbox-worker.ts'
import { WriterLeaseService } from './writer-lease.ts'
import { WorldStore } from './world-store.ts'
import { PlayerInputJobs } from './player-input-jobs.ts'
import { WorldBootstrap } from '@harness-world/kernel'
import { intentWorld } from '../../../tests/fixtures/player-intent-world.ts'

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
  it('round-trips v8 input authority, rejects its tampering and never invents it on v7 import', () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const compiled = intentWorld()
    const address = compiled.manifest.address
    const store = new WorldStore(source)
    new WorldBootstrap(store, true).activate(compiled)
    store.close()
    const jobs = new PlayerInputJobs(source)
    const job = jobs.receive(address, 'p', 'key', { text: 'hello' }, 1)
    jobs.close()
    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'input.dshworld')
    service.exportAuthority(exportPath, 'input-export')
    const target = join(root, 'target.sqlite')
    service.importAuthority(exportPath, target, 'input-import')
    const imported = new PlayerInputJobs(target)
    expect(imported.read(address, 'key')).toEqual(job)
    imported.close()
    const original = JSON.parse(readFileSync(exportPath, 'utf8'))
    const forged = structuredClone(original)
    forged.data.tables.player_input_jobs[0].job_json = JSON.stringify({ ...job, input: { text: 'changed' } })
    forged.bundleHash = hashWorldJson('logical-authority-export', forged.data)
    const forgedPath = join(root, 'forged.dshworld')
    writeFileSync(forgedPath, JSON.stringify(forged))
    expect(() => service.importAuthority(forgedPath, join(root, 'forged.sqlite'), 'input-forged')).toThrow()
    const legacy = structuredClone(original)
    legacy.format = 'dshworld-authority/v7'
    legacy.data.authorityVersion = 7
    legacy.bundleHash = hashWorldJson('logical-authority-export', legacy.data)
    const legacyPath = join(root, 'legacy.dshworld')
    writeFileSync(legacyPath, JSON.stringify(legacy))
    expect(() => service.importAuthority(legacyPath, join(root, 'invalid-legacy.sqlite'), 'legacy-invalid'))
      .toThrow('legacy authority cannot contain player input jobs')
    delete legacy.data.tables.player_input_jobs
    legacy.bundleHash = hashWorldJson('logical-authority-export', legacy.data)
    writeFileSync(legacyPath, JSON.stringify(legacy))
    const legacyTarget = join(root, 'legacy.sqlite')
    service.importAuthority(legacyPath, legacyTarget, 'legacy-import')
    const legacyJobs = new PlayerInputJobs(legacyTarget)
    expect(legacyJobs.read(address, 'key')).toBeUndefined()
    legacyJobs.close()
  })

  it('round-trips a recoverable Player Input Round and rejects broken authority, state path or Inbox binding', () => {
    const root = directory()
    const source = join(root, 'pending-input.sqlite')
    const compiled = intentWorld()
    const address = compiled.manifest.address
    const store = new WorldStore(source)
    new WorldBootstrap(store, true).activate(compiled)
    const child = { ...address, branchId: brandId('branch:zz-logical-input-child', 'BranchId') }
    store.forkBranch(address, child, store.head(address).headSeq)
    store.close()
    const leases = new WriterLeaseService(source)
    const lease = leases.acquire(address, 'logical-input')
    const childLease = leases.acquire(child, 'logical-input-child')
    const jobs = new PlayerInputJobs(source)
    const inbox = new RoundInbox(source)
    let job = jobs.receive(address, 'principal:player', 'pending-input', { text: '/move location:next' }, 2)
    let childJob = jobs.receive(child, 'principal:player', 'child-input', { text: 'child' }, 2)
    jobs.claim(address, lease)
    job = jobs.advance(job, lease, 'validated', { version: 'player-submission/v2', actions: [] })
    const receipt = inbox.enqueue({ address, principalId: job.principalId, idempotencyKey: job.idempotencyKey,
      correlationId: 'logical-input', playerInputId: job.inputId, input: { playerInputId: job.inputId } }, 2)
    job = jobs.advance(job, lease, 'round_enqueued', receipt as unknown as never)
    jobs.claim(child, childLease)
    childJob = jobs.advance(childJob, childLease, 'validated', { version: 'player-submission/v2', actions: [] })
    inbox.enqueue({ address: child, principalId: childJob.principalId, idempotencyKey: childJob.idempotencyKey,
      correlationId: 'logical-input-child', playerInputId: childJob.inputId, input: { playerInputId: childJob.inputId } }, 2)
    inbox.close()
    jobs.close()
    leases.close()

    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'pending-input.dshworld')
    service.exportAuthority(exportPath, 'pending-input-export')
    const target = join(root, 'pending-input-target.sqlite')
    service.importAuthority(exportPath, target, 'pending-input-import')
    const importedJobs = new PlayerInputJobs(target)
    const importedInbox = new RoundInbox(target)
    expect(importedJobs.read(address, job.idempotencyKey)).toEqual(job)
    expect(importedJobs.read(child, childJob.idempotencyKey)).toEqual(childJob)
    expect(importedInbox.readStatus(address, { idempotencyKey: job.idempotencyKey })).toMatchObject({ status: 'queued' })
    importedInbox.close()
    importedJobs.close()

    const original = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    const attempt = (name: string, mutate: (copy: any) => void, expected: string) => {
      const copy = structuredClone(original)
      mutate(copy)
      copy.bundleHash = hashWorldJson('logical-authority-export', copy.data)
      const path = join(root, `${name}.dshworld`)
      writeFileSync(path, JSON.stringify(copy))
      expect(() => service.importAuthority(path, join(root, `${name}.sqlite`), `logical:${name}`)).toThrow(expected)
    }
    attempt('accepted-head', copy => {
      const changed = { ...job, acceptedHeadHash: hashWorldJson('forged-input-head', {}) }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input authority')
    attempt('accepted-head-beyond-branch', copy => {
      const changed = { ...job, acceptedHeadSeq: job.acceptedHeadSeq + 100, acceptedHeadHash: hashWorldJson('future-input-head', {}) }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input authority')
    attempt('accepted-head-beyond-fork', copy => {
      const changed = { ...childJob, acceptedHeadSeq: childJob.acceptedHeadSeq + 100, acceptedHeadHash: hashWorldJson('future-child-input-head', {}) }
      copy.data.tables.player_input_jobs[1].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[1].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input authority')
    attempt('missing-activation', copy => {
      copy.data.tables.branch_activations = []
    }, 'divergent Player Input authority')
    attempt('state-path', copy => {
      const changed = { ...job, records: { round_enqueued: job.records.round_enqueued! } }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input authority')
    attempt('state-backtrack', copy => {
      const changed = { ...job, records: { ...job.records, timed_out: {} } }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input authority')
    attempt('missing-inbox', copy => { copy.data.tables.round_inbox = [] }, 'lost its Round Inbox item')
    attempt('invalid-pending', copy => { copy.data.tables.round_inbox[0].input_hash = 'sha256:unexpected' }, 'invalid pending Round Inbox')
    attempt('wrong-binding', copy => {
      const round = copy.data.tables.round_inbox[0]
      round.input_json = JSON.stringify({ playerInputId: 'player-input:forged' })
      round.input_hash = hashWorldJson('player-round-input', { principalId: round.principal_id, input: JSON.parse(round.input_json) })
    }, 'divergent Player Input Round binding')
    for (const [name, input] of [['null-binding', null], ['array-binding', []], ['primitive-binding', 'forged']] as const) {
      attempt(name, copy => {
        const round = copy.data.tables.round_inbox[0]
        round.input_json = JSON.stringify(input)
        round.input_hash = hashWorldJson('player-round-input', { principalId: round.principal_id, input })
      }, 'divergent Player Input Round binding')
    }
    attempt('receipt-shape', copy => {
      const changed = { ...job, records: { ...job.records, round_enqueued: 'invalid' } }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input Round binding')
    for (const [name, receiptValue] of [['receipt-null', null], ['receipt-array', []]] as const) {
      attempt(name, copy => {
        const changed = { ...job, records: { ...job.records, round_enqueued: receiptValue } }
        copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
        copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
      }, 'divergent Player Input Round binding')
    }
    attempt('receipt-empty', copy => {
      const changed = { ...job, records: { ...job.records, round_enqueued: {} } }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input Round binding')
    attempt('receipt-binding', copy => {
      const changed = { ...job, records: { ...job.records, round_enqueued: { ...(job.records.round_enqueued as any), roundId: 'round:wrong' } } }
      copy.data.tables.player_input_jobs[0].job_json = JSON.stringify(changed)
      copy.data.tables.player_input_jobs[0].state_hash = hashWorldJson('player-input-state/v1', changed)
    }, 'divergent Player Input Round binding')
  })

  it('preserves quarantine authority and rejects a forged failure ledger', () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const address = fixtureAddress('logical-quarantine')
    const store = new WorldStore(source)
    store.createBranch(address)
    store.close()
    const quarantine = new BranchQuarantineService(source, () => 42)
    const error = createErrorEnvelope({
      errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', message: 'logical quarantine fixture',
      retryable: false, correlationId: 'logical:quarantine', address,
    })
    quarantine.quarantine({ address, error, source: 'logical-transfer.test' })
    quarantine.close()

    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'quarantined.dshworld')
    service.exportAuthority(exportPath, 'logical:quarantine-export')
    const envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    expect(envelope).toMatchObject({ format: 'dshworld-authority/v8', data: { authorityVersion: 8 } })
    const target = join(root, 'quarantined-import.sqlite')
    service.importAuthority(exportPath, target, 'logical:quarantine-import')
    const imported = new BranchQuarantineService(target)
    expect(imported.explain(address)).toMatchObject({
      runtimePhase: 'quarantined', failures: [{ failureId: error.errorId, status: 'open' }],
    })
    imported.close()

    envelope.data.tables.branch_failures[0].error_json = JSON.stringify({ forged: true })
    envelope.bundleHash = hashWorldJson('logical-authority-export', envelope.data)
    const forgedPath = join(root, 'forged-failure.dshworld')
    writeFileSync(forgedPath, JSON.stringify(envelope))
    expect(() => service.importAuthority(forgedPath, join(root, 'forged.sqlite'), 'logical:forged-failure'))
      .toThrow('divergent Branch failure')
  })

  it('round-trips authority tables without Session, Memory, Audit, or process state', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const parent = fixtureAddress('logical-parent')
    const child = fixtureAddress('logical-child')
    const setup = new WorldStore(source)
    setup.createBranch(parent)
    const commitRequest = {
      ...fixtureCommitRequest(parent),
      authority: {
        schemaVersion: 1,
        participants: [{ participantId: 'player', terminalStatus: 'proposed' }],
        actions: [{ actionId: 'action:logical', parameters: { value: 'preserved' } }],
        resolutions: [{ actionId: 'action:logical', status: 'accepted' }],
      },
    }
    const committed = await setup.commitRound(commitRequest)
    setup.forkBranch(parent, child, 1)
    const eventHash = setup.readEvents(parent)[0]!.eventHash
    setup.close()
    const leases = new WriterLeaseService(source)
    const lease = leases.acquire(parent, 'kernel:logical')
    const inbox = new RoundInbox(source)
    inbox.enqueue({
      address: parent,
      idempotencyKey: 'logical:completed',
      principalId: 'principal:logical',
      input: { actionType: 'fixture' },
      correlationId: 'logical:inbox',
    }, 4)
    inbox.claimNext(parent, 'kernel:logical', lease.fencingToken)
    const completedResult = { status: 'accepted', bundleHash: committed.bundleHash }
    inbox.complete(parent, 1, 'kernel:logical', lease.fencingToken, {
      transactionId: commitRequest.transactionId,
      bundleHash: committed.bundleHash,
    }, completedResult)
    inbox.close()
    leases.close()
    const sender = new WorldOutbox(source)
    const delivery = sender.claimNext(parent)
    if (delivery === undefined) throw new Error('logical transfer fixture Outbox is missing')
    await sender.recordDelivered(delivery)
    sender.close()

    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'world.dshworld')
    const bundleHash = service.exportAuthority(exportPath, 'logical:export')
    const target = join(root, 'target.sqlite')
    expect(service.importAuthority(exportPath, target, 'logical:import')).toBe(bundleHash)
    const imported = new WorldStore(target)
    expect(imported.readEvents(parent)[0]!.eventHash).toBe(eventHash)
    expect(imported.readEvents(child)).toHaveLength(1)
    expect(imported.readRoundAuthority(parent, commitRequest.transactionId)).toMatchObject({
      authority: { schemaVersion: 1, actions: [{ parameters: { value: 'preserved' } }] },
    })
    expect(imported.readRoundAuthority(child, commitRequest.transactionId)).toMatchObject({ authorityHash: expect.any(String) })
    expect(imported.readRoundAuthority(parent, brandId('transaction:missing', 'TransactionId'))).toBeUndefined()
    imported.close()
    const importedInbox = new RoundInbox(target)
    expect(importedInbox.readCompleted(parent, 'logical:completed')).toEqual(completedResult)
    importedInbox.close()
    const importedOutbox = new WorldOutbox(target)
    const rebuiltSession = new SessionDeliveryAdapter(join(root, 'rebuilt-session.sqlite'))
    const rebuiltWorker = new SessionOutboxWorker(importedOutbox, rebuiltSession, parent)
    await expect(rebuiltWorker.runOnce('logical:session-rebuild')).resolves.toMatchObject({
      status: 'delivered', deliveryId: commitRequest.outbox[0]!.deliveryId,
    })
    expect(rebuiltSession.cursor(commitRequest.outbox[0]!.sessionId)).toBe(1)
    expect(rebuiltSession.readEvent(commitRequest.outbox[0]!.sessionId, 1)).toMatchObject({
      payloadHash: hashWorldJson('world-outbox-payload', commitRequest.outbox[0]!.payload),
    })
    rebuiltSession.close()
    importedOutbox.close()
    const importProvenance = new OperationalAuditLog(`${target}.audit.sqlite`)
    expect(importProvenance.read()).toMatchObject([{
      operation: 'authority.import.completed',
      details: { exportPath: expect.stringContaining('world.dshworld'), bundleHash },
    }])
    importProvenance.close()
    const tamperedInbox = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    tamperedInbox.data.tables.round_inbox[0].commit_bundle_hash = 'sha256:wrong'
    tamperedInbox.bundleHash = hashWorldJson('logical-authority-export', tamperedInbox.data)
    const tamperedInboxPath = join(root, 'tampered-inbox.dshworld')
    writeFileSync(tamperedInboxPath, JSON.stringify(tamperedInbox))
    expect(() => service.importAuthority(tamperedInboxPath, join(root, 'tampered-inbox.sqlite'), 'logical:inbox-tamper'))
      .toThrow('completed Round Inbox')
    const missingCommit = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    missingCommit.data.tables.round_inbox[0].commit_transaction_id = 'transaction:missing'
    missingCommit.bundleHash = hashWorldJson('logical-authority-export', missingCommit.data)
    const missingCommitPath = join(root, 'missing-commit.dshworld')
    writeFileSync(missingCommitPath, JSON.stringify(missingCommit))
    expect(() => service.importAuthority(missingCommitPath, join(root, 'missing-commit.sqlite'), 'logical:commit-missing'))
      .toThrow('completed Round Inbox')
    const tamperedAuthority = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    tamperedAuthority.data.tables.round_authority[0].authority_json = JSON.stringify({ forged: true })
    tamperedAuthority.bundleHash = hashWorldJson('logical-authority-export', tamperedAuthority.data)
    const tamperedAuthorityPath = join(root, 'tampered-authority.dshworld')
    writeFileSync(tamperedAuthorityPath, JSON.stringify(tamperedAuthority))
    expect(() => service.importAuthority(tamperedAuthorityPath, join(root, 'tampered-authority.sqlite'), 'logical:authority-tamper'))
      .toThrow('Round authority is divergent')
    const missingAuthority = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    missingAuthority.data.tables.round_authority = []
    missingAuthority.bundleHash = hashWorldJson('logical-authority-export', missingAuthority.data)
    const missingAuthorityPath = join(root, 'missing-authority.dshworld')
    writeFileSync(missingAuthorityPath, JSON.stringify(missingAuthority))
    expect(() => service.importAuthority(missingAuthorityPath, join(root, 'missing-authority.sqlite'), 'logical:authority-missing'))
      .toThrow('authority presence is inconsistent')
    const malformedResult = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    malformedResult.data.tables.round_inbox[0].result_json = JSON.stringify('not-an-object')
    malformedResult.data.tables.round_inbox[0].result_hash = hashWorldJson('player-round-result', 'not-an-object')
    malformedResult.bundleHash = hashWorldJson('logical-authority-export', malformedResult.data)
    const malformedResultPath = join(root, 'malformed-result.dshworld')
    writeFileSync(malformedResultPath, JSON.stringify(malformedResult))
    expect(() => service.importAuthority(malformedResultPath, join(root, 'malformed-result.sqlite'), 'logical:result-shape'))
      .toThrow('completed Round Inbox')
    const missingResult = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    missingResult.data.tables.round_inbox[0].result_json = null
    missingResult.data.tables.round_inbox[0].result_hash = null
    missingResult.bundleHash = hashWorldJson('logical-authority-export', missingResult.data)
    const missingResultPath = join(root, 'missing-result.dshworld')
    writeFileSync(missingResultPath, JSON.stringify(missingResult))
    expect(() => service.importAuthority(missingResultPath, join(root, 'missing-result.sqlite'), 'logical:result-missing'))
      .toThrow()
    const failedInbox = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    failedInbox.data.tables.round_inbox[0].status = 'failed'
    failedInbox.data.tables.round_inbox[0].commit_transaction_id = null
    failedInbox.data.tables.round_inbox[0].commit_bundle_hash = null
    failedInbox.bundleHash = hashWorldJson('logical-authority-export', failedInbox.data)
    const failedInboxPath = join(root, 'failed-inbox.dshworld')
    writeFileSync(failedInboxPath, JSON.stringify(failedInbox))
    expect(() => service.importAuthority(failedInboxPath, join(root, 'failed-inbox.sqlite'), 'logical:failed-inbox'))
      .toThrow('invalid completed Round Inbox')
    expect(() => service.exportAuthority(source, 'logical:alias')).toThrow('aliases the source')
    expect(() => service.importAuthority(exportPath, target, 'logical:exists')).toThrow('already exists')
    const audit = new OperationalAuditLog(`${source}.audit.sqlite`)
    expect(audit.read().map(event => event.operation)).toEqual(expect.arrayContaining([
      'authority.export.requested', 'authority.export.completed',
      'authority.import.requested', 'authority.import.completed',
    ]))
    audit.close()
  })

  it('round-trips v6 Reaction authority exactly and rejects a divergent Job state', async () => {
    const root = directory()
    const source = join(root, 'reaction-source.sqlite')
    const address = fixtureAddress('logical-reaction')
    const characterId = brandId('character:logical-reaction', 'CharacterId')
    const base = fixtureCommitRequest(address)
    const reactionCycle = {
      policyVersion: 'reaction-policy/v1',
      profileId: 'responsive/v1',
      maxWaves: 3,
      maxNpcCalls: 1,
      maxCallsPerCharacter: 2,
      maxActionsPerCall: 1,
      allowedActionTypes: ['speak@1'],
      initialTokenBudget: 10,
      deadlineAtMs: 30_000,
      candidates: [{
        characterId,
        estimatedTokens: 4,
        stimuli: [{
          sourceEventOrdinal: 0,
          observationOrdinal: 0,
          observationId: 'observation:logical-reaction',
          observerCharacterId: characterId,
        }],
      }],
    } satisfies ReactionCycleDraft
    const request = {
      ...base,
      events: [{
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:logical-reaction', value: { observerId: characterId, content: 'wake' } },
      }],
      outbox: [],
      reactionCycle,
    }
    const setup = new WorldStore(source)
    setup.createBranch(address)
    const committed = await setup.commitRound(request)
    setup.close()
    const leases = new WriterLeaseService(source)
    const writer = leases.acquire(address, 'reaction-worker:logical')
    const worker = new WorldStore(source)
    const claimed = worker.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 10_000)!
    const expected = worker.activeReactionCycle(address)!
    worker.close()
    leases.close()

    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'reaction.dshworld')
    service.exportAuthority(exportPath, 'logical:reaction-export')
    const envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    expect(envelope.data.tables).toMatchObject({
      world_reaction_cycles: [{ cycle_id: expected.cycle.cycleId }],
      world_reaction_waves: [{ cycle_id: expected.cycle.cycleId, wave: 1 }],
      world_reaction_jobs: [{ job_id: claimed.jobId, status: 'claimed', claim_fencing_token: 1 }],
      world_reaction_job_stimuli: [{ job_id: claimed.jobId, source_event_seq: 1 }],
    })
    const target = join(root, 'reaction-target.sqlite')
    service.importAuthority(exportPath, target, 'logical:reaction-import')
    const imported = new WorldStore(target)
    expect(imported.activeReactionCycle(address)).toEqual(expected)
    expect(imported.committedRound(address, request.transactionId)).toMatchObject({ bundleHash: committed.bundleHash })
    imported.close()

    const legacy = structuredClone(envelope)
    legacy.format = 'dshworld-authority/v6'
    legacy.data.authorityVersion = 6
    delete legacy.data.tables.player_input_jobs
    for (const row of legacy.data.tables.world_reaction_cycles) delete row.action_group_max_actions
    const legacyPath = join(root, 'legacy-v6.dshworld')
    const saveLegacy = () => {
      legacy.bundleHash = hashWorldJson('logical-authority-export', legacy.data)
      writeFileSync(legacyPath, JSON.stringify(legacy))
    }
    saveLegacy()
    const legacyTarget = join(root, 'legacy-v6.sqlite')
    service.importAuthority(legacyPath, legacyTarget, 'logical:v6-import')
    const legacyStore = new WorldStore(legacyTarget)
    expect(legacyStore.activeReactionCycle(address)).toEqual(expected)
    legacyStore.close()
    const v16 = new DatabaseSync(legacyTarget)
    v16.exec('DROP TABLE player_input_jobs; ALTER TABLE world_reaction_cycles DROP COLUMN action_group_max_actions; PRAGMA user_version = 16')
    v16.close()
    const migrated = new WorldStore(legacyTarget)
    expect(migrated.activeReactionCycle(address)).toEqual(expected)
    expect(migrated.committedRound(address, request.transactionId)).toMatchObject({ bundleHash: committed.bundleHash })
    migrated.close()
    for (const [name, rows] of [
      ['invalid', [null]], ['array', [[]]], ['primitive', [1]],
      ['extension', [{ action_group_max_actions: 2 }]], ['missing', null],
    ] as const) {
      legacy.data.tables.world_reaction_cycles = rows
      saveLegacy()
      expect(() => service.importAuthority(legacyPath, join(root, `legacy-v6-${name}.sqlite`), 'logical:v6-invalid')).toThrow()
    }

    envelope.data.tables.world_reaction_jobs[0].state_hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    envelope.bundleHash = hashWorldJson('logical-authority-export', envelope.data)
    const forgedPath = join(root, 'reaction-forged.dshworld')
    writeFileSync(forgedPath, JSON.stringify(envelope))
    expect(() => service.importAuthority(forgedPath, join(root, 'reaction-forged.sqlite'), 'logical:reaction-forged'))
      .toThrow('divergent Reaction Cycle')
  })

  it('exports every authority table from one WAL snapshot during a concurrent commit', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const target = fixtureAddress('snapshot')
    const setup = new WorldStore(source)
    setup.createBranch(target)
    const first = await setup.commitRound(fixtureCommitRequest(target))
    setup.close()
    let committedDuringExport = false
    const service = new WorldLogicalTransferService(source, (table) => {
      if (table !== 'branches' || committedDuringExport) return
      committedDuringExport = true
      const writer = new WorldStore(source)
      void writer.commitRound({
        ...fixtureCommitRequest(target),
        transactionId: brandId('transaction:concurrent-export', 'TransactionId'),
        roundId: brandId('round:concurrent-export', 'InteractionRoundId'),
        expectedHeadSeq: first.headSeq,
        expectedTick: first.tick,
        nextTick: first.tick + 1,
        events: [{ eventType: 'fixture.concurrent', eventVersion: 1, data: {} }],
        outbox: [],
      })
      writer.close()
    })
    const exportPath = join(root, 'snapshot.dshworld')
    service.exportAuthority(exportPath, 'logical:snapshot')
    expect(committedDuringExport).toBe(true)
    const importedPath = join(root, 'snapshot-import.sqlite')
    service.importAuthority(exportPath, importedPath, 'logical:snapshot-import')
    const imported = new WorldStore(importedPath)
    expect(imported.head(target).headSeq).toBe(first.headSeq)
    imported.close()
    const sourceAfter = new WorldStore(source)
    expect(sourceAfter.head(target).headSeq).toBe(first.headSeq + 1)
    sourceAfter.close()
  })

  it('rolls back both in-transaction and post-commit export failures', () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    setup.createBranch(fixtureAddress('export-failure'))
    setup.close()

    const interrupted = new WorldLogicalTransferService(source, table => {
      if (table === 'events') throw new Error('interrupted export')
    })
    expect(() => interrupted.exportAuthority(join(root, 'interrupted.dshworld'), 'logical:interrupted'))
      .toThrow('interrupted export')

    const occupiedTarget = join(root, 'occupied-after-commit.dshworld')
    const occupied = new WorldLogicalTransferService(source, table => {
      if (table === 'round_inbox') writeFileSync(occupiedTarget, 'occupied')
    })
    expect(() => occupied.exportAuthority(occupiedTarget, 'logical:post-commit'))
      .toThrow()
  })

  it('round-trips an empty genesis head and rejects corrupted genesis metadata', () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    setup.createBranch(fixtureAddress('empty-logical'))
    setup.close()
    const service = new WorldLogicalTransferService(source)
    const exportPath = join(root, 'empty.dshworld')
    service.exportAuthority(exportPath, 'logical:empty')
    service.importAuthority(exportPath, join(root, 'empty.sqlite'), 'logical:empty-import')
    const envelope = JSON.parse(readFileSync(exportPath, 'utf8')) as any
    const rejectHead = (name: string, mutate: (head: any) => void) => {
      const copy = structuredClone(envelope)
      mutate(copy.data.tables.heads[0])
      copy.bundleHash = hashWorldJson('logical-authority-export', copy.data)
      const path = join(root, `${name}.dshworld`)
      writeFileSync(path, JSON.stringify(copy))
      expect(() => service.importAuthority(path, join(root, `${name}.sqlite`), `logical:${name}`))
        .toThrow('Event chain tail')
    }
    rejectHead('empty-hash', head => { head.event_hash = 'sha256:not-genesis' })
    rejectHead('empty-tick', head => { head.tick = 1 })
  })

  it('upgrades version 4 and 5 authority exports without inventing newer authority', async () => {
    const root = directory()
    const source = join(root, 'legacy-source.sqlite')
    const address = fixtureAddress('legacy-v4')
    const setup = new WorldStore(source)
    setup.createBranch(address)
    const { authority: omittedAuthority, ...request } = fixtureCommitRequest(address)
    expect(omittedAuthority).toBeDefined()
    await setup.commitRound(request)
    setup.close()

    const service = new WorldLogicalTransferService(source)
    const currentPath = join(root, 'current.dshworld')
    service.exportAuthority(currentPath, 'logical:v4-source')
    const current = JSON.parse(readFileSync(currentPath, 'utf8')) as any
    const v5 = structuredClone(current)
    v5.format = 'dshworld-authority/v5'
    v5.data.authorityVersion = 5
    delete v5.data.tables.player_input_jobs
    delete v5.data.tables.world_reaction_cycles
    delete v5.data.tables.world_reaction_waves
    delete v5.data.tables.world_reaction_jobs
    delete v5.data.tables.world_reaction_job_stimuli
    v5.bundleHash = hashWorldJson('logical-authority-export', v5.data)
    const v5Path = join(root, 'legacy-v5.dshworld')
    writeFileSync(v5Path, JSON.stringify(v5))
    const v5Target = join(root, 'legacy-v5-target.sqlite')
    expect(service.importAuthority(v5Path, v5Target, 'logical:v5-import')).toBe(v5.bundleHash)
    const v5Imported = new WorldStore(v5Target)
    expect(v5Imported.committedRound(address, request.transactionId)).toMatchObject({ bundleHash: expect.any(String) })
    expect(v5Imported.activeReactionCycle(address)).toBeUndefined()
    v5Imported.close()

    const legacy = structuredClone(current)
    legacy.format = 'dshworld-authority/v4'
    legacy.data.authorityVersion = 4
    delete legacy.data.tables.player_input_jobs
    delete legacy.data.tables.round_authority
    for (const commit of legacy.data.tables.round_commits) delete commit.authority_hash
    legacy.bundleHash = hashWorldJson('logical-authority-export', legacy.data)
    const legacyPath = join(root, 'legacy.dshworld')
    writeFileSync(legacyPath, JSON.stringify(legacy))

    const target = join(root, 'legacy-target.sqlite')
    expect(service.importAuthority(legacyPath, target, 'logical:v4-import')).toBe(legacy.bundleHash)
    const imported = new WorldStore(target)
    expect(imported.committedRound(address, request.transactionId)).toMatchObject({ bundleHash: expect.any(String) })
    expect(imported.readRoundAuthority(address, request.transactionId)).toBeUndefined()
    imported.close()

    const missingCommits = structuredClone(legacy)
    delete missingCommits.data.tables.round_commits
    missingCommits.bundleHash = hashWorldJson('logical-authority-export', missingCommits.data)
    const missingPath = join(root, 'legacy-missing.dshworld')
    writeFileSync(missingPath, JSON.stringify(missingCommits))
    expect(() => service.importAuthority(missingPath, join(root, 'legacy-missing.sqlite'), 'logical:v4-missing'))
      .toThrow('round_commits is missing')

    const invalidRow = structuredClone(legacy)
    invalidRow.data.tables.round_commits = [1]
    invalidRow.bundleHash = hashWorldJson('logical-authority-export', invalidRow.data)
    const invalidPath = join(root, 'legacy-invalid.dshworld')
    writeFileSync(invalidPath, JSON.stringify(invalidRow))
    expect(() => service.importAuthority(invalidPath, join(root, 'legacy-invalid.sqlite'), 'logical:v4-invalid'))
      .toThrow('invalid row')
  })

  it('rejects malformed, unsupported, missing-table, invalid-row, and divergent Event exports', async () => {
    const root = directory()
    const source = join(root, 'source.sqlite')
    const setup = new WorldStore(source)
    const address = fixtureAddress()
    setup.createBranch(address)
    await setup.commitRound(fixtureCommitRequest(address))
    setup.forkBranch(address, fixtureAddress('logical-validation-child'), 1)
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

    const rejectTamper = (name: string, mutate: (copy: any) => void, expected: string) => {
      const copy = structuredClone(envelope)
      mutate(copy)
      copy.bundleHash = hashWorldJson('logical-authority-export', copy.data)
      const exportPath = join(root, `${name}.dshworld`)
      writeFileSync(exportPath, JSON.stringify(copy))
      expect(() => service.importAuthority(exportPath, join(root, `${name}.sqlite`), `logical:${name}`)).toThrow(expected)
    }
    rejectTamper('unknown-column', copy => { copy.data.tables.heads[0].extra = true }, 'missing or unknown columns')
    rejectTamper('renamed-column', copy => {
      copy.data.tables.heads[0].unexpected_tick = copy.data.tables.heads[0].tick
      delete copy.data.tables.heads[0].tick
    }, 'missing or unknown columns')
    rejectTamper('head', copy => { copy.data.tables.heads[0].head_seq = 0 }, 'Head does not match')
    rejectTamper('head-tail', copy => { copy.data.tables.heads[0].event_hash = 'sha256:wrong-tail' }, 'Event chain tail')
    rejectTamper('head-tail-tick', copy => { copy.data.tables.heads[0].tick += 1 }, 'Event chain tail')
    rejectTamper('round-bundle', copy => { copy.data.tables.round_commits[0].bundle_hash = 'sha256:wrong' }, 'Round bundle')
    rejectTamper('round-event-range', copy => { copy.data.tables.round_commits[0].head_seq += 1 }, 'Round event range')
    rejectTamper('round-outbox-boundary', copy => { copy.data.tables.outbox[0].world_seq += 1 }, 'Outbox boundary')
    rejectTamper('round-tick-boundary', copy => { copy.data.tables.round_commits[0].base_tick += 2 }, 'tick boundary')
    rejectTamper('outbox-state', copy => { copy.data.tables.outbox[0].delivery_status = 'delivered' }, 'normalized Outbox')
    rejectTamper('outbox-attempt', copy => { copy.data.tables.outbox[0].attempt_count = 1 }, 'normalized Outbox')
    rejectTamper('outbox-sequence', copy => { copy.data.tables.outbox[0].session_delivery_seq = 2 }, 'Outbox delivery sequencing')
    rejectTamper('outbox-counter', copy => {
      copy.data.tables.outbox[0].session_delivery_seq = 1
      copy.data.tables.outbox_session_counters = [{
        session_id: copy.data.tables.outbox[0].session_id,
        next_delivery_seq: 3,
      }]
    }, 'Outbox delivery sequencing')
    rejectTamper('outbox-error', copy => { copy.data.tables.outbox[0].last_error = 'tampered' }, 'normalized Outbox')
    rejectTamper('outbox-payload', copy => {
      copy.data.tables.outbox[0].payload_hash = 'sha256:wrong-payload'
      const commit = copy.data.tables.round_commits[0]
      commit.bundle_hash = hashWorldJson('world-round-bundle', {
        address: fixtureAddress(),
        roundId: commit.round_id,
        tick: commit.tick,
        eventHashes: copy.data.tables.events
          .filter((event: any) => event.transaction_id === commit.transaction_id)
          .map((event: any) => event.event_hash),
        outboxHashes: ['sha256:wrong-payload'],
        authorityHash: commit.authority_hash,
      })
    }, 'normalized Outbox')

    rejectTamper('fork-parent-world', copy => {
      copy.data.tables.branches[1].world_id = 'world:other'
    }, 'invalid Branch parent')
    rejectTamper('fork-anchor', copy => {
      copy.data.tables.branches[1].fork_seq = 999
    }, 'invalid Branch fork anchor')
    rejectTamper('fork-cycle', copy => {
      copy.data.tables.branches[1].parent_address_key = copy.data.tables.branches[1].address_key
    }, 'cyclic Branch lineage')

    rejectTamper('event-chain', copy => {
      const event = copy.data.tables.events[0]
      event.previous_hash = 'sha256:wrong-parent'
      event.event_hash = hashWorldJson('world-event-envelope', {
        address: fixtureAddress(),
        seq: event.seq,
        tick: event.tick,
        eventType: event.event_type,
        eventVersion: event.event_version,
        data: JSON.parse(event.data_json),
        previousHash: event.previous_hash,
        transactionId: event.transaction_id,
        eventOrdinal: event.event_ordinal,
      })
    }, 'discontinuous Event chain')
  })
})
