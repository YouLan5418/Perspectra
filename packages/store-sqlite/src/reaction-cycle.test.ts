import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  brandId,
  hashWorldJson,
  type CommitRoundRequest,
  type ReactionCycleDraft,
  type ReactionCycleId,
  type StoredReactionJob,
  type StoredReactionStimulus,
  type StoredReactionWave,
  type WorldAddress,
} from '@harness-world/contracts'
import {
  hashReactionJobState,
  hashReactionStimulusEntry,
  hashReactionWaveState,
  prepareInitialReactionCycle,
  type PrepareInitialReactionCycleInput,
} from './reaction-cycle.ts'
import { WorldStore } from './world-store.ts'

const directories: string[] = []
const supplementary = brandId('character:\u{10000}', 'CharacterId')
const privateUse = brandId('character:\uE000', 'CharacterId')

function fixture(): { readonly path: string; readonly address: WorldAddress } {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-reaction-'))
  directories.push(directory)
  return {
    path: join(directory, 'world.sqlite'),
    address: {
      tenantId: brandId('tenant:reaction', 'TenantId'),
      worldId: brandId('world:reaction', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    },
  }
}

function reactionDraft(overrides: Partial<ReactionCycleDraft> = {}): ReactionCycleDraft {
  return {
    policyVersion: 'reaction-policy/v1',
    profileId: 'responsive/v1',
    maxWaves: 3,
    maxNpcCalls: 1,
    maxCallsPerCharacter: 2,
    maxActionsPerCall: 1,
    allowedActionTypes: ['speak@1'],
    initialTokenBudget: 4,
    deadlineAtMs: 10_000,
    candidates: [
      {
        characterId: privateUse,
        estimatedTokens: 2,
        stimuli: [{ sourceEventOrdinal: 1, observationOrdinal: 0, observationId: 'observation:private', observerCharacterId: privateUse }],
      },
      {
        characterId: supplementary,
        estimatedTokens: 2,
        stimuli: [{ sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'observation:supplementary', observerCharacterId: supplementary }],
      },
    ],
    ...overrides,
  }
}

function request(address: WorldAddress, reactionCycle = reactionDraft()): CommitRoundRequest {
  return {
    address,
    transactionId: brandId('transaction:reaction-root', 'TransactionId'),
    roundId: brandId('round:reaction-root', 'InteractionRoundId'),
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events: [
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:supplementary', value: { observerId: supplementary, content: 'first' } },
      },
      {
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:private', value: { observerId: privateUse, content: 'second' } },
      },
    ],
    outbox: [],
    reactionCycle,
    correlationId: 'reaction:root',
  }
}

