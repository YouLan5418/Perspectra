import { describe, expect, it } from 'vitest'
import { brandId, createErrorEnvelope, compareWorldText, worldAddressKey, WorldError, type WorldAddress } from '@harness-world/contracts'
import type { BranchWorkStep } from '@harness-world/application'
import {
  BranchWorkScheduler,
  MAX_RESIDENT_WAKE_KEYS,
  QUANTUM_RETRY_DELAY_MS,
  type BranchWorkPort,
  type BranchWorkScanPort,
} from './branch-work-scheduler.ts'

function address(name: string): WorldAddress {
  return {
    tenantId: brandId('tenant:scheduler', 'TenantId'),
    worldId: brandId('world:scheduler', 'WorldId'),
    branchId: brandId(`branch:${name}`, 'BranchId'),
  }
}

function roundStep(name: string): BranchWorkStep {
  return {
    status: 'player_round',
    roundId: brandId(`round:${name}`, 'InteractionRoundId'),
    transactionId: brandId(`transaction:${name}`, 'TransactionId'),
    headSeq: 1,
    tick: 1,
    bundleHash: 'sha256:quantum',
    openedCycleId: null,
  }
}

function waveStep(name: string, wave: number, terminalReason: 'quiescent' | null = null): BranchWorkStep {
  return {
    status: 'reaction_wave',
    cycleId: `reaction-cycle:${name}`,
    rootRoundId: brandId(`round:root:${name}`, 'InteractionRoundId'),
    wave,
    roundId: brandId(`round:reaction:${name}:${wave}`, 'InteractionRoundId'),
    transactionId: brandId(`transaction:reaction:${name}:${wave}`, 'TransactionId'),
    headSeq: wave,
    tick: wave,
    terminalReason,
    actionCount: 1,
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(value => { resolve = value })
  return { promise, resolve }
}

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

const noWork: BranchWorkScanPort = { scanRunnableBranches: () => [] }

function retryable(target: WorldAddress): WorldError {
  return new WorldError(createErrorEnvelope({
    errorCode: 'WORLDSTORE_BUSY', category: 'runtime', message: 'transient quantum', retryable: true,
    correlationId: 'scheduler:retry', address: target,
  }))
}

describe('BranchWorkScheduler', () => {
  it('runs one quantum per wake with defaults and stops cleanly', async () => {
    const served: string[] = []
    const work: BranchWorkPort = {
      processNextBranchWork: async (quantumAddress) => {
        served.push(quantumAddress.branchId)
        return served.length === 1 ? roundStep(quantumAddress.branchId) : { status: 'idle' }
      },
    }
    const scheduler = new BranchWorkScheduler({ work, scan: noWork })
    expect(scheduler.wake(address('only'))).toBe(true)
    scheduler.start()
    await settle()
    expect(served).toEqual(['branch:only', 'branch:only'])
    expect(scheduler.snapshot()).toMatchObject({
      started: true, closing: false, readyBranches: 0, inFlightBranches: 0,
      rescanRequired: false, wakeOverflow: 0, failures: 0, scanFailures: 0, oldestReadyWaitMs: 0,
      quanta: { idle: 1, player_input: 0, player_round: 1, reaction_wave: 0 },
      wakes: { explicit: 1, rescan: 0, startup: 0, 'reaction.active': 0, 'round.accepted': 0 },
    })
    await scheduler.stop()
    expect(scheduler.snapshot()).toMatchObject({ closing: true })
    expect(scheduler.wake(address('only'))).toBe(false)
    await scheduler.stop()
  })

  it('passes the configured correlation id, clock and hooks through each quantum', async () => {
    const target = address('hooked')
    const quantumCorrelationIds: string[] = []
    const projected: Array<{ branchId: string; status: string; correlationId: string }> = []
    const failedBranches: string[] = []
    let calls = 0
    let clock = 5_000
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress, correlationId) => {
          calls += 1
          quantumCorrelationIds.push(correlationId)
          if (calls === 2) throw retryable(quantumAddress)
          return calls === 1 ? waveStep('hooked', 1) : { status: 'idle' }
        },
      },
      scan: noWork,
      correlationId: 'test:branch-work',
      maxConcurrentBranches: 1,
      rescanIntervalMs: 60_000,
      onStep: (stepAddress, step, correlationId) => {
        projected.push({ branchId: stepAddress.branchId, status: step.status, correlationId })
      },
      onFailure: (failureAddress) => { failedBranches.push(failureAddress.branchId) },
      now: () => clock,
    })
    scheduler.wake(target, 'round.accepted')
    scheduler.start()
    await settle()
    await new Promise(resolve => setTimeout(resolve, QUANTUM_RETRY_DELAY_MS + 50))
    clock = 9_000
    expect(calls).toBe(3)
    expect(new Set(quantumCorrelationIds)).toEqual(new Set([`test:branch-work:${worldAddressKey(target)}`]))
    expect(projected).toEqual([
      { branchId: 'branch:hooked', status: 'reaction_wave', correlationId: `test:branch-work:${worldAddressKey(target)}` },
      { branchId: 'branch:hooked', status: 'idle', correlationId: `test:branch-work:${worldAddressKey(target)}` },
    ])
    expect(failedBranches).toEqual(['branch:hooked'])
    expect(scheduler.snapshot()).toMatchObject({
      failures: 1, readyBranches: 0, oldestReadyWaitMs: 0,
      quanta: { idle: 1, player_input: 0, player_round: 0, reaction_wave: 1 },
      wakes: { 'round.accepted': 1 },
    })
    await scheduler.stop()
  })

  it('gives every ready Branch one quantum before any Branch runs twice', async () => {
    const order: string[] = []
    const runs = new Map<string, number>()
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          const key = quantumAddress.branchId
          const seen = (runs.get(key) ?? 0) + 1
          runs.set(key, seen)
          order.push(key)
          return seen === 1 ? roundStep(key) : { status: 'idle' }
        },
      },
      scan: noWork,
      maxConcurrentBranches: 1,
      rescanIntervalMs: 60_000,
    })
    const addresses = Array.from({ length: 32 }, (_, index) => address(`b${String(index).padStart(2, '0')}`))
    const expected = addresses.map(value => value.branchId).sort(compareWorldText)
    for (const shuffled of [...addresses].reverse()) scheduler.wake(shuffled, 'reaction.active')
    scheduler.start()
    await settle(40)
    expect(order).toHaveLength(64)
    expect(new Set(order.slice(0, 32)).size).toBe(32)
    expect(order.slice(0, 32)).toEqual(expected)
    expect(order.slice(32)).toEqual(expected)
    await scheduler.stop()
  })

  it('bounds concurrency to the configured number of Branches', async () => {
    const gate = deferred()
    const started: string[] = []
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          started.push(quantumAddress.branchId)
          await gate.promise
          return { status: 'idle' }
        },
      },
      scan: noWork,
      maxConcurrentBranches: 2,
      rescanIntervalMs: 60_000,
    })
    scheduler.wake(address('one'), 'explicit')
    scheduler.wake(address('two'), 'explicit')
    scheduler.wake(address('three'), 'explicit')
    scheduler.start()
    await settle()
    expect(started).toEqual(['branch:one', 'branch:three'])
    expect(scheduler.snapshot()).toMatchObject({ inFlightBranches: 2, readyBranches: 3 })
    gate.resolve()
    await settle()
    expect(started.sort(compareWorldText)).toEqual(['branch:one', 'branch:three', 'branch:two'])
    await scheduler.stop()
  })

  it('merges duplicate wakes and recovers durable work through rescan', async () => {
    const durable = [address('durable-one'), address('durable-two')]
    const served: string[] = []
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          served.push(quantumAddress.branchId)
          return { status: 'idle' }
        },
      },
      scan: { scanRunnableBranches: () => durable },
      rescanIntervalMs: 60_000,
    })
    expect(scheduler.wake(durable[0]!)).toBe(true)
    expect(scheduler.wake(durable[0]!, 'reaction.active')).toBe(false)
    expect(scheduler.rescan()).toBe(2)
    expect(scheduler.snapshot().wakes).toMatchObject({ explicit: 1, rescan: 2 })
    scheduler.start()
    await settle()
    expect(served.sort(compareWorldText)).toEqual(['branch:durable-one', 'branch:durable-two'])
    expect(scheduler.rescan('startup')).toBe(2)
    await settle()
    expect(served).toHaveLength(4)
    await scheduler.stop()
  })

  it('degrades to a rescan instead of growing past the resident wake cap', () => {
    const scheduler = new BranchWorkScheduler({
      work: { processNextBranchWork: async () => ({ status: 'idle' }) },
      scan: noWork,
      rescanIntervalMs: 60_000,
    })
    for (let index = 0; index < MAX_RESIDENT_WAKE_KEYS; index += 1) {
      expect(scheduler.wake(address(`cap-${String(index).padStart(4, '0')}`), 'explicit')).toBe(true)
    }
    expect(scheduler.wake(address('overflow'), 'explicit')).toBe(false)
    expect(scheduler.snapshot()).toMatchObject({
      readyBranches: MAX_RESIDENT_WAKE_KEYS, wakeOverflow: 1, rescanRequired: true, started: false,
    })
  })

  it('recovers an overflowed wake from the durable scan once resident hints drain', async () => {
    const overflowed = address('overflow-target')
    const served: string[] = []
    let scans = 0
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          served.push(quantumAddress.branchId)
          return { status: 'idle' }
        },
      },
      scan: {
        scanRunnableBranches: () => {
          scans += 1
          return scans === 1 ? [] : [overflowed]
        },
      },
      rescanIntervalMs: 60_000,
    })
    for (let index = 0; index < MAX_RESIDENT_WAKE_KEYS; index += 1) {
      scheduler.wake(address(`drain-${String(index).padStart(4, '0')}`), 'explicit')
    }
    expect(scheduler.wake(overflowed, 'reaction.active')).toBe(false)
    expect(scheduler.snapshot()).toMatchObject({ wakeOverflow: 1, rescanRequired: true })
    scheduler.start()
    await settle(40)
    expect(scheduler.snapshot().readyBranches).toBe(0)
    expect(scheduler.rescan('rescan')).toBe(1)
    await settle()
    expect(served).toContain('branch:overflow-target')
    await scheduler.stop()
  })

  it('drops a Branch after each non-retryable failure and counts it', async () => {
    const failures: string[] = []
    let calls = 0
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async () => {
          calls += 1
          throw calls === 1
            ? new Error('untyped quantum failure')
            : new WorldError(createErrorEnvelope({
              errorCode: 'BRANCH_QUARANTINED', category: 'admin', message: 'final quantum failure',
              retryable: false, correlationId: 'scheduler:final',
            }))
        },
      },
      scan: { scanRunnableBranches: () => [address('failing')] },
      rescanIntervalMs: 60_000,
      onFailure: (failureAddress) => { failures.push(failureAddress.branchId) },
    })
    scheduler.start()
    await settle()
    expect(scheduler.rescan('startup')).toBe(1)
    await settle()
    expect(calls).toBe(2)
    expect(failures).toEqual(['branch:failing', 'branch:failing'])
    expect(scheduler.snapshot()).toMatchObject({ failures: 2, readyBranches: 0 })
    await scheduler.stop()
  })

  it('discards a pending retry when the scheduler stops during the backoff', async () => {
    let calls = 0
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          calls += 1
          throw retryable(quantumAddress)
        },
      },
      scan: noWork,
      rescanIntervalMs: 60_000,
    })
    scheduler.wake(address('stalled'), 'explicit')
    scheduler.start()
    await settle(2)
    expect(calls).toBe(1)
    expect(scheduler.snapshot()).toMatchObject({ inFlightBranches: 1, readyBranches: 1, failures: 1 })
    await expect(scheduler.stop()).resolves.toEqual({ timedOut: false, abandonedBranches: 0 })
    expect(calls).toBe(1)
    expect(scheduler.snapshot()).toMatchObject({ readyBranches: 0, inFlightBranches: 0, shutdownTimeouts: 0 })
  })

  it('abandons in-flight quanta once the shutdown budget is exhausted', async () => {
    const gate = deferred()
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async () => {
          await gate.promise
          return { status: 'idle' }
        },
      },
      scan: noWork,
      rescanIntervalMs: 60_000,
    })
    scheduler.wake(address('abandoned'), 'explicit')
    scheduler.start()
    await settle()
    expect(scheduler.snapshot()).toMatchObject({ inFlightBranches: 1, readyBranches: 1 })
    await expect(scheduler.stop(5)).resolves.toEqual({ timedOut: true, abandonedBranches: 1 })
    expect(scheduler.snapshot()).toMatchObject({ shutdownTimeouts: 1, readyBranches: 0 })
    gate.resolve()
    await settle()
    expect(scheduler.snapshot()).toMatchObject({ inFlightBranches: 0 })
  })

  it('keeps scheduling after a durable scan failure and reports the oldest wait', async () => {
    let clock = 1_000
    let scans = 0
    const served: string[] = []
    const scheduler = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          served.push(quantumAddress.branchId)
          return { status: 'idle' }
        },
      },
      scan: {
        scanRunnableBranches: () => {
          scans += 1
          if (scans === 1) throw new Error('scan unavailable')
          return [address('recovered')]
        },
      },
      rescanIntervalMs: 20,
      now: () => clock,
    })
    scheduler.start()
    await settle()
    expect(scheduler.snapshot()).toMatchObject({ scanFailures: 1, readyBranches: 0 })
    clock = 4_000
    scheduler.wake(address('waiting'), 'explicit')
    expect(scheduler.snapshot()).toMatchObject({ readyBranches: 1, inFlightBranches: 0 })
    clock = 7_000
    expect(scheduler.snapshot().oldestReadyWaitMs).toBe(3_000)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(scheduler.snapshot().scanFailures).toBe(1)
    expect(served).toContain('branch:recovered')
    expect(scheduler.snapshot().rescans).toBeGreaterThanOrEqual(2)
    await scheduler.stop()
  })

  it('stops without ever starting and excludes in-flight Branches from the oldest wait', async () => {
    const idle = new BranchWorkScheduler({
      work: { processNextBranchWork: async () => ({ status: 'idle' }) },
      scan: noWork,
      rescanIntervalMs: 60_000,
    })
    await idle.stop()
    expect(idle.snapshot()).toMatchObject({ started: false, closing: true, rescans: 0, inFlightBranches: 0 })

    const gate = deferred()
    let clock = 1_000
    const running = new BranchWorkScheduler({
      work: {
        processNextBranchWork: async (quantumAddress) => {
          if (quantumAddress.branchId === 'branch:blocked') await gate.promise
          return roundStep(quantumAddress.branchId)
        },
      },
      scan: noWork,
      maxConcurrentBranches: 1,
      rescanIntervalMs: 60_000,
      now: () => clock,
    })
    running.wake(address('blocked'), 'explicit')
    running.wake(address('waiting'), 'explicit')
    running.start()
    await settle()
    clock = 6_000
    expect(running.snapshot()).toMatchObject({ inFlightBranches: 1, readyBranches: 2, oldestReadyWaitMs: 5_000 })
    gate.resolve()
    await running.stop()
    expect(running.snapshot()).toMatchObject({ readyBranches: 0, inFlightBranches: 0 })
  })
})
