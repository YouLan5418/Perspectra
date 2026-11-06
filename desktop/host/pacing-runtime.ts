import type { RoundCountEvent, WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import { currentLocation } from '@harness-world/kernel'
import type { PacingBeatInput, PacingCandidate, PacingChoice, PacingInstance } from '@harness-world/plugin-sdk'
import {
  activityWorldFromEvents,
  beatDrafts,
  beatStimulusTargets,
  pacingHistory,
  parseAutoStartConditions,
  parseBeatResult,
  readActivityWorld,
  type ActivityWorld,
} from '@harness-world/application'
import type { ActivitiesRuntime } from './activities-runtime.ts'
import type { StatusRuntime } from './status-runtime.ts'

const authorFault = (error: unknown): error is Error => error instanceof TypeError || error instanceof RangeError

/** Binds pacing to committed history and one round's recorded draws. It decides nothing itself: activities start
 * through their existing path, and a beat is one atomic round of status and observations. */
export class PacingRuntime {
  #lastDecision: WorldJsonObject | null = null
  #randomValues: number[] = []
  #randomReplay: readonly number[] | undefined
  #randomCursor = 0
  constructor(
    private readonly world: {
      readonly mechanism: PacingInstance
      readonly worldPath: string
      readonly address: WorldAddress
      readonly playerId: string
      readonly activities: ActivitiesRuntime | undefined
      readonly status: StatusRuntime | undefined
    },
  ) {}
  /** Only for the creator's view. */
  get lastDecision(): WorldJsonObject | null {
    return structuredClone(this.#lastDecision)
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
    if (this.world.activities) return this.world.activities.drawRandom()
    const value = this.#randomReplay === undefined ? Math.random() : this.#randomReplay[this.#randomCursor]
    if (value === undefined) throw new TypeError('节奏随机记录不足。')
    this.#randomCursor++
    this.#randomValues.push(value)
    return value
  }
  #input(world: ActivityWorld): PacingBeatInput {
    const places: Record<string, string | null> = {}
    for (const character of world.manifest.characters)
      places[character.characterId] = currentLocation(world.events, character.characterId) ?? null
    return {
      truth: world.truth(this.world.status)!,
      world: { ...world.worldView(this.world.playerId), places } as WorldJsonObject,
    }
  }
  /** At most one thing this round. \`beatFrom\` is the head a committed beat started from. */
  async endOfRound(turnStartSeq: number): Promise<{ readonly started: boolean; readonly beatFrom?: number }> {
    const { activities, mechanism, status, worldPath, address } = this.world
    if (activities?.current()?.game.active === true) return { started: false }
    const ready = activities?.autoStartCandidates() ?? []
    const unmanaged = ready.filter(candidate => !mechanism.managedActivities.includes(candidate.key))
    // What the author did not hand over to pacing happens as it always has.
    if (unmanaged.length) return { started: await activities!.startChosen(unmanaged) }
    const world = readActivityWorld(worldPath, address)
    const candidates: PacingCandidate[] = ready.map(candidate => ({ kind: 'activity', key: candidate.key }))
    // One broken beat is left out and named; the others and the rest of the world carry on.
    const excluded: { beatId: string; error: string }[] = []
    if (status && mechanism.beats.length) {
      const input = this.#input(world)
      for (const beatId of mechanism.beats) {
        try {
          if (parseAutoStartConditions(mechanism.checks(beatId, input)).every(check => check.met))
            candidates.push({ kind: 'beat', key: beatId })
        } catch (error) {
          if (!authorFault(error)) throw error
          excluded.push({ beatId, error: error.message })
        }
      }
    }
    let active = true
    const random = () => {
      if (!active) throw new Error('Pacing random capability has ended')
      return this.#draw()
    }
    let choice: PacingChoice
    try {
      choice = mechanism.choose({
        candidates,
        // The committed events carry their sequence and transaction; RulebookEvent only omits them from its type.
        history: pacingHistory(world.events as unknown as readonly RoundCountEvent[], turnStartSeq, mechanism),
        random,
      })
    } finally {
      active = false
    }
    const reason = { ...choice.reason, ...(excluded.length ? { excluded } : {}) } as WorldJsonObject
    this.#lastDecision = { ...choice, reason } as unknown as WorldJsonObject
    if (choice.kind === 'none') return { started: false }
    if (choice.kind === 'activity') {
      const chosen = ready.find(candidate => candidate.key === choice.key)
      if (!chosen) throw new TypeError('节奏选择了条件未满足的活动')
      return { started: await activities!.startAuto(chosen) }
    }
    if (!candidates.some(candidate => candidate.kind === 'beat' && candidate.key === choice.key))
      throw new TypeError('节奏选择了条件未满足的节拍')
    const failure = await this.#fire(choice.key, world)
    if (failure === undefined) return { started: false, beatFrom: world.headSeq }
    this.#lastDecision = {
      kind: 'none',
      reason: { ...reason, why: 'beat-failed', beatId: choice.key, error: failure },
    }
    return { started: false }
  }
  /** Returns the author's mistake, if any. It commits nothing and is not retried; storage faults still throw. */
  async #fire(beatId: string, decided: ActivityWorld): Promise<string | undefined> {
    const { mechanism, status, worldPath, address, playerId } = this.world
    let failure: string | undefined
    await status!.commitBeat(worldPath, address, `pacing:${decided.headSeq}:${beatId}`, snapshot => {
      const world = activityWorldFromEvents(
        worldPath,
        address,
        snapshot.head.headSeq,
        snapshot.events,
        decided.manifest,
      )
      const input = this.#input(world),
        sceneAudience = (input.world.characterIds as string[]) ?? []
      let active = true
      try {
        const result = parseBeatResult(
          mechanism.apply(beatId, input, () => {
            if (!active) throw new Error('Pacing random capability has ended')
            return this.#draw()
          }),
          beatStimulusTargets(world.manifest, world.events, playerId),
          playerId,
        )
        return {
          events: beatDrafts({
            status: status!.beatResult(world.events, beatId, result.changes, result.reveals),
            actionId: `beat:${world.headSeq}:${beatId}`,
            notice: result.notice,
            sceneNotice: result.sceneNotice,
            stimuli: result.stimuli,
            sceneAudience,
            playerId,
          }),
          authority: { source: 'pacing-beat', beatId, status: 'accepted' },
        }
      } catch (error) {
        if (!authorFault(error)) throw error
        failure = error.message
        return undefined
      } finally {
        active = false
      }
    })
    return failure
  }
}
