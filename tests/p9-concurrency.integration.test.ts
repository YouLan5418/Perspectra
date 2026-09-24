import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { WorldApplication, type ReactionParticipantBinding } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
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
