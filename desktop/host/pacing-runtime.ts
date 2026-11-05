import type { WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import type { PacingCandidate, PacingChoice, PacingInstance } from '@harness-world/plugin-sdk'
import { pacingHistory } from '@harness-world/application'
import { WorldStore } from '@harness-world/store-sqlite'
import type { ActivitiesRuntime } from './activities-runtime.ts'

/** Binds pacing to committed history and one round's recorded draws. It decides nothing itself and writes only
 * through the existing activity start. */
export class PacingRuntime {
  #lastDecision: PacingChoice | undefined
  #randomValues: number[] = []
  #randomReplay: readonly number[] | undefined
  #randomCursor = 0
  constructor(
    private readonly mechanism: PacingInstance,
    private readonly worldPath: string,
    private readonly address: WorldAddress,
    private readonly activities: ActivitiesRuntime | undefined,
  ) {}
  /** Only for the creator's view. */
  get lastDecision(): WorldJsonObject | null {
    return this.#lastDecision === undefined ? null : (structuredClone(this.#lastDecision) as unknown as WorldJsonObject)
  }
  /** A world with beats but no activities records its own draws in the round. */
  beginRoundRandom(values?: readonly number[]): void {
    this.#randomValues = []
    this.#randomReplay = values
    this.#randomCursor = 0
  }
  roundRandom(): number[] {
    return [...this.#randomValues]
  }
  #draw(): number {
    if (this.activities) return this.activities.drawRandom()
    const value = this.#randomReplay === undefined ? Math.random() : this.#randomReplay[this.#randomCursor]
    if (value === undefined) throw new TypeError('节奏随机记录不足。')
    this.#randomCursor++
    this.#randomValues.push(value)
    return value
  }
  /** At most one thing this round. Returns whether an activity started. */
  async endOfRound(turnStartSeq: number): Promise<{ readonly started: boolean }> {
    const { activities, mechanism } = this
    if (activities?.current()?.game.active === true) return { started: false }
    const ready = activities?.autoStartCandidates() ?? []
    const unmanaged = ready.filter(candidate => !mechanism.managedActivities.includes(candidate.key))
    // What the author did not hand over to pacing happens as it always has.
    if (unmanaged.length) return { started: await activities!.startChosen(unmanaged) }
    const candidates: PacingCandidate[] = ready.map(candidate => ({ kind: 'activity', key: candidate.key }))
    const store = new WorldStore(this.worldPath)
    let events
    try {
      events = store.readEvents(this.address)
    } finally {
      store.close()
    }
    let active = true
    let choice: PacingChoice
    try {
      choice = mechanism.choose({
        candidates,
        history: pacingHistory(events, turnStartSeq, mechanism),
        random: () => {
          if (!active) throw new Error('Pacing random capability has ended')
          return this.#draw()
        },
      })
    } finally {
      active = false
    }
    this.#lastDecision = choice
    if (choice.kind === 'none') return { started: false }
    if (choice.kind === 'activity') {
      const chosen = ready.find(candidate => candidate.key === choice.key)
      if (!chosen) throw new TypeError('节奏选择了条件未满足的活动')
      return { started: await activities!.startAuto(chosen) }
    }
    return { started: false }
  }
}