function prepareInput(overrides: Partial<PrepareInitialReactionCycleInput> = {}): PrepareInitialReactionCycleInput {
  const address = fixture().address
  const events = request(address).events.map((draft, eventOrdinal) => ({
    draft,
    eventOrdinal,
    seq: eventOrdinal + 1,
    eventHash: hashWorldJson('reaction-test-event', eventOrdinal),
  }))
  return {
    address,
    rootRoundId: brandId('round:prepare', 'InteractionRoundId'),
    rootTransactionId: brandId('transaction:prepare', 'TransactionId'),
    finalHeadSeq: 2,
    finalHeadHash: events[1]!.eventHash,
    draft: reactionDraft(),
    events,
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorldStore Reaction Cycle authority', () => {
  it('atomically freezes, replays, restarts, and verifies one UTF-16 ordered initial wave', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const root = request(address)
    const committed = await store.commitRound(root)
    const bundle = store.activeReactionCycle(address)!
    expect(bundle).toMatchObject({
      cycle: {
        rootRoundId: root.roundId,
        rootTransactionId: root.transactionId,
        createdAtSeq: 2,
        status: 'active',
      },
      waves: [{ wave: 1, baseHeadSeq: 2, status: 'frozen', reservedCalls: 1, reservedTokens: 2 }],
    })
    expect(bundle.jobs.map(job => [job.characterId, job.status, job.budgetDecision, job.budgetOrdinal])).toEqual([
      [supplementary, 'pending', 'reserved', 0],
      [privateUse, 'skipped', 'call_limit', null],
    ])
    expect(bundle.stimuli.map(value => [value.observerCharacterId, value.sourceEventSeq, value.stimulusOrdinal]))
      .toEqual([[supplementary, 1, 0], [privateUse, 2, 0]])
    expect(store.readReactionCycle(address, bundle.cycle.cycleId)).toEqual(bundle)
    expect(store.readReactionCycle(address, brandId('reaction-cycle:missing', 'ReactionCycleId'))).toBeUndefined()
    expect(store.committedRound(address, root.transactionId)).toMatchObject({ bundleHash: committed.bundleHash })
    await expect(store.commitRound(root)).resolves.toEqual({ ...committed, status: 'already_committed' })
    store.close()

    const reopened = new WorldStore(path)
    expect(reopened.activeReactionCycle(address)).toEqual(bundle)
    expect(reopened.committedRound(address, root.transactionId)).toMatchObject({ bundleHash: committed.bundleHash })
    reopened.close()
  })

  it('restores multiple stimuli for one Job in durable ordinal order', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const base = request(address, reactionDraft({
      candidates: [{
        characterId: supplementary,
        estimatedTokens: 2,
        stimuli: [
          { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'observation:supplementary', observerCharacterId: supplementary },
          { sourceEventOrdinal: 1, observationOrdinal: 0, observationId: 'observation:supplementary:second', observerCharacterId: supplementary },
        ],
      }],
    }))
    const second = base.events[1]!
    const root: CommitRoundRequest = { ...base, events: [
      base.events[0]!,
      { ...second, data: { id: 'observation:supplementary:second', value: { observerId: supplementary, content: 'second' } } },
    ] }
    await store.commitRound(root)
    expect(store.activeReactionCycle(address)?.stimuli.map(value => value.observationId)).toEqual([
      'observation:supplementary',
      'observation:supplementary:second',
    ])
    store.close()
  })

  it('rolls back the complete Root Round when a Reaction stimulus is not authorized by its source Event', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const invalid = reactionDraft({
      candidates: [{
        characterId: supplementary,
        estimatedTokens: 1,
        stimuli: [{ sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'observation:forged', observerCharacterId: supplementary }],
      }],
    })
    await expect(store.commitRound(request(address, invalid))).rejects.toThrow('identity or observer')
    expect(store.head(address)).toEqual({ headSeq: 0, tick: 0, eventHash: 'genesis' })
    expect(store.activeReactionCycle(address)).toBeUndefined()
    store.close()
  })

  it('fails closed when a durable Reaction state Hash is altered', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    await store.commitRound(request(address))
    const cycleId = store.activeReactionCycle(address)!.cycle.cycleId
    store.close()
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE world_reaction_cycles SET state_hash = ? WHERE cycle_id = ?`)
      .run('sha256:0000000000000000000000000000000000000000000000000000000000000000', cycleId)
    raw.close()
    const corrupted = new WorldStore(path)
    expect(() => corrupted.readReactionCycle(address, cycleId as ReactionCycleId)).toThrow('hash is divergent')
    corrupted.close()
  })

  it('rejects every malformed policy, budget candidate, and stimulus before persistence', () => {
    const base = prepareInput()
    const first = base.draft.candidates[0]!
    const stimulus = first.stimuli[0]!
    const invalidDrafts: ReactionCycleDraft[] = [
      { ...base.draft, policyVersion: 'bad' as 'reaction-policy/v1' },
      { ...base.draft, profileId: 'bad' as 'responsive/v1' },
      { ...base.draft, maxWaves: 0 },
      { ...base.draft, maxNpcCalls: 9 },
      { ...base.draft, maxCallsPerCharacter: 0 },
      { ...base.draft, maxActionsPerCall: 2 as 1 },
      { ...base.draft, allowedActionTypes: [] as unknown as readonly ['speak@1'] },
      { ...base.draft, allowedActionTypes: ['bad'] as unknown as readonly ['speak@1'] },
      { ...base.draft, initialTokenBudget: -1 },
      { ...base.draft, deadlineAtMs: -1 },
      { ...base.draft, candidates: [] },
      { ...base.draft, candidates: [first, { ...first }] },
      { ...base.draft, candidates: [{ ...first, estimatedTokens: 0 }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [] }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [{ ...stimulus, sourceEventOrdinal: -1 }] }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [{ ...stimulus, observationOrdinal: -1 }] }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [{ ...stimulus, observationOrdinal: 1 }] }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [stimulus, stimulus] }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [{ ...stimulus, observerCharacterId: supplementary }] }] },
      { ...base.draft, candidates: [{ ...first, stimuli: [{ ...stimulus, sourceEventOrdinal: 99 }] }] },
    ]
    for (const draft of invalidDrafts) expect(() => prepareInitialReactionCycle({ ...base, draft })).toThrow()
    expect(() => prepareInitialReactionCycle({ ...base, finalHeadSeq: 0 })).toThrow()
    expect(() => prepareInitialReactionCycle({ ...base, events: [] })).toThrow()
    expect(() => prepareInitialReactionCycle({ ...base, finalHeadSeq: 3 })).toThrow()
    expect(() => prepareInitialReactionCycle({
      ...base,
      events: base.events.map((event, index) => index === 1 ? { ...event, eventOrdinal: 9 } : event),
    })).toThrow('Root Round')
    expect(() => prepareInitialReactionCycle({
      ...base,
      events: base.events.map((event, index) => index === 1
        ? { ...event, draft: { ...event.draft, eventType: 'fixture.event' } }
        : event),
    })).toThrow('Root Round')
    expect(() => prepareInitialReactionCycle({
      ...base,
      events: base.events.map((event, index) => index === 1
        ? { ...event, draft: { ...event.draft, data: null } }
        : event),
    })).toThrow('must be an object')
    expect(() => prepareInitialReactionCycle({
      ...base,
      events: base.events.map((event, index) => index === 1
        ? { ...event, draft: { ...event.draft, data: { id: 'observation:private', value: [] } } }
        : event),
    })).toThrow('must be an object')
    expect(() => prepareInitialReactionCycle({
      ...base,
      events: base.events.map((event, index) => index === 1
        ? { ...event, draft: { ...event.draft, data: { id: 'observation:private', value: { observerId: supplementary } } } }
        : event),
    })).toThrow('identity or observer')
  })

  it('reads every nullable terminal shape and rejects divergent durable rows', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    const root = request(address)
    await store.commitRound(root)
    const initial = store.activeReactionCycle(address)!
    store.close()
    const pending = initial.jobs.find(job => job.status === 'pending')!
    const claimed: StoredReactionJob = {
      ...pending,
      status: 'settled',
      claimOwnerId: 'worker:reaction',
      claimExpiresAtMs: 20_000,
      claimFencingToken: 1,
      attemptCount: 1,
      contextReceiptId: 'context-receipt:reaction',
      contextReceiptHash: hashWorldJson('context-receipt:test', 'reaction'),
      providerCallId: 'provider-call:reaction',
      providerRequestHash: hashWorldJson('provider-request:test', 'reaction'),
      proposalHash: hashWorldJson('proposal:test', 'reaction'),
      resultTransactionId: root.transactionId,
      outcome: 'proposed',
    }
    const claimedStateHash = hashReactionJobState(claimed)
    const frozen = initial.waves[0]!
    const committedWave: StoredReactionWave = {
      ...frozen,
      status: 'committed',
      reactionRoundId: root.roundId,
      resultTransactionId: root.transactionId,
      authorityHash: hashWorldJson('authority:test', 'reaction'),
    }
    const waveStateHash = hashReactionWaveState(committedWave)
    const raw = new DatabaseSync(path)
    raw.prepare(`
      UPDATE world_reaction_jobs SET status = 'settled', claim_owner_id = ?, claim_expires_at_ms = ?,
        claim_fencing_token = ?, attempt_count = ?, context_receipt_id = ?, context_receipt_hash = ?,
        provider_call_id = ?, provider_request_hash = ?, proposal_hash = ?, result_transaction_id = ?,
        outcome = ?, state_hash = ? WHERE job_id = ?
    `).run(
      claimed.claimOwnerId, claimed.claimExpiresAtMs, claimed.claimFencingToken, claimed.attemptCount,
      claimed.contextReceiptId, claimed.contextReceiptHash, claimed.providerCallId, claimed.providerRequestHash,
      claimed.proposalHash, claimed.resultTransactionId, claimed.outcome, claimedStateHash, claimed.jobId,
    )
    raw.prepare(`
      UPDATE world_reaction_waves SET status = 'committed', reaction_round_id = ?, result_transaction_id = ?,
        authority_hash = ?, state_hash = ? WHERE cycle_id = ? AND wave = 1
    `).run(committedWave.reactionRoundId, committedWave.resultTransactionId, committedWave.authorityHash, waveStateHash, initial.cycle.cycleId)
    raw.close()
    const updated = new WorldStore(path)
    const updatedBundle = updated.readReactionCycle(address, initial.cycle.cycleId)!
    expect(updatedBundle.waves[0]).toMatchObject({ status: 'committed', authorityHash: committedWave.authorityHash })
    expect(updatedBundle.jobs.find(job => job.jobId === claimed.jobId))
      .toMatchObject({ status: 'settled', providerCallId: claimed.providerCallId, outcome: 'proposed' })
    updated.close()

    const terminalRaw = new DatabaseSync(path)
    const terminalCycle = {
      ...initial.cycle,
      status: 'terminal' as const,
      terminalReason: 'provider_terminal' as const,
      terminalAtSeq: initial.cycle.createdAtSeq,
    }
    terminalRaw.prepare(`UPDATE world_reaction_cycles SET status = 'terminal', terminal_reason = ?, terminal_at_seq = ?, state_hash = ? WHERE cycle_id = ?`)
      .run(terminalCycle.terminalReason, terminalCycle.terminalAtSeq, hashWorldJson('reaction-cycle-state/v1', {
        cycleId: terminalCycle.cycleId,
        cycleHash: terminalCycle.cycleHash,
        status: terminalCycle.status,
        stopReason: terminalCycle.stopReason,
        terminalReason: terminalCycle.terminalReason,
        terminalAtSeq: terminalCycle.terminalAtSeq,
      }), terminalCycle.cycleId)
    terminalRaw.close()
    const terminal = new WorldStore(path)
    expect(terminal.activeReactionCycle(address)).toBeUndefined()
    expect(terminal.readReactionCycle(address, initial.cycle.cycleId)).toMatchObject({ cycle: { status: 'terminal' } })
    terminal.close()
  })

  it.each([
    ['noncanonical-policy-json', `UPDATE world_reaction_cycles SET allowed_action_types_json = '[ "speak@1" ]'`],
    ['malformed-policy', `UPDATE world_reaction_cycles SET profile_id = 'wrong'`],
    ['wave-sequence', `UPDATE world_reaction_waves SET wave = 2`],
    ['malformed-plan', `UPDATE world_reaction_waves SET budget_plan_json = '{}'`],
    ['divergent-plan', `UPDATE world_reaction_waves SET budget_plan_hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'`],
    ['invalid-base-hash', `UPDATE world_reaction_waves SET base_head_hash = 'bad'`],
    ['wave-hash', `UPDATE world_reaction_waves SET state_hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'`],
    ['missing-wave', `DELETE FROM world_reaction_waves`],
    ['job-hash', `UPDATE world_reaction_jobs SET state_hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE status = 'pending'`],
    ['stimulus-entry', `UPDATE world_reaction_job_stimuli SET stimulus_entry_hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE source_event_seq = 1`],
    ['stimulus-source', `UPDATE events SET event_type = 'fixture.event' WHERE seq = 1`],
    ['missing-stimulus-source', `DELETE FROM events WHERE seq = 1`],
    ['missing-stimulus', `DELETE FROM world_reaction_job_stimuli WHERE source_event_seq = 1`],
    ['budget-job-count', `DELETE FROM world_reaction_jobs WHERE status = 'skipped'`],
  ])('rejects %s corruption', async (_name, sql) => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    await store.commitRound(request(address))
    const cycleId = store.activeReactionCycle(address)!.cycle.cycleId
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec(sql)
    raw.close()
    const corrupted = new WorldStore(path)
    expect(() => corrupted.readReactionCycle(address, cycleId)).toThrow()
    corrupted.close()
  })

  it('rejects a renumbered stimulus and a Job that diverges from its frozen budget decision', async () => {
    for (const mode of ['stimulus-ordinal', 'budget-decision'] as const) {
      const { path, address } = fixture()
      const store = new WorldStore(path)
      store.createBranch(address)
      await store.commitRound(request(address))
      const bundle = store.activeReactionCycle(address)!
      store.close()
      const raw = new DatabaseSync(path)
      if (mode === 'stimulus-ordinal') {
        const source = bundle.stimuli[0]!
        const changed: StoredReactionStimulus = { ...source, stimulusOrdinal: 1 }
        raw.prepare(`UPDATE world_reaction_job_stimuli SET stimulus_ordinal = 1, stimulus_entry_hash = ? WHERE job_id = ?`)
          .run(hashReactionStimulusEntry(changed), changed.jobId)
      } else {
        const source = bundle.jobs[0]!
        const changed: StoredReactionJob = { ...source, budgetOrdinal: 1 }
        const changedJobHash = hashWorldJson('reaction-job/v1', {
          jobId: changed.jobId, address: changed.address, cycleId: changed.cycleId, wave: changed.wave,
          characterId: changed.characterId, stimulusHash: changed.stimulusHash,
          budgetDecision: changed.budgetDecision, budgetOrdinal: changed.budgetOrdinal, reservedTokens: changed.reservedTokens,
        })
        const changedWithHash = { ...changed, jobHash: changedJobHash }
        raw.prepare(`UPDATE world_reaction_jobs SET budget_ordinal = 1, job_hash = ?, state_hash = ? WHERE job_id = ?`)
          .run(
            changedJobHash,
            hashReactionJobState(changedWithHash),
            changed.jobId,
          )
      }
      raw.close()
      const corrupted = new WorldStore(path)
      expect(() => corrupted.readReactionCycle(address, bundle.cycle.cycleId)).toThrow()
      corrupted.close()
    }
  })
})
