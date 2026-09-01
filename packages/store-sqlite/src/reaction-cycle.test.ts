import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ThrowingFaultInjector } from '@harness-world/testkit'
import {
  brandId,
  hashWorldJson,
  type CommitRoundRequest,
  type ReactionCycleDraft,
  type ReactionCycleId,
  type ReactionWaveSettlementDraft,
  type StoredReactionJob,
  type StoredReactionStimulus,
  type StoredReactionWave,
  type WorldAddress,
  type WorldEventDraft,
} from '@harness-world/contracts'
import {
  hashReactionJobState,
  hashReactionCycleState,
  hashReactionStimulusEntry,
  hashReactionWaveState,
  normalizeReactionWaveSettlement,
  prepareReactionWaveSettlement,
  readReactionWaveSettlementHashByTransaction,
  prepareInitialReactionCycle,
  type PrepareInitialReactionCycleInput,
} from './reaction-cycle.ts'
import { RoundInbox } from './round-inbox.ts'
import { WorldStore } from './world-store.ts'
import { WriterLeaseService } from './writer-lease.ts'

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

async function settlementFixture(bindProvider = true) {
  const { path, address } = fixture()
  const clock = { value: 10 }
  const store = new WorldStore(path, undefined, () => clock.value)
  store.createBranch(address)
  const leases = new WriterLeaseService(path, () => clock.value)
  const writer = leases.acquire(address, 'reaction-worker:settlement-fixture', 1_000)
  await store.commitRound({ ...request(address), writerFencingToken: writer.fencingToken })
  const cycle = store.activeReactionCycle(address)!.cycle
  const claimed = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 500)!
  const job = bindProvider
    ? store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
        contextReceiptId: 'context-receipt:settlement-fixture',
        contextReceiptHash: hashWorldJson('context-receipt:test', 'settlement-fixture'),
        providerCallId: 'provider-call:settlement-fixture',
        providerRequestHash: hashWorldJson('provider-request:test', 'settlement-fixture'),
      },
    )
    : claimed
  const settlement = {
    cycleId: cycle.cycleId,
    wave: 1,
    terminalReason: 'quiescent' as const,
    jobs: [{
      jobId: job.jobId,
      claimOwnerId: job.claimOwnerId,
      claimFencingToken: job.claimFencingToken,
      expectedStateHash: job.stateHash,
      outcome: 'proposed' as const,
      proposalHash: hashWorldJson('reaction-proposal:test', 'settlement-fixture'),
    }],
  }
  return { path, address, clock, store, leases, writer, cycle, job, settlement }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('WorldStore Reaction Cycle authority', () => {
  it('normalizes and rejects malformed Reaction settlement contracts', () => {
    const first = {
      jobId: brandId('reaction-job:z', 'ReactionJobId'),
      claimOwnerId: 'reaction-worker:normalize',
      claimFencingToken: 1,
      expectedStateHash: hashWorldJson('reaction-state:test', 'z'),
      outcome: 'proposed' as const,
      proposalHash: hashWorldJson('reaction-proposal:test', 'z'),
    }
    const second = {
      ...first,
      jobId: brandId('reaction-job:a', 'ReactionJobId'),
      expectedStateHash: hashWorldJson('reaction-state:test', 'a'),
      outcome: 'runtime_unavailable' as const,
      proposalHash: null,
    }
    const draft = {
      cycleId: brandId('reaction-cycle:normalize', 'ReactionCycleId'),
      wave: 1,
      terminalReason: 'quiescent' as const,
      jobs: [first, second],
    }
    expect(normalizeReactionWaveSettlement(draft).jobs.map(job => job.jobId)).toEqual([
      second.jobId, first.jobId,
    ])
    expect(() => normalizeReactionWaveSettlement({ ...draft, wave: 0 })).toThrow(RangeError)
    expect(() => normalizeReactionWaveSettlement({ ...draft, terminalReason: 'invalid' as never })).toThrow('terminal reason')
    expect(() => normalizeReactionWaveSettlement({ ...draft, jobs: [first, first] })).toThrow('must be unique')
    expect(() => normalizeReactionWaveSettlement({ ...draft, jobs: [{ ...first, claimOwnerId: '' }] })).toThrow(TypeError)
    expect(() => normalizeReactionWaveSettlement({ ...draft, jobs: [{ ...first, claimFencingToken: 0 }] })).toThrow(RangeError)
    expect(() => normalizeReactionWaveSettlement({ ...draft, jobs: [{ ...first, expectedStateHash: 'bad' as never }] }))
      .toThrow('expectedStateHash')
    expect(() => normalizeReactionWaveSettlement({ ...draft, jobs: [{ ...first, proposalHash: 'bad' as never }] }))
      .toThrow('proposalHash')
    expect(() => normalizeReactionWaveSettlement({ ...draft, jobs: [{ ...first, proposalHash: null }] }))
      .toThrow('does not match')
    expect(() => normalizeReactionWaveSettlement({
      ...draft,
      jobs: [{ ...first, outcome: 'abstained', proposalHash: first.proposalHash }],
    })).toThrow('does not match')
    expect(normalizeReactionWaveSettlement({
      ...draft,
      jobs: [{ ...first, outcome: 'rejected' }],
    }).jobs[0]?.outcome).toBe('rejected')
    const candidate = { characterId: privateUse, estimatedTokens: 1, stimuli: [] }
    expect(normalizeReactionWaveSettlement({
      ...draft,
      terminalReason: null,
      nextWaveCandidates: [candidate, { ...candidate, characterId: supplementary }],
    }).nextWaveCandidates?.map(value => value.characterId)).toEqual([supplementary, privateUse])
    expect(() => normalizeReactionWaveSettlement({
      ...draft, nextWaveCandidates: [candidate, candidate],
    })).toThrow('duplicate next-Wave candidate')
    expect(() => normalizeReactionWaveSettlement({
      ...draft, nextWaveCandidates: [{ ...candidate, characterId: '' as never }],
    })).toThrow(TypeError)
    expect(() => normalizeReactionWaveSettlement({
      ...draft, nextWaveCandidates: [{ ...candidate, estimatedTokens: 0 }],
    })).toThrow(RangeError)
  })

  it('rejects incomplete, stale, unbound, and authority-free Reaction settlements before mutation', async () => {
    const value = await settlementFixture()
    const authority = { schemaVersion: 1, origin: 'reaction', cycleId: value.cycle.cycleId, wave: 1 } as const
    const round = (suffix: string, settlement: ReactionWaveSettlementDraft, includeAuthority = true): CommitRoundRequest => ({
      address: value.address,
      transactionId: brandId(`transaction:settlement-guard:${suffix}`, 'TransactionId'),
      roundId: brandId(`round:settlement-guard:${suffix}`, 'InteractionRoundId'),
      expectedHeadSeq: 2,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: { suffix } }],
      outbox: [],
      ...(includeAuthority ? { authority } : {}),
      reactionSettlement: settlement,
      writerFencingToken: value.writer.fencingToken,
      correlationId: `settlement-guard:${suffix}`,
    })
    await expect(value.store.commitRound(round('missing-authority', value.settlement, false)))
      .rejects.toThrow('requires Round Authority')
    await expect(value.store.commitRound(round('missing-cycle', {
      ...value.settlement,
      cycleId: brandId('reaction-cycle:missing', 'ReactionCycleId'),
    }))).rejects.toThrow('absent or terminal')
    await expect(value.store.commitRound(round('missing-wave', {
      ...value.settlement,
      wave: 2,
    }))).rejects.toThrow('current frozen wave')
    await expect(value.store.commitRound(round('invented-stop', {
      ...value.settlement,
      terminalReason: 'user_cancelled',
    }))).rejects.toThrow('cannot invent')
    await expect(value.store.commitRound(round('incomplete', {
      ...value.settlement,
      jobs: [],
    }))).rejects.toThrow('every reserved Job')
    await expect(value.store.commitRound(round('stale', {
      ...value.settlement,
      jobs: [{ ...value.settlement.jobs[0]!, expectedStateHash: hashWorldJson('reaction-state:test', 'stale') }],
    }))).rejects.toThrow('stale, expired, or divergent')
    const raw = new DatabaseSync(value.path)
    expect(() => prepareReactionWaveSettlement(
      raw,
      value.address,
      value.settlement,
      brandId('round:settlement-guard:base', 'InteractionRoundId'),
      brandId('transaction:settlement-guard:base', 'TransactionId'),
      hashWorldJson('world-round-authority', authority),
      2,
      hashWorldJson('reaction-head:test', 'divergent'),
      3,
      hashWorldJson('reaction-head:test', 'final'),
      [],
      value.clock.value,
    )).toThrow('base Head is divergent')
    raw.close()
    value.clock.value = 511
    await expect(value.store.commitRound(round('expired', value.settlement))).rejects.toThrow('stale, expired, or divergent')
    expect(value.store.head(value.address)).toMatchObject({ headSeq: 2, tick: 1 })
    value.store.close()
    value.leases.close()

    const unbound = await settlementFixture(false)
    await expect(unbound.store.commitRound({
      ...round('unbound', {
        ...unbound.settlement,
        cycleId: unbound.cycle.cycleId,
        jobs: [{
          ...unbound.settlement.jobs[0]!,
          jobId: unbound.job.jobId,
          claimOwnerId: unbound.job.claimOwnerId,
          claimFencingToken: unbound.job.claimFencingToken,
          expectedStateHash: unbound.job.stateHash,
        }],
      }),
      address: unbound.address,
      writerFencingToken: unbound.writer.fencingToken,
      authority: { ...authority, cycleId: unbound.cycle.cycleId },
    })).rejects.toThrow('requires a bound ProviderCall')
    const runtimeUnavailable = {
      ...unbound.settlement,
      jobs: [{
        ...unbound.settlement.jobs[0]!,
        outcome: 'runtime_unavailable' as const,
        proposalHash: null,
      }],
    }
    await expect(unbound.store.commitRound({
      ...round('runtime-unavailable', runtimeUnavailable),
      address: unbound.address,
      writerFencingToken: unbound.writer.fencingToken,
      authority: { ...authority, cycleId: unbound.cycle.cycleId },
      reactionSettlement: runtimeUnavailable,
    })).resolves.toMatchObject({ status: 'committed' })
    unbound.store.close()
    unbound.leases.close()
  })

  it.each([
    ['empty stimuli', [], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'at least one'],
    ['duplicate coordinates', [
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'duplicate stimulus'],
    ['negative coordinate', [
      { sourceEventOrdinal: -1, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'sourceEventOrdinal'],
    ['observer mismatch', [
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'next', observerCharacterId: supplementary },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'observer does not match'],
    ['nonzero observation ordinal', [
      { sourceEventOrdinal: 0, observationOrdinal: 1, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'exactly one'],
    ['missing source Event', [
      { sourceEventOrdinal: 1, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'must reference'],
    ['wrong source Event type', [
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'fixture.reaction', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'must reference'],
    ['malformed source data', [
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: [] }], 'data must be an object'],
    ['malformed Observation value', [
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'next', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: [] } }], 'value must be an object'],
    ['source identity mismatch', [
      { sourceEventOrdinal: 0, observationOrdinal: 0, observationId: 'other', observerCharacterId: privateUse },
    ], [{ eventType: 'observation.upsert', eventVersion: 1, data: { id: 'next', value: { observerId: privateUse } } }], 'identity or observer diverges'],
  ] as const)('rejects a next-Wave candidate with %s', async (_label, stimuli, events, expected) => {
    const value = await settlementFixture()
    const head = value.store.head(value.address)
    await expect(value.store.commitRound({
      address: value.address,
      transactionId: brandId(`transaction:continuation-invalid:${_label}`, 'TransactionId'),
      roundId: brandId(`round:continuation-invalid:${_label}`, 'InteractionRoundId'),
      expectedHeadSeq: head.headSeq,
      expectedTick: head.tick,
      nextTick: head.tick + 1,
      events: events as never,
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: value.cycle.cycleId, wave: 1 },
      reactionSettlement: {
        ...value.settlement,
        terminalReason: null,
        nextWaveCandidates: [{ characterId: privateUse, estimatedTokens: 1, stimuli }],
      },
      writerFencingToken: value.writer.fencingToken,
      correlationId: `continuation-invalid:${_label}`,
    })).rejects.toThrow(expected)
    value.store.close()
    value.leases.close()
  })

  it('preserves player preemption as the terminal reason when the frozen Wave settles', async () => {
    const value = await settlementFixture()
    const inbox = new RoundInbox(value.path)
    inbox.enqueue({
      address: value.address,
      idempotencyKey: 'player:settlement-preempt',
      principalId: 'principal:player',
      input: { type: 'speak', text: '插话' },
      correlationId: 'player:settlement-preempt',
    }, 1)
    const base = {
      address: value.address,
      transactionId: brandId('transaction:settlement-preempt', 'TransactionId'),
      roundId: brandId('round:settlement-preempt', 'InteractionRoundId'),
      expectedHeadSeq: 2,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: { preempted: true } }],
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: value.cycle.cycleId, wave: 1 },
      writerFencingToken: value.writer.fencingToken,
      correlationId: 'settlement-preempt',
    } as const
    await expect(value.store.commitRound({
      ...base,
      reactionSettlement: value.settlement,
    })).rejects.toThrow('preserve the durable stop reason')
    const preempted = { ...value.settlement, terminalReason: 'player_preempted' as const }
    await expect(value.store.commitRound({ ...base, reactionSettlement: preempted }))
      .resolves.toMatchObject({ status: 'committed' })
    expect(value.store.readReactionCycle(value.address, value.cycle.cycleId)?.cycle)
      .toMatchObject({ status: 'terminal', stopReason: 'player_preempted', terminalReason: 'player_preempted' })
    inbox.close()
    value.store.close()
    value.leases.close()
  })

  it.each([
    ['world_reaction_jobs', 'Job'],
    ['world_reaction_waves', 'Wave'],
    ['world_reaction_cycles', 'Cycle'],
  ] as const)('rolls back the whole Reaction Round when the %s settlement CAS is lost', async (table, label) => {
    const value = await settlementFixture()
    const blocker = new DatabaseSync(value.path)
    blocker.exec(`
      CREATE TRIGGER block_reaction_settlement
      BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(IGNORE); END;
    `)
    blocker.close()
    await expect(value.store.commitRound({
      address: value.address,
      transactionId: brandId(`transaction:settlement-cas:${label}`, 'TransactionId'),
      roundId: brandId(`round:settlement-cas:${label}`, 'InteractionRoundId'),
      expectedHeadSeq: 2,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: { label } }],
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: value.cycle.cycleId, wave: 1 },
      reactionSettlement: value.settlement,
      writerFencingToken: value.writer.fencingToken,
      correlationId: `settlement-cas:${label}`,
    })).rejects.toThrow(`settlement ${label} changed concurrently`)
    expect(value.store.head(value.address)).toMatchObject({ headSeq: 2, tick: 1 })
    const unblock = new DatabaseSync(value.path)
    unblock.exec(`DROP TRIGGER block_reaction_settlement`)
    unblock.close()
    expect(value.store.activeReactionCycle(value.address)?.cycle.status).toBe('active')
    value.store.close()
    value.leases.close()
  })

  it('atomically commits one NPC-only Round and settles its Wave, Jobs, and Cycle', async () => {
    const { path, address } = fixture()
    let now = 10
    const store = new WorldStore(path, undefined, () => now)
    store.createBranch(address)
    const leases = new WriterLeaseService(path, () => now)
    const writer = leases.acquire(address, 'reaction-worker:settle', 1_000)
    const root = request(address, reactionDraft({ maxNpcCalls: 2 }))
    await expect(store.commitRound({
      ...root,
      reactionSettlement: {
        cycleId: brandId('reaction-cycle:mutually-exclusive', 'ReactionCycleId'),
        wave: 1,
        terminalReason: 'quiescent',
        jobs: [],
      },
    })).rejects.toThrow('cannot create and settle')
    await store.commitRound({ ...root, writerFencingToken: writer.fencingToken })
    const initial = store.activeReactionCycle(address)!
    const claims = [
      store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 500)!,
      store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 500)!,
    ]
    const bound = claims.map((claimed, index) => store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
        contextReceiptId: `context-receipt:reaction:settle:${index}`,
        contextReceiptHash: hashWorldJson('context-receipt:test', `reaction:settle:${index}`),
        providerCallId: `provider-call:reaction:settle:${index}`,
        providerRequestHash: hashWorldJson('provider-request:test', `reaction:settle:${index}`),
      },
    ))
    const proposalHashes = bound.map((_, index) => hashWorldJson('reaction-proposal:test', { index }))
    const reactionRequest: CommitRoundRequest = {
      address,
      transactionId: brandId('transaction:reaction:settle', 'TransactionId'),
      roundId: brandId('round:reaction:settle', 'InteractionRoundId'),
      expectedHeadSeq: 2,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: { text: '回应' } }],
      outbox: [],
      authority: {
        schemaVersion: 1,
        origin: 'reaction',
        cycleId: initial.cycle.cycleId,
        wave: 1,
      },
      reactionSettlement: {
        cycleId: initial.cycle.cycleId,
        wave: 1,
        terminalReason: 'quiescent',
        jobs: bound.map((job, index) => ({
          jobId: job.jobId,
          claimOwnerId: job.claimOwnerId,
          claimFencingToken: job.claimFencingToken,
          expectedStateHash: job.stateHash,
          outcome: 'proposed' as const,
          proposalHash: proposalHashes[index]!,
        })).reverse(),
      },
      writerFencingToken: writer.fencingToken,
      correlationId: 'reaction:settle',
    }
    const committed = await store.commitRound(reactionRequest)
    expect(committed).toMatchObject({ status: 'committed', headSeq: 3, tick: 2 })
    expect(store.activeReactionCycle(address)).toBeUndefined()
    const settled = store.readReactionCycle(address, initial.cycle.cycleId)!
    expect(settled.cycle).toMatchObject({
      status: 'terminal', terminalReason: 'quiescent', terminalAtSeq: 3,
    })
    expect(settled.waves[0]).toMatchObject({
      status: 'committed', reactionRoundId: reactionRequest.roundId,
      resultTransactionId: reactionRequest.transactionId,
    })
    expect(settled.jobs.filter(job => job.status === 'settled')).toHaveLength(2)
    expect(settled.jobs.filter(job => job.status === 'settled').map(job => job.proposalHash).sort())
      .toEqual([...proposalHashes].sort())
    expect(store.reactionCycleView(address, initial.cycle.cycleId)).toMatchObject({
      status: 'terminal',
      usedCalls: 2,
      usedTokens: 4,
      lastCommittedWave: 1,
      lastReactionRoundId: reactionRequest.roundId,
      lastResultTransactionId: reactionRequest.transactionId,
      lastAuthorityHash: expect.stringMatching(/^sha256:/u),
    })
    expect(store.cancelReactionCycle(address, initial.cycle.cycleId)).toMatchObject({ status: 'terminal' })
    expect(store.committedRound(address, reactionRequest.transactionId)).toMatchObject({
      roundId: reactionRequest.roundId, bundleHash: committed.bundleHash,
    })
    const authorityHash = store.readRoundAuthority(address, reactionRequest.transactionId)!.authorityHash
    const raw = new DatabaseSync(path)
    expect(readReactionWaveSettlementHashByTransaction(
      raw, address, reactionRequest.transactionId, authorityHash, 3,
    )).toMatch(/^sha256:/u)
    expect(() => readReactionWaveSettlementHashByTransaction(
      raw, address, reactionRequest.transactionId, authorityHash, 999,
    )).toThrow('continuation binding is absent')
    expect(() => readReactionWaveSettlementHashByTransaction(
      raw, address, reactionRequest.transactionId, null, 3,
    )).toThrow('settlement binding is divergent')
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.prepare(`DELETE FROM world_reaction_cycles WHERE cycle_id = ?`).run(initial.cycle.cycleId)
    expect(() => readReactionWaveSettlementHashByTransaction(
      raw, address, reactionRequest.transactionId, authorityHash, 3,
    )).toThrow('settlement binding is divergent')
    raw.close()
    await expect(store.commitRound(reactionRequest)).resolves.toEqual({ ...committed, status: 'already_committed' })
    await expect(store.commitRound({
      ...reactionRequest,
      transactionId: brandId('transaction:reaction:settle:terminal', 'TransactionId'),
      roundId: brandId('round:reaction:settle:terminal', 'InteractionRoundId'),
      expectedHeadSeq: 3,
      expectedTick: 2,
      nextTick: 3,
    })).rejects.toThrow('absent or terminal')
    now = 20
    store.close()
    leases.close()
  })

  it('derives and commits three bounded Waves from durable usage before stopping at the Wave limit', async () => {
    const { path, address } = fixture()
    const clock = { value: 10 }
    const store = new WorldStore(path, undefined, () => clock.value)
    store.createBranch(address)
    const leases = new WriterLeaseService(path, () => clock.value)
    const writer = leases.acquire(address, 'reaction-worker:multi-wave', 2_000)
    const rootRequest = request(address, reactionDraft({
      maxNpcCalls: 3,
      initialTokenBudget: 6,
      candidates: [{
        characterId: supplementary,
        estimatedTokens: 1,
        stimuli: [{
          sourceEventOrdinal: 0,
          observationOrdinal: 0,
          observationId: 'observation:supplementary',
          observerCharacterId: supplementary,
        }],
      }],
    }))
    await store.commitRound({ ...rootRequest, writerFencingToken: writer.fencingToken })
    const cycleId = store.activeReactionCycle(address)!.cycle.cycleId

    const commitWave = async (
      wave: number,
      observerCharacterId: typeof supplementary,
      nextCharacterId: typeof supplementary,
      terminalReason: ReactionWaveSettlementDraft['terminalReason'],
    ) => {
      const claimed = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 500)!
      expect(claimed).toMatchObject({ wave, characterId: observerCharacterId })
      const bound = store.bindReactionJobProvider(
        address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
          contextReceiptId: `context-receipt:multi-wave:${wave}`,
          contextReceiptHash: hashWorldJson('context-receipt:test', { wave }),
          providerCallId: `provider-call:multi-wave:${wave}`,
          providerRequestHash: hashWorldJson('provider-request:test', { wave }),
        },
      )
      const head = store.head(address)
      const transactionId = brandId(`transaction:reaction:multi-wave:${wave}`, 'TransactionId')
      const roundId = brandId(`round:reaction:multi-wave:${wave}`, 'InteractionRoundId')
      const observationId = `observation:multi-wave:${wave}:${nextCharacterId}`
      const committed = await store.commitRound({
        address,
        transactionId,
        roundId,
        expectedHeadSeq: head.headSeq,
        expectedTick: head.tick,
        nextTick: head.tick + 1,
        events: [{
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: { id: observationId, value: { observerId: nextCharacterId, content: `wave ${wave}` } },
        }],
        outbox: [],
        authority: { schemaVersion: 1, origin: 'reaction', cycleId, wave },
        reactionSettlement: {
          cycleId,
          wave,
          terminalReason,
          jobs: [{
            jobId: bound.jobId,
            claimOwnerId: bound.claimOwnerId,
            claimFencingToken: bound.claimFencingToken,
            expectedStateHash: bound.stateHash,
            outcome: 'proposed',
            proposalHash: hashWorldJson('reaction-proposal:test', { wave }),
          }],
          nextWaveCandidates: [{
            characterId: nextCharacterId,
            estimatedTokens: 1,
            stimuli: [{
              sourceEventOrdinal: 0,
              observationOrdinal: 0,
              observationId,
              observerCharacterId: nextCharacterId,
            }],
          }],
        },
        writerFencingToken: writer.fencingToken,
        correlationId: `reaction:multi-wave:${wave}`,
      })
      expect(store.committedRound(address, transactionId)).toMatchObject({ bundleHash: committed.bundleHash })
      return committed
    }

    await commitWave(1, supplementary, privateUse, null)
    let bundle = store.activeReactionCycle(address)!
    expect(bundle.waves[1]).toMatchObject({ wave: 2, status: 'frozen', callsBefore: 1, tokensBefore: 5 })
    expect(bundle.jobs.find(job => job.wave === 2)).toMatchObject({ characterId: privateUse, status: 'pending' })
    expect(store.committedRound(address, rootRequest.transactionId)).toBeDefined()

    await commitWave(2, privateUse, supplementary, null)
    bundle = store.activeReactionCycle(address)!
    expect(bundle.waves[2]).toMatchObject({ wave: 3, status: 'frozen', callsBefore: 2, tokensBefore: 4 })
    expect(bundle.jobs.find(job => job.wave === 3)).toMatchObject({ characterId: supplementary, status: 'pending' })

    await commitWave(3, supplementary, privateUse, 'wave_limit')
    expect(store.activeReactionCycle(address)).toBeUndefined()
    const terminal = store.readReactionCycle(address, cycleId)!
    expect(terminal.cycle).toMatchObject({ status: 'terminal', terminalReason: 'wave_limit', terminalAtSeq: 5 })
    expect(terminal.waves).toHaveLength(3)
    expect(terminal.jobs.filter(job => job.status === 'settled')).toHaveLength(3)
    expect(terminal.waves.some(wave => wave.wave === 4)).toBe(false)
    expect(store.committedRound(address, rootRequest.transactionId)).toBeDefined()
    const firstTransactionId = brandId('transaction:reaction:multi-wave:1', 'TransactionId')
    const firstAuthorityHash = store.readRoundAuthority(address, firstTransactionId)!.authorityHash
    const raw = new DatabaseSync(path)
    expect(readReactionWaveSettlementHashByTransaction(
      raw, address, firstTransactionId, firstAuthorityHash, 999,
    )).toMatch(/^sha256:/u)
    const impossibleTerminal = { ...terminal.cycle, terminalAtSeq: 3 }
    raw.prepare(`UPDATE world_reaction_cycles SET terminal_at_seq = ?, state_hash = ? WHERE cycle_id = ?`)
      .run(3, hashReactionCycleState(impossibleTerminal), cycleId)
    expect(() => readReactionWaveSettlementHashByTransaction(
      raw, address, firstTransactionId, firstAuthorityHash, 3,
    )).toThrow('unexpectedly created a continuation')
    raw.prepare(`UPDATE world_reaction_cycles SET terminal_at_seq = ?, state_hash = ? WHERE cycle_id = ?`)
      .run(terminal.cycle.terminalAtSeq, terminal.cycle.stateHash, cycleId)
    raw.close()
    store.close()
    leases.close()
  })

  it('derives terminal reasons and mixed reservation results instead of trusting the scheduler', async () => {
    const run = async (input: {
      readonly suffix: string
      readonly outcome: 'proposed' | 'abstained' | 'provider_terminal'
      readonly terminalReason: ReactionWaveSettlementDraft['terminalReason']
      readonly nextCharacters?: readonly (typeof supplementary)[]
      readonly maxNpcCalls?: number
      readonly maxCallsPerCharacter?: number
      readonly initialTokenBudget?: number
      readonly rootEstimatedTokens?: number
      readonly deadlineAtMs?: number
      readonly settleAtMs?: number
      readonly expectFailure?: string
    }) => {
      const { path, address } = fixture()
      const clock = { value: 10 }
      const store = new WorldStore(path, undefined, () => clock.value)
      store.createBranch(address)
      const leases = new WriterLeaseService(path, () => clock.value)
      const writer = leases.acquire(address, `reaction-worker:terminal:${input.suffix}`, 2_000)
      await store.commitRound({
        ...request(address, reactionDraft({
          maxNpcCalls: input.maxNpcCalls ?? 2,
          maxCallsPerCharacter: input.maxCallsPerCharacter ?? 2,
          initialTokenBudget: input.initialTokenBudget ?? 4,
          deadlineAtMs: input.deadlineAtMs ?? 10_000,
          candidates: [{
            characterId: supplementary,
            estimatedTokens: input.rootEstimatedTokens ?? 1,
            stimuli: [{
              sourceEventOrdinal: 0,
              observationOrdinal: 0,
              observationId: 'observation:supplementary',
              observerCharacterId: supplementary,
            }],
          }],
        })),
        writerFencingToken: writer.fencingToken,
      })
      const cycle = store.activeReactionCycle(address)!.cycle
      const claimed = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 500)!
      const bound = store.bindReactionJobProvider(
        address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
          contextReceiptId: `context-receipt:terminal:${input.suffix}`,
          contextReceiptHash: hashWorldJson('context-receipt:test', input.suffix),
          providerCallId: `provider-call:terminal:${input.suffix}`,
          providerRequestHash: hashWorldJson('provider-request:test', input.suffix),
        },
      )
      clock.value = input.settleAtMs ?? clock.value
      const nextCharacters = input.nextCharacters ?? []
      const events: WorldEventDraft[] = nextCharacters.map((characterId, index) => ({
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: `observation:terminal:${input.suffix}:${index}`, value: { observerId: characterId } },
      }))
      if (events.length === 0) events.push({
        eventType: 'fixture.reaction', eventVersion: 1, data: { suffix: input.suffix },
      })
      const commit = store.commitRound({
        address,
        transactionId: brandId(`transaction:reaction:terminal:${input.suffix}`, 'TransactionId'),
        roundId: brandId(`round:reaction:terminal:${input.suffix}`, 'InteractionRoundId'),
        expectedHeadSeq: 2,
        expectedTick: 1,
        nextTick: 2,
        events,
        outbox: [],
        authority: { schemaVersion: 1, origin: 'reaction', cycleId: cycle.cycleId, wave: 1 },
        reactionSettlement: {
          cycleId: cycle.cycleId,
          wave: 1,
          terminalReason: input.terminalReason,
          jobs: [{
            jobId: bound.jobId,
            claimOwnerId: bound.claimOwnerId,
            claimFencingToken: bound.claimFencingToken,
            expectedStateHash: bound.stateHash,
            outcome: input.outcome,
            proposalHash: input.outcome === 'proposed' ? hashWorldJson('reaction-proposal:test', input.suffix) : null,
          }],
          nextWaveCandidates: nextCharacters.map((characterId, index) => ({
            characterId,
            estimatedTokens: 1,
            stimuli: [{
              sourceEventOrdinal: index,
              observationOrdinal: 0,
              observationId: `observation:terminal:${input.suffix}:${index}`,
              observerCharacterId: characterId,
            }],
          })),
        },
        writerFencingToken: writer.fencingToken,
        correlationId: `reaction:terminal:${input.suffix}`,
      })
      if (input.expectFailure === undefined) await expect(commit).resolves.toMatchObject({ status: 'committed' })
      else await expect(commit).rejects.toThrow(input.expectFailure)
      const bundle = store.readReactionCycle(address, cycle.cycleId)!
      store.close()
      leases.close()
      return bundle
    }

    expect((await run({ suffix: 'abstained', outcome: 'abstained', terminalReason: 'all_abstained' })).cycle)
      .toMatchObject({ terminalReason: 'all_abstained' })
    expect((await run({ suffix: 'provider', outcome: 'provider_terminal', terminalReason: 'provider_terminal' })).cycle)
      .toMatchObject({ terminalReason: 'provider_terminal' })
    expect((await run({
      suffix: 'deadline', outcome: 'proposed', terminalReason: 'deadline_reached', deadlineAtMs: 15, settleAtMs: 16,
    })).cycle).toMatchObject({ terminalReason: 'deadline_reached' })
    expect((await run({
      suffix: 'call-limit', outcome: 'proposed', terminalReason: 'call_limit', maxNpcCalls: 1,
      nextCharacters: [privateUse],
    })).cycle).toMatchObject({ terminalReason: 'call_limit' })
    expect((await run({
      suffix: 'token-limit', outcome: 'proposed', terminalReason: 'token_budget_exhausted',
      maxNpcCalls: 2, initialTokenBudget: 1, rootEstimatedTokens: 1, nextCharacters: [privateUse],
    })).cycle).toMatchObject({ terminalReason: 'token_budget_exhausted' })
    expect((await run({
      suffix: 'character-limit', outcome: 'proposed', terminalReason: 'call_limit',
      maxNpcCalls: 2, maxCallsPerCharacter: 1, nextCharacters: [supplementary],
    })).cycle).toMatchObject({ terminalReason: 'call_limit' })
    const mixed = await run({
      suffix: 'mixed', outcome: 'proposed', terminalReason: null,
      maxNpcCalls: 3, maxCallsPerCharacter: 1, nextCharacters: [privateUse, supplementary],
    })
    expect(mixed.cycle.status).toBe('active')
    expect(mixed.jobs.filter(job => job.wave === 2).map(job => job.status).sort()).toEqual(['pending', 'skipped'])
    await run({
      suffix: 'mismatch', outcome: 'proposed', terminalReason: 'all_abstained',
      expectFailure: 'terminal decision diverges',
    })
  })

  it('rejects self-consistent Cycle metadata whose durable usage exceeds the rewritten limits', async () => {
    const value = await settlementFixture()
    const cycle = value.store.readReactionCycle(value.address, value.cycle.cycleId)!.cycle
    const budgetHash = hashWorldJson('reaction-cycle-budget/v1', {
      policyVersion: cycle.policyVersion,
      profileId: cycle.profileId,
      maxWaves: cycle.maxWaves,
      maxNpcCalls: cycle.maxNpcCalls,
      maxCallsPerCharacter: cycle.maxCallsPerCharacter,
      maxActionsPerCall: cycle.maxActionsPerCall,
      allowedActionTypes: cycle.allowedActionTypes,
      initialTokenBudget: 1,
      deadlineAtMs: cycle.deadlineAtMs,
    })
    const immutable = {
      cycleId: cycle.cycleId,
      address: cycle.address,
      rootRoundId: cycle.rootRoundId,
      rootTransactionId: cycle.rootTransactionId,
      createdAtSeq: cycle.createdAtSeq,
      policyVersion: cycle.policyVersion,
      profileId: cycle.profileId,
      maxWaves: cycle.maxWaves,
      maxNpcCalls: cycle.maxNpcCalls,
      maxCallsPerCharacter: cycle.maxCallsPerCharacter,
      maxActionsPerCall: cycle.maxActionsPerCall,
      allowedActionTypes: cycle.allowedActionTypes,
      initialTokenBudget: 1,
      deadlineAtMs: cycle.deadlineAtMs,
      budgetHash,
    }
    const cycleHash = hashWorldJson('reaction-cycle/v1', immutable)
    const stateHash = hashWorldJson('reaction-cycle-state/v1', {
      cycleId: cycle.cycleId,
      cycleHash,
      status: cycle.status,
      stopReason: cycle.stopReason,
      terminalReason: cycle.terminalReason,
      terminalAtSeq: cycle.terminalAtSeq,
    })
    const raw = new DatabaseSync(value.path)
    raw.prepare(`
      UPDATE world_reaction_cycles SET initial_token_budget = 1, budget_hash = ?, cycle_hash = ?, state_hash = ?
      WHERE cycle_id = ?
    `).run(budgetHash, cycleHash, stateHash, cycle.cycleId)
    raw.close()
    await expect(value.store.commitRound({
      address: value.address,
      transactionId: brandId('transaction:reaction:usage-overflow', 'TransactionId'),
      roundId: brandId('round:reaction:usage-overflow', 'InteractionRoundId'),
      expectedHeadSeq: 2,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: {} }],
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: cycle.cycleId, wave: 1 },
      reactionSettlement: value.settlement,
      writerFencingToken: value.writer.fencingToken,
      correlationId: 'reaction:usage-overflow',
    })).rejects.toThrow('durable usage exceeds')
    value.store.close()
    value.leases.close()
  })

  it('atomically enqueues player input and requests Cycle preemption with first reason winning', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    await store.commitRound(request(address))
    const cycleId = store.activeReactionCycle(address)!.cycle.cycleId
    const inbox = new RoundInbox(path)
    const firstRequest = {
      address,
      idempotencyKey: 'player:preempt:first',
      principalId: 'principal:player',
      input: { type: 'speak', text: '等等' },
      correlationId: 'player:preempt:first',
    } as const
    expect(inbox.enqueue(firstRequest, 2)).toMatchObject({ status: 'enqueued', inboxSeq: 1 })
    expect(store.activeReactionCycle(address)?.cycle).toMatchObject({
      cycleId,
      status: 'stop_requested',
      stopReason: 'player_preempted',
    })
    expect(store.cancelReactionCycle(address, cycleId)).toMatchObject({
      status: 'stop_requested', stopReason: 'player_preempted',
    })
    expect(inbox.enqueue(firstRequest, 2)).toMatchObject({ status: 'already_enqueued', inboxSeq: 1 })
    expect(inbox.enqueue({
      ...firstRequest,
      idempotencyKey: 'player:preempt:second',
      correlationId: 'player:preempt:second',
      input: { type: 'speak', text: '继续' },
    }, 2)).toMatchObject({ status: 'enqueued', inboxSeq: 2 })
    expect(store.activeReactionCycle(address)?.cycle).toMatchObject({
      cycleId,
      status: 'stop_requested',
      stopReason: 'player_preempted',
    })
    inbox.close()
    store.close()
  })

  it('rolls back player admission when the atomic Cycle preemption CAS cannot apply', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    await store.commitRound(request(address))
    const blocker = new DatabaseSync(path)
    blocker.exec(`
      CREATE TRIGGER block_reaction_player_preemption
      BEFORE UPDATE OF status ON world_reaction_cycles
      WHEN NEW.status = 'stop_requested'
      BEGIN SELECT RAISE(IGNORE); END;
    `)
    blocker.close()
    const inbox = new RoundInbox(path)
    const playerRequest = {
      address,
      idempotencyKey: 'player:preempt:rollback',
      principalId: 'principal:player',
      input: { type: 'speak', text: '停一下' },
      correlationId: 'player:preempt:rollback',
    } as const
    expect(() => inbox.enqueue(playerRequest, 1)).toThrow('stop request changed concurrently')
    expect(store.activeReactionCycle(address)?.cycle.status).toBe('active')
    const unblock = new DatabaseSync(path)
    unblock.exec(`DROP TRIGGER block_reaction_player_preemption`)
    unblock.close()
    expect(inbox.enqueue(playerRequest, 1)).toMatchObject({ status: 'enqueued', inboxSeq: 1 })
    inbox.close()
    store.close()
  })

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

  it('exposes privacy-safe Cycle views and idempotently requests user cancellation', async () => {
    const { path, address } = fixture()
    const store = new WorldStore(path)
    store.createBranch(address)
    await store.commitRound(request(address))
    const cycleId = store.activeReactionCycle(address)!.cycle.cycleId
    expect(store.reactionCycleView(address, brandId('reaction-cycle:missing', 'ReactionCycleId'))).toBeUndefined()
    const view = store.reactionCycleView(address, cycleId)!
    expect(view).toMatchObject({
      cycleId,
      status: 'active',
      currentWave: 1,
      usedCalls: 0,
      usedTokens: 0,
      lastCommittedWave: null,
      lastReactionRoundId: null,
      lastResultTransactionId: null,
      lastAuthorityHash: null,
    })
    expect(view).not.toHaveProperty('jobs')
    expect(view).not.toHaveProperty('stimuli')
    expect(store.listReactionCycles(address)).toEqual([view])
    expect(store.cancelReactionCycle(address, brandId('reaction-cycle:missing', 'ReactionCycleId'))).toBeUndefined()
    store.close()

    const faulting = new WorldStore(path, new ThrowingFaultInjector('reaction.after-cancel-request'))
    expect(() => faulting.cancelReactionCycle(address, cycleId)).toThrow('reaction.after-cancel-request')
    expect(faulting.reactionCycleView(address, cycleId)?.status).toBe('active')
    faulting.close()

    const blocker = new DatabaseSync(path)
    blocker.exec(`
      CREATE TRIGGER block_reaction_user_cancel
      BEFORE UPDATE OF status ON world_reaction_cycles
      WHEN NEW.stop_reason = 'user_cancelled'
      BEGIN SELECT RAISE(IGNORE); END;
    `)
    blocker.close()
    const guarded = new WorldStore(path)
    expect(() => guarded.cancelReactionCycle(address, cycleId)).toThrow('cancellation changed concurrently')
    const unblock = new DatabaseSync(path)
    unblock.exec(`DROP TRIGGER block_reaction_user_cancel`)
    unblock.close()
    const cancelled = guarded.cancelReactionCycle(address, cycleId)!
    expect(cancelled).toMatchObject({ status: 'stop_requested', stopReason: 'user_cancelled' })
    expect(guarded.cancelReactionCycle(address, cycleId)).toEqual(cancelled)
    guarded.close()
  })

  it('lists multiple Cycles newest first after a terminal Cycle permits another Root Round', async () => {
    const value = await settlementFixture()
    await value.store.commitRound({
      address: value.address,
      transactionId: brandId('transaction:reaction:list:first-terminal', 'TransactionId'),
      roundId: brandId('round:reaction:list:first-terminal', 'InteractionRoundId'),
      expectedHeadSeq: 2,
      expectedTick: 1,
      nextTick: 2,
      events: [{ eventType: 'fixture.reaction', eventVersion: 1, data: {} }],
      outbox: [],
      authority: { schemaVersion: 1, origin: 'reaction', cycleId: value.cycle.cycleId, wave: 1 },
      reactionSettlement: value.settlement,
      writerFencingToken: value.writer.fencingToken,
      correlationId: 'reaction:list:first-terminal',
    })
    await value.store.commitRound({
      address: value.address,
      transactionId: brandId('transaction:reaction:list:second-root', 'TransactionId'),
      roundId: brandId('round:reaction:list:second-root', 'InteractionRoundId'),
      expectedHeadSeq: 3,
      expectedTick: 2,
      nextTick: 3,
      events: [{
        eventType: 'observation.upsert',
        eventVersion: 1,
        data: { id: 'observation:reaction:list:second', value: { observerId: privateUse } },
      }],
      outbox: [],
      reactionCycle: reactionDraft({
        candidates: [{
          characterId: privateUse,
          estimatedTokens: 1,
          stimuli: [{
            sourceEventOrdinal: 0,
            observationOrdinal: 0,
            observationId: 'observation:reaction:list:second',
            observerCharacterId: privateUse,
          }],
        }],
      }),
      writerFencingToken: value.writer.fencingToken,
      correlationId: 'reaction:list:second-root',
    })
    const activeId = value.store.activeReactionCycle(value.address)!.cycle.cycleId
    expect(value.store.listReactionCycles(value.address).map(view => view.cycleId))
      .toEqual([activeId, value.cycle.cycleId])
    value.store.close()
    value.leases.close()
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

  it('claims, renews, and fences one Job across Writer takeover without duplicating its reservation', async () => {
    const { path, address } = fixture()
    let now = 0
    const bootstrap = new WorldStore(path, undefined, () => now)
    bootstrap.createBranch(address)
    await bootstrap.commitRound(request(address))
    bootstrap.close()
    const leases = new WriterLeaseService(path, () => now)
    const firstWriter = leases.acquire(address, 'reaction-worker:first', 120)
    const firstStore = new WorldStore(path, undefined, () => now)
    const first = firstStore.claimNextReactionJob(address, firstWriter.ownerId, firstWriter.fencingToken, 100)!
    expect(first).toMatchObject({
      status: 'claimed',
      attemptCount: 1,
      claimFencingToken: 1,
      claimExpiresAtMs: 100,
      budgetDecision: 'reserved',
    })
    expect(firstStore.committedRound(address, brandId('transaction:reaction-root', 'TransactionId')))
      .toMatchObject({ roundId: brandId('round:reaction-root', 'InteractionRoundId') })
    expect(firstStore.claimNextReactionJob(address, firstWriter.ownerId, firstWriter.fencingToken, 100)).toBeUndefined()
    now = 50
    const renewed = firstStore.renewReactionJobClaim(
      address, first.jobId, firstWriter.ownerId, firstWriter.fencingToken, first.claimFencingToken, 100,
    )
    expect(renewed.claimExpiresAtMs).toBe(120)

    now = 121
    const secondWriter = leases.acquire(address, 'reaction-worker:second', 1_000)
    const secondStore = new WorldStore(path, undefined, () => now)
    const replacement = secondStore.claimNextReactionJob(address, secondWriter.ownerId, secondWriter.fencingToken, 100)!
    expect(replacement).toMatchObject({ attemptCount: 2, claimFencingToken: 2, claimOwnerId: secondWriter.ownerId })
    expect(secondStore.committedRound(address, brandId('transaction:reaction-root', 'TransactionId')))
      .toMatchObject({ roundId: brandId('round:reaction-root', 'InteractionRoundId') })
    expect(() => firstStore.renewReactionJobClaim(
      address, first.jobId, firstWriter.ownerId, firstWriter.fencingToken, first.claimFencingToken, 100,
    )).toThrow('current branch Writer lease')
    now = 150
    expect(secondStore.renewReactionJobClaim(
      address, replacement.jobId, secondWriter.ownerId, secondWriter.fencingToken, replacement.claimFencingToken, 100,
    ).claimExpiresAtMs).toBe(250)
    expect(secondStore.activeReactionCycle(address)?.jobs.filter(job => job.status === 'claimed')).toHaveLength(1)
    firstStore.close()
    secondStore.close()
    leases.close()
  })

  it('does not claim absent or stopped work and rolls back a fault after the claim CAS', async () => {
    const { path, address } = fixture()
    let now = 10
    const bootstrap = new WorldStore(path, undefined, () => now)
    bootstrap.createBranch(address)
    const leases = new WriterLeaseService(path, () => now)
    const writer = leases.acquire(address, 'reaction-worker:fault', 1_000)
    expect(bootstrap.claimNextReactionJob(address, writer.ownerId, writer.fencingToken)).toBeUndefined()
    await bootstrap.commitRound({ ...request(address), writerFencingToken: writer.fencingToken })
    const cycle = bootstrap.activeReactionCycle(address)!.cycle
    const stopped = { ...cycle, status: 'stop_requested' as const, stopReason: 'user_cancelled' as const }
    bootstrap.close()
    const raw = new DatabaseSync(path)
    raw.prepare(`UPDATE world_reaction_cycles SET status = 'stop_requested', stop_reason = ?, state_hash = ? WHERE cycle_id = ?`)
      .run(stopped.stopReason, hashReactionCycleState(stopped), cycle.cycleId)
    raw.close()
    const stoppedStore = new WorldStore(path, undefined, () => now)
    expect(stoppedStore.claimNextReactionJob(address, writer.ownerId, writer.fencingToken)).toBeUndefined()
    expect(stoppedStore.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 30_000, true))
      .toMatchObject({ status: 'claimed', providerCallId: null })
    stoppedStore.close()

    const second = fixture()
    const secondBootstrap = new WorldStore(second.path, undefined, () => now)
    secondBootstrap.createBranch(second.address)
    await secondBootstrap.commitRound(request(second.address))
    secondBootstrap.close()
    const secondLeases = new WriterLeaseService(second.path, () => now)
    const secondWriter = secondLeases.acquire(second.address, 'reaction-worker:fault', 1_000)
    const faulting = new WorldStore(
      second.path,
      new ThrowingFaultInjector('reaction.after-job-claim'),
      () => now,
    )
    expect(() => faulting.claimNextReactionJob(
      second.address, secondWriter.ownerId, secondWriter.fencingToken, 100,
    )).toThrow('reaction.after-job-claim')
    faulting.close()
    const recovered = new WorldStore(second.path, undefined, () => now)
    expect(recovered.claimNextReactionJob(second.address, secondWriter.ownerId, secondWriter.fencingToken, 100))
      .toMatchObject({ attemptCount: 1, claimFencingToken: 1 })
    recovered.close()
    secondLeases.close()
    leases.close()
  })

  it('lists active Cycle addresses in world UTF-16 order rather than SQLite byte order', async () => {
    const { path, address } = fixture()
    const supplementaryAddress = {
      ...address,
      branchId: brandId('branch:\u{10000}', 'BranchId'),
    }
    const privateUseAddress = {
      ...address,
      branchId: brandId('branch:\uE000', 'BranchId'),
    }
    const store = new WorldStore(path)
    store.createBranch(privateUseAddress)
    store.createBranch(supplementaryAddress)
    await store.commitRound(request(privateUseAddress))
    await store.commitRound({
      ...request(supplementaryAddress),
      transactionId: brandId('transaction:reaction-root:supplementary', 'TransactionId'),
      roundId: brandId('round:reaction-root:supplementary', 'InteractionRoundId'),
    })

    expect(store.activeReactionCycleAddresses()).toEqual([
      supplementaryAddress,
      privateUseAddress,
    ])
    store.close()
  })

  it('rejects invalid claim input, missing Writer ownership, and stale renewal proofs', async () => {
    const { path, address } = fixture()
    let now = 0
    const store = new WorldStore(path, undefined, () => now)
    store.createBranch(address)
    await store.commitRound(request(address))
    expect(() => store.claimNextReactionJob(address, '', 1)).toThrow(TypeError)
    expect(() => store.claimNextReactionJob(address, 'reaction-worker:guard', 0)).toThrow(RangeError)
    expect(() => store.claimNextReactionJob(address, 'reaction-worker:guard', 1, 0)).toThrow(RangeError)
    expect(() => store.claimNextReactionJob(address, 'reaction-worker:guard', 1)).toThrow('current branch Writer lease')
    const leases = new WriterLeaseService(path, () => now)
    const writer = leases.acquire(address, 'reaction-worker:guard', 1_000)
    const claimed = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100)!
    expect(() => store.renewReactionJobClaim(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, 0, 100,
    )).toThrow(RangeError)
    expect(() => store.renewReactionJobClaim(
      address, brandId('reaction-job:missing', 'ReactionJobId'), writer.ownerId, writer.fencingToken, claimed.claimFencingToken, 100,
    )).toThrow('stale, expired')
    expect(() => store.renewReactionJobClaim(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken + 1, 100,
    )).toThrow('stale, expired')
    now = 101
    expect(() => store.renewReactionJobClaim(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, 100,
    )).toThrow('stale, expired')
    store.close()
    leases.close()
  })

  it('fails closed when a claim or renewal CAS does not update its exact durable row', async () => {
    for (const operation of ['claim', 'renew'] as const) {
      const { path, address } = fixture()
      const bootstrap = new WorldStore(path, undefined, () => 0)
      bootstrap.createBranch(address)
      await bootstrap.commitRound(request(address))
      bootstrap.close()
      const leases = new WriterLeaseService(path, () => 0)
      const writer = leases.acquire(address, `reaction-worker:cas:${operation}`, 1_000)
      const store = new WorldStore(path, undefined, () => 0)
      const claimed = operation === 'renew'
        ? store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100)!
        : undefined
      const raw = new DatabaseSync(path)
      raw.exec(`
        CREATE TRIGGER ignore_reaction_job_update
        BEFORE UPDATE ON world_reaction_jobs
        WHEN OLD.status = '${operation === 'claim' ? 'pending' : 'claimed'}'
        BEGIN SELECT RAISE(IGNORE); END
      `)
      raw.close()
      if (operation === 'claim') {
        expect(() => store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100))
          .toThrow('claim changed concurrently')
      } else {
        expect(() => store.renewReactionJobClaim(
          address, claimed!.jobId, writer.ownerId, writer.fencingToken, claimed!.claimFencingToken, 100,
        )).toThrow('claim changed concurrently')
      }
      store.close()
      leases.close()
    }
  })

  it('binds a claimed Job to one append-once ProviderCall and reclaims the same binding after lease expiry', async () => {
    const { path, address } = fixture()
    let now = 0
    const bootstrap = new WorldStore(path, undefined, () => now)
    bootstrap.createBranch(address)
    await bootstrap.commitRound(request(address))
    bootstrap.close()
    const leases = new WriterLeaseService(path, () => now)
    const writer = leases.acquire(address, 'reaction-worker:provider', 1_000)
    const store = new WorldStore(path, undefined, () => now)
    const claimed = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100)!
    const binding = {
      contextReceiptId: 'context-receipt:reaction-provider',
      contextReceiptHash: hashWorldJson('context-receipt:test', 'provider'),
      providerCallId: 'provider-call:reaction-provider',
      providerRequestHash: hashWorldJson('provider-request:test', 'provider'),
    }
    const bound = store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, binding,
    )
    expect(bound).toMatchObject(binding)
    expect(store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, binding,
    )).toEqual(bound)
    expect(store.committedRound(address, brandId('transaction:reaction-root', 'TransactionId')))
      .toMatchObject({ roundId: brandId('round:reaction-root', 'InteractionRoundId') })
    expect(() => store.bindReactionJobProvider(
      address,
      claimed.jobId,
      writer.ownerId,
      writer.fencingToken,
      claimed.claimFencingToken,
      { ...binding, providerCallId: 'provider-call:divergent' },
    )).toThrow('binding is divergent')
    now = 101
    const recovered = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100)!
    expect(recovered).toMatchObject({
      ...binding,
      attemptCount: 2,
      claimFencingToken: claimed.claimFencingToken + 1,
    })
    expect(() => store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, binding,
    )).toThrow('live matching claim')
    expect(store.bindReactionJobProvider(
      address, recovered.jobId, writer.ownerId, writer.fencingToken, recovered.claimFencingToken, binding,
    )).toEqual(recovered)
    store.close()
    leases.close()
  })

  it('rejects invalid or concurrently changed Provider bindings', async () => {
    const { path, address } = fixture()
    const bootstrap = new WorldStore(path, undefined, () => 0)
    bootstrap.createBranch(address)
    await bootstrap.commitRound(request(address))
    bootstrap.close()
    const leases = new WriterLeaseService(path, () => 0)
    const writer = leases.acquire(address, 'reaction-worker:provider-cas', 1_000)
    const store = new WorldStore(path, undefined, () => 0)
    const claimed = store.claimNextReactionJob(address, writer.ownerId, writer.fencingToken, 100)!
    const binding = {
      contextReceiptId: 'context-receipt:reaction-provider-cas',
      contextReceiptHash: hashWorldJson('context-receipt:test', 'provider-cas'),
      providerCallId: 'provider-call:reaction-provider-cas',
      providerRequestHash: hashWorldJson('provider-request:test', 'provider-cas'),
    }
    expect(() => store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, { ...binding, contextReceiptId: '' },
    )).toThrow(TypeError)
    expect(() => store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, {
        ...binding,
        contextReceiptHash: 'sha256:bad',
      },
    )).toThrow('not a lowercase WorldHash')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TRIGGER ignore_reaction_provider_binding
      BEFORE UPDATE ON world_reaction_jobs
      WHEN OLD.status = 'claimed'
      BEGIN SELECT RAISE(IGNORE); END
    `)
    raw.close()
    expect(() => store.bindReactionJobProvider(
      address, claimed.jobId, writer.ownerId, writer.fencingToken, claimed.claimFencingToken, binding,
    )).toThrow('binding changed concurrently')
    store.close()
    leases.close()
  })
})
