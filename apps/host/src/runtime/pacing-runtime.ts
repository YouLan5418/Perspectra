import { playerRoundNumber, type WorldAddress, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { currentLocation } from '@perspectra/core/kernel'
import type { PacingBeatInput, PacingCandidate, PacingChoice, PacingHistory, PacingInstance } from '@perspectra/sdk'
import {
  activityWorldFromEvents,
  beatDrafts,
  beatStimulusTargets,
  pacingHistory,
  parseAutoStartConditions,
  parseBeatResult,
  activityProgress,
  type ActivityWorld,
  type WorldRoundSnapshot,
  type WorldRoundEffects,
} from '@perspectra/core'
import type { WorldEventRuntime } from './world-events.ts'
import type { ActivitiesRuntime } from './activities-runtime.ts'
import { isPluginFault } from './plugin-runtime.ts'
import type { StatusRuntime } from './status-runtime.ts'

const authorFault = (error: unknown): error is Error =>
  error instanceof TypeError || error instanceof RangeError || isPluginFault(error)

/** Binds pacing to committed history and one round's recorded draws. It decides nothing itself: activities start
 * through their existing path, and a beat is one atomic round of status and observations. */
export class PacingRuntime {
  #lastDecision: WorldJsonObject | null = null
  #randomValues: number[] = []
  #randomReplay: readonly number[] | undefined
  #randomCursor = 0
  readonly #legacyCountAtOccurrence = new Map<number, number>()
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
    // Same as the activities' draws: the recorded prefix, then fresh draws.
    const value = this.#randomReplay?.[this.#randomCursor] ?? Math.random()
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
  /** The mounted branch has an immutable prefix. Count legacy firings before each paced occurrence
   * once, using the same projector even when several decisions share a player round. */
  #history(snapshot: WorldRoundSnapshot, start: number, events?: WorldEventRuntime): PacingHistory {
    const mechanism = this.world.mechanism
    const history = pacingHistory(snapshot.events, start, mechanism)
    if (!events || !mechanism.worldEvents?.length) return history
    const fired = [...history.fired]
    let inserted = 0
    for (const event of events.pacedHistory(snapshot.head.headSeq)) {
      if (!mechanism.worldEvents.includes(event.key)) continue
      let before = this.#legacyCountAtOccurrence.get(event.seq)
      if (before === undefined) {
        before = history.fired.length
          ? pacingHistory(
              snapshot.events.filter(row => row.seq < event.seq),
              start,
              mechanism,
            ).fired.length
          : 0
        this.#legacyCountAtOccurrence.set(event.seq, before)
      }
      fired.splice(before + inserted, 0, { kind: 'event', key: event.key, round: event.round })
      inserted++
    }
    return { ...history, fired }
  }
  /** At most one pure proposal; cycle settlement owns its validation and atomic commit. */
  prepareCycle(
    snapshot: WorldRoundSnapshot,
    turnStartSeq: number,
    cycleId: string,
    coreRead: <T>(work: () => T) => T,
    onWarning: (kind: 'activity' | 'beat', error: Error) => void,
    worldEvents?: WorldEventRuntime,
  ): WorldRoundEffects | undefined {
    const { activities, mechanism, status, worldPath, address } = this.world
    const busy = coreRead(() => [...activityProgress(snapshot.events).values()].some(state => state.game.active))
    const eventIds =
      worldEvents && mechanism.worldEvents?.length
        ? coreRead(() => {
            const { round } = playerRoundNumber(snapshot.events, turnStartSeq, false)
            return worldEvents.pacedRuleIds(snapshot, round, busy).filter(key => mechanism.worldEvents!.includes(key))
          })
        : []
    if (busy && !eventIds.length) return undefined
    const base = activityWorldFromEvents(worldPath, address, snapshot.head.headSeq, snapshot.events, snapshot.manifest)
    const world: ActivityWorld = {
      ...base,
      truth: status => coreRead(() => base.truth(status)),
      worldView: actor => coreRead(() => base.worldView(actor)),
    }
    const ready = busy ? [] : (activities?.autoStartCandidates(world, error => onWarning('activity', error)) ?? [])
    const unmanaged = ready.filter(candidate => !mechanism.managedActivities.includes(candidate.key))
    // What the author did not hand over to pacing happens as it always has.
    if (unmanaged.length) return activities!.prepareAutoStart(activities!.chooseAutoStart(unmanaged), world, cycleId)
    const candidates: PacingCandidate[] = ready.map(candidate => ({ kind: 'activity', key: candidate.key }))
    // One broken beat is left out and named; the others and the rest of the world carry on.
    const excluded: { beatId: string; error: string }[] = []
    if (!busy && status && mechanism.beats.length) {
      const input = this.#input(world)
      for (const beatId of mechanism.beats) {
        try {
          if (parseAutoStartConditions(mechanism.checks(beatId, input)).every(check => check.met))
            candidates.push({ kind: 'beat', key: beatId })
        } catch (error) {
          if (!authorFault(error)) throw error
          excluded.push({ beatId, error: error.message })
          onWarning('beat', error)
        }
      }
    }
    for (const key of eventIds) candidates.push({ kind: 'event', key })
    let active = true
    const random = () => {
      if (!active) throw new Error('Pacing random capability has ended')
      return this.#draw()
    }
    let choice: PacingChoice
    try {
      choice = mechanism.choose({
        candidates,
        history: coreRead(() => this.#history(snapshot, turnStartSeq, worldEvents)),
        random,
      })
    } finally {
      active = false
    }
    const reason = { ...choice.reason, ...(excluded.length ? { excluded } : {}) } as WorldJsonObject
    this.#lastDecision = { ...choice, reason } as unknown as WorldJsonObject
    if (choice.kind === 'none') return undefined
    if (choice.kind === 'event') {
      if (!worldEvents || !eventIds.includes(choice.key)) throw new TypeError('节奏选择了条件未满足的世界事件')
      return coreRead(() => worldEvents.settlePaced(snapshot, cycleId, turnStartSeq, choice.key, busy))
    }
    if (choice.kind === 'activity') {
      const chosen = ready.find(candidate => candidate.key === choice.key)
      if (!chosen) throw new TypeError('节奏选择了条件未满足的活动')
      return activities!.prepareAutoStart(chosen, world, cycleId)
    }
    if (
      choice.kind !== 'beat' ||
      !candidates.some(candidate => candidate.kind === 'beat' && candidate.key === choice.key)
    )
      throw new TypeError('节奏选择了条件未满足的节拍')
    return this.#beatEffects(choice.key, world, cycleId)
  }
  #beatEffects(beatId: string, world: ActivityWorld, cycleId: string): WorldRoundEffects {
    const { mechanism, status, playerId } = this.world
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
          actionId: `${cycleId}:beat:${beatId}`,
          notice: result.notice,
          sceneNotice: result.sceneNotice,
          stimuli: result.stimuli,
          sceneAudience,
          playerId,
        }),
        authority: { source: 'pacing-beat', beatId, cycleId, status: 'accepted' },
      }
    } finally {
      active = false
    }
  }
}
