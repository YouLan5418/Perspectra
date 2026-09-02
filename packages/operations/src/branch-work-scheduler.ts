import { compareWorldText, worldAddressKey, WorldError, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import type { BranchWorkStep } from '@harness-world/application'

export const MAX_CONCURRENT_BRANCHES_DEFAULT = 4
export const MAX_CONCURRENT_BRANCHES_MIN = 1
export const MAX_CONCURRENT_BRANCHES_MAX = 32
export const RESCAN_INTERVAL_MS_DEFAULT = 1_000
export const RESCAN_INTERVAL_MS_MIN = 100
export const RESCAN_INTERVAL_MS_MAX = 60_000
/** Resident wake keys are hints only; overflow degrades to a durable rescan instead of growing. */
export const MAX_RESIDENT_WAKE_KEYS = 1_024
export const QUANTUM_RETRY_DELAY_MS = 100

export const BRANCH_WORK_WAKE_REASONS = Object.freeze([
  'round.accepted',
  'reaction.active',
  'startup',
  'rescan',
  'explicit',
] as const)
export type BranchWorkWakeReason = typeof BRANCH_WORK_WAKE_REASONS[number]

export interface BranchWorkPort {
  processNextBranchWork(address: WorldAddress, correlationId: string): Promise<BranchWorkStep>
}

export interface BranchWorkScanPort {
  scanRunnableBranches(): readonly WorldAddress[]
}

export interface BranchWorkSchedulerSnapshot extends WorldJsonObject {
  readonly started: boolean
  readonly closing: boolean
  readonly readyBranches: number
  readonly inFlightBranches: number
  readonly rescanRequired: boolean
  readonly wakeOverflow: number
  readonly rescans: number
  readonly scanFailures: number
  readonly failures: number
  readonly oldestReadyWaitMs: number
  readonly quanta: Record<BranchWorkStep['status'], number>
  readonly wakes: Record<BranchWorkWakeReason, number>
}

export interface BranchWorkSchedulerOptions {
  readonly work: BranchWorkPort
  readonly scan: BranchWorkScanPort
  readonly correlationId?: string
  readonly maxConcurrentBranches?: number
  readonly rescanIntervalMs?: number
  readonly onStep?: (address: WorldAddress, step: BranchWorkStep, correlationId: string) => void
  readonly onFailure?: (address: WorldAddress, error: unknown) => void
  readonly now?: () => number
  readonly delay?: (ms: number) => Promise<void>
}

interface ReadyBranch {
  readonly address: WorldAddress
  readonly wokenAtMs: number
}

/**
 * Fair Host scheduler over durable Branch work (ADR-0079).
 *
 * Every Branch executes at most one quantum at a time, selection rotates over the UTF-16 order of
 * `worldAddressKey`, and wake hints may be lost, merged or reordered because the durable scan can
 * always re-derive readiness.
 */
export class BranchWorkScheduler {
  readonly #ready = new Map<string, ReadyBranch>()
  readonly #inFlight = new Map<string, Promise<void>>()
  readonly #quanta: Record<BranchWorkStep['status'], number> = { idle: 0, player_round: 0, reaction_wave: 0 }
  readonly #wakes: Record<BranchWorkWakeReason, number> = {
    'round.accepted': 0, 'reaction.active': 0, startup: 0, rescan: 0, explicit: 0,
  }
  readonly #maxConcurrentBranches: number
  readonly #rescanIntervalMs: number
  readonly #correlationId: string
  readonly #now: () => number
  readonly #delay: (ms: number) => Promise<void>
  #cursor: string | null = null
  #rescanRequired = true
  #wakeOverflow = 0
  #rescans = 0
  #scanFailures = 0
  #failures = 0
  #started = false
  #closing = false
  #timer: NodeJS.Timeout | undefined
  #pump: Promise<void> | undefined
  #signal: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined

  constructor(private readonly options: BranchWorkSchedulerOptions) {
    this.#maxConcurrentBranches = options.maxConcurrentBranches ?? MAX_CONCURRENT_BRANCHES_DEFAULT
    this.#rescanIntervalMs = options.rescanIntervalMs ?? RESCAN_INTERVAL_MS_DEFAULT
    this.#correlationId = options.correlationId ?? 'branch-work'
    this.#now = options.now ?? Date.now
    this.#delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Lossy, mergeable readiness hint. Returns true only when the Branch became newly resident. */
  wake(address: WorldAddress, reason: BranchWorkWakeReason = 'explicit'): boolean {
    if (this.#closing) return false
    this.#wakes[reason] += 1
    const key = worldAddressKey(address)
    if (this.#ready.has(key)) return false
    if (this.#ready.size >= MAX_RESIDENT_WAKE_KEYS) {
      this.#wakeOverflow += 1
      this.#rescanRequired = true
      this.#signalPump()
      return false
    }
    this.#ready.set(key, { address, wokenAtMs: this.#now() })
    this.#signalPump()
    return true
  }

  /** Re-derive readiness from durable tables; returns how many runnable Branches the scan observed. */
  rescan(reason: BranchWorkWakeReason = 'rescan'): number {
    this.#rescanRequired = false
    this.#rescans += 1
    const addresses = this.options.scan.scanRunnableBranches()
    for (const address of addresses) this.wake(address, reason)
    return addresses.length
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#rescanRequired = true
    this.#pump = this.#runPump()
    this.#timer = setInterval(() => {
      this.#rescanRequired = true
      this.#signalPump()
    }, this.#rescanIntervalMs)
    this.#timer.unref()
  }

  async stop(): Promise<void> {
    this.#closing = true
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    this.#signalPump()
    await this.#pump
    await Promise.all(this.#inFlight.values())
    this.#ready.clear()
  }

  /** Fixed-cardinality scheduler observation; never exposes a WorldAddress, Prompt or world text. */
  snapshot(): BranchWorkSchedulerSnapshot {
    const now = this.#now()
    let oldestReadyWaitMs = 0
    for (const [key, entry] of this.#ready) {
      if (this.#inFlight.has(key)) continue
      oldestReadyWaitMs = Math.max(oldestReadyWaitMs, now - entry.wokenAtMs)
    }
    return {
      started: this.#started,
      closing: this.#closing,
      readyBranches: this.#ready.size,
      inFlightBranches: this.#inFlight.size,
      rescanRequired: this.#rescanRequired,
      wakeOverflow: this.#wakeOverflow,
      rescans: this.#rescans,
      scanFailures: this.#scanFailures,
      failures: this.#failures,
      oldestReadyWaitMs,
      quanta: { ...this.#quanta },
      wakes: { ...this.#wakes },
    }
  }

  async #runPump(): Promise<void> {
    while (!this.#closing) {
      if (this.#rescanRequired) {
        try {
          this.rescan('rescan')
        } catch {
          this.#scanFailures += 1
        }
      }
      if (this.#launch() === 0) await this.#waitForSignal()
    }
  }

  #launch(): number {
    let launched = 0
    while (this.#inFlight.size < this.#maxConcurrentBranches) {
      const key = this.#selectKey()
      if (key === undefined) break
      const entry = this.#ready.get(key)!
      this.#cursor = key
      this.#inFlight.set(key, this.#runQuantum(key, entry.address))
      launched += 1
    }
    return launched
  }

  /** Round-robin over the UTF-16 order of ready keys, starting just after the last served Branch. */
  #selectKey(): string | undefined {
    const keys = [...this.#ready.keys()].filter(key => !this.#inFlight.has(key)).sort(compareWorldText)
    if (keys.length === 0) return undefined
    const cursor = this.#cursor
    if (cursor === null) return keys[0]!
    return keys.find(key => compareWorldText(key, cursor) > 0) ?? keys[0]!
  }

  #runQuantum(key: string, address: WorldAddress): Promise<void> {
    const correlationId = `${this.#correlationId}:${key}`
    const quantum = (async () => {
      try {
        const step = await this.options.work.processNextBranchWork(address, correlationId)
        this.#quanta[step.status] += 1
        if (step.status === 'idle') this.#ready.delete(key)
        else this.#requeue(key, address)
        this.options.onStep?.(address, step, correlationId)
      } catch (error: unknown) {
        this.#failures += 1
        this.options.onFailure?.(address, error)
        if (error instanceof WorldError && error.envelope.retryable) {
          await this.#delay(QUANTUM_RETRY_DELAY_MS)
          this.#requeue(key, address)
        } else {
          this.#ready.delete(key)
        }
      } finally {
        this.#inFlight.delete(key)
        this.#signalPump()
      }
    })()
    return quantum
  }

  #requeue(key: string, address: WorldAddress): void {
    if (this.#closing) {
      this.#ready.delete(key)
      return
    }
    this.#ready.set(key, { address, wokenAtMs: this.#now() })
  }

  #waitForSignal(): Promise<void> {
    let resolve!: () => void
    const promise = new Promise<void>(value => { resolve = value })
    this.#signal = { promise, resolve }
    return promise
  }

  #signalPump(): void {
    const pending = this.#signal
    this.#signal = undefined
    pending?.resolve()
  }
}
