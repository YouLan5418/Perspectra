import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { WorldApplication, type ReactionParticipantBinding } from '@harness-world/application'
import { brandId, compareWorldText } from '@harness-world/contracts'
import { BranchWorkScheduler } from '@harness-world/operations'
import { RoundInbox, WorldStore } from '@harness-world/store-sqlite'
import { ADDRESS, v5Manifest } from './reaction-fixture.ts'

// ADR-0079: real application/SQLite/context/provider path, not a mocked scheduler.
it('dispatches eight reaction providers together and permits another branch to commit while they wait', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-p9-concurrency-'))
  const worldPath = join(directory, 'world.sqlite')
  const npcIds = Array.from({ length: 8 }, (_, index) => brandId(`character:npc${index}`, 'CharacterId'))
  const other = { ...ADDRESS, branchId: brandId('branch:other', 'BranchId') }
  const starts: number[] = []
  const ends: number[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let allStarted!: () => void
  const started = new Promise<void>(resolve => { allStarted = resolve })
  const bindings: ReactionParticipantBinding[] = npcIds.map(actorId => ({
    participantId: `agent:${actorId}`, role: 'agent', actorId,
    allowedActionTypes: ['speak'], priority: 0, estimatedTokens: 2, timeoutMs: 10_000,
    provider: { async propose() {
      starts.push(performance.now())
      if (starts.length === 8) allStarted()
      await gate
      await delay(100)
      ends.push(performance.now())
      return { schemaVersion: 2, decision: 'abstain', actions: [] }
    } },
  }))
  const app = new WorldApplication({
    worldPath, sessionPath: join(directory, 'session.sqlite'), memoryPath: join(directory, 'memory.sqlite'),
    modelBudgetTokens: 64, leaseTtlMs: 30_000,
    participants: () => [], reactionParticipants: address => address.branchId === other.branchId ? [] : bindings,
  })
  const request = (id: string) => ({ idempotencyKey: id, principalId: 'principal:player',
    action: { actionType: 'speak', parameters: { text: 'Hello everyone' } }, correlationId: id })
  let running: Promise<unknown> | undefined
  try {
    app.activate(v5Manifest({ npcIds }))
    app.activate(v5Manifest({ address: other, npcIds: [] }))
    await app.submit(ADDRESS, request('parallel:root'))
    running = app.processNextBranchWork(ADDRESS, 'parallel:wave')
    // A serial implementation cannot reach this barrier before any provider returns.
    await Promise.race([started, delay(5_000).then(() => { throw new Error('eight providers did not start concurrently') })])
    expect(ends).toHaveLength(0)
    await app.submit(other, request('parallel:other'))
    const probe = new WorldStore(worldPath)
    try { expect(probe.verifyBranchIntegrity(other).tick).toBe(1) } finally { probe.close() }
    expect(ends).toHaveLength(0)
    const releasedAt = performance.now()
    release()
    expect(await running).toMatchObject({ status: 'reaction_wave' })
    expect(starts).toHaveLength(8)
    expect(ends).toHaveLength(8)
    // Timing is evidence, not a portable release threshold; the barrier above
    // deterministically proves overlap even on a heavily loaded CI host.
    console.info(JSON.stringify({ profile: 'p9-eight-providers', calls: starts.length,
      providerTailMs: Math.round(Math.max(...ends) - releasedAt), serialDelayMs: 800 }))
    await app.submit(ADDRESS, request('parallel:root'))
    expect(starts).toHaveLength(8)
  } finally {
    release()
    await running?.catch(() => {})
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('recovers 32 durable branches without wake hints and commits each first quantum before any second', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-p9-fairness-'))
  const worldPath = join(directory, 'world.sqlite')
  const app = new WorldApplication({ worldPath, sessionPath: join(directory, 'session.sqlite'),
    memoryPath: join(directory, 'memory.sqlite'), leaseTtlMs: 60_000,
    participants: () => [], reactionParticipants: () => [] })
  const addresses = Array.from({ length: 32 }, (_, index) => ({ ...ADDRESS,
    branchId: brandId(`branch:fair-${index.toString().padStart(2, '0')}`, 'BranchId') }))
  const served: string[] = []
  const errors: unknown[] = []
  let completed!: () => void
  const completion = new Promise<void>(resolve => { completed = resolve })
  const scheduler = new BranchWorkScheduler({
    work: app,
    scan: { scanRunnableBranches() {
      const inbox = new RoundInbox(worldPath)
      try { return inbox.unfinishedAddresses() } finally { inbox.close() }
    } },
    maxConcurrentBranches: 1,
    onStep(address, step) {
      if (step.status === 'player_round') served.push(address.branchId)
      if (served.length === 64) completed()
    },
    onFailure(_address, error) { errors.push(error); completed() },
  })
  try {
    for (const address of addresses) {
      app.activate(v5Manifest({ address, npcIds: [] }))
      for (let round = 0; round < 2; round += 1) {
        await app.acceptRound(address, { idempotencyKey: `fair:${round}`, principalId: 'principal:player',
          action: { actionType: 'speak', parameters: { text: 'Still here' } }, correlationId: 'fairness' })
      }
    }
    scheduler.start() // Deliberately no wake: discover all work from the durable inbox.
    await Promise.race([completion, delay(20_000).then(() => { throw new Error('durable fairness drain timed out') })])
    await scheduler.stop()
    expect(errors).toEqual([])
    const order = addresses.map(address => address.branchId).sort(compareWorldText)
    expect(served).toEqual([...order, ...order])
    const store = new WorldStore(worldPath)
    try {
      for (const address of addresses) expect(store.verifyBranchIntegrity(address).tick).toBe(2)
    } finally { store.close() }
  } finally {
    await scheduler.stop()
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
