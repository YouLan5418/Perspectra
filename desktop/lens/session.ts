import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostState } from '../host/http-server.ts'
import type { AutoStartEvaluation } from '../host/pack-activities.ts'
import { diffLensViews, type LensChange } from './diff.ts'
import { applyScenario, parseScenario } from './scenario.ts'
import { LensSimulation, type LensNpcPlan, type LensStart, type LensStep, type LensStepTrace } from './simulation.ts'
import { LensStore, type LensRequestView } from './store.ts'
import { buildLensView, type LensView } from './view.ts'

export interface LensSnapshot {
  readonly view: LensView
  readonly baseline: { readonly kind: 'seen' | 'checkpoint' | 'none'; readonly name?: string }
  readonly changes: readonly LensChange[]
  readonly requests: readonly LensRequestView[]
  readonly checkpoints: readonly { name: string; savedAt: string }[]
  readonly scenarios: readonly string[]
  readonly simulation: {
    readonly start: LensStart
    readonly trace: readonly LensStepTrace[]
    readonly state: HostState
    readonly conditions: readonly AutoStartEvaluation[]
  }
}
type Baseline = { readonly kind: 'seen' } | { readonly kind: 'checkpoint'; readonly name: string }

/** One open lens on a pack: its view, change baseline, change requests and one simulation. Every operation runs
 * one after another, because a simulation cannot take two steps at once. Only `markSeen` moves the "seen" baseline;
 * nothing here touches an instance or a save. */
export class LensSession {
  #queue: Promise<unknown> = Promise.resolve()
  #baseline: Baseline = { kind: 'seen' }
  #trace: LensStepTrace[] = []
  #closed = false

  private constructor(
    private readonly packPath: string,
    private readonly store: LensStore,
    private view: LensView,
    private simulation: LensSimulation,
  ) {}

  static async open(packPath: string): Promise<LensSession> {
    const simulation = await LensSimulation.open(packPath)
    try {
      return new LensSession(packPath, new LensStore(packPath), await buildLensView(packPath, simulation), simulation)
    } catch (error) {
      await simulation.close()
      throw error
    }
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => {
      if (this.#closed) throw new Error('透视已关闭。')
      return work()
    })
    this.#queue = result.catch(() => undefined)
    return result
  }

  async #snapshot(): Promise<LensSnapshot> {
    const baseView = this.#baseline.kind === 'seen' ? this.store.seen() : this.store.checkpoint(this.#baseline.name)
    return {
      view: this.view,
      baseline:
        baseView === null
          ? { kind: 'none' }
          : this.#baseline.kind === 'seen'
            ? { kind: 'seen' }
            : { kind: 'checkpoint', name: this.#baseline.name },
      changes: baseView === null ? [] : diffLensViews(baseView, this.view),
      requests: this.store.requests(this.view),
      checkpoints: this.store.checkpoints(),
      scenarios: this.store.scenarios(),
      simulation: {
        start: this.simulation.startedFrom,
        trace: this.#trace,
        state: await this.simulation.state(),
        conditions: this.simulation.conditionsNow(),
      },
    }
  }

  /** Opens the replacement first, so a start that fails leaves the current simulation in place. */
  async #replaceSimulation(start: LensStart): Promise<LensSimulation> {
    const next = await LensSimulation.open(this.packPath, start)
    const old = this.simulation
    this.simulation = next
    this.#trace = []
    await old.close()
    return next
  }

  snapshot(): Promise<LensSnapshot> {
    return this.#run(() => this.#snapshot())
  }

  /** Reads the pack again and starts the simulation over from the current start. The baseline does not move. */
  reload(): Promise<LensSnapshot> {
    return this.#run(async () => {
      const opening = await LensSimulation.open(this.packPath)
      try {
        this.view = await buildLensView(this.packPath, opening)
      } finally {
        await opening.close()
      }
      await this.#replaceSimulation(this.simulation.startedFrom)
      return this.#snapshot()
    })
  }

  setBaseline(baseline: Baseline): Promise<LensSnapshot> {
    return this.#run(async () => {
      if (baseline.kind === 'checkpoint') this.store.checkpoint(baseline.name)
      this.#baseline = baseline.kind === 'seen' ? { kind: 'seen' } : { kind: 'checkpoint', name: baseline.name }
      return this.#snapshot()
    })
  }

  markSeen(): Promise<LensSnapshot> {
    return this.#run(async () => {
      this.store.markSeen(this.view)
      this.#baseline = { kind: 'seen' }
      return this.#snapshot()
    })
  }

  saveCheckpoint(name: string): Promise<LensSnapshot> {
    return this.#run(async () => {
      this.store.saveCheckpoint(name, this.view)
      return this.#snapshot()
    })
  }

  addRequest(itemId: string, note: string): Promise<LensSnapshot> {
    return this.#run(async () => {
      const item = this.view.items.find(candidate => candidate.id === itemId)
      if (item === undefined) throw new Error(`找不到设置项：${itemId}`)
      this.store.addRequest(item, note)
      return this.#snapshot()
    })
  }

  closeRequest(id: string): Promise<LensSnapshot> {
    return this.#run(async () => {
      this.store.closeRequest(id)
      return this.#snapshot()
    })
  }

  restart(start: LensStart): Promise<LensSnapshot> {
    return this.#run(async () => {
      await this.#replaceSimulation(start)
      return this.#snapshot()
    })
  }

  step(step: LensStep): Promise<LensSnapshot> {
    return this.#run(async () => {
      this.#trace = [...this.#trace, await this.simulation.step(step)]
      return this.#snapshot()
    })
  }

  setNpcPlans(plans: Record<string, readonly LensNpcPlan[]>): Promise<LensSnapshot> {
    return this.#run(async () => {
      this.simulation.setNpcPlans(plans)
      return this.#snapshot()
    })
  }

  /** Restarts from the script's own start, plays it on this session's simulation, and shows its steps as the trace. */
  runScenario(name: string): Promise<LensSnapshot> {
    return this.#run(async () => {
      if (!this.store.scenarios().includes(name)) throw new Error(`找不到推演脚本：${name}`)
      const file = join(this.packPath, '.perspectra-lens', 'scenarios', name)
      if (!existsSync(file)) throw new Error(`找不到推演脚本：${name}`)
      let scenario
      try {
        scenario = parseScenario(JSON.parse(readFileSync(file, 'utf8')))
      } catch (error) {
        throw new Error(`推演脚本无效（${name}）：${(error as Error).message}`)
      }
      const sim = await this.#replaceSimulation(scenario.start ?? {})
      this.#trace = [...(await applyScenario(sim, scenario)).steps]
      return this.#snapshot()
    })
  }

  close(): Promise<void> {
    const result = this.#queue.then(async () => {
      if (this.#closed) return
      this.#closed = true
      await this.simulation.close()
    })
    this.#queue = result.catch(() => undefined)
    return result
  }
}
