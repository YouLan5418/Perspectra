import { fork } from 'node:child_process'
import {
  brandId,
  hashWorldJson,
  type CommitRoundRequest,
  type FaultInjector,
  type FaultPoint,
  type WorldAddress,
} from '@harness-world/contracts'

/** Mutable clock controlled only by a test. */
export class DeterministicClock {
  constructor(private value: number) {}

  now(): number {
    return this.value
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError('advance requires a non-negative safe integer')
    this.value += milliseconds
  }
}
/** Fault injector for transaction rollback tests that do not claim hard-crash coverage. */
export class ThrowingFaultInjector implements FaultInjector {
  constructor(private readonly target: FaultPoint) {}

  hit(point: FaultPoint): void {
    if (point === this.target) throw new Error(`simulated fault at ${point}`)
  }
}

/** Child-side fault injector that lets the parent terminate the process at an exact point. */
export class IpcPauseFaultInjector implements FaultInjector {
  constructor(private readonly target: FaultPoint) {}

  hit(point: FaultPoint): void {
    if (point !== this.target) return
    process.send?.({ type: 'fault-reached', point })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
}

/** Stable fixture address shared by subprocess and parent recovery assertions. */
export function fixtureAddress(branch = 'main'): WorldAddress {
  return {
    tenantId: brandId('tenant:test', 'TenantId'),
    worldId: brandId('world:test', 'WorldId'),
    branchId: brandId(`branch:${branch}`, 'BranchId'),
  }
}

/** Stable one-event Round request used by crash recovery tests. */
export function fixtureCommitRequest(address = fixtureAddress()): CommitRoundRequest {
  const transactionId = brandId('transaction:crash-fixture', 'TransactionId')
  const roundId = brandId('round:crash-fixture', 'InteractionRoundId')
  return {
    address,
    transactionId,
    roundId,
    expectedHeadSeq: 0,
    expectedTick: 0,
    nextTick: 1,
    events: [{ eventType: 'fixture.event', eventVersion: 1, data: { value: 'committed' } }],
    outbox: [{
      deliveryId: brandId('delivery:crash-fixture', 'DeliveryId'),
      sessionId: brandId('session:crash-fixture', 'SessionId'),
      payload: { value: 'delivered' },
      critical: true,
    }],
    correlationId: 'crash-fixture',
  }
}

/** Stable Session delivery used by crash recovery tests. */
export function fixtureDeliveryRequest() {
  const observationEvent = { observationId: 'observation:crash-fixture', content: 'visible' } as const
  return {
    sessionId: brandId('session:crash-fixture', 'SessionId'),
    sessionDeliverySeq: 1,
    deliveryId: brandId('delivery:crash-fixture', 'DeliveryId'),
    payloadHash: hashWorldJson('session-observation', observationEvent),
    observationEvent,
    correlationId: 'crash-fixture',
  }
}

/** Start a TS worker, wait for its IPC fault marker, then terminate it at OS level. */
export async function hardKillAt(workerPath: string, args: readonly string[]): Promise<void> {
  const child = fork(workerPath, [...args], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`crash worker did not reach its fault point: ${stderr}`))
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'fault-reached') return
      child.kill('SIGKILL')
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && signal === null) {
        reject(new Error('crash worker exited normally before it was killed'))
      } else {
        resolve()
      }
    })
  })
}
