import { createPluginCallContext, type PluginCallContext } from '@perspectra/core/runtime'
import { executeSchedulerRound } from './scheduler-execution.ts'
import type { ExecutionSchedulerRound } from './scheduler-round.ts'
import { randomUUID } from 'node:crypto'
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises'
import type { CharacterId } from '@perspectra/sdk/contracts'
import type {
  ExecutionCycleActivationResult,
  ExecutionCycleBudget,
  ExecutionCycleResult,
  ExecutionCycleTerminal,
  PluginFault,
  SchedulerInstance,
  SchedulerResult,
  WakeupSource,
} from '@perspectra/sdk'
import type { WorldInstanceScope } from '@perspectra/core/runtime'
import type { CharacterTurnResult } from './character-turn.ts'
import type { WorldRoundEffects, WorldRoundSnapshot } from './world-round-execution.ts'
import { ExecutionModelAccount, withExecutionObservation } from './execution-observation.ts'

export const DEFAULT_EXECUTION_BUDGET: Readonly<Required<ExecutionCycleBudget>> = Object.freeze({
  maxActivations: 27,
  maxConcurrentActivations: 2,
  deadlineMs: 270_000,
})

export type ActivationCommitProgress = Pick<
  CharacterTurnResult,
  'calls' | 'controlledCommitted' | 'publicationCommitted' | 'performResult' | 'lastDecision'
>

export interface ExecutionCycleControl {
  readonly cycleId: string
  readonly signal: AbortSignal
  activate(
    characterId: CharacterId,
    run: (signal: AbortSignal, progress: (value: ActivationCommitProgress) => void) => Promise<CharacterTurnResult>,
  ): Promise<ExecutionCycleActivationResult>
  observe(terminalReason: string): void
}

export interface ExecutionSchedulerDriver {
  readonly scheduler: SchedulerInstance
  readonly pluginId: string
  readonly context?: PluginCallContext
  readonly onRound?: (result: SchedulerResult) => void
}

export type ExecutionRoundRunner = (round: ExecutionSchedulerRound) => Promise<SchedulerResult>
type ExecutionRounds = Iterable<ExecutionSchedulerRound> | AsyncIterable<ExecutionSchedulerRound>

/** @internal Application-owned settlement adapter. Never pass its raw snapshot or commit drafts to an author hook.
 * B4 binds author GameplayCycleEndInput/GameplayEffect through owned projections and core validators. */
export interface CoreCycleEndHook {
  readonly pluginId: string
  readonly hookId: string
  /** Internal prerequisite order; equal entries retain stable plugin/hook ordering. */
  readonly order?: number
  readonly resolve: (
    snapshot: WorldRoundSnapshot,
    cycleId: string,
    signal: AbortSignal,
  ) => WorldRoundEffects | undefined | Promise<WorldRoundEffects | undefined>
}

export class CycleHookFault extends Error implements PluginFault {
  readonly origin = 'plugin'
  readonly operation = 'onCycleEnd'
  constructor(
    readonly pluginId: string,
    readonly hookId: string,
  ) {
    super(`插件 ${pluginId} 的 onCycleEnd 操作失败。`)
    this.name = 'PluginFault'
  }
}

export interface WorldExecutionEngineOptions {
  readonly scope: WorldInstanceScope
  readonly characters: readonly CharacterId[]
  readonly defaults?: Partial<ExecutionCycleBudget>
  /** The application binds branch identity, validation, the writer lease and the atomic commit. */
  readonly settle: (
    hook: CoreCycleEndHook,
    cycleId: string,
    signal: AbortSignal,
  ) => Promise<{ readonly afterSeq: number } | undefined>
}

function budget(value: Partial<ExecutionCycleBudget>): Required<ExecutionCycleBudget> {
  const resolved = { ...DEFAULT_EXECUTION_BUDGET, ...value }
  for (const key of ['maxActivations', 'maxConcurrentActivations'] as const)
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1)
      throw new RangeError(`${key} must be a positive safe integer`)
  if (!Number.isFinite(resolved.deadlineMs) || resolved.deadlineMs < 1)
    throw new RangeError('deadlineMs must be positive and finite')
  return Object.freeze(resolved)
}

