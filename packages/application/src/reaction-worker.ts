import type { ReactionWaveResult } from './reaction-scheduler.ts'

export interface ReactionWaveRunner {
  runCurrentWave(): Promise<ReactionWaveResult | undefined>
}

export interface ReactionExecutionLane {
  enqueueRound<T>(work: () => Promise<T>): Promise<T>
}

export interface ReactionDrainResult {
  readonly cycleId: string | null
  readonly waves: readonly ReactionWaveResult[]
}

/** Serially drain one bounded Cycle on the same branch lane used by player Rounds. */
export class ReactionCycleWorker {
  constructor(
    private readonly lane: ReactionExecutionLane,
    private readonly runner: ReactionWaveRunner,
  ) {}

  drain(): Promise<ReactionDrainResult> {
    return this.lane.enqueueRound(async () => {
      const waves: ReactionWaveResult[] = []
      const identities = new Set<string>()
      while (true) {
        const result = await this.runner.runCurrentWave()
        if (result === undefined) return { cycleId: waves[0]?.cycleId ?? null, waves }
        const identity = `${result.cycleId}\u001f${result.wave}`
        if (identities.has(identity)) throw new Error('Reaction worker observed the same Wave twice')
        identities.add(identity)
        waves.push(result)
        if (result.terminalReason !== null) return { cycleId: result.cycleId, waves }
      }
    })
  }

  /** Execute at most one frozen Wave so a Host scheduler can bound every Branch to one quantum. */
  runOneWave(): Promise<ReactionWaveResult | undefined> {
    return this.lane.enqueueRound(() => this.runner.runCurrentWave())
  }
}