/** Drain this event-loop turn's promise continuations before choosing cancellation over an observed core failure. */
async function invokeExecution<T>(
  scope: WorldInstanceScope,
  signal: AbortSignal,
  work: (signal: AbortSignal) => T | PromiseLike<T>,
): Promise<T> {
  let failed = false
  let failure: unknown
  try {
    return await scope.invoke(async active => {
      try {
        return await work(active)
      } catch (error) {
        failed = true
        failure = error
        throw error
      }
    }, signal)
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      await nextEventLoopTurn()
      if (failed && failure !== signal.reason) throw failure
    }
    throw error
  }
}

/** One instance's public execution entry. It owns no world facts and creates no parallel storage root. */
export class WorldExecutionEngine {
  readonly #requests = new Set<WorldExecutionRequest>()
  readonly #hooks = new Map<string, CoreCycleEndHook>()
  readonly #wakeups = new Map<string, WakeupSource>()
  readonly #characters: ReadonlySet<CharacterId>
  readonly #defaults: Required<ExecutionCycleBudget>
  #closed = false

  constructor(readonly options: WorldExecutionEngineOptions) {
    this.#characters = new Set(options.characters)
    this.#defaults = budget(options.defaults ?? {})
  }

  assertActive(): void {
    this.options.scope.assertActive()
    if (this.#closed) throw new Error('execution engine is closed')
  }

  assertCharacter(characterId: CharacterId): void {
    if (!this.#characters.has(characterId)) throw new TypeError('execution requires a declared NPC')
  }

  beginRequest(options: { readonly budget?: Partial<ExecutionCycleBudget>; readonly signal?: AbortSignal } = {}) {
    this.assertActive()
    const request = new WorldExecutionRequest(this, budget({ ...this.#defaults, ...options.budget }), options.signal)
    this.#requests.add(request)
    return request
  }

  registerCoreCycleEndHook(hook: CoreCycleEndHook): () => void {
    this.assertActive()
    if (!hook.pluginId.trim() || !hook.hookId.trim() || typeof hook.resolve !== 'function')
      throw new TypeError('cycle hook requires stable plugin and hook IDs and a resolver')
    if (hook.order !== undefined && !Number.isSafeInteger(hook.order))
      throw new TypeError('cycle hook order must be an integer')
    const key = JSON.stringify([hook.pluginId, hook.hookId])
    if (this.#hooks.has(key)) throw new Error('cycle hook is already registered')
    const registered = { ...hook }
    this.#hooks.set(key, registered)
    return () => {
      if (this.#hooks.get(key) === registered) this.#hooks.delete(key)
    }
  }

  hooks(): readonly CoreCycleEndHook[] {
    return [...this.#hooks.values()].sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        a.pluginId.localeCompare(b.pluginId, 'en') ||
        a.hookId.localeCompare(b.hookId, 'en'),
    )
  }

  registerWakeupSource(source: WakeupSource): () => void {
    this.assertActive()
    if (!source?.id?.trim() || typeof source.nominate !== 'function')
      throw new TypeError('wakeup source requires a stable ID and nominate function')
    if (this.#wakeups.has(source.id)) throw new Error('wakeup source is already registered')
    const registered: WakeupSource = {
      id: source.id,
      nominate: input => {
        if (this.#closed || this.#wakeups.get(source.id) !== registered) return []
        return source.nominate(input)
      },
    }
    this.#wakeups.set(source.id, registered)
    return () => {
      if (this.#wakeups.get(source.id) === registered) this.#wakeups.delete(source.id)
    }
  }

  wakeupSources(): readonly WakeupSource[] {
    return [...this.#wakeups.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))
  }

  release(request: WorldExecutionRequest): void {
    this.#requests.delete(request)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const request of this.#requests) request.close()
    this.#hooks.clear()
    this.#wakeups.clear()
  }
}

/** Counters belong to the request, so a scheduler cannot obtain new quota by changing cycle boundaries. */
export class WorldExecutionRequest {
  readonly signal: AbortSignal
  readonly #controller = new AbortController()
  readonly #deadlineAt: number
  readonly #timer: ReturnType<typeof setTimeout>
  #deadlineExpired = false
  #closed = false
  #used = 0
  #running = 0
  #cycle: WorldExecutionCycle | undefined

  constructor(
    readonly engine: WorldExecutionEngine,
    readonly limits: Required<ExecutionCycleBudget>,
    signal?: AbortSignal,
  ) {
    this.#deadlineAt = performance.now() + limits.deadlineMs
    this.signal = AbortSignal.any([
      engine.options.scope.signal,
      this.#controller.signal,
      ...(signal === undefined ? [] : [signal]),
    ])
    this.#timer = setTimeout(() => this.#expire(), limits.deadlineMs)
    this.signal.addEventListener('abort', () => clearTimeout(this.#timer), { once: true })
    if (this.signal.aborted) clearTimeout(this.#timer)
  }

  stopped(): 'budget_exhausted' | 'interrupted' | undefined {
    if (!this.signal.aborted && performance.now() >= this.#deadlineAt) this.#expire()
    if (this.signal.aborted || this.#closed) return this.#deadlineExpired ? 'budget_exhausted' : 'interrupted'
    return undefined
  }

  reserve(): 'budget_exhausted' | 'interrupted' | undefined {
    this.engine.assertActive()
    const stopped = this.stopped()
    if (stopped) return stopped
    if (this.#used >= this.limits.maxActivations || this.#running >= this.limits.maxConcurrentActivations)
      return 'budget_exhausted'
    this.#used++
    this.#running++
    return undefined
  }

  releaseActivation(): void {
    this.#running--
  }

  openCycle(): WorldExecutionCycle {
    this.engine.assertActive()
    if (this.#closed) throw new Error('execution request is closed')
    if (this.#cycle !== undefined) throw new Error('execution request already has an open cycle')
    return (this.#cycle = new WorldExecutionCycle(this))
  }

  async runCycle(work: (control: ExecutionCycleControl) => Promise<void>): Promise<ExecutionCycleResult> {
    const cycle = this.openCycle()
    try {
      await cycle.run(() => invokeExecution(this.engine.options.scope, this.signal, () => work(cycle.control)))
    } catch (error) {
      if (!this.signal.aborted || error !== this.signal.reason) {
        cycle.control.observe('failed')
        await cycle.complete()
        throw error
      }
    }
    return cycle.complete()
  }

  /** Input-independent cycle driver for Host, tests and headless consumers. */
  async runScheduledCycle(
    input: ExecutionSchedulerDriver & {
      readonly rounds: ExecutionRounds
      /** Rebuild activity/scene bindings at the committed settlement prefix. Ordinary scene rounds reuse theirs. */
      readonly settlementRounds?: (afterSeq: number, signal: AbortSignal) => ExecutionRounds | Promise<ExecutionRounds>
    },
  ): Promise<ExecutionCycleResult> {
    const cycle = this.openCycle()
    const driver = { ...input, context: input.context ?? createPluginCallContext(this.engine.options.scope) }
    const sceneRounds: ExecutionSchedulerRound[] = []
    const runRounds = async (rounds: ExecutionRounds, runRound: ExecutionRoundRunner) => {
      for await (const round of rounds) {
        const stopped = this.stopped()
        if (stopped) break
        await runRound(round)
        if (!cycle.canSettle) break
      }
    }
    try {
      await cycle.run(() =>
        invokeExecution(this.engine.options.scope, this.signal, () =>
          runRounds(input.rounds, async round => {
            if (round.phase === 'scene') sceneRounds.push(round)
            const result = await executeSchedulerRound({ ...driver, round, control: cycle.control })
            input.onRound?.(result)
            return result
          }),
        ),
      )
    } catch (error) {
      if (!this.signal.aborted || error !== this.signal.reason) {
        cycle.control.observe('failed')
        await cycle.complete()
        throw error
      }
    }
    return cycle.completeScheduled(driver, async (afterSeq, runRound) => {
      const rounds = input.settlementRounds
        ? await input.settlementRounds(afterSeq, this.signal)
        : sceneRounds.map(round => round.forReactions(afterSeq))
      await runRounds(rounds, runRound)
    })
  }

  finishCycle(cycle: WorldExecutionCycle): void {
    if (this.#cycle === cycle) this.#cycle = undefined
  }

  snapshot() {
    return {
      usedActivations: this.#used,
      runningActivations: this.#running,
      remainingActivations: this.limits.maxActivations - this.#used,
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#controller.abort()
    this.engine.release(this)
  }

  #expire(): void {
    if (this.signal.aborted || this.#closed) return
    this.#deadlineExpired = true
    this.#controller.abort(new Error('execution request deadline exhausted'))
  }
}

export class WorldExecutionCycle {
  readonly cycleId = randomUUID()
  readonly control: ExecutionCycleControl
  readonly #account = new ExecutionModelAccount()
  #activationLifetime = new AbortController()
  readonly #activations: ExecutionCycleActivationResult[] = []
  readonly #pending = new Set<Promise<unknown>>()
  #hasFailure = false
  #failure: unknown
  #status: ExecutionCycleTerminal = 'completed'
  #generation = 0
  #closed = false
  #completion: Promise<ExecutionCycleResult> | undefined

  constructor(readonly request: WorldExecutionRequest) {
    this.control = this.#control(0)
  }

  run<T>(work: () => T): T {
    return withExecutionObservation(this.#account, work)
  }

  #control(generation: number): ExecutionCycleControl {
    return {
      cycleId: this.cycleId,
      signal: this.request.signal,
      activate: (id, run) => {
        if (this.#closed || generation !== this.#generation)
          return Promise.reject(new Error('execution cycle has ended'))
        this.request.engine.assertCharacter(id)
        const denied = this.request.reserve()
        const result: ExecutionCycleActivationResult = {
          characterId: id,
          status: denied ?? 'abstained',
          calls: 0,
          controlledCommitted: false,
          publicationCommitted: false,
        }
        this.#activations.push(result)
        if (denied) {
          this.#observe(denied)
          return Promise.resolve(result)
        }
        let entered = false
        const lifetime = this.#activationLifetime
        const signal = AbortSignal.any([this.request.signal, lifetime.signal])
        const progress = (value: ActivationCommitProgress) => Object.assign(result, structuredClone(value))
        const operation = this.run(async () => {
          try {
            const value = await invokeExecution(this.request.engine.options.scope, signal, signal => {
              entered = true
              return (async () => {
                try {
                  signal.throwIfAborted()
                  return await run(signal, progress)
                } finally {
                  this.request.releaseActivation()
                }
              })()
            })
            Object.assign(result, structuredClone(value))
            // A stale activation may be replanned by the scheduler against the new prefix.
            // Its final result, rather than this recoverable attempt, decides the cycle boundary.
            if (value.status !== 'stale') this.#observe(value.status)
          } catch (error) {
            const stopped = this.request.stopped()
            if (signal.aborted && error === signal.reason) {
              Object.assign(result, { status: stopped ?? 'interrupted' })
              this.#observe(stopped ?? 'interrupted')
            } else {
              this.#observe('failed')
              this.#hasFailure = true
              this.#failure = error
              throw error
            }
          } finally {
            if (!entered) this.request.releaseActivation()
          }
          return structuredClone(result)
        })
        this.#pending.add(operation)
        void operation.finally(() => this.#pending.delete(operation)).catch(() => undefined)
        return operation
      },
      observe: reason => {
        if (this.#closed || generation !== this.#generation) throw new Error('execution cycle has ended')
        this.#observe(reason)
      },
    }
  }

  #observe(reason: string): void {
    if (['failed', 'plugin_failed', 'plugin_invalid', 'result_unknown'].includes(reason)) this.#status = 'failed'
    else if (
      this.#status !== 'failed' &&
      ['budget_exhausted', 'call_limit', 'wave_limit', 'character_limit', 'opportunity_limit'].includes(reason)
    )
      this.#status = 'budget_exhausted'
    else if (this.#status === 'completed' && ['interrupted', 'stale'].includes(reason)) this.#status = 'interrupted'
  }

  get canSettle(): boolean {
    return !this.#closed && this.#status === 'completed' && !this.request.stopped()
  }

  complete(
    afterSettlement?: (control: ExecutionCycleControl, afterSeq: number) => Promise<void>,
  ): Promise<ExecutionCycleResult> {
    return (this.#completion ??= this.#finish(afterSettlement))
  }

  /** Shared settlement/reaction coordinator. The caller binds current opportunities; core drives every round. */
  completeScheduled(
    input: ExecutionSchedulerDriver,
    bindRounds: (afterSeq: number, runRound: ExecutionRoundRunner) => Promise<void>,
  ): Promise<ExecutionCycleResult> {
    const context = input.context ?? createPluginCallContext(this.request.engine.options.scope)
    return this.complete(async (control, afterSeq) => {
      await bindRounds(afterSeq, async round => {
        const stopped = this.request.stopped()
        if (stopped) control.observe(stopped)
        if (!this.canSettle) return { calls: 0, wave: 0, terminalReason: stopped ?? 'failed', activations: [] }
        const result = await executeSchedulerRound({ ...input, context, control, round })
        input.onRound?.(result)
        return result
      })
    })
  }

  async #settleActivations(): Promise<void> {
    if (this.#pending.size > 0) {
      if (this.#status === 'completed') this.#observe(this.request.stopped() ?? 'failed')
      this.#activationLifetime.abort()
    }
    const pending = await Promise.allSettled(this.#pending)
    const rejected = pending.find(entry => entry.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    if (this.#hasFailure) throw this.#failure
  }

  async #finish(
    afterSettlement?: (control: ExecutionCycleControl, afterSeq: number) => Promise<void>,
  ): Promise<ExecutionCycleResult> {
    this.#generation++
    let failure: PluginFault | undefined
    try {
      await this.#settleActivations()
      this.#observe(this.request.stopped() ?? '')
      let afterSeq: number | undefined
      if (this.#status === 'completed') {
        for (const hook of this.request.engine.hooks()) {
          if (this.request.stopped()) {
            this.#observe(this.request.stopped()!)
            break
          }
          try {
            const committed = await this.run(() =>
              this.request.engine.options.settle(hook, this.cycleId, this.request.signal),
            )
            if (committed && afterSeq === undefined) afterSeq = committed.afterSeq
          } catch (error) {
            if (error instanceof CycleHookFault) {
              failure = {
                origin: error.origin,
                pluginId: error.pluginId,
                operation: error.operation,
                message: error.message,
              }
              this.#observe('failed')
              break
            }
            if (this.request.signal.aborted && error === this.request.signal.reason) {
              this.#observe(this.request.stopped() ?? 'interrupted')
              break
            }
            throw error
          }
        }
      }
      this.#activationLifetime.abort()
      this.#activationLifetime = new AbortController()
      if (this.#status === 'completed' && afterSeq !== undefined && afterSettlement) {
        try {
          await this.run(() =>
            invokeExecution(this.request.engine.options.scope, this.request.signal, () =>
              afterSettlement(this.#control(this.#generation), afterSeq),
            ),
          )
        } catch (error) {
          if (this.request.signal.aborted && error === this.request.signal.reason)
            this.#observe(this.request.stopped() ?? 'interrupted')
          else {
            this.#observe('failed')
            await this.#settleActivations()
            throw error
          }
        }
      }
      await this.#settleActivations()
      this.#observe(this.request.stopped() ?? '')
      return {
        cycleId: this.cycleId,
        status: this.#status,
        calls: this.#activations.reduce((sum, entry) => sum + entry.calls, 0),
        activations: structuredClone(this.#activations),
        usage: this.#account.snapshot(),
        ...(failure === undefined ? {} : { failure }),
      }
    } finally {
      this.#closed = true
      this.#activationLifetime.abort()
      this.#generation++
      this.request.finishCycle(this)
    }
  }
}
